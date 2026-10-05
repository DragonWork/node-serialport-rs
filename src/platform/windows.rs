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
    Devices::Communication::{COMMTIMEOUTS, DCB, GetCommState, SetCommState, SetCommTimeouts},
    Storage::FileSystem::FILE_FLAG_OVERLAPPED,
};

pub(crate) struct SerialStream {
    // These own different handles to the same device. Tokio exclusively owns
    // the overlapped-I/O handle; COMPort owns a duplicate used only for control.
    io: NamedPipeClient,
    control: COMPort,
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
        // Match the async serial contract: wait for the first byte indefinitely,
        // then finish after an inter-byte gap; never synthesize timeout EOFs.
        let timeouts = COMMTIMEOUTS {
            ReadIntervalTimeout: 1,
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
        Ok(Self { io, control })
    }

    pub fn try_read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.io.try_read(bytes)
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
        Pin::new(&mut self.get_mut().io).poll_read(cx, buffer)
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
