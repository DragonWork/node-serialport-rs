// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::io;

use crate::{NativeOptions, error::invalid, platform::SerialStream};

pub(crate) fn open(options: &NativeOptions) -> io::Result<SerialStream> {
    // Reject unsupported settings before opening a device can change its state.
    #[cfg(unix)]
    if options.stop_bits == 1.5 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "1.5 stop bits requires Windows",
        ));
    }
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    if matches!(options.parity.as_str(), "mark" | "space") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Mark/space parity is not available on this platform",
        ));
    }
    #[cfg(windows)]
    if options.vmin.unwrap_or(1) != 1 || options.vtime.unwrap_or(0) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "vmin and vtime require Unix",
        ));
    }
    #[cfg(windows)]
    if !options.lock {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows requires exclusive serial access",
        ));
    }
    if options.path.is_empty() || options.path.contains('\0') {
        return Err(invalid("Invalid device path"));
    }
    if options.baud_rate == 0 {
        return Err(invalid("Baud rate must be positive"));
    }
    #[cfg(windows)]
    {
        SerialStream::open(options)
    }
    #[cfg(unix)]
    {
        open_unix(options)
    }
}

#[cfg(unix)]
fn open_unix(options: &NativeOptions) -> io::Result<SerialStream> {
    let data_bits = match options.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => {
            return Err(invalid("Invalid dataBits"));
        }
    };
    let stop_bits = match options.stop_bits {
        1.0 => StopBits::One,
        2.0 => StopBits::Two,
        _ => {
            return Err(invalid("Invalid stopBits"));
        }
    };
    let parity = match options.parity.as_str() {
        "none" | "mark" | "space" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => {
            return Err(invalid("Invalid parity"));
        }
    };
    let flow = if options.rtscts {
        FlowControl::Hardware
    } else if options.xon {
        FlowControl::Software
    } else {
        FlowControl::None
    };
    let builder = serialport::new(&options.path, options.baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(flow)
        .exclusive(options.lock);
    let mut port = crate::platform::open(&builder)?;
    crate::platform::configure(&mut port, options)?;
    // Reapply custom speeds after changing the terminal flags.
    crate::platform::set_baud_rate(&mut port, options.baud_rate)?;
    if let Some(level) = options.dtr_on_open {
        port.set_dtr(level)?;
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalid_path() -> NativeOptions {
        NativeOptions {
            path: "\0".into(),
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: 1.0,
            parity: "none".into(),
            lock: true,
            rtscts: false,
            rts_mode: None,
            dtr_on_open: None,
            vmin: None,
            vtime: None,
            xon: false,
            xoff: false,
            xany: false,
            hupcl: true,
        }
    }

    #[test]
    fn windows_open_preserves_driver_flags_and_applies_requested_lines() {
        use crate::platform::{windows_dcb_flags, windows_device_path, windows_format};
        assert_eq!(windows_device_path("COM12"), r"\\.\COM12");
        assert_eq!(windows_device_path(r"\\.\COM12"), r"\\.\COM12");
        assert_eq!(windows_device_path(r"\\?\port"), r"\\?\port");
        for (hupcl, dtr_on_open, expected) in [
            (true, None, true),
            (false, None, false),
            (true, Some(false), false),
            (false, Some(true), true),
        ] {
            let options = NativeOptions {
                hupcl,
                dtr_on_open,
                rtscts: true,
                xoff: true,
                parity: "mark".into(),
                data_bits: 5,
                stop_bits: 1.5,
                ..invalid_path()
            };
            assert_eq!(windows_format(&options).unwrap(), (5, 3, 1));
            let flags = windows_dcb_flags(u32::MAX, &options);
            assert_eq!((flags >> 4) & 3, u32::from(expected));
            assert_eq!((flags >> 12) & 3, 2);
            assert_eq!(flags & 0x47, 7); // binary, parity and CTS flow, no DSR sensitivity
            assert_eq!((flags >> 8) & 3, 2);
            assert_eq!(flags & ((1 << 3) | (1 << 10) | (1 << 11) | (1 << 14)), 0);
            assert_ne!(flags & (1 << 7), 0);
        }
    }

    #[test]
    fn invalid_paths_and_zero_baud_are_rejected_without_device_access() {
        for path in ["", "\0"] {
            let options = NativeOptions {
                path: path.into(),
                ..invalid_path()
            };
            assert_eq!(
                open(&options).err().unwrap().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        let options = NativeOptions {
            path: "unused-device".into(),
            baud_rate: 0,
            ..invalid_path()
        };
        assert_eq!(
            open(&options).err().unwrap().to_string(),
            "Baud rate must be positive"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn asynchronous_open_and_baud_updates_preserve_line_settings() {
        use nix::{
            fcntl::{FcntlArg, FdFlag, OFlag, fcntl},
            sys::termios::{self, ControlFlags, InputFlags, LocalFlags, SpecialCharacterIndices},
        };
        use serialport::{SerialPort, TTYPort};

        let (_master, mut slave) = TTYPort::pair().unwrap();
        slave.set_exclusive(false).unwrap();
        for (xon, xoff, xany, hupcl, vmin, vtime) in [
            (false, false, false, false, None, None),
            (true, false, true, true, Some(0), Some(0)),
            (false, true, false, true, Some(4), Some(1)),
            (true, true, true, false, Some(255), Some(255)),
        ] {
            let options = NativeOptions {
                path: slave.name().unwrap(),
                lock: false,
                xon,
                xoff,
                xany,
                hupcl,
                vmin,
                vtime,
                ..invalid_path()
            };
            let mut port = open(&options).unwrap();
            assert_eq!(
                crate::platform::set_baud_rate(&mut port, 0)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
            assert_eq!(crate::platform::baud_rate(&port).unwrap(), 115200);
            let flags = OFlag::from_bits_retain(fcntl(&port, FcntlArg::F_GETFL).unwrap());
            assert!(flags.contains(OFlag::O_NONBLOCK));
            let flags = FdFlag::from_bits_retain(fcntl(&port, FcntlArg::F_GETFD).unwrap());
            assert!(flags.contains(FdFlag::FD_CLOEXEC));

            for baud_rate in [115200, 57600] {
                crate::platform::set_baud_rate(&mut port, baud_rate).unwrap();
                assert_eq!(crate::platform::baud_rate(&port).unwrap(), baud_rate);
                let settings = termios::tcgetattr(&port).unwrap();
                assert_eq!(settings.input_flags.contains(InputFlags::IXON), xon);
                assert_eq!(settings.input_flags.contains(InputFlags::IXOFF), xoff);
                assert_eq!(settings.input_flags.contains(InputFlags::IXANY), xany);
                assert_eq!(settings.control_flags.contains(ControlFlags::HUPCL), hupcl);
                assert!(
                    !settings
                        .local_flags
                        .intersects(LocalFlags::ICANON | LocalFlags::ECHO)
                );
                assert_eq!(
                    settings.control_chars[SpecialCharacterIndices::VMIN as usize],
                    vmin.unwrap_or(1)
                );
                assert_eq!(
                    settings.control_chars[SpecialCharacterIndices::VTIME as usize],
                    vtime.unwrap_or(0)
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_stop_bits_are_rejected_before_opening() {
        let options = NativeOptions {
            stop_bits: 1.5,
            ..invalid_path()
        };
        assert_eq!(
            open(&options)
                .err()
                .map(|error| error.to_string())
                .as_deref(),
            Some("1.5 stop bits requires Windows")
        );
    }

    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    #[test]
    fn unsupported_parity_is_rejected_before_opening() {
        for parity in ["mark", "space"] {
            let options = NativeOptions {
                parity: parity.into(),
                ..invalid_path()
            };
            assert_eq!(
                open(&options)
                    .err()
                    .map(|error| error.to_string())
                    .as_deref(),
                Some("Mark/space parity is not available on this platform")
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn shared_windows_access_is_rejected_before_opening() {
        let options = NativeOptions {
            lock: false,
            ..invalid_path()
        };
        assert_eq!(
            open(&options)
                .err()
                .map(|error| error.to_string())
                .as_deref(),
            Some("Windows requires exclusive serial access")
        );
    }
}
