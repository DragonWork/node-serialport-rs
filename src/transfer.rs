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
    Pin::new(port)
        .poll_read(cx, &mut buffer)
        .map(|result| result.map(|()| Transfer::Read(buffer.filled().len())))
}

fn poll_write<T: AsyncWrite + Unpin>(
    port: &mut T,
    cx: &mut Context<'_>,
    bytes: Option<&[u8]>,
) -> Poll<io::Result<Transfer>> {
    let Some(bytes) = bytes else {
        return Poll::Pending;
    };
    Pin::new(port)
        .poll_write(cx, bytes)
        .map(|result| result.map(Transfer::Write))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Waker;

    struct ReadyPort;
    impl AsyncRead for ReadyPort {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
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
        let mut port = ReadyPort;
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
        let mut port = ReadyPort;
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
}
