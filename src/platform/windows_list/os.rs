// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

use super::{Metadata, registry_string, wide_string};
use crate::PortInfo;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Device_IDW, CM_Get_Parent, CR_SUCCESS, DICS_FLAG_GLOBAL, DIGCF_PRESENT, DIREG_DEV,
    GUID_DEVCLASS_MODEM, GUID_DEVCLASS_PORTS, HDEVINFO, MAX_DEVICE_ID_LEN, SP_DEVINFO_DATA,
    SPDRP_FRIENDLYNAME, SPDRP_LOCATION_INFORMATION, SPDRP_MFG, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDeviceRegistryPropertyW, SetupDiOpenDevRegKey,
};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Registry::{HKEY, KEY_QUERY_VALUE, RegCloseKey, RegQueryValueExW};

struct DeviceSet(HDEVINFO);

impl Drop for DeviceSet {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the valid set returned by SetupDiGetClassDevsW.
        unsafe { SetupDiDestroyDeviceInfoList(self.0) };
    }
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the valid key returned by SetupDiOpenDevRegKey.
        unsafe { RegCloseKey(self.0) };
    }
}

fn port_name(set: &DeviceSet, device: &SP_DEVINFO_DATA) -> Option<String> {
    // SAFETY: device belongs to this live set; the key is opened for querying only.
    let key = unsafe {
        SetupDiOpenDevRegKey(
            set.0,
            device,
            DICS_FLAG_GLOBAL,
            0,
            DIREG_DEV,
            KEY_QUERY_VALUE,
        )
    };
    if key == INVALID_HANDLE_VALUE {
        return None;
    }
    let key = RegistryKey(key);
    registry_string(|buffer, kind, size| {
        *size = std::mem::size_of_val(buffer) as u32;
        let data = if buffer.is_empty() {
            null_mut()
        } else {
            buffer.as_mut_ptr().cast()
        };
        // SAFETY: the key is live, the name is NUL-terminated, and size describes
        // the writable buffer in bytes (or a null buffer for the size probe).
        (unsafe {
            RegQueryValueExW(
                key.0,
                windows_sys::core::w!("PortName"),
                null(),
                kind,
                data,
                size,
            )
        }) == ERROR_SUCCESS
    })
}

fn property(set: &DeviceSet, device: &SP_DEVINFO_DATA, property: u32) -> Option<String> {
    registry_string(|buffer, kind, size| {
        let data = if buffer.is_empty() {
            null_mut()
        } else {
            buffer.as_mut_ptr().cast()
        };
        // SAFETY: device belongs to this live set; data is writable for the
        // supplied byte count and all output pointers remain valid for the call.
        (unsafe {
            SetupDiGetDeviceRegistryPropertyW(
                set.0,
                device,
                property,
                kind,
                data,
                std::mem::size_of_val(buffer) as u32,
                size,
            )
        }) != 0
    })
}

fn instance_id(set: &DeviceSet, device: &SP_DEVINFO_DATA) -> Option<String> {
    // Windows bounds device instance IDs by MAX_DEVICE_ID_LEN, including NUL.
    let mut buffer = [0u16; MAX_DEVICE_ID_LEN as usize];
    // SAFETY: device belongs to the set and the buffer length is in UTF-16 characters.
    let ok = unsafe {
        SetupDiGetDeviceInstanceIdW(
            set.0,
            device,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            null_mut(),
        )
    };
    (ok != 0).then(|| wide_string(&buffer)).flatten()
}

fn parent_id(device: &SP_DEVINFO_DATA) -> Option<String> {
    let mut parent = 0;
    // SAFETY: DevInst came from SetupAPI and parent is a writable output value.
    if unsafe { CM_Get_Parent(&mut parent, device.DevInst, 0) } != CR_SUCCESS {
        return None;
    }
    let mut buffer = [0u16; MAX_DEVICE_ID_LEN as usize];
    // SAFETY: parent is a returned device instance and buffer is writable for
    // the given character count. Device removal is reported as a failed lookup.
    let status = unsafe { CM_Get_Device_IDW(parent, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    (status == CR_SUCCESS)
        .then(|| wide_string(&buffer))
        .flatten()
}

pub(crate) fn enrich(ports: &mut [PortInfo]) {
    if ports.is_empty() {
        return;
    }
    // Match the serialport crate's Ports and Modem classes. Enrichment never adds
    // or removes ports, including its registry-only fallback devices.
    for class in [GUID_DEVCLASS_PORTS, GUID_DEVCLASS_MODEM] {
        // SAFETY: class is an SDK GUID; optional filters and window are null.
        let handle = unsafe { SetupDiGetClassDevsW(&class, null(), null_mut(), DIGCF_PRESENT) };
        if handle == INVALID_HANDLE_VALUE as HDEVINFO {
            continue;
        }
        let set = DeviceSet(handle);
        for index in 0..u32::MAX {
            let mut device = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            // SAFETY: the set is live and device is a correctly sized writable structure.
            if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut device) } == 0 {
                break;
            }
            let Some(name) = port_name(&set, &device) else {
                continue;
            };
            let Some(port) = ports
                .iter_mut()
                .find(|port| port.path.eq_ignore_ascii_case(&name))
            else {
                continue;
            };
            Metadata {
                pnp_id: instance_id(&set, &device),
                parent_id: parent_id(&device),
                manufacturer: property(&set, &device, SPDRP_MFG),
                location_id: property(&set, &device, SPDRP_LOCATION_INFORMATION),
                friendly_name: property(&set, &device, SPDRP_FRIENDLYNAME),
            }
            .apply(port);
        }
    }
    // Normalize fallback USB IDs even if the extra metadata was inaccessible.
    for port in ports {
        Metadata::default().apply(port);
    }
}
