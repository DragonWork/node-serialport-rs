// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Transfer {
    Read(usize),
    Write(usize),
}

#[derive(Default)]
pub(crate) struct TransferPoller {
    write_first: bool,
}

impl TransferPoller {
    pub fn poll<T: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        port: &mut T,
        cx: &mut Context<'_>,
        read: Option<&mut [u8]>,
        write: Option<&[u8]>,
    ) -> Poll<io::Result<Transfer>> {
        let ready = if self.write_first {
            match poll_write(port, cx, write) {
                Poll::Pending => poll_read(port, cx, read),
                ready => ready,
            }
        } else {
            match poll_read(port, cx, read) {
                Poll::Pending => poll_write(port, cx, write),
                ready => ready,
            }
        };
        if let Poll::Ready(Ok(transfer)) = &ready {
            self.write_first = matches!(transfer, Transfer::Read(_));
        }
        ready
    }
}

fn poll_read<T: AsyncRead + Unpin>(
    port: &mut T,
    cx: &mut Context<'_>,
    bytes: Option<&mut [u8]>,
) -> Poll<io::Result<Transfer>> {
    let Some(bytes) = bytes else {
        return Poll::Pending;
    };
    let mut buffer = ReadBuf::new(bytes);
    let result = Pin::new(port)
        .poll_read(cx, &mut buffer)
        .map(|result| result.map(|()| Transfer::Read(buffer.filled().len())));
    retry_interrupted(result, cx)
}

fn poll_write<T: AsyncWrite + Unpin>(
    port: &mut T,
    cx: &mut Context<'_>,
    bytes: Option<&[u8]>,
) -> Poll<io::Result<Transfer>> {
    let Some(bytes) = bytes else {
        return Poll::Pending;
    };
    let result = Pin::new(port)
        .poll_write(cx, bytes)
        .map(|result| result.map(Transfer::Write));
    retry_interrupted(result, cx)
}

fn retry_interrupted(
    result: Poll<io::Result<Transfer>>,
    cx: &Context<'_>,
) -> Poll<io::Result<Transfer>> {
    match result {
        Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {
            // Retry on the next poll so the other direction and ports can progress.
            cx.waker().wake_by_ref();
            Poll::Pending
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Wake, Waker},
    };

    #[derive(Default)]
    struct ReadyPort {
        read_error: Option<io::ErrorKind>,
        write_error: Option<io::ErrorKind>,
    }
    impl AsyncRead for ReadyPort {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(error) = self.read_error {
                return Poll::Ready(Err(error.into()));
            }
            buffer.put_slice(&[42]);
            Poll::Ready(Ok(()))
        }
    }
    impl AsyncWrite for ReadyPort {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if let Some(error) = self.write_error {
                return Poll::Ready(Err(error.into()));
            }
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn continuously_ready_reads_cannot_starve_writes() {
        let mut poller = TransferPoller::default();
        let mut port = ReadyPort::default();
        let mut cx = Context::from_waker(Waker::noop());
        for expected in [
            Transfer::Read(1),
            Transfer::Write(1),
            Transfer::Read(1),
            Transfer::Write(1),
        ] {
            let mut buffer = [0];
            let Poll::Ready(Ok(actual)) =
                poller.poll(&mut port, &mut cx, Some(&mut buffer), Some(&[7]))
            else {
                panic!("No I/O progress");
            };
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn absent_direction_does_not_delay_the_other() {
        let mut poller = TransferPoller::default();
        let mut port = ReadyPort::default();
        let mut cx = Context::from_waker(Waker::noop());
        let mut buffer = [0];
        assert!(matches!(
            poller.poll(&mut port, &mut cx, Some(&mut buffer), None),
            Poll::Ready(Ok(Transfer::Read(1)))
        ));
        assert!(matches!(
            poller.poll(&mut port, &mut cx, Some(&mut buffer), None),
            Poll::Ready(Ok(Transfer::Read(1)))
        ));
        assert!(matches!(
            poller.poll(&mut port, &mut cx, None, Some(&[7])),
            Poll::Ready(Ok(Transfer::Write(1)))
        ));
    }

    #[derive(Default)]
    struct WakeCounter(AtomicUsize);

    impl Wake for WakeCounter {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn interrupted_transfers_yield_and_wake_before_retrying() {
        for write in [false, true] {
            let wake = Arc::new(WakeCounter::default());
            let waker = Waker::from(Arc::clone(&wake));
            let mut cx = Context::from_waker(&waker);
            let mut poller = TransferPoller::default();
            let mut port = ReadyPort {
                read_error: Some(io::ErrorKind::Interrupted),
                write_error: Some(io::ErrorKind::Interrupted),
            };
            let mut buffer = [0];
            let result = poller.poll(
                &mut port,
                &mut cx,
                (!write).then_some(buffer.as_mut_slice()),
                write.then_some(&[7]),
            );
            assert!(result.is_pending());
            assert_eq!(wake.0.load(Ordering::Relaxed), 1);
            port.read_error = None;
            port.write_error = None;
            let result = poller.poll(
                &mut port,
                &mut cx,
                (!write).then_some(buffer.as_mut_slice()),
                write.then_some(&[7]),
            );
            let Poll::Ready(Ok(transfer)) = result else {
                panic!("No I/O progress after interruption");
            };
            assert_eq!(
                transfer,
                if write {
                    Transfer::Write(1)
                } else {
                    Transfer::Read(1)
                }
            );
            if !write {
                assert_eq!(buffer, [42]);
            }
        }
    }

    #[test]
    fn interruptions_do_not_starve_the_other_direction() {
        let mut port = ReadyPort {
            read_error: Some(io::ErrorKind::Interrupted),
            ..ReadyPort::default()
        };
        let mut poller = TransferPoller::default();
        let mut cx = Context::from_waker(Waker::noop());
        let mut buffer = [0];
        assert!(matches!(
            poller.poll(&mut port, &mut cx, Some(&mut buffer), Some(&[7])),
            Poll::Ready(Ok(Transfer::Write(1)))
        ));
        port.read_error = None;
        port.write_error = Some(io::ErrorKind::Interrupted);
        poller.write_first = true;
        assert!(matches!(
            poller.poll(&mut port, &mut cx, Some(&mut buffer), Some(&[7])),
            Poll::Ready(Ok(Transfer::Read(1)))
        ));
    }

    #[test]
    fn permanent_errors_are_reported_without_retrying() {
        for kind in [io::ErrorKind::BrokenPipe, io::ErrorKind::PermissionDenied] {
            for write_first in [false, true] {
                let mut port = ReadyPort {
                    read_error: Some(kind),
                    write_error: Some(kind),
                };
                let mut poller = TransferPoller { write_first };
                let mut cx = Context::from_waker(Waker::noop());
                let mut buffer = [0];
                let Poll::Ready(Err(error)) =
                    poller.poll(&mut port, &mut cx, Some(&mut buffer), Some(&[7]))
                else {
                    panic!("Permanent I/O error was suppressed");
                };
                assert_eq!(error.kind(), kind);
            }
        }
    }
}
