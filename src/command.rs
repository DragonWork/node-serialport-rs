// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

pub(crate) enum Operation {
    Read(usize),
    ReadCredit { bytes: usize, slots: usize },
    Write(Vec<u8>),
    Update(u32),
    Set(u32),
    Get,
    GetBaudRate,
    Flush,
    Drain,
}

pub(crate) struct Command {
    pub id: u32,
    pub operation: Operation,
}

impl Command {
    pub fn ordered(&self) -> bool {
        !matches!(
            self.operation,
            Operation::Read(_) | Operation::ReadCredit { .. }
        )
    }
}
