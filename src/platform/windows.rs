// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::OpenOptions,
    hint::cold_path,
    io,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle, RawHandle},
    },
    pin::Pin,
    task::{Context, Poll},
};

use serialport::{COMPort, SerialPort, SerialPortBuilder};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::windows::named_pipe::NamedPipeClient,
};
use windows_sys::Win32::{
    Devices::Communication::{
        COMMTIMEOUTS, ClearCommError, DCB, GetCommState, SetCommState, SetCommTimeouts,
    },
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
    pub fn open(builder: &SerialPortBuilder) -> serialport::Result<Self> {
        let port = COMPort::open(builder).inspect_err(|_| cold_path())?;
        let name = port.name().ok_or_else(|| {
            cold_path();
            serialport::Error::new(serialport::ErrorKind::NoDevice, "Empty device name")
        })?;
        let mut settings = DCB {
            DCBlength: size_of::<DCB>() as u32,
            ..Default::default()
        };
        // SAFETY: port owns a live COM handle; settings is writable for this call.
        (unsafe { GetCommState(port.as_raw_handle(), &raw mut settings) } != 0).ok_or_else(
            || {
                cold_path();
                io::Error::last_os_error()
            },
        )?;
        drop(port);

        let path = if name.starts_with('\\') {
            name
        } else {
            format!(r"\\.\{name}")
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OVERLAPPED)
            .open(path)
            .inspect_err(|_| cold_path())?;
        let handle = file.as_raw_handle();
        // SAFETY: file owns the COM handle and the fully initialized DCB remains live.
        (unsafe { SetCommState(handle, &raw const settings) } != 0).ok_or_else(|| {
            cold_path();
            io::Error::last_os_error()
        })?;
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

    pub fn drain_output(&mut self) -> io::Result<()> {
        io::Write::flush(&mut self.control)
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

impl AsRawHandle for SerialStream {
    fn as_raw_handle(&self) -> RawHandle {
        self.io.as_raw_handle()
    }
}
