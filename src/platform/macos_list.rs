// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#[cfg(target_os = "macos")]
pub(crate) fn location_id(location: &serialport::Location) -> Option<String> {
    format_location(location.bus_id(), location.port_chain())
}

fn format_location(bus: &str, ports: &[u8]) -> Option<String> {
    // serialport decodes the IOKit locationID into a bus byte and six port
    // nibbles, dropping trailing zeroes. Restore SerialPort's %08x spelling.
    let bus: u8 = bus.parse().ok()?;
    if ports.len() > 6 || ports.iter().any(|&port| port > 15) {
        return None;
    }
    let mut id = u32::from(bus) << 24;
    for (index, &port) in ports.iter().enumerate() {
        id |= u32::from(port) << (20 - index * 4);
    }
    Some(format!("{id:08x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_match_serialports_eight_digit_hex_format() {
        for (bus, ports, expected) in [
            ("20", &[3, 2][..], "14320000"),
            ("1", &[2][..], "01200000"),
            ("18", &[0, 3][..], "12030000"),
            ("255", &[15, 15, 15, 15, 15, 15][..], "ffffffff"),
            ("0", &[][..], "00000000"),
        ] {
            assert_eq!(format_location(bus, ports).as_deref(), Some(expected));
        }
    }

    #[test]
    fn invalid_locations_are_unavailable_instead_of_truncated() {
        for (bus, ports) in [
            ("256", &[1][..]),
            ("not a bus", &[1][..]),
            ("1", &[16][..]),
            ("1", &[1, 2, 3, 4, 5, 6, 7][..]),
        ] {
            assert!(format_location(bus, ports).is_none());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn iokit_location_decoding_round_trips_through_the_dependency() {
        for id in [0, 0x01200000, 0x12030000, 0x14320000, 0xffffffff] {
            let location = serialport::Location::from_location_id(id);
            assert_eq!(location_id(&location), Some(format!("{id:08x}")));
        }
    }
}
