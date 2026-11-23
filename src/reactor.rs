// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::poll_fn,
    hint::cold_path,
    io,
    pin::Pin,
    sync::{Arc, atomic::Ordering},
    task::{Context, Poll, Waker},
    time::Duration,
};

use napi::{Status, threadsafe_function::ThreadsafeFunctionCallMode};
use serialport::{ClearBuffer, SerialPort};
use tokio::sync::mpsc;

use crate::{
    Callback, CallbackEvent, Command, Control, NativeEvent, NativeOptions, Operation,
    platform::SerialStream,
    settings,
    transfer::{Transfer, TransferPoller},
};

// Bound immediately-ready follow-up work before servicing the command queue again.
const READ_BURST_LIMIT: usize = 16;

struct ReadWindow {
    bytes: usize,
    slots: usize,
    size: usize,
}

enum PendingDrain {
    Queue(Pin<Box<tokio::time::Sleep>>),
    Driver(u32, tokio::task::JoinHandle<io::Result<()>>),
}

impl PendingDrain {
    async fn wait(&mut self) -> Option<NativeEvent> {
        match self {
            Self::Queue(timer) => {
                timer.await;
                None
            }
            Self::Driver(id, task) => Some(
                match task
                    .await
                    .unwrap_or_else(|error| Err(io::Error::other(error)))
                {
                    Ok(()) => NativeEvent::new(*id, "ok"),
                    Err(error) => NativeEvent::error(*id, error),
                },
            ),
        }
    }
}

fn send(callback: &Callback, event: NativeEvent) -> bool {
    // At most 64 requests and 32 read-ahead events share the 128-entry queue.
    // Callback closure during environment teardown is an ordinary lifecycle path.
    callback.call(
        Ok(CallbackEvent::Event(event)),
        ThreadsafeFunctionCallMode::NonBlocking,
    ) == Status::Ok
}

struct Completion {
    control: Arc<Control>,
    callback: Callback,
    result: Option<io::Result<()>>,
}

impl Drop for Completion {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Release);
        // Release the descriptor even if the worker unwinds before normal completion.
        let session = std::mem::take(&mut *self.control.session.lock().unwrap_or_else(|error| {
            cold_path();
            error.into_inner()
        }));
        // Closing a descriptor may enter the driver; do it after releasing the mutex.
        drop(session.port);
        let (id, result) = match session.failed_write {
            Some((id, error)) => (id, Some(Err(error))),
            None => (0, self.result.take()),
        };
        let closed = NativeEvent::new(id, "close");
        let closed = match result {
            Some(Ok(())) => closed,
            Some(Err(error)) => closed.with_error(error),
            None => {
                cold_path();
                closed.with_error(io::Error::other("Serial worker stopped unexpectedly"))
            }
        };
        send(&self.callback, closed);
    }
}

pub(crate) async fn run(
    options: NativeOptions,
    receiver: mpsc::Receiver<Command>,
    control: Arc<Control>,
    callback: Callback,
) {
    let mut completion = Completion {
        control,
        callback,
        result: None,
    };
    let control = &completion.control;
    let callback = &completion.callback;
    let opened = tokio::task::spawn_blocking(move || settings::open(&options)).await;
    let result = match opened {
        Ok(Ok(port)) => {
            control
                .session
                .lock()
                .unwrap_or_else(|error| {
                    cold_path();
                    error.into_inner()
                })
                .port = Some(port);
            if control.stop.load(Ordering::Acquire) || !send(callback, NativeEvent::new(0, "open"))
            {
                Ok(())
            } else {
                let mut drain = None;
                let result = run_open(receiver, control, callback, &mut drain).await;
                if let Some(PendingDrain::Driver(_, task)) = drain {
                    // Cancel queued work. A running drain must release its handle before close.
                    task.abort();
                    let _ = task.await;
                }
                result
            }
        }
        Ok(Err(error)) => {
            cold_path();
            Err(error)
        }
        Err(error) => {
            cold_path();
            Err(io::Error::other(error))
        }
    };
    completion.result = Some(result);
}

async fn run_open(
    mut receiver: mpsc::Receiver<Command>,
    control: &Arc<Control>,
    callback: &Callback,
    drain: &mut Option<PendingDrain>,
) -> io::Result<()> {
    let mut commands = VecDeque::<Command>::new();
    let mut read = None::<(u32, usize)>;
    let mut streaming = false;
    let mut window = ReadWindow {
        bytes: 0,
        slots: 0,
        size: 1024,
    };
    let mut written = 0;
    let mut read_buffer = Vec::new();
    let mut transfers = TransferPoller::default();
    loop {
        if control.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        while let Some(command) = commands.front() {
            if control.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let event = match &command.operation {
                Operation::Write(data) => {
                    if written < data.len() {
                        break;
                    }
                    written = 0;
                    NativeEvent::new(command.id, "ok")
                }
                Operation::Drain => {
                    if drain.is_some() {
                        break;
                    }
                    if with_port(control, |port| crate::platform::output_pending(port))? {
                        *drain = Some(PendingDrain::Queue(Box::pin(tokio::time::sleep(
                            Duration::from_millis(1),
                        ))));
                        break;
                    }
                    match with_port(control, |port| port.start_drain()) {
                        Ok(task) => {
                            *drain = Some(PendingDrain::Driver(command.id, task));
                            break;
                        }
                        Err(error) => NativeEvent::error(command.id, error),
                    }
                }
                _ => with_port(control, |port| operation(port, command))
                    .unwrap_or_else(|error| NativeEvent::error(command.id, error)),
            };
            if !finish_command(&mut commands, control, callback, event) {
                return Ok(());
            }
        }

        let write = commands
            .front()
            .and_then(|command| match &command.operation {
                Operation::Write(data) => Some(&data[written..]),
                _ => None,
            });
        let read_capacity = read.map(|(_, length)| length).or_else(|| {
            (window.bytes > 0 && window.slots > 0).then_some(window.bytes.min(window.size))
        });
        if let Some(length) = read_capacity
            && read_buffer.len() < length
        {
            read_buffer.resize(length, 0);
        }
        tokio::select! {
            biased;
            _ = control.changed.notified() => {},
            event = async { drain.as_mut().unwrap().wait().await }, if drain.is_some() => {
                *drain = None;
                if let Some(event) = event
                    && !finish_command(&mut commands, control, callback, event) {
                    return Ok(());
                }
            },
            // Admission bounds ordered commands; never gate read-credit delivery
            // behind a blocked write and a full command backlog.
            command = receiver.recv() => {
                match command {
                    Some(Command {id, operation: Operation::Read(length)}) => {
                        if read.is_some() || streaming {
                            if !send(callback, NativeEvent::error(id, io::Error::new(io::ErrorKind::ResourceBusy, "Read already pending"))) {
                                return Ok(());
                            }
                        } else {
                            read = Some((id, length));
                        }
                    }
                    Some(Command {operation: Operation::ReadCredit {bytes, slots}, ..}) => {
                        window.bytes += bytes;
                        window.slots += slots;
                        if read.is_some() || window.bytes > crate::CHUNK_SIZE || window.slots > crate::READ_SLOTS {
                            cold_path();
                            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid read credit"));
                        }
                        streaming = true;
                    }
                    Some(command) => { commands.push_back(command); },
                    None => return Ok(()),
                }
            },
            ready = poll_fn(|cx| with_port(control, |port| {
                Ok(transfers.poll(port, cx, read_capacity.map(|length| &mut read_buffer[..length]), write))
            }).unwrap_or_else(|error| Poll::Ready(Err(error)))), if read_capacity.is_some() || write.is_some() => {
                let (is_read, length) = match ready? {
                    Transfer::Read(length) => (true, length),
                    Transfer::Write(length) => (false, length),
                };
                if length == 0 {
                    cold_path();
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "Serial device disconnected"));
                }
                if is_read {
                    let sent = if streaming {
                        let filled = Some(length) == read_capacity;
                        window.size = if filled { (window.size * 2).min(crate::CHUNK_SIZE) }
                            else { length.next_power_of_two().clamp(64, crate::CHUNK_SIZE) };
                        window.bytes -= length;
                        window.slots -= 1;
                        // Small partial reads normally drained the available input. Keep
                        // their existing path, and give queued writes/controls priority.
                        if write.is_some() || (!filled && length < 1024)
                            || control.pending_ops.load(Ordering::Acquire) != 0 {
                            send_read(callback, &mut read_buffer, length)
                        } else {
                            send_ready_reads(control, callback, &mut read_buffer, length, &mut window)?
                        }
                    } else {
                        let (id, _) = read.take().ok_or_else(|| {
                            cold_path();
                            io::Error::other("Unexpected read completion")
                        })?;
                        let mut event = NativeEvent::new(id, "read");
                        event.data = Some(crate::read_payload(&mut read_buffer, length).into());
                        send(callback, event)
                    };
                    if !sent { return Ok(()); }
                } else { written += length; }
            },
        }
    }
}

fn finish_command(
    commands: &mut VecDeque<Command>,
    control: &Control,
    callback: &Callback,
    event: NativeEvent,
) -> bool {
    commands.pop_front();
    // Release the completed command before JS can submit its successor.
    control.pending_ops.fetch_sub(1, Ordering::Release);
    send(callback, event)
}

fn send_read(callback: &Callback, buffer: &mut Vec<u8>, length: usize) -> bool {
    callback.call(
        Ok(CallbackEvent::read(buffer, length)),
        ThreadsafeFunctionCallMode::NonBlocking,
    ) == Status::Ok
}

// Keep burst-only storage and polling out of the latency-sensitive reactor path.
#[inline(never)]
fn send_ready_reads(
    control: &Control,
    callback: &Callback,
    read_buffer: &mut Vec<u8>,
    length: usize,
    window: &mut ReadWindow,
) -> io::Result<bool> {
    // Let JS process the first chunk while Rust collects ready followers.
    if !send_read(callback, read_buffer, length) {
        return Ok(false);
    }
    let mut first = None;
    let mut batch = Vec::new();
    // Avoid even taking the mutex when the first chunk used the remaining credit.
    if window.bytes == 0 || window.slots == 0 {
        return Ok(true);
    }
    // Charge successful followers to the same cooperative budget as poll_read.
    // This context never touches I/O readiness; the main poller owns its waker.
    let mut budget_context = Context::from_waker(Waker::noop());
    // Distribute the remaining byte credit over the reads still allowed in this burst.
    let bytes_per_read = window
        .bytes
        .div_ceil(window.slots.min(READ_BURST_LIMIT - 1));
    let collected = with_port(control, |port| {
        // One lock covers a bounded burst. A contending inline write is queued,
        // making pending_ops nonzero and ending collection at the next iteration.
        for _ in 1..READ_BURST_LIMIT {
            if control.stop.load(Ordering::Acquire)
                || control.pending_ops.load(Ordering::Acquire) != 0
                || window.bytes == 0
                || window.slots == 0
            {
                break;
            }
            let Poll::Ready(budget) = tokio::task::coop::poll_proceed(&mut budget_context) else {
                break;
            };
            let read_capacity = window.bytes.min(window.size.max(bytes_per_read));
            if read_buffer.len() < read_capacity {
                read_buffer.resize(read_capacity, 0);
            }
            // WouldBlock and interruptions normally end a burst; retain the
            // main reader's waker for the next readiness edge or retry.
            let next_length = match port.try_read(&mut read_buffer[..read_capacity]) {
                Ok(length) => {
                    budget.made_progress();
                    length
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(error) => {
                    cold_path();
                    return Err(error);
                }
            };
            if next_length == 0 {
                cold_path();
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Serial device disconnected",
                ));
            }
            window.size = if next_length == read_capacity {
                (next_length * 2).clamp(64, crate::CHUNK_SIZE)
            } else {
                next_length.next_power_of_two().clamp(64, crate::CHUNK_SIZE)
            };
            let data = crate::read_payload(read_buffer, next_length).into();
            if let Some(previous) = first.take() {
                batch.reserve_exact(READ_BURST_LIMIT - 1);
                batch.push(previous);
                batch.push(data);
            } else if batch.is_empty() {
                first = Some(data);
            } else {
                batch.push(data);
            }
            window.bytes -= next_length;
            window.slots -= 1;
        }
        Ok(())
    });
    // Release the mutex before publishing followers, even after a terminal error.
    let sent = if let Some(data) = first {
        callback.call(
            Ok(CallbackEvent::Read(data)),
            ThreadsafeFunctionCallMode::NonBlocking,
        ) == Status::Ok
    } else if !batch.is_empty() {
        callback.call(
            Ok(CallbackEvent::ReadBatch(batch)),
            ThreadsafeFunctionCallMode::NonBlocking,
        ) == Status::Ok
    } else {
        true
    };
    if !sent {
        return Ok(false);
    }
    // Deliver already-read bytes before reporting an error from a later read.
    collected.map(|()| true)
}

fn with_port<T>(
    control: &Control,
    operation: impl FnOnce(&mut SerialStream) -> io::Result<T>,
) -> io::Result<T> {
    let mut state = control.session.lock().map_err(|_| {
        cold_path();
        io::Error::other("Serial state poisoned")
    })?;
    let port = state.port.as_mut().ok_or_else(|| {
        cold_path();
        io::Error::new(io::ErrorKind::BrokenPipe, "Port is closed")
    })?;
    operation(port)
}

fn operation(port: &mut SerialStream, command: &Command) -> io::Result<NativeEvent> {
    let mut event = NativeEvent::new(command.id, "ok");
    match &command.operation {
        Operation::Update(baud_rate) => crate::platform::set_baud_rate(port, *baud_rate)?,
        Operation::GetBaudRate => event.baud_rate = Some(crate::platform::baud_rate(port)?),
        Operation::Set(options) => port.set_signals(options)?,
        Operation::Get => {
            let (cts, dsr, dcd) = port.modem_status()?;
            event.cts = Some(cts);
            event.dsr = Some(dsr);
            event.dcd = Some(dcd);
        }
        Operation::Flush => port.control().clear(ClearBuffer::All)?,
        _ => {
            cold_path();
            return Err(io::Error::other("Unexpected transfer in control queue"));
        }
    }
    Ok(event)
}
