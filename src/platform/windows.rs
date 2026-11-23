// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{File, OpenOptions},
    hint::cold_path,
    io,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, IntoRawHandle},
    },
    pin::Pin,
    task::{Context, Poll},
};

use serialport::{COMPort, SerialPort};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::windows::named_pipe::NamedPipeClient,
};
use windows_sys::Win32::{
    Devices::Communication::{
        COMMTIMEOUTS, COMSTAT, ClearCommError, DCB, GetCommState, SetCommState, SetCommTimeouts,
    },
    Foundation::{ERROR_CALL_NOT_IMPLEMENTED, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED},
    Storage::FileSystem::FILE_FLAG_OVERLAPPED,
};

use super::windows_read::{self, ReadState};

pub(crate) struct SerialStream {
    // These own different handles to the same device. Tokio exclusively owns
    // the overlapped-I/O handle; COMPort owns a duplicate used only for control.
    io: NamedPipeClient,
    control: COMPort,
    read: ReadState,
}

impl SerialStream {
    pub fn open(options: &crate::NativeOptions) -> io::Result<Self> {
        let (bits, parity, stop) = super::windows_format(options)?;
        let path = super::windows_device_path(&options.path);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OVERLAPPED)
            .open(path)?;
        let handle = file.as_raw_handle();
        let mut settings = DCB {
            DCBlength: size_of::<DCB>() as u32,
            ..Default::default()
        };
        // SAFETY: file owns the COM handle and settings is writable for this call.
        (unsafe { GetCommState(handle, &raw mut settings) } != 0)
            .ok_or_else(io::Error::last_os_error)?;
        settings.BaudRate = options.baud_rate;
        settings.ByteSize = bits;
        settings.Parity = parity;
        settings.StopBits = stop;
        settings._bitfield = super::windows_dcb_flags(settings._bitfield, options);
        settings.XonChar = 17;
        settings.XoffChar = 19;
        settings.ErrorChar = 0;
        settings.EofChar = 26;
        // SAFETY: the COM handle and the configured DCB remain valid for the call.
        (unsafe { SetCommState(handle, &raw const settings) } != 0)
            .ok_or_else(io::Error::last_os_error)?;
        // Return available bytes immediately; avoid extreme timeout values.
        // Empty completions are retried after checking device status.
        let timeouts = COMMTIMEOUTS {
            ReadIntervalTimeout: u32::MAX,
            ReadTotalTimeoutMultiplier: u32::MAX,
            ReadTotalTimeoutConstant: 60_000,
            ..Default::default()
        };
        // SAFETY: handle and timeouts are valid for this synchronous call.
        (unsafe { SetCommTimeouts(handle, &raw const timeouts) } != 0).ok_or_else(|| {
            cold_path();
            io::Error::last_os_error()
        })?;

        let control_handle = file
            .try_clone()
            .inspect_err(|_| cold_path())?
            .into_raw_handle();
        // SAFETY: the duplicate is live and uniquely transferred to COMPort.
        // Its Read/Write implementations are never used; data I/O belongs to Tokio.
        let control = unsafe { COMPort::from_raw_handle(control_handle) };
        let io_handle = file.into_raw_handle();
        // SAFETY: this uniquely owned handle was opened with FILE_FLAG_OVERLAPPED.
        // Tokio takes ownership and closes it if registration fails as well.
        let io =
            unsafe { NamedPipeClient::from_raw_handle(io_handle) }.inspect_err(|_| cold_path())?;
        Ok(Self {
            io,
            control,
            read: ReadState::default(),
        })
    }

    pub fn try_read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        windows_read::try_read(
            bytes,
            |bytes| self.io.try_read(bytes),
            || check_status(&self.control),
        )
    }

    pub fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.io.try_write(bytes)
    }

    pub fn set_signals(&mut self, options: &crate::NativeSetOptions) -> io::Result<()> {
        if let Some(dtr) = options.dtr {
            self.control.write_data_terminal_ready(dtr)?;
        }
        if let Some(rts) = options.rts {
            self.control.write_request_to_send(rts)?;
        }
        match options.brk {
            Some(true) => self.control.set_break()?,
            Some(false) => self.control.clear_break()?,
            None => {}
        }
        Ok(())
    }

    pub fn modem_status(&mut self) -> io::Result<(bool, bool, bool)> {
        Ok((
            self.control.read_clear_to_send()?,
            self.control.read_data_set_ready()?,
            self.control.read_carrier_detect()?,
        ))
    }

    pub fn start_drain(&self) -> io::Result<tokio::task::JoinHandle<io::Result<()>>> {
        let file = File::from(self.io.as_handle().try_clone_to_owned()?);
        Ok(tokio::task::spawn_blocking(move || file.sync_all()))
    }

    pub fn control(&self) -> &COMPort {
        &self.control
    }

    pub fn control_mut(&mut self) -> &mut COMPort {
        &mut self.control
    }
}

impl AsyncRead for SerialStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.read
            .poll_read(&mut this.io, cx, buffer, || check_status(&this.control))
    }
}

pub(crate) fn output_pending(port: &SerialStream) -> io::Result<bool> {
    let mut status = COMSTAT::default();
    // SAFETY: control owns the COM handle and status is writable for the call.
    if unsafe {
        ClearCommError(
            port.control.as_raw_handle(),
            std::ptr::null_mut(),
            &raw mut status,
        )
    } != 0
    {
        return Ok(status.cbOutQue != 0);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_CALL_NOT_IMPLEMENTED | ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED) => {
            Ok(false)
        }
        _ => Err(error),
    }
}

fn check_status(port: &COMPort) -> io::Result<()> {
    // Mio also maps ERROR_BROKEN_PIPE to zero bytes. Do not hide a failed
    // device-status query when deciding whether an empty read can be retried.
    // SAFETY: port owns a live COM handle; both output pointers are optional.
    if unsafe {
        ClearCommError(
            port.as_raw_handle(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

impl AsyncWrite for SerialStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write(cx, bytes)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
    }
}
