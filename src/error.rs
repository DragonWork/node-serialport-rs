// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use std::io;

pub(crate) struct ErrorDetails {
    pub message: String,
    pub code: &'static str,
    pub errno: Option<i32>,
}

impl From<io::Error> for ErrorDetails {
    fn from(error: io::Error) -> Self {
        Self {
            message: error.to_string(),
            code: code(&error),
            errno: error.raw_os_error(),
        }
    }
}

fn code(error: &io::Error) -> &'static str {
    use io::ErrorKind::*;
    match error.kind() {
        NotFound => "ERR_SERIALPORT_NOT_FOUND",
        PermissionDenied => "ERR_SERIALPORT_PERMISSION_DENIED",
        InvalidInput | InvalidData => "ERR_SERIALPORT_INVALID_ARGUMENT",
        ResourceBusy | WouldBlock => "ERR_SERIALPORT_BUSY",
        TimedOut => "ERR_SERIALPORT_TIMED_OUT",
        Unsupported => "ERR_SERIALPORT_UNSUPPORTED",
        BrokenPipe | NotConnected | ConnectionAborted | ConnectionReset | UnexpectedEof
        | WriteZero => "ERR_SERIALPORT_DISCONNECTED",
        _ => "ERR_SERIALPORT_IO",
    }
}

pub(crate) fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_preserve_error_categories_and_messages() {
        for (kind, expected) in [
            (io::ErrorKind::NotFound, "ERR_SERIALPORT_NOT_FOUND"),
            (
                io::ErrorKind::PermissionDenied,
                "ERR_SERIALPORT_PERMISSION_DENIED",
            ),
            (
                io::ErrorKind::InvalidInput,
                "ERR_SERIALPORT_INVALID_ARGUMENT",
            ),
            (io::ErrorKind::ResourceBusy, "ERR_SERIALPORT_BUSY"),
            (io::ErrorKind::TimedOut, "ERR_SERIALPORT_TIMED_OUT"),
            (io::ErrorKind::Unsupported, "ERR_SERIALPORT_UNSUPPORTED"),
            (io::ErrorKind::BrokenPipe, "ERR_SERIALPORT_DISCONNECTED"),
            (io::ErrorKind::Other, "ERR_SERIALPORT_IO"),
        ] {
            let details = ErrorDetails::from(io::Error::new(kind, "driver detail"));
            assert_eq!(details.code, expected);
            assert_eq!(details.message, "driver detail");
            assert_eq!(details.errno, None);
        }
    }

    #[test]
    fn details_retain_available_os_error_numbers() {
        let details = ErrorDetails::from(io::Error::from_raw_os_error(12345));
        assert_eq!(details.errno, Some(12345));
        assert!(!details.message.is_empty());
    }
}
