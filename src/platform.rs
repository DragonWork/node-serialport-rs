// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use crate::NativeOptions;
use std::io;
use tokio_serial::{SerialPort, SerialPortBuilder, SerialStream};

pub(crate) fn open(builder: &SerialPortBuilder) -> io::Result<SerialStream> {
    let opened = SerialStream::open(builder);
    #[cfg(target_os = "macos")]
    if let Err(error) = &opened
        // The dependency discards errno and retains its description.
        && error.description == nix::errno::Errno::ENOTTY.desc()
    {
        // Zero skips IOSSIOSPEED; configure the POSIX speed after opening instead.
        return SerialStream::open(&builder.clone().baud_rate(0)).map_err(Into::into);
    }
    opened.map_err(Into::into)
}

pub(crate) fn set_baud_rate(port: &mut SerialStream, baud_rate: u32) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    if port.baud_rate()? == 0 {
        use nix::sys::termios::{self, SetArg};
        let mut settings = termios::tcgetattr(descriptor(port))?;
        termios::cfsetspeed(&mut settings, baud_rate)?;
        return termios::tcsetattr(descriptor(port), SetArg::TCSANOW, &settings)
            .map_err(Into::into);
    }
    port.set_baud_rate(baud_rate).map_err(Into::into)
}

pub(crate) fn baud_rate(port: &SerialStream) -> io::Result<u32> {
    let baud_rate = port.baud_rate()?;
    #[cfg(target_os = "macos")]
    if baud_rate == 0 {
        let settings = nix::sys::termios::tcgetattr(descriptor(port))?;
        return Ok(nix::sys::termios::cfgetospeed(&settings));
    }
    Ok(baud_rate)
}

#[cfg(unix)]
fn descriptor(port: &SerialStream) -> std::os::fd::BorrowedFd<'_> {
    use std::os::fd::{AsRawFd, BorrowedFd};
    // SAFETY: the borrowed descriptor cannot outlive the port that owns it.
    unsafe { BorrowedFd::borrow_raw(port.as_raw_fd()) }
}

#[cfg(target_os = "linux")]
pub(crate) fn port_ids() -> std::collections::HashMap<std::path::PathBuf, String> {
    let mut ids = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir("/dev/serial/by-id") {
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if let Ok(path) = entry.path().canonicalize() {
                ids.entry(path)
                    .or_insert_with(|| entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    ids
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn port_ids() -> std::collections::HashMap<std::path::PathBuf, String> {
    std::collections::HashMap::new()
}

#[cfg(unix)]
pub(crate) fn configure(port: &SerialStream, options: &NativeOptions) -> io::Result<()> {
    use nix::sys::termios::{self, ControlFlags, InputFlags, SetArg};

    if options.stop_bits == 1.5 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "1.5 stop bits requires Windows",
        ));
    }
    let fd = descriptor(port);
    let mut settings = termios::tcgetattr(fd)?;
    settings.input_flags.set(InputFlags::IXON, options.xon);
    settings.input_flags.set(InputFlags::IXOFF, options.xoff);
    settings.input_flags.set(InputFlags::IXANY, options.xany);
    settings
        .control_flags
        .set(ControlFlags::HUPCL, options.hupcl);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let sticky = matches!(options.parity.as_str(), "mark" | "space");
        settings.control_flags.set(ControlFlags::CMSPAR, sticky);
        if sticky {
            settings.control_flags.insert(ControlFlags::PARENB);
            settings
                .control_flags
                .set(ControlFlags::PARODD, options.parity == "mark");
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    if matches!(options.parity.as_str(), "mark" | "space") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Mark/space parity is not available on this platform",
        ));
    }
    termios::tcsetattr(fd, SetArg::TCSANOW, &settings)?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn configure(port: &SerialStream, options: &NativeOptions) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Devices::Communication::{DCB, GetCommState, SetCommState};

    let handle = port.as_raw_handle();
    // SAFETY: DCB is a plain Windows ABI structure; zero initialization is valid.
    let mut settings: DCB = unsafe { std::mem::zeroed() };
    settings.DCBlength = std::mem::size_of::<DCB>() as u32;
    // SAFETY: the port owns a live handle and settings is writable for the complete call.
    if unsafe { GetCommState(handle, &mut settings) } == 0 {
        return Err(io::Error::last_os_error());
    }
    settings.BaudRate = options.baud_rate;
    settings.ByteSize = options.data_bits as u8;
    settings.Parity = match options.parity.as_str() {
        "odd" => 1,
        "even" => 2,
        "mark" => 3,
        "space" => 4,
        _ => 0,
    };
    settings.StopBits = if options.stop_bits == 1.5 {
        1
    } else if options.stop_bits == 2.0 {
        2
    } else {
        0
    };
    // DCB flag positions are defined by the Windows SDK (fOutX/fInX at 8/9).
    for (bit, value) in [
        (1, settings.Parity != 0),
        (2, options.rtscts),
        // On Windows hupcl selects DTR on open, not the Unix close behavior.
        (4, options.hupcl),
        (5, false),
        (8, options.xon),
        (9, options.xoff),
    ] {
        settings._bitfield = (settings._bitfield & !(1 << bit)) | (u32::from(value) << bit);
    }
    // SAFETY: both the handle and DCB remain valid until this synchronous call returns.
    if unsafe { SetCommState(handle, &settings) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
