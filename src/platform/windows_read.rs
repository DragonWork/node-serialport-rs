// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    hint::cold_path,
    io,
    pin::Pin,
    task::{Context, Poll, ready},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, ReadBuf},
    time::{Sleep, sleep},
};

#[derive(Default)]
pub(super) struct ReadState {
    backoff: Option<Pin<Box<Sleep>>>,
}

impl ReadState {
    pub fn poll_read<T: AsyncRead + Unpin>(
        &mut self,
        io: &mut T,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
        mut check: impl FnMut() -> io::Result<()>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if let Some(backoff) = &mut self.backoff {
            ready!(backoff.as_mut().poll(cx));
            self.backoff = None;
        }
        for _ in 0..2 {
            let filled = buffer.filled().len();
            ready!(Pin::new(&mut *io).poll_read(cx, buffer))?;
            if buffer.filled().len() != filled {
                return Poll::Ready(Ok(()));
            }
            cold_path();
            check()?;
            // Mio has rearmed the read. Poll it to register a waker or return
            // already-arrived data without adding a timer to a normal timeout.
        }
        // A driver repeatedly completing empty reads must neither spin nor
        // synthesize EOF. Only this abnormal path needs a short backoff.
        let mut backoff = Box::pin(sleep(Duration::from_millis(1)));
        if backoff.as_mut().poll(cx).is_ready() {
            cx.waker().wake_by_ref();
        }
        self.backoff = Some(backoff);
        Poll::Pending
    }
}

pub(super) fn try_read(
    bytes: &mut [u8],
    read: impl FnOnce(&mut [u8]) -> io::Result<usize>,
    check: impl FnOnce() -> io::Result<()>,
) -> io::Result<usize> {
    if bytes.is_empty() {
        return Ok(0);
    }
    match read(bytes) {
        Ok(0) => {
            cold_path();
            check()?;
            Err(io::ErrorKind::WouldBlock.into())
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        assert_matches, collections::VecDeque, future::poll_fn, task::Waker, time::Duration,
    };

    enum Completion {
        Empty,
        Pending,
        Data(&'static [u8]),
        Error(i32),
    }

    #[derive(Default)]
    struct Reader {
        completions: VecDeque<Completion>,
        waker: Option<Waker>,
        polls: usize,
        always_empty: bool,
    }

    impl Reader {
        fn new(completions: impl IntoIterator<Item = Completion>) -> Self {
            Self {
                completions: completions.into_iter().collect(),
                ..Self::default()
            }
        }
    }

    impl AsyncRead for Reader {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            this.polls += 1;
            match this.completions.pop_front() {
                Some(Completion::Empty) => Poll::Ready(Ok(())),
                Some(Completion::Data(data)) => {
                    buffer.put_slice(data);
                    Poll::Ready(Ok(()))
                }
                Some(Completion::Error(code)) => {
                    Poll::Ready(Err(io::Error::from_raw_os_error(code)))
                }
                None if this.always_empty => Poll::Ready(Ok(())),
                Some(Completion::Pending) | None => {
                    this.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }
    }

    #[test]
    fn timeout_rearms_the_reader_and_preserves_the_buffer() {
        let mut state = ReadState::default();
        let mut reader = Reader::new([Completion::Empty, Completion::Pending]);
        let mut bytes = [0; 8];
        let mut buffer = ReadBuf::new(&mut bytes);
        buffer.put_slice(b"old");
        let mut cx = Context::from_waker(Waker::noop());
        assert!(
            state
                .poll_read(&mut reader, &mut cx, &mut buffer, || Ok(()))
                .is_pending()
        );
        assert_eq!(buffer.filled(), b"old");
        assert!(
            reader.waker.is_some(),
            "The next completion must be able to wake the reader"
        );

        reader.completions.push_back(Completion::Data(b"new"));
        reader.waker.take().unwrap().wake();
        assert_matches!(
            state.poll_read(&mut reader, &mut cx, &mut buffer, || panic!(
                "Data must not query device status"
            )),
            Poll::Ready(Ok(()))
        );
        assert_eq!(buffer.filled(), b"oldnew");
    }

    #[test]
    fn data_after_a_timeout_is_delivered_in_the_same_poll() {
        let mut state = ReadState::default();
        let mut reader = Reader::new([Completion::Empty, Completion::Data(b"reply")]);
        let mut bytes = [0; 16];
        let mut buffer = ReadBuf::new(&mut bytes);
        let mut cx = Context::from_waker(Waker::noop());
        assert_matches!(
            state.poll_read(&mut reader, &mut cx, &mut buffer, || Ok(())),
            Poll::Ready(Ok(()))
        );
        assert_eq!(buffer.filled(), b"reply");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repeated_empty_completions_never_become_eof() {
        let mut state = ReadState::default();
        let mut reader = Reader::new(
            (0..12)
                .map(|_| Completion::Empty)
                .chain([Completion::Data(b"reply")]),
        );
        let mut bytes = [0; 16];
        let mut buffer = ReadBuf::new(&mut bytes);
        tokio::time::timeout(
            Duration::from_secs(1),
            poll_fn(|cx| state.poll_read(&mut reader, cx, &mut buffer, || Ok(()))),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(buffer.filled(), b"reply");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_driver_returning_only_empty_reads_cannot_spin() {
        let mut state = ReadState::default();
        let mut reader = Reader {
            always_empty: true,
            ..Reader::default()
        };
        let mut bytes = [0; 8];
        let mut buffer = ReadBuf::new(&mut bytes);
        let result = tokio::time::timeout(
            Duration::from_millis(20),
            poll_fn(|cx| state.poll_read(&mut reader, cx, &mut buffer, || Ok(()))),
        )
        .await;
        assert!(result.is_err(), "An idle serial port must remain pending");
        assert!(
            reader.polls < 100,
            "Empty reads spun {} times",
            reader.polls
        );
        reader.always_empty = false;
        reader.completions.push_back(Completion::Data(b"resume"));
        tokio::time::timeout(
            Duration::from_secs(1),
            poll_fn(|cx| state.poll_read(&mut reader, cx, &mut buffer, || Ok(()))),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(buffer.filled(), b"resume");
    }

    #[test]
    fn empty_destinations_do_not_consume_a_completion() {
        let mut state = ReadState::default();
        let mut reader = Reader::new([Completion::Data(b"x")]);
        let mut buffer = ReadBuf::new(&mut []);
        let mut cx = Context::from_waker(Waker::noop());
        assert_matches!(
            state.poll_read(&mut reader, &mut cx, &mut buffer, || panic!(
                "No I/O for an empty destination"
            )),
            Poll::Ready(Ok(()))
        );
        assert_eq!(reader.polls, 0);
    }

    #[test]
    fn read_errors_and_failed_device_checks_propagate() {
        for completions in [
            vec![Completion::Error(1167)],
            vec![Completion::Empty, Completion::Error(1167)],
        ] {
            let mut state = ReadState::default();
            let mut reader = Reader::new(completions);
            let mut bytes = [0; 8];
            let mut buffer = ReadBuf::new(&mut bytes);
            let mut cx = Context::from_waker(Waker::noop());
            let Poll::Ready(Err(error)) =
                state.poll_read(&mut reader, &mut cx, &mut buffer, || Ok(()))
            else {
                panic!("Read error was swallowed");
            };
            assert_eq!(error.raw_os_error(), Some(1167));
        }

        let mut state = ReadState::default();
        let mut reader = Reader::new([Completion::Empty]);
        let mut bytes = [0; 8];
        let mut buffer = ReadBuf::new(&mut bytes);
        let mut cx = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(error)) = state.poll_read(&mut reader, &mut cx, &mut buffer, || {
            Err(io::Error::from_raw_os_error(1167))
        }) else {
            panic!("Device removal was swallowed");
        };
        assert_eq!(error.raw_os_error(), Some(1167));
    }

    #[test]
    fn nonblocking_reads_distinguish_timeouts_data_and_errors() {
        let mut bytes = [0; 8];
        assert_eq!(
            try_read(&mut bytes, |_| Ok(0), || Ok(()))
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            try_read(
                &mut [],
                |_| panic!("Empty destination must not read"),
                || panic!("Empty destination must not query device status")
            )
            .unwrap(),
            0
        );
        assert_eq!(
            try_read(
                &mut bytes,
                |bytes| {
                    bytes.copy_from_slice(b"response");
                    Ok(8)
                },
                || panic!("Data must not query device status")
            )
            .unwrap(),
            8
        );
        assert_eq!(&bytes, b"response");
        let error = try_read(
            &mut bytes,
            |_| Err(io::Error::from_raw_os_error(1167)),
            || panic!("Read failed"),
        )
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(1167));
        let error = try_read(
            &mut bytes,
            |_| Ok(0),
            || Err(io::Error::from_raw_os_error(1167)),
        )
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(1167));
    }
}
