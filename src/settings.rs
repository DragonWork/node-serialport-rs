// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use serialport::{DataBits, FlowControl, Parity, StopBits};

use crate::{NativeOptions, platform::SerialStream};

pub(crate) fn open(options: &NativeOptions) -> Result<SerialStream, String> {
    let data_bits = match options.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => {
            return Err("Invalid dataBits".into());
        }
    };
    let stop_bits = match options.stop_bits {
        1.0 | 1.5 => StopBits::One,
        2.0 => StopBits::Two,
        _ => {
            return Err("Invalid stopBits".into());
        }
    };
    let parity = match options.parity.as_str() {
        "none" | "mark" | "space" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => {
            return Err("Invalid parity".into());
        }
    };
    // Reject unsupported settings before opening a device can change its state.
    #[cfg(unix)]
    if options.stop_bits == 1.5 {
        return Err("1.5 stop bits requires Windows".into());
    }
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    if matches!(options.parity.as_str(), "mark" | "space") {
        return Err("Mark/space parity is not available on this platform".into());
    }
    #[cfg(windows)]
    if !options.lock {
        return Err("Windows requires exclusive serial access".into());
    }
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
        .flow_control(flow);
    #[cfg(unix)]
    let builder = builder.exclusive(options.lock);
    let mut port = crate::platform::open(&builder).map_err(|error| error.to_string())?;
    crate::platform::configure(&port, options).map_err(|error| error.to_string())?;
    // Reapply custom speeds after changing the platform termios/DCB flags.
    crate::platform::set_baud_rate(&mut port, options.baud_rate)
        .map_err(|error| error.to_string())?;
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
            xon: false,
            xoff: false,
            xany: false,
            hupcl: true,
        }
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
        for (xon, xoff, xany, hupcl) in [
            (false, false, false, false),
            (true, false, true, true),
            (false, true, false, true),
            (true, true, true, false),
        ] {
            let options = NativeOptions {
                path: slave.name().unwrap(),
                lock: false,
                xon,
                xoff,
                xany,
                hupcl,
                ..invalid_path()
            };
            let mut port = open(&options).unwrap();
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
                    1
                );
                assert_eq!(
                    settings.control_chars[SpecialCharacterIndices::VTIME as usize],
                    0
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
            open(&options).err().as_deref(),
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
                open(&options).err().as_deref(),
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
            open(&options).err().as_deref(),
            Some("Windows requires exclusive serial access")
        );
    }
}
