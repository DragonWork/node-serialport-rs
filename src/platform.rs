// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use crate::NativeOptions;
use serialport::SerialPort;
#[cfg(unix)]
use serialport::SerialPortBuilder;
use std::io;

std::cfg_select! {
    unix => {
        mod unix;
        pub(crate) use unix::{SerialStream, output_pending};
    }
    windows => {
        mod windows;
        pub(crate) use windows::{SerialStream, output_pending};
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) mod macos_list;
#[cfg(any(windows, test))]
pub(crate) mod windows_list;
#[cfg(any(windows, test))]
mod windows_read;

#[cfg(unix)]
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
    if baud_rate == 0 {
        return Err(crate::error::invalid("Baud rate must be positive"));
    }
    #[cfg(target_os = "macos")]
    if port.control().baud_rate()? == 0 {
        use nix::sys::termios::{self, SetArg};
        use std::os::fd::AsFd;
        let fd = port.as_fd();
        let mut settings = termios::tcgetattr(fd)?;
        termios::cfsetspeed(&mut settings, baud_rate)?;
        return termios::tcsetattr(fd, SetArg::TCSANOW, &settings).map_err(Into::into);
    }
    port.control_mut()
        .set_baud_rate(baud_rate)
        .map_err(Into::into)
}

pub(crate) fn baud_rate(port: &SerialStream) -> io::Result<u32> {
    let baud_rate = port.control().baud_rate()?;
    #[cfg(target_os = "macos")]
    if baud_rate == 0 {
        let settings = nix::sys::termios::tcgetattr(port)?;
        return Ok(nix::sys::termios::cfgetospeed(&settings));
    }
    Ok(baud_rate)
}

pub(crate) fn port_ids() -> std::collections::HashMap<std::path::PathBuf, String> {
    std::cfg_select! {
        target_os = "linux" => {
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
        _ => { std::collections::HashMap::new() }
    }
}

#[cfg(unix)]
pub(crate) fn configure(port: &mut SerialStream, options: &NativeOptions) -> io::Result<()> {
    use nix::sys::termios::{self, ControlFlags, InputFlags, SetArg, SpecialCharacterIndices};

    let mut settings = termios::tcgetattr(&*port)?;
    let minimum = options.vmin.unwrap_or(1);
    settings.control_chars[SpecialCharacterIndices::VMIN as usize] = minimum;
    settings.control_chars[SpecialCharacterIndices::VTIME as usize] = options.vtime.unwrap_or(0);
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
    termios::tcsetattr(&*port, SetArg::TCSANOW, &settings)?;
    port.zero_minimum = minimum == 0;
    Ok(())
}

#[cfg(any(windows, test))]
pub(crate) fn windows_device_path(path: &str) -> String {
    if path.starts_with('\\') {
        path.to_owned()
    } else {
        format!(r"\\.\{path}")
    }
}

#[cfg(any(windows, test))]
pub(crate) fn windows_format(options: &NativeOptions) -> io::Result<(u8, u8, u8)> {
    use crate::error::invalid;
    if !(5..=8).contains(&options.data_bits) {
        return Err(invalid("Invalid dataBits"));
    }
    let parity = match options.parity.as_str() {
        "none" => 0,
        "odd" => 1,
        "even" => 2,
        "mark" => 3,
        "space" => 4,
        _ => return Err(invalid("Invalid parity")),
    };
    let stop = match options.stop_bits {
        1.0 => 0,
        1.5 => 1,
        2.0 => 2,
        _ => return Err(invalid("Invalid stopBits")),
    };
    Ok((options.data_bits as u8, parity, stop))
}

#[cfg(any(windows, test))]
pub(crate) fn windows_dcb_flags(flags: u32, options: &NativeOptions) -> u32 {
    let mut flags = windows_rts_flags(flags, options.rtscts, options.rts_mode.as_ref());
    for (bit, enabled) in [
        (0, true), // fBinary
        (1, options.parity != "none"),
        (3, false), // fOutxDsrFlow
        (4, options.dtr_on_open.unwrap_or(options.hupcl)),
        (5, false), // manual DTR
        (6, false), // fDsrSensitivity
        (8, options.xon),
        (9, options.xoff),
        (10, false), // fErrorChar
        (11, false), // fNull
        (14, false), // fAbortOnError
    ] {
        flags = (flags & !(1 << bit)) | (u32::from(enabled) << bit);
    }
    flags
}

#[cfg(any(windows, test))]
fn windows_rts_flags(flags: u32, rtscts: bool, mode: Option<&crate::RtsMode>) -> u32 {
    use crate::RtsMode;
    // DCB.fOutxCtsFlow is bit 2 and fRtsControl occupies bits 12 and 13.
    let flags = flags & !((1 << 2) | (3 << 12));
    if !rtscts {
        return flags;
    }
    let rts = match mode.unwrap_or(&RtsMode::Handshake) {
        RtsMode::Enable => 1,
        RtsMode::Handshake => 2,
        RtsMode::Toggle => 3,
    };
    flags | (1 << 2) | (rts << 12)
}

#[cfg(test)]
#[test]
fn windows_rts_modes_preserve_other_dcb_flags() {
    use crate::RtsMode;
    for (mode, bits) in [
        (None, 2),
        (Some(RtsMode::Handshake), 2),
        (Some(RtsMode::Enable), 1),
        (Some(RtsMode::Toggle), 3),
    ] {
        for initial in [0, u32::MAX] {
            let other = initial & !0x3004;
            assert_eq!(
                windows_rts_flags(initial, true, mode.as_ref()),
                other | 4 | bits << 12
            );
            assert_eq!(windows_rts_flags(initial, false, mode.as_ref()), other);
        }
    }
}
