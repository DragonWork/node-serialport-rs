// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
use mio_serial::{SerialPort, SerialStream};
#[cfg(unix)]
use std::io::{self, BufRead, Read, Write};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (mut master, mut slave) = SerialStream::pair()?;
    slave.set_exclusive(false)?;
    let path = slave.name().ok_or("Unnamed pseudo-terminal")?;
    drop(slave);
    println!("{path}");
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let (op, value) = line.split_once(' ').unwrap_or((&line, ""));
        match op {
            "write" => {
                if !value.is_ascii() || value.len() % 2 != 0 {
                    return Err("Invalid hexadecimal data".into());
                }
                let bytes: Result<Vec<_>, _> = (0..value.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&value[i..i + 2], 16))
                    .collect();
                let bytes = bytes?;
                let mut offset = 0;
                while offset < bytes.len() {
                    match master.write(&bytes[offset..]) {
                        Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero).into()),
                        Ok(count) => offset += count,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                println!("ok");
            }
            "read" => {
                let mut bytes = vec![0; value.parse::<usize>()?];
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut offset = 0;
                while offset < bytes.len() {
                    match master.read(&mut bytes[offset..]) {
                        Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into()),
                        Ok(count) => offset += count,
                        Err(error)
                            if error.kind() == io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                for byte in bytes {
                    print!("{byte:02x}");
                }
                println!();
            }
            "hangup" => break,
            _ => return Err("Unknown command".into()),
        }
        io::stdout().flush()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Pseudo-terminal tests require Unix");
    std::process::exit(1);
}
