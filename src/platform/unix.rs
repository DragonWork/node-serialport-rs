// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    hint::cold_path,
    io,
    os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd},
    pin::Pin,
    task::{Context, Poll, ready},
};

use nix::{
    fcntl::{FcntlArg, OFlag, fcntl},
    sys::termios,
    unistd,
};
use serialport::{SerialPortBuilder, TTYPort};
use tokio::io::{AsyncRead, AsyncWrite, Interest, ReadBuf, unix::AsyncFd};

pub(crate) struct SerialStream {
    io: AsyncFd<TTYPort>,
}

impl SerialStream {
    pub fn open(builder: &SerialPortBuilder) -> serialport::Result<Self> {
        let port = TTYPort::open(builder).inspect_err(|_| cold_path())?;
        // TTYPort opens in blocking mode. Keep its settings/ownership, but use
        // nonblocking descriptor I/O instead of its timeout-based Read/Write.
        let fd = super::descriptor(&port);
        let flags = fcntl(fd, FcntlArg::F_GETFL)
            .map_err(io::Error::from)
            .inspect_err(|_| cold_path())?;
        fcntl(
            fd,
            FcntlArg::F_SETFL(OFlag::from_bits_retain(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(io::Error::from)
        .inspect_err(|_| cold_path())?;
        Ok(Self {
            io: AsyncFd::new(port).inspect_err(|_| cold_path())?,
        })
    }

    pub fn try_read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.io.try_io(Interest::READABLE, |port| {
            unistd::read(super::descriptor(port), bytes).map_err(Into::into)
        })
    }

    pub fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // An immediate write need not wait for Tokio to observe writability.
        unistd::write(&self.io, bytes).map_err(Into::into)
    }

    // Physical output drain is invoked only on the bounded blocking pool.
    pub fn drain_output(&mut self) -> io::Result<()> {
        loop {
            match termios::tcdrain(&self.io) {
                Err(nix::errno::Errno::EINTR) => cold_path(),
                result => return result.map_err(Into::into),
            }
        }
    }

    pub fn control(&self) -> &TTYPort {
        self.io.get_ref()
    }

    pub fn control_mut(&mut self) -> &mut TTYPort {
        self.io.get_mut()
    }
}

impl AsyncRead for SerialStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut ready = ready!(self.io.poll_read_ready(cx))?;
            match ready.try_io(|io| {
                unistd::read(io, buffer.initialize_unfilled()).map_err(io::Error::from)
            }) {
                Ok(Ok(length)) => {
                    buffer.advance(length);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => {
                    cold_path();
                    return Poll::Ready(Err(error));
                }
                Err(_) => continue,
            }
        }
    }
}

impl AsyncWrite for SerialStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = ready!(self.io.poll_write_ready(cx))?;
            match ready.try_io(|io| unistd::write(io, bytes).map_err(io::Error::from)) {
                Ok(result) => return Poll::Ready(result.inspect_err(|_| cold_path())),
                Err(_) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Writes go straight to the kernel; there is no userspace output buffer.
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}

impl AsRawFd for SerialStream {
    fn as_raw_fd(&self) -> RawFd {
        self.io.as_raw_fd()
    }
}

impl AsFd for SerialStream {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.io.as_fd()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::SerialPort;
    use std::{future::poll_fn, io::Write, time::Duration};

    fn pair() -> (TTYPort, SerialStream) {
        let (master, mut slave) = TTYPort::pair().unwrap();
        slave.set_exclusive(false).unwrap();
        let path = slave.name().unwrap();
        let stream =
            crate::platform::open(&serialport::new(path, 115200).exclusive(false)).unwrap();
        (master, stream)
    }

    async fn read(port: &mut SerialStream, bytes: &mut [u8]) -> io::Result<usize> {
        tokio::time::timeout(
            Duration::from_secs(5),
            poll_fn(|cx| {
                let mut buffer = ReadBuf::new(bytes);
                Pin::new(&mut *port)
                    .poll_read(cx, &mut buffer)
                    .map_ok(|()| buffer.filled().len())
            }),
        )
        .await
        .expect("serial readiness did not wake the reader")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn drained_bursts_rearm_and_wake_on_new_input() {
        let (mut master, mut port) = pair();
        let mut bytes = [0; 8];
        assert_eq!(
            port.try_read(&mut bytes).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        for expected in [b"first".as_slice(), b"next", b"last"] {
            // Let the async read register its waker before the peer sends data.
            let writer = tokio::spawn(async move {
                tokio::task::yield_now().await;
                master.write_all(expected).unwrap();
                master
            });
            let mut received = 0;
            while received < expected.len() {
                let length = read(&mut port, &mut bytes[received..expected.len()])
                    .await
                    .unwrap();
                assert_ne!(length, 0, "peer disconnected during the transfer");
                received += length;
            }
            assert_eq!(&bytes[..received], expected);
            master = writer.await.unwrap();
            assert_eq!(
                port.try_read(&mut bytes).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn peer_disconnect_completes_the_pending_read() {
        let (master, mut port) = pair();
        let closer = tokio::spawn(async move {
            tokio::task::yield_now().await;
            drop(master);
        });
        let mut bytes = [0; 8];
        match read(&mut port, &mut bytes).await {
            Ok(length) => assert_eq!(length, 0),
            Err(error) => assert_ne!(error.kind(), io::ErrorKind::WouldBlock),
        }
        closer.await.unwrap();
    }
}
