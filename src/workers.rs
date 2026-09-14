// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    io,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicUsize, Ordering},
    },
};

use tokio::{runtime::Handle, sync::Notify};

struct Worker {
    handle: Handle,
    ports: AtomicUsize,
    stopped: Arc<Notify>,
}

impl Worker {
    fn start() -> io::Result<Arc<Self>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(2)
            .thread_name("serialport-block")
            .build()?;
        let handle = runtime.handle().clone();
        let stopped = Arc::new(Notify::new());
        let shutdown = Arc::clone(&stopped);
        std::thread::Builder::new()
            .name("serialport-rt".into())
            .spawn(move || runtime.block_on(shutdown.notified()))?;
        Ok(Arc::new(Self {
            handle,
            ports: AtomicUsize::new(0),
            stopped,
        }))
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stopped.notify_one();
    }
}

struct Lease(Arc<Worker>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.ports.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire() -> io::Result<Lease> {
    static WORKERS: OnceLock<Mutex<Vec<Weak<Worker>>>> = OnceLock::new();
    static LIMIT: OnceLock<usize> = OnceLock::new();
    let limit = *LIMIT.get_or_init(|| {
        std::thread::available_parallelism()
            .map_or(1, usize::from)
            .clamp(1, 4)
    });
    let mut pool = WORKERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| io::Error::other("I/O worker pool poisoned"))?;
    let mut active = Vec::new();
    pool.retain(|weak| match weak.upgrade() {
        Some(worker) => {
            active.push(worker);
            true
        }
        None => false,
    });
    let least_busy = active
        .iter()
        .min_by_key(|worker| worker.ports.load(Ordering::Acquire));
    let worker = match least_busy {
        Some(worker) if worker.ports.load(Ordering::Acquire) == 0 || active.len() >= limit => {
            Arc::clone(worker)
        }
        _ => {
            let worker = Worker::start()?;
            pool.push(Arc::downgrade(&worker));
            worker
        }
    };
    worker.ports.fetch_add(1, Ordering::AcqRel);
    Ok(Lease(worker))
}

pub(crate) fn spawn(task: impl Future<Output = ()> + Send + 'static) -> io::Result<()> {
    let lease = acquire()?;
    let handle = lease.0.handle.clone();
    handle.spawn(async move {
        // Keep the worker alive through descriptor cleanup and the final callback.
        let _lease = lease;
        task.await;
    });
    Ok(())
}
