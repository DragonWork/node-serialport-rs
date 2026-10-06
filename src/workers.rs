// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    hint::cold_path,
    io,
    sync::{
        Arc, LazyLock, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
};

use tokio::{runtime::Handle, sync::Notify};

const MAX_WORKERS: usize = 4;

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
        // This count only guides worker selection; it does not publish port state.
        self.0.ports.fetch_sub(1, Ordering::Relaxed);
    }
}

fn acquire() -> io::Result<Lease> {
    static WORKERS: Mutex<Vec<Weak<Worker>>> = Mutex::new(Vec::new());
    static LIMIT: LazyLock<usize> = LazyLock::new(|| {
        std::thread::available_parallelism()
            .map_or(1, usize::from)
            .clamp(1, MAX_WORKERS)
    });
    let limit = *LIMIT;
    let mut pool = WORKERS.lock().map_err(|_| {
        cold_path();
        io::Error::other("I/O worker pool poisoned")
    })?;
    let mut active: [Option<Arc<Worker>>; MAX_WORKERS] = [const { None }; MAX_WORKERS];
    let mut active_count = 0;
    pool.retain(|weak| match weak.upgrade() {
        Some(worker) => {
            active[active_count] = Some(worker);
            active_count += 1;
            true
        }
        None => false,
    });
    let least_busy = active
        .iter()
        .enumerate()
        .filter_map(|(index, worker)| worker.as_ref().map(|worker| (index, worker)))
        .min_by_key(|(_, worker)| worker.ports.load(Ordering::Relaxed))
        .map(|(index, _)| index);
    let reusable = least_busy.and_then(|index| {
        active[index]
            .take_if(|worker| worker.ports.load(Ordering::Relaxed) == 0 || active_count >= limit)
    });
    let worker = match reusable {
        Some(worker) => worker,
        None => {
            let worker = Worker::start()?;
            pool.push(Arc::downgrade(&worker));
            worker
        }
    };
    worker.ports.fetch_add(1, Ordering::Relaxed);
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
