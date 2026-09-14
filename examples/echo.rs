// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use mio::{Events, Interest, Poll, Token};
    use mio_serial::{SerialPort, SerialStream};
    use std::io::{self, Read, Write};

    let (mut master, mut slave) = SerialStream::pair()?;
    slave.set_exclusive(false)?;
    let path = slave.name().ok_or("Unnamed pseudo-terminal")?;
    drop(slave);
    println!("{path}");
    io::stdout().flush()?;

    // Wait until the client has opened the slave before polling the master.
    let mut command = String::new();
    if io::stdin().read_line(&mut command)? == 0 {
        return Ok(());
    }
    let mut poll = Poll::new()?;
    let mut events = Events::with_capacity(8);
    poll.registry().register(
        &mut master,
        Token(0),
        Interest::READABLE | Interest::WRITABLE,
    )?;
    println!("ready");
    io::stdout().flush()?;

    let mut buffer = [0; 64 * 1024];
    loop {
        let count = match master.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                poll.poll(&mut events, None)?;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let mut offset = 0;
        while offset < count {
            match master.write(&buffer[offset..count]) {
                Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero).into()),
                Ok(written) => offset += written,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    poll.poll(&mut events, None)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Pseudo-terminal benchmarks require Unix");
    std::process::exit(1);
}
