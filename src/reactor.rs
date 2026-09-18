// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::poll_fn,
    io::{self, Write},
    sync::{Arc, atomic::Ordering},
    task::{Context, Poll, Waker},
    time::Duration,
};

use napi::{Status, bindgen_prelude::Either3, threadsafe_function::ThreadsafeFunctionCallMode};
use tokio::sync::mpsc;
use tokio_serial::{ClearBuffer, SerialPort, SerialStream};

use crate::{
    Callback, Command, Control, NativeEvent, NativeOptions, Operation, settings,
    transfer::{Transfer, TransferPoller},
};

// Bound immediately-ready follow-up work before servicing the command queue again.
const READ_BURST_LIMIT: usize = 16;

struct ReadWindow {
    bytes: usize,
    slots: usize,
    size: usize,
}

fn send(callback: &Callback, event: NativeEvent) -> bool {
    // At most 64 requests and 32 read-ahead events share the 128-entry queue.
    callback.call(
        Ok(Either3::C(event)),
        ThreadsafeFunctionCallMode::NonBlocking,
    ) == Status::Ok
}

fn send_stream_buffers(
    callback: &Callback,
    mut buffers: Vec<napi::bindgen_prelude::Buffer>,
) -> bool {
    let value = if buffers.len() == 1 {
        Either3::A(buffers.pop().expect("one read buffer"))
    } else {
        Either3::B(buffers)
    };
    callback.call(Ok(value), ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok
}

struct Completion {
    control: Arc<Control>,
    callback: Callback,
    error: Option<String>,
}

impl Drop for Completion {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Release);
        // Release the descriptor even if the worker unwinds before normal completion.
        self.control
            .session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let mut closed = NativeEvent::new(0, "close");
        closed.message = self.error.take();
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
        error: Some("Serial worker stopped unexpectedly".into()),
    };
    let control = &completion.control;
    let callback = &completion.callback;
    let opened = tokio::task::spawn_blocking(move || settings::open(&options)).await;
    let result = match opened {
        Ok(Ok(port)) => {
            *control
                .session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(port);
            if control.stop.load(Ordering::Acquire) || !send(callback, NativeEvent::new(0, "open"))
            {
                Ok(())
            } else {
                run_open(receiver, control, callback)
                    .await
                    .map_err(|error| error.to_string())
            }
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(error.to_string()),
    };
    completion.error = result.err();
}

async fn run_open(
    mut receiver: mpsc::Receiver<Command>,
    control: &Arc<Control>,
    callback: &Callback,
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
        let mut draining = false;
        while let Some(command) = commands.front() {
            if control.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Operation::Write(data) = &command.operation {
                if written < data.len() {
                    break;
                }
                written = 0;
                if !send(callback, NativeEvent::new(command.id, "ok")) {
                    return Ok(());
                }
            } else if matches!(command.operation, Operation::Drain) {
                if with_port(control, |port| {
                    port.bytes_to_write().map_err(io::Error::other)
                })? != 0
                {
                    draining = true;
                    break;
                }
                // Physical drain can block even after the driver's queue becomes empty.
                let control = Arc::clone(control);
                let drained =
                    tokio::task::spawn_blocking(move || with_port(&control, |port| port.flush()))
                        .await
                        .map_err(io::Error::other)
                        .and_then(|result| result);
                let event = match drained {
                    Ok(()) => NativeEvent::new(command.id, "ok"),
                    Err(error) => NativeEvent::error(command.id, error),
                };
                if !send(callback, event) {
                    return Ok(());
                }
            } else {
                let event = with_port(control, |port| {
                    operation(port, command).map_err(io::Error::other)
                })
                .unwrap_or_else(|error| NativeEvent::error(command.id, error));
                if !send(callback, event) {
                    return Ok(());
                }
            }
            control.pending_ops.fetch_sub(1, Ordering::Release);
            commands.pop_front();
        }
        let write = commands
            .front()
            .and_then(|command| match &command.operation {
                Operation::Write(data) => Some(&data[written..]),
                _ => None,
            });
        let read_length = read
            .map(|(_, length)| length)
            .or_else(|| (window.bytes > 0 && window.slots > 0).then_some(window.bytes));
        if let Some(length) = read_length
            && read_buffer.is_empty()
        {
            read_buffer.resize(length.min(window.size), 0);
        }
        tokio::select! {
            biased;
            _ = control.changed.notified() => {},
            command = receiver.recv(), if commands.len() < 64 => {
                match command {
                    Some(Command {id, operation: Operation::Read(length)}) => {
                        if read.is_some() || streaming { send(callback, NativeEvent::error(id, "Read already pending")); }
                        else {
                            read = Some((id, length));
                        }
                    }
                    Some(Command {operation: Operation::ReadCredit {bytes, slots}, ..}) => {
                        window.bytes += bytes;
                        window.slots += slots;
                        if read.is_some() || window.bytes > crate::CHUNK_SIZE || window.slots > crate::READ_SLOTS {
                            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid read credit"));
                        }
                        streaming = true;
                    }
                    Some(command) => { commands.push_back(command); },
                    None => return Ok(()),
                }
            },
            ready = poll_fn(|cx| with_port(control, |port| {
                Ok(transfers.poll(port, cx, read_length.map(|_| read_buffer.as_mut_slice()), write))
            }).unwrap_or_else(|error| Poll::Ready(Err(error)))), if read_length.is_some() || write.is_some() => {
                let (is_read, length) = match ready? {
                    Transfer::Read(length) => (true, length),
                    Transfer::Write(length) => (false, length),
                };
                if length == 0 { return Err(io::Error::new(io::ErrorKind::BrokenPipe, "Serial device disconnected")); }
                if is_read {
                    let filled = length == read_buffer.len();
                    window.size = if filled { (window.size * 2).min(crate::CHUNK_SIZE) }
                        else { length.next_power_of_two().clamp(64, crate::CHUNK_SIZE) };
                    read_buffer.truncate(length);
                    let data = std::mem::take(&mut read_buffer);
                    let sent = if streaming {
                        window.bytes -= length;
                        window.slots -= 1;
                        // Small partial reads normally drained the available input. Keep
                        // their existing path, and give queued writes/controls priority.
                        if write.is_some() || (!filled && length < 1024)
                            || control.pending_ops.load(Ordering::Acquire) != 0 {
                            callback.call(Ok(Either3::A(data.into())), ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok
                        } else {
                            send_ready_reads(control, callback, &mut transfers, data, &mut read_buffer, &mut window)?
                        }
                    } else {
                        let (id, _) = read.take().ok_or_else(|| io::Error::other("Unexpected read completion"))?;
                        let mut event = NativeEvent::new(id, "read");
                        event.data = Some(data.into());
                        send(callback, event)
                    };
                    if !sent { return Ok(()); }
                } else { written += length; }
            },
            // Only explicit drains use a timer; idle connections have no deadlines.
            _ = async { tokio::time::sleep(Duration::from_millis(1)).await }, if draining => {},
        }
    }
}

// Keep burst-only storage and polling out of the latency-sensitive reactor path.
#[inline(never)]
fn send_ready_reads(
    control: &Control,
    callback: &Callback,
    transfers: &mut TransferPoller,
    data: Vec<u8>,
    read_buffer: &mut Vec<u8>,
    window: &mut ReadWindow,
) -> io::Result<bool> {
    let mut first = Some(data.into());
    let mut batch = Vec::new();
    let mut deferred_error = None;
    for _ in 1..READ_BURST_LIMIT {
        if control.stop.load(Ordering::Acquire)
            || control.pending_ops.load(Ordering::Acquire) != 0
            || window.bytes == 0
            || window.slots == 0
        {
            break;
        }
        read_buffer.resize(window.bytes.min(window.size), 0);
        let ready = match poll_read_now(control, transfers, read_buffer) {
            Ok(ready) => ready,
            Err(error) => {
                deferred_error = Some(error);
                break;
            }
        };
        let next_length = match ready {
            Poll::Pending => break,
            Poll::Ready(Err(error)) => {
                deferred_error = Some(error);
                break;
            }
            Poll::Ready(Ok(Transfer::Write(_))) => {
                deferred_error = Some(io::Error::other("Unexpected write while batching reads"));
                break;
            }
            Poll::Ready(Ok(Transfer::Read(length))) => length,
        };
        if next_length == 0 {
            deferred_error = Some(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Serial device disconnected",
            ));
            break;
        }
        window.size = if next_length == read_buffer.len() {
            (window.size * 2).min(crate::CHUNK_SIZE)
        } else {
            next_length.next_power_of_two().clamp(64, crate::CHUNK_SIZE)
        };
        read_buffer.truncate(next_length);
        if let Some(data) = first.take() {
            batch.reserve_exact(READ_BURST_LIMIT);
            batch.push(data);
        }
        batch.push(std::mem::take(read_buffer).into());
        window.bytes -= next_length;
        window.slots -= 1;
    }
    let sent = if let Some(data) = first {
        callback.call(
            Ok(Either3::A(data)),
            ThreadsafeFunctionCallMode::NonBlocking,
        ) == Status::Ok
    } else {
        send_stream_buffers(callback, batch)
    };
    if !sent {
        return Ok(false);
    }
    if let Some(error) = deferred_error {
        return Err(error);
    }
    Ok(true)
}

fn poll_read_now(
    control: &Control,
    transfers: &mut TransferPoller,
    buffer: &mut [u8],
) -> io::Result<Poll<io::Result<Transfer>>> {
    let mut cx = Context::from_waker(Waker::noop());
    with_port(control, |port| {
        Ok(transfers.poll(port, &mut cx, Some(buffer), None))
    })
}

fn with_port<T>(
    control: &Control,
    operation: impl FnOnce(&mut SerialStream) -> io::Result<T>,
) -> io::Result<T> {
    let mut state = control
        .session
        .lock()
        .map_err(|_| io::Error::other("Serial state poisoned"))?;
    let port = state
        .as_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "Port is closed"))?;
    operation(port)
}

fn operation(port: &mut SerialStream, command: &Command) -> Result<NativeEvent, String> {
    let mut event = NativeEvent::new(command.id, "ok");
    match &command.operation {
        Operation::Update(baud_rate) => {
            crate::platform::set_baud_rate(port, *baud_rate).map_err(|error| error.to_string())?
        }
        Operation::GetBaudRate => {
            event.baud_rate =
                Some(crate::platform::baud_rate(port).map_err(|error| error.to_string())?)
        }
        Operation::Set(flags) => {
            port.write_data_terminal_ready(flags & 1 != 0)
                .map_err(|error| error.to_string())?;
            port.write_request_to_send(flags & 2 != 0)
                .map_err(|error| error.to_string())?;
            if flags & 4 != 0 {
                port.set_break()
            } else {
                port.clear_break()
            }
            .map_err(|error| error.to_string())?;
        }
        Operation::Get => {
            event.cts = Some(
                port.read_clear_to_send()
                    .map_err(|error| error.to_string())?,
            );
            event.dsr = Some(
                port.read_data_set_ready()
                    .map_err(|error| error.to_string())?,
            );
            event.dcd = Some(
                port.read_carrier_detect()
                    .map_err(|error| error.to_string())?,
            );
        }
        Operation::Flush => port
            .clear(ClearBuffer::All)
            .map_err(|error| error.to_string())?,
        _ => return Err("Unexpected transfer in control queue".into()),
    }
    Ok(event)
}
