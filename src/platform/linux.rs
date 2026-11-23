// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use super::unix::{syscall_result, unsupported_ioctl};
use nix::libc;
use std::{
    io,
    os::fd::{AsFd, AsRawFd},
};

const ASYNC_LOW_LATENCY: libc::c_int = 1 << 13;

// Linux UAPI linux/serial.h. Both ioctls transfer the complete serial_struct.
#[repr(C)]
#[derive(Default)]
struct SerialInfo {
    kind: libc::c_int,
    line: libc::c_int,
    port: libc::c_uint,
    irq: libc::c_int,
    flags: libc::c_int,
    xmit_fifo_size: libc::c_int,
    custom_divisor: libc::c_int,
    baud_base: libc::c_int,
    close_delay: libc::c_ushort,
    io_type: libc::c_char,
    reserved_char: libc::c_char,
    hub6: libc::c_int,
    closing_wait: libc::c_ushort,
    closing_wait2: libc::c_ushort,
    iomem_base: *mut u8,
    iomem_reg_shift: libc::c_ushort,
    port_high: libc::c_uint,
    iomap_base: libc::c_ulong,
}

const _: () = assert!(std::mem::offset_of!(SerialInfo, flags) == 16);
const _: () = assert!(size_of::<SerialInfo>() == if usize::BITS == 64 { 72 } else { 60 });

impl SerialInfo {
    fn read(port: &impl AsFd) -> io::Result<Self> {
        let mut info = Self::default();
        // SAFETY: the fd is live and info has the kernel serial_struct layout.
        syscall_result(unsafe {
            libc::ioctl(port.as_fd().as_raw_fd(), libc::TIOCGSERIAL, &raw mut info)
        })?;
        Ok(info)
    }

    fn change_low_latency(&mut self, enabled: bool) -> bool {
        if (self.flags & ASYNC_LOW_LATENCY != 0) == enabled {
            return false;
        }
        self.flags ^= ASYNC_LOW_LATENCY;
        true
    }
}

pub(crate) fn low_latency(port: &impl AsFd) -> bool {
    SerialInfo::read(port).is_ok_and(|info| info.flags & ASYNC_LOW_LATENCY != 0)
}

pub(crate) fn set_low_latency(port: &impl AsFd, enabled: bool) -> io::Result<()> {
    let mut info = match SerialInfo::read(port) {
        Err(error) if !enabled && unsupported_ioctl(&error) => return Ok(()),
        result => result?,
    };
    if !info.change_low_latency(enabled) {
        return Ok(());
    }
    // SAFETY: the kernel receives its original structure with only the selected flag changed.
    syscall_result(unsafe {
        libc::ioctl(port.as_fd().as_raw_fd(), libc::TIOCSSERIAL, &raw const info)
    })
}

#[cfg(test)]
#[test]
fn low_latency_changes_only_the_requested_flag() {
    let mut info = SerialInfo {
        flags: 0x405,
        ..Default::default()
    };
    assert!(!info.change_low_latency(false));
    assert!(info.change_low_latency(true));
    assert_eq!(info.flags, 0x405 | ASYNC_LOW_LATENCY);
    assert!(!info.change_low_latency(true));
    assert!(info.change_low_latency(false));
    assert_eq!(info.flags, 0x405);
}

#[cfg(test)]
#[test]
fn unsupported_low_latency_is_off_and_enabling_it_reports_errno() {
    let file = std::fs::File::open("/dev/null").unwrap();
    assert!(!low_latency(&file));
    set_low_latency(&file, false).unwrap();
    assert_eq!(
        set_low_latency(&file, true).unwrap_err().raw_os_error(),
        Some(libc::ENOTTY)
    );
}
