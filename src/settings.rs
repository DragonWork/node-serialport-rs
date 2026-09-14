// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use tokio_serial::{DataBits, FlowControl, Parity, SerialStream, StopBits};

use crate::NativeOptions;

pub(crate) fn open(options: &NativeOptions) -> Result<SerialStream, String> {
    let data_bits = match options.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => return Err("Invalid dataBits".into()),
    };
    let stop_bits = match options.stop_bits {
        1.0 | 1.5 => StopBits::One,
        2.0 => StopBits::Two,
        _ => return Err("Invalid stopBits".into()),
    };
    let parity = match options.parity.as_str() {
        "none" | "mark" | "space" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => return Err("Invalid parity".into()),
    };
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
    let builder = tokio_serial::new(&options.path, options.baud_rate)
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
