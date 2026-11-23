// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    os::fd::{AsFd, AsRawFd, BorrowedFd},
    pin::Pin,
    task::{Context, Poll, ready},
};

use nix::{
    fcntl::{FcntlArg, OFlag, fcntl},
    libc,
    sys::termios,
    unistd,
};
use serialport::{SerialPortBuilder, TTYPort};
use tokio::io::{AsyncRead, AsyncWrite, Interest, ReadBuf, unix::AsyncFd};

pub(crate) struct SerialStream {
    io: AsyncFd<TTYPort>,
    pub(super) zero_minimum: bool,
}

pub(super) fn syscall_result(result: libc::c_int) -> io::Result<()> {
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn unsupported_ioctl(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
        || matches!(
            error.raw_os_error(),
            Some(libc::ENOTTY | libc::ENOSYS | libc::EOPNOTSUPP)
        )
}

pub(crate) fn output_pending(port: &impl AsFd) -> io::Result<bool> {
    #[cfg(any(target_os = "netbsd", target_os = "openbsd"))]
    let request = nix::request_code_read!(b't', 115, size_of::<libc::c_int>());
    #[cfg(not(any(target_os = "netbsd", target_os = "openbsd")))]
    let request = libc::TIOCOUTQ;
    let mut bytes: libc::c_int = 0;
    // SAFETY: TIOCOUTQ writes one c_int and the port owns the descriptor.
    match syscall_result(unsafe {
        libc::ioctl(port.as_fd().as_raw_fd(), request as _, &raw mut bytes)
    }) {
        Ok(()) => Ok(bytes != 0),
        Err(error) if unsupported_ioctl(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

impl SerialStream {
    pub fn open(builder: &SerialPortBuilder) -> serialport::Result<Self> {
        // macOS PTYs can return ENOTTY before the caller retries with a POSIX speed.
        // Only the caller can classify the final open failure as cold.
        let port = TTYPort::open(builder)?;
        // TTYPort opens in blocking mode. Keep its settings/ownership, but use
        // nonblocking descriptor I/O instead of its timeout-based Read/Write.
        // SAFETY: port owns the descriptor throughout both fcntl calls.
        let fd = unsafe { BorrowedFd::borrow_raw(port.as_raw_fd()) };
        let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(io::Error::from)?;
        fcntl(
            fd,
            FcntlArg::F_SETFL(OFlag::from_bits_retain(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(io::Error::from)?;
        Ok(Self {
            // SAFETY: TTYPort owns a valid descriptor that remains open and unchanged
            // while registered. Control operations never replace or close the port.
            io: unsafe { AsyncFd::register(port) }.map_err(io::Error::from)?,
            zero_minimum: false,
        })
    }

    pub fn try_read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.io
            .try_io(Interest::READABLE, |_| self.read_available(bytes))
    }

    fn read_available(&self, bytes: &mut [u8]) -> io::Result<usize> {
        let length = unistd::read(&self.io, &mut *bytes)?;
        if length == 0 && self.zero_minimum && !bytes.is_empty() {
            // VMIN=0 permits an empty read on a live terminal. Preserve real hangups.
            let mut pollfd = libc::pollfd {
                fd: self.io.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: pollfd is writable for one descriptor and the timeout is zero.
            syscall_result(unsafe { libc::poll(&raw mut pollfd, 1, 0) })?;
            if pollfd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0 {
                return Err(io::ErrorKind::WouldBlock.into());
            }
        }
        Ok(length)
    }

    pub fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // An immediate write need not wait for Tokio to observe writability.
        unistd::write(&self.io, bytes).map_err(Into::into)
    }

    fn set_line(&self, line: libc::c_int, enabled: bool) -> io::Result<()> {
        let request = if enabled {
            libc::TIOCMBIS
        } else {
            libc::TIOCMBIC
        };
        // SAFETY: the port owns the descriptor and both requests read one c_int.
        syscall_result(unsafe { libc::ioctl(self.io.as_raw_fd(), request as _, &raw const line) })
    }

    pub fn set_dtr(&self, enabled: bool) -> io::Result<()> {
        self.set_line(libc::TIOCM_DTR, enabled)
    }

    pub fn set_signals(&self, options: &crate::NativeSetOptions) -> io::Result<()> {
        if let Some(dtr) = options.dtr {
            self.set_dtr(dtr)?;
        }
        if let Some(rts) = options.rts {
            self.set_line(libc::TIOCM_RTS, rts)?;
        }
        let Some(brk) = options.brk else {
            return Ok(());
        };
        let request = if brk { libc::TIOCSBRK } else { libc::TIOCCBRK };
        // SAFETY: the port owns fd and neither break request takes a payload.
        syscall_result(unsafe {
            libc::ioctl(
                self.io.as_raw_fd(),
                request as _,
                std::ptr::null_mut::<libc::c_void>(),
            )
        })
    }

    pub fn modem_status(&self) -> io::Result<(bool, bool, bool)> {
        let mut lines: libc::c_int = 0;
        // SAFETY: the port owns the descriptor and TIOCMGET writes one c_int.
        syscall_result(unsafe {
            libc::ioctl(self.io.as_raw_fd(), libc::TIOCMGET as _, &raw mut lines)
        })?;
        Ok((
            lines & libc::TIOCM_CTS != 0,
            lines & libc::TIOCM_DSR != 0,
            lines & libc::TIOCM_CAR != 0,
        ))
    }

    pub fn start_drain(&self) -> io::Result<tokio::task::JoinHandle<io::Result<()>>> {
        let fd = self.as_fd().try_clone_to_owned()?;
        Ok(tokio::task::spawn_blocking(move || {
            loop {
                match termios::tcdrain(&fd) {
                    Err(nix::errno::Errno::EINTR) => continue,
                    result => return result.map_err(Into::into),
                }
            }
        }))
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
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            let mut ready = ready!(self.io.poll_read_ready(cx))?;
            match ready.try_io(|_| self.read_available(buffer.initialize_unfilled())) {
                Ok(Ok(length)) => {
                    buffer.advance(length);
                    return Poll::Ready(Ok(()));
                }
                // The transfer poller distinguishes retries from permanent errors.
                Ok(Err(error)) => return Poll::Ready(Err(error)),
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
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        loop {
            let mut ready = ready!(self.io.poll_write_ready(cx))?;
            match ready.try_io(|io| unistd::write(io, bytes).map_err(io::Error::from)) {
                Ok(result) => return Poll::Ready(result),
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

impl AsFd for SerialStream {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.io.as_fd()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serialport::SerialPort;
    use std::{
        future::poll_fn,
        io::{Read, Write},
        time::Duration,
    };

    fn pair() -> (TTYPort, SerialStream) {
        let (master, mut slave) = TTYPort::pair().unwrap();
        slave.set_exclusive(false).unwrap();
        let path = slave.name().unwrap();
        let stream =
            crate::platform::open(&serialport::new(path, 115200).exclusive(false)).unwrap();
        (master, stream)
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "current_thread")]
    async fn unsupported_output_queue_probes_fall_back_but_hangups_fail() {
        assert!(!output_pending(&std::fs::File::open("/dev/null").unwrap()).unwrap());
        let (master, port) = pair();
        assert!(!output_pending(&port).unwrap());
        drop(master);
        assert_eq!(
            output_pending(&port).unwrap_err().raw_os_error(),
            Some(libc::EIO)
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "current_thread")]
    async fn a_live_zero_minimum_read_rearms_and_a_hangup_finishes() {
        let (master, mut port) = pair();
        let mut settings = termios::tcgetattr(&port).unwrap();
        settings.control_chars[termios::SpecialCharacterIndices::VMIN as usize] = 0;
        termios::tcsetattr(&port, termios::SetArg::TCSANOW, &settings).unwrap();
        port.zero_minimum = true;
        let mut byte = [0];
        assert_eq!(
            port.read_available(&mut byte).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(master);
        assert_eq!(port.read_available(&mut byte).unwrap(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn empty_transfers_complete_without_waiting_for_readiness() {
        let (_master, mut port) = pair();
        let mut cx = Context::from_waker(std::task::Waker::noop());
        let mut buffer = ReadBuf::new(&mut []);
        assert!(matches!(
            Pin::new(&mut port).poll_read(&mut cx, &mut buffer),
            Poll::Ready(Ok(()))
        ));
        assert!(matches!(
            Pin::new(&mut port).poll_write(&mut cx, &[]),
            Poll::Ready(Ok(0))
        ));
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

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_read_does_not_retain_the_old_buffer() {
        let (mut master, mut port) = pair();
        let mut cancelled = [0xa5; 8];
        let pending = poll_fn(|cx| {
            let mut buffer = ReadBuf::new(&mut cancelled);
            Poll::Ready(Pin::new(&mut port).poll_read(cx, &mut buffer))
        })
        .await;
        assert!(pending.is_pending());

        let expected = b"new read";
        master.write_all(expected).unwrap();
        let mut received = [0; 8];
        let mut offset = 0;
        while offset < received.len() {
            let length = read(&mut port, &mut received[offset..]).await.unwrap();
            assert_ne!(length, 0);
            offset += length;
        }
        assert_eq!(&received, expected);
        assert_eq!(cancelled, [0xa5; 8]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_writer_wakes_and_preserves_partial_writes() {
        let (mut master, mut port) = pair();
        master.set_timeout(Duration::from_secs(5)).unwrap();
        let expected = Vec::from_fn(4 * crate::CHUNK_SIZE, |i| (i * 37 + 11) as u8);
        let mut offset = 0;
        loop {
            match port.try_write(&expected[offset..]) {
                Ok(length) => {
                    assert_ne!(length, 0);
                    offset += length;
                    assert!(offset < expected.len(), "PTY did not apply backpressure");
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => panic!("Failed to fill PTY: {error}"),
            }
        }

        // Keep the peer idle until the async writer actually parks on readiness.
        let (resume, waiting) = tokio::sync::oneshot::channel();
        let length = expected.len();
        let peer = tokio::spawn(async move {
            waiting.await.unwrap();
            tokio::task::spawn_blocking(move || {
                let mut received = vec![0; length];
                master.read_exact(&mut received).unwrap();
                (master, received)
            })
            .await
            .unwrap()
        });
        let mut resume = Some(resume);
        tokio::time::timeout(Duration::from_secs(8), async {
            while offset < expected.len() {
                let length = poll_fn(|cx| {
                    let result = Pin::new(&mut port).poll_write(cx, &expected[offset..]);
                    if result.is_pending()
                        && let Some(resume) = resume.take()
                    {
                        resume.send(()).unwrap();
                    }
                    result
                })
                .await
                .unwrap();
                assert_ne!(length, 0);
                offset += length;
            }
            let (_master, received) = peer.await.unwrap();
            assert_eq!(received, expected);
        })
        .await
        .expect("serial writability did not wake the blocked writer");
    }
}
