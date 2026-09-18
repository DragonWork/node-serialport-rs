// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#![deny(unsafe_code)]

mod command;
#[allow(unsafe_code)]
mod platform;
mod reactor;
mod settings;
mod transfer;
mod workers;

use command::{Command, Operation};

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use napi::{
    Env, Error, Result, Status, Task,
    bindgen_prelude::{Array, AsyncTask, Buffer, BufferSlice, Either3, Function},
    threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;
use tokio::sync::{Notify, mpsc};

pub(crate) const CHUNK_SIZE: usize = 64 * 1024;
pub(crate) const READ_SLOTS: usize = 32;
pub(crate) type CallbackValue = Either3<Buffer, Vec<Buffer>, NativeEvent>;
pub(crate) type Callback =
    ThreadsafeFunction<CallbackValue, (), CallbackValue, Status, true, false, 128>;

#[napi(object)]
pub struct NativeOptions {
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u32,
    pub stop_bits: f64,
    pub parity: String,
    pub lock: bool,
    pub rtscts: bool,
    pub xon: bool,
    pub xoff: bool,
    pub xany: bool,
    pub hupcl: bool,
}

#[napi(object)]
#[derive(Default)]
pub struct NativeEvent {
    pub id: u32,
    pub kind: String,
    pub data: Option<Buffer>,
    pub message: Option<String>,
    pub cts: Option<bool>,
    pub dsr: Option<bool>,
    pub dcd: Option<bool>,
    pub baud_rate: Option<u32>,
}

impl NativeEvent {
    pub(crate) fn new(id: u32, kind: &str) -> Self {
        Self {
            id,
            kind: kind.into(),
            ..Self::default()
        }
    }
    pub(crate) fn error(id: u32, error: impl std::fmt::Display) -> Self {
        Self {
            message: Some(error.to_string()),
            ..Self::new(id, "error")
        }
    }
}

pub(crate) struct Control {
    stop: AtomicBool,
    changed: Notify,
    pending_ops: AtomicUsize,
    session: Mutex<Option<tokio_serial::SerialStream>>,
}

impl Control {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.changed.notify_one();
    }
}

type Registry = Arc<Mutex<Vec<Weak<Control>>>>;
static ENVIRONMENTS: OnceLock<Mutex<HashMap<usize, Registry>>> = OnceLock::new();

fn register_cleanup(env: Env, control: &Arc<Control>) -> Result<()> {
    let key = env.raw() as usize;
    let mut environments = ENVIRONMENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| Error::from_reason("Session registry poisoned"))?;
    if let std::collections::hash_map::Entry::Vacant(entry) = environments.entry(key) {
        let registry: Registry = Arc::default();
        env.add_env_cleanup_hook(Arc::clone(&registry), move |registry| {
            if let Ok(sessions) = registry.lock() {
                for session in sessions.iter().filter_map(Weak::upgrade) {
                    session.stop();
                }
            }
            if let Ok(mut environments) = ENVIRONMENTS.get_or_init(Default::default).lock() {
                environments.remove(&key);
            }
        })?;
        entry.insert(registry);
    }
    let mut sessions = environments[&key]
        .lock()
        .map_err(|_| Error::from_reason("Session registry poisoned"))?;
    sessions.retain(|session| session.strong_count() != 0);
    sessions.push(Arc::downgrade(control));
    Ok(())
}

#[napi]
pub struct NativePort {
    control: Arc<Control>,
    sender: mpsc::Sender<Command>,
}

#[napi]
impl NativePort {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        options: NativeOptions,
        callback: Function<'_, CallbackValue, ()>,
        allocator: Function<'_, u32, Buffer>,
    ) -> Result<Self> {
        let allocator = allocator.create_ref()?;
        let callback = callback
            .build_threadsafe_function::<CallbackValue>()
            .callee_handled::<true>()
            .max_queue_size::<128>()
            .build_callback(move |ctx| match ctx.value {
                Either3::A(data) if data.len() <= 1024 => {
                    // Copy on the JS thread; no JS-owned memory crosses into the I/O worker.
                    let mut buffer = allocator.borrow_back(&ctx.env)?.call(data.len() as u32)?;
                    if buffer.len() != data.len() {
                        return Err(Error::from_reason("Invalid read buffer allocation"));
                    }
                    buffer.copy_from_slice(&data);
                    Ok(Either3::A(buffer))
                }
                Either3::B(mut buffers) => {
                    for data in &mut buffers {
                        if data.len() <= 1024 {
                            let mut buffer =
                                allocator.borrow_back(&ctx.env)?.call(data.len() as u32)?;
                            if buffer.len() != data.len() {
                                return Err(Error::from_reason("Invalid read buffer allocation"));
                            }
                            buffer.copy_from_slice(data);
                            *data = buffer;
                        }
                    }
                    Ok(Either3::B(buffers))
                }
                event => Ok(event),
            })?;
        let control = Arc::new(Control {
            stop: AtomicBool::new(false),
            changed: Notify::new(),
            pending_ops: AtomicUsize::new(0),
            session: Mutex::new(None),
        });
        register_cleanup(env, &control)?;
        let (sender, receiver) = mpsc::channel(64 + READ_SLOTS);
        let worker_control = Arc::clone(&control);
        workers::spawn(reactor::run(options, receiver, worker_control, callback))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(Self { control, sender })
    }

    #[napi]
    pub fn read(&self, id: u32, length: u32) -> Result<()> {
        if length == 0 || length as usize > CHUNK_SIZE {
            return Err(Error::new(Status::InvalidArg, "Invalid transfer size"));
        }
        self.enqueue(Command {
            id,
            operation: Operation::Read(length as usize),
        })
    }

    #[napi]
    pub fn read_credit(&self, bytes: u32, events: u32) -> Result<()> {
        if bytes == 0 || bytes as usize > CHUNK_SIZE || events == 0 || events as usize > READ_SLOTS
        {
            return Err(Error::new(Status::InvalidArg, "Invalid read credit"));
        }
        self.enqueue(Command {
            id: 0,
            operation: Operation::ReadCredit {
                bytes: bytes as usize,
                slots: events as usize,
            },
        })
    }

    #[napi]
    pub fn write(&self, id: u32, data: BufferSlice<'_>, allow_inline: bool) -> Result<bool> {
        if data.len() > CHUNK_SIZE {
            return Err(Error::new(Status::InvalidArg, "Invalid transfer size"));
        }
        if self.control.stop.load(Ordering::Acquire) {
            return Err(Error::from_reason("Port is closed"));
        }
        let mut written = 0;
        // Never wait for the port lock or bypass an earlier write/control operation.
        if allow_inline
            && self.control.pending_ops.load(Ordering::Acquire) == 0
            && let Ok(mut state) = self.control.session.try_lock()
            && let Some(port) = state.as_mut()
            && let Ok(count) = port.try_write(&data)
        {
            written = count;
            if count == data.len() {
                return Ok(true);
            }
        }
        // Only queued bytes need an owned snapshot beyond this synchronous call.
        self.enqueue(Command {
            id,
            operation: Operation::Write(data[written..].to_vec()),
        })?;
        Ok(false)
    }

    #[napi]
    pub fn request(&self, id: u32, op: String, value: u32) -> Result<()> {
        let operation = match op.as_str() {
            "update" => Operation::Update(value),
            "set" => Operation::Set(value),
            "get" => Operation::Get,
            "getBaudRate" => Operation::GetBaudRate,
            "flush" => Operation::Flush,
            "drain" => Operation::Drain,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Unknown serial control operation",
                ));
            }
        };
        self.enqueue(Command { id, operation })
    }

    #[napi]
    pub fn writev(&self, id: u32, buffers: Array<'_>, length_hint: Option<u32>) -> Result<()> {
        if self.control.stop.load(Ordering::Acquire) {
            return Err(Error::from_reason("Port is closed"));
        }
        let capacity = length_hint.unwrap_or(0) as usize;
        if capacity > CHUNK_SIZE || buffers.len() > 1024 {
            return Err(Error::new(Status::InvalidArg, "Invalid transfer size"));
        }
        let mut data = Vec::with_capacity(capacity);
        for index in 0..buffers.len() {
            // Borrow one segment at a time: callers may repeat or overlap buffers.
            // No borrow survives the next JS array access or this synchronous call.
            let buffer: BufferSlice<'_> = buffers
                .get(index)?
                .ok_or_else(|| Error::new(Status::InvalidArg, "Missing write buffer"))?;
            if buffer.len() > CHUNK_SIZE - data.len() {
                return Err(Error::new(Status::InvalidArg, "Invalid transfer size"));
            }
            data.extend_from_slice(&buffer);
        }
        self.enqueue(Command {
            id,
            operation: Operation::Write(data),
        })
    }

    #[napi]
    pub fn close(&self) {
        self.control.stop();
    }
}

impl NativePort {
    fn enqueue(&self, command: Command) -> Result<()> {
        if self.control.stop.load(Ordering::Acquire) {
            return Err(Error::from_reason("Port is closed"));
        }
        let ordered = command.ordered();
        if ordered {
            self.control.pending_ops.fetch_add(1, Ordering::AcqRel);
        }
        if let Err(error) = self.sender.try_send(command) {
            if ordered {
                self.control.pending_ops.fetch_sub(1, Ordering::Release);
            }
            return Err(Error::from_reason(error.to_string()));
        }
        Ok(())
    }
}

impl Drop for NativePort {
    fn drop(&mut self) {
        self.control.stop();
    }
}

#[napi(object)]
pub struct PortInfo {
    pub path: String,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
    pub pnp_id: Option<String>,
    pub location_id: Option<String>,
}

pub struct ListTask;

impl Task for ListTask {
    type Output = Vec<PortInfo>;
    type JsValue = Vec<PortInfo>;
    fn compute(&mut self) -> Result<Self::Output> {
        let ports = std::panic::catch_unwind(tokio_serial::available_ports)
            .map_err(|_| Error::from_reason("Serial port enumeration failed"))?
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let pnp_ids = crate::platform::port_ids();
        let mut result = Vec::with_capacity(ports.len());
        for port in ports {
            let (manufacturer, serial_number, vendor_id, product_id) = match port.port_type {
                tokio_serial::SerialPortType::UsbPort(usb) => (
                    usb.manufacturer,
                    usb.serial_number,
                    Some(format!("{:04x}", usb.vid)),
                    Some(format!("{:04x}", usb.pid)),
                ),
                _ => (None, None, None, None),
            };
            let pnp_id = pnp_ids.get(std::path::Path::new(&port.port_name)).cloned();
            result.push(PortInfo {
                path: port.port_name,
                manufacturer,
                serial_number,
                vendor_id,
                product_id,
                pnp_id,
                location_id: None,
            });
        }
        result.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(result)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn list_ports() -> AsyncTask<ListTask> {
    AsyncTask::new(ListTask)
}
