// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use crate::PortInfo;

#[cfg(windows)]
mod os;
#[cfg(windows)]
pub(crate) use os::enrich;

#[derive(Default)]
struct Metadata {
    pnp_id: Option<String>,
    parent_id: Option<String>,
    manufacturer: Option<String>,
    location_id: Option<String>,
    friendly_name: Option<String>,
}

impl Metadata {
    fn apply(self, port: &mut PortInfo) {
        if let Some(value) = self.manufacturer {
            port.manufacturer = Some(value);
        }
        if let Some(value) = self.location_id {
            port.location_id = Some(value);
        }
        if let Some(value) = self.friendly_name {
            port.friendly_name = Some(value);
        }
        if let Some(id) = self.pnp_id {
            if let Some(usb) = usb_identity(&id) {
                port.vendor_id = Some(usb.vendor.to_ascii_uppercase());
                port.product_id = Some(usb.product.to_ascii_uppercase());
                let parent = self.parent_id.as_deref().and_then(usb_identity);
                let serial = parent
                    .filter(|parent| {
                        usb.use_parent
                            && parent.vendor.eq_ignore_ascii_case(usb.vendor)
                            && parent.product.eq_ignore_ascii_case(usb.product)
                    })
                    .map_or(usb.serial, |parent| parent.serial);
                port.serial_number = Some(serial.to_owned());
            }
            port.pnp_id = Some(id);
        }
        // Keep Windows' spelling even if the optional SetupAPI lookups failed.
        for value in [&mut port.vendor_id, &mut port.product_id]
            .into_iter()
            .flatten()
        {
            value.make_ascii_uppercase();
        }
    }
}

struct UsbIdentity<'a> {
    vendor: &'a str,
    product: &'a str,
    serial: &'a str,
    use_parent: bool,
}

fn usb_identity(id: &str) -> Option<UsbIdentity<'_>> {
    let (bus, rest) = id.split_once('\\')?;
    let (device, instance) = rest.split_once('\\')?;
    let ftdi = bus.eq_ignore_ascii_case("FTDIBUS");
    if (!ftdi && !bus.eq_ignore_ascii_case("USB")) || instance.contains('\\') {
        return None;
    }
    let mut fields = device.split(['&', '+']);
    let vendor = fields.next()?.strip_prefix("VID_")?;
    let product = fields.next()?.strip_prefix("PID_")?;
    if [vendor, product]
        .iter()
        .any(|value| value.len() != 4 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return None;
    }
    // SerialPort's FTDI fallback removes the optional channel-A suffix. A
    // matching parent USB instance supplies the authoritative serial instead.
    let serial = if ftdi {
        let value = fields.next()?;
        value
            .strip_suffix('A')
            .filter(|value| !value.is_empty())
            .unwrap_or(value)
    } else {
        instance
    };
    if serial.is_empty() {
        return None;
    }
    Some(UsbIdentity {
        vendor,
        product,
        serial,
        use_parent: ftdi || fields.any(|field| field.starts_with("MI_")),
    })
}

// Registry property sizes are bytes, while the buffers hold UTF-16 code units.
// Missing, malformed or oversized optional properties must not fail list().
fn registry_string(
    mut query: impl FnMut(&mut [u16], &mut u32, &mut u32) -> bool,
) -> Option<String> {
    let mut kind = 0;
    let mut size = 0;
    query(&mut [], &mut kind, &mut size);
    if size == 0 || size > 64 * 1024 || size % 2 != 0 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize / 2];
    if !query(&mut buffer, &mut kind, &mut size) || kind != 1 /* REG_SZ */ || size % 2 != 0 {
        return None;
    }
    wide_string(buffer.get(..size as usize / 2)?)
}

fn wide_string(buffer: &[u16]) -> Option<String> {
    let end = buffer
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(buffer.len());
    (end != 0).then(|| String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ch340_matches_serialport_metadata_without_truncating_the_instance() {
        let mut port = PortInfo {
            path: "COM14".into(),
            serial_number: Some("7".into()),
            ..Default::default()
        };
        Metadata {
            pnp_id: Some(r"USB\VID_1A86&PID_7523\7&33129A7&1&3".into()),
            manufacturer: Some("wch.cn".into()),
            location_id: Some("Port_#0003.Hub_#0006".into()),
            friendly_name: Some("USB-SERIAL CH340 (COM14)".into()),
            ..Default::default()
        }
        .apply(&mut port);
        assert_eq!(port.path, "COM14");
        assert_eq!(
            port.pnp_id.as_deref(),
            Some(r"USB\VID_1A86&PID_7523\7&33129A7&1&3")
        );
        assert_eq!(port.serial_number.as_deref(), Some("7&33129A7&1&3"));
        assert_eq!(port.vendor_id.as_deref(), Some("1A86"));
        assert_eq!(port.product_id.as_deref(), Some("7523"));
        assert_eq!(port.manufacturer.as_deref(), Some("wch.cn"));
        assert_eq!(port.location_id.as_deref(), Some("Port_#0003.Hub_#0006"));
        assert_eq!(
            port.friendly_name.as_deref(),
            Some("USB-SERIAL CH340 (COM14)")
        );
    }

    #[test]
    fn composite_and_ftdi_ports_use_only_a_matching_usb_parent() {
        for (id, parent, expected) in [
            (
                r"USB\VID_1D50&PID_6018&MI_02\6&A694CA9&0&0002",
                Some(r"USB\VID_1D50&PID_6018\serial-123"),
                "serial-123",
            ),
            (
                r"USB\VID_1D50&PID_6018&MI_02\6&A694CA9&0&0002",
                Some(r"USB\VID_1234&PID_0001\hub-serial"),
                "6&A694CA9&0&0002",
            ),
            (
                r"USB\VID_1D50&PID_6018&MI_02\6&A694CA9&0&0002",
                None,
                "6&A694CA9&0&0002",
            ),
            (
                r"FTDIBUS\VID_0403+PID_6001+A702TB52A\0000",
                Some(r"USB\VID_0403&PID_6001\A702TB52"),
                "A702TB52",
            ),
            (
                r"FTDIBUS\VID_0403+PID_6001+A702TB52A\0000",
                None,
                "A702TB52",
            ),
        ] {
            let mut port = PortInfo::default();
            Metadata {
                pnp_id: Some(id.into()),
                parent_id: parent.map(str::to_owned),
                ..Default::default()
            }
            .apply(&mut port);
            assert_eq!(port.serial_number.as_deref(), Some(expected), "{id}");
        }
    }

    #[test]
    fn bluetooth_ports_keep_non_usb_metadata_and_missing_properties_keep_fallbacks() {
        let mut port = PortInfo::default();
        Metadata {
            pnp_id: Some(r"BTHENUM\{00001101-0000-1000-8000-00805f9b34fb}\device".into()),
            manufacturer: Some("Microsoft".into()),
            friendly_name: Some("Standard Serial over Bluetooth link (COM8)".into()),
            ..Default::default()
        }
        .apply(&mut port);
        assert!(port.pnp_id.as_ref().unwrap().starts_with("BTHENUM\\"));
        assert_eq!(port.manufacturer.as_deref(), Some("Microsoft"));
        assert!(port.friendly_name.is_some());
        assert!(port.vendor_id.is_none());
        assert!(port.product_id.is_none());
        assert!(port.serial_number.is_none());
        assert!(port.location_id.is_none());
        Metadata::default().apply(&mut port);
        assert_eq!(port.manufacturer.as_deref(), Some("Microsoft"));
        assert!(port.pnp_id.is_some());
        assert!(port.friendly_name.is_some());
    }

    #[test]
    fn malformed_or_non_usb_identifiers_do_not_invent_usb_fields() {
        for id in [
            "",
            "USB",
            r"USB\VID_12&PID_3456\id",
            r"USB\VID_1234&PID_ZZZZ\id",
            r"USB\VID_1234&PID_3456\",
            r"USB\VID_1234&PID_3456\id\extra",
            r"ACPI\PNP0501\0",
            "USB\\VID_é💻&PID_3456\\id",
        ] {
            assert!(usb_identity(id).is_none(), "{id}");
        }
    }

    #[test]
    fn registry_strings_support_long_unicode_names_and_byte_sized_lengths() {
        let expected = format!("{} 串口 🦀", "Serial adapter".repeat(40));
        let data: Vec<_> = expected.encode_utf16().chain([0]).collect();
        let result = registry_string(|buffer, kind, size| {
            *kind = 1;
            *size = (data.len() * 2) as u32;
            if buffer.is_empty() {
                return false;
            }
            buffer.copy_from_slice(&data);
            true
        });
        assert_eq!(result.as_deref(), Some(expected.as_str()));
        assert_eq!(wide_string(&[65, 0, 66]), Some("A".into()));
        assert_eq!(wide_string(&[65]), Some("A".into()));
        assert_eq!(wide_string(&[0]), None);
    }

    #[test]
    fn unreadable_or_malformed_registry_properties_are_optional() {
        for (kind, size, readable) in [
            (1, 0, true),
            (1, 3, true),
            (1, 65538, true),
            (7, 4, true),
            (1, 4, false),
        ] {
            assert!(
                registry_string(|_, actual_kind, actual_size| {
                    *actual_kind = kind;
                    *actual_size = size;
                    readable
                })
                .is_none()
            );
        }
        // A property that grows between the size probe and read must be ignored safely.
        assert!(
            registry_string(|buffer, kind, size| {
                *kind = 1;
                *size = if buffer.is_empty() { 4 } else { 8 };
                true
            })
            .is_none()
        );
    }
}
