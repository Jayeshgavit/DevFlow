//! On-demand local TCP inventory. No shell, network probes or unmanaged termination.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;
use crate::{AppState, ProcessEntry};

static SCANNING: AtomicBool = AtomicBool::new(false);
struct ScanGuard;
impl Drop for ScanGuard { fn drop(&mut self) { SCANNING.store(false, Ordering::Release); } }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listener {
    address: String, family: String, port: u16, pid: u32,
    executable: Option<String>, name: Option<String>, creation_time: Option<String>,
    service_key: Option<String>, run_token: Option<String>, ownership_verified: bool, inspection: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inventory { listeners: Vec<Listener>, errors: Vec<String>, inspected_at: u64 }

#[tauri::command]
pub(crate) async fn inspect_ports(state: State<'_, AppState>) -> Result<Inventory, String> {
    if SCANNING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("A port inspection is already running.".into());
    }
    let guard = ScanGuard;
    #[cfg(windows)] {
        let jobs = state.processes.lock().map_err(|_| "Service registry unavailable")?.iter()
            .filter_map(|(key, entry)| match entry {
                ProcessEntry::Running(run) => Some((key.clone(), run.job.clone())), _ => None,
            }).collect::<Vec<_>>();
        tauri::async_runtime::spawn_blocking(move || { let _guard = guard; inspect(jobs) })
            .await.map_err(|_| "Port inspection was interrupted".to_string())?
    }
    #[cfg(not(windows))] { let _ = (state, guard); Err("Port inspection requires Windows.".into()) }
}

#[cfg(windows)]
fn inspect(jobs: Vec<(String, std::sync::Arc<crate::windows_job::WindowsJob>)>) -> Result<Inventory, String> {
    use std::{collections::HashMap, mem::size_of, net::{Ipv4Addr, Ipv6Addr}, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, ptr, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
    use windows_sys::Win32::{Foundation::FILETIME, NetworkManagement::IpHelper::*, System::Threading::*};
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut result = Inventory { listeners: vec![], errors: vec![], inspected_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 };
    for (family, af) in [("IPv4", 2u32), ("IPv6", 23u32)] {
        // u64 storage provides alignment; the native table is capped at 8 MiB.
        let mut bytes = 0u32;
        let code = unsafe { GetExtendedTcpTable(ptr::null_mut(), &mut bytes, 0, af, TCP_TABLE_OWNER_PID_LISTENER, 0) };
        if code != 122 && code != 0 { result.errors.push(format!("{family} listener inspection failed (Windows {code})")); continue; }
        let mut table = None;
        for _ in 0..3 {
            if bytes < 4 || bytes > 8 * 1024 * 1024 { break; }
            let mut data = vec![0u64; (bytes as usize + 7) / 8];
            let capacity = data.len() * 8;
            let code = unsafe { GetExtendedTcpTable(data.as_mut_ptr().cast(), &mut bytes, 0, af, TCP_TABLE_OWNER_PID_LISTENER, 0) };
            if code == 0 && bytes as usize <= capacity { table = Some((data, bytes as usize)); break; }
            if code != 122 { break; }
        }
        let Some((data, length)) = table else { result.errors.push(format!("{family} listener inspection unavailable or changed too quickly")); continue; };
        let count = unsafe { *data.as_ptr().cast::<u32>() } as usize;
        let row_size = if af == 2 { size_of::<MIB_TCPROW_OWNER_PID>() } else { size_of::<MIB_TCP6ROW_OWNER_PID>() };
        if count > 16384 || 4 + count * row_size > length { result.errors.push(format!("{family} listener table exceeded bounds")); continue; }
        for index in 0..count {
            let p = unsafe { data.as_ptr().cast::<u8>().add(4 + index * row_size) };
            let (address, port, pid) = if af == 2 {
                let row = unsafe { ptr::read_unaligned(p.cast::<MIB_TCPROW_OWNER_PID>()) };
                (Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).to_string(), u16::from_be(row.dwLocalPort as u16), row.dwOwningPid)
            } else {
                let row = unsafe { ptr::read_unaligned(p.cast::<MIB_TCP6ROW_OWNER_PID>()) };
                let ip = Ipv6Addr::from(row.ucLocalAddr);
                (if row.dwLocalScopeId == 0 { ip.to_string() } else { format!("{ip}%{}", row.dwLocalScopeId) }, u16::from_be(row.dwLocalPort as u16), row.dwOwningPid)
            };
            result.listeners.push(Listener { address, family: family.into(), port, pid, executable: None, name: None, creation_time: None, service_key: None, run_token: None, ownership_verified: false, inspection: "Process details unavailable".into() });
        }
    }
    // Open each PID once; creation time, image and Job membership come from the same handle.
    let mut cache = HashMap::new();
    for listener in &mut result.listeners {
        if let Some(details) = cache.get(&listener.pid) {
            let details: &Listener = details;
            listener.executable = details.executable.clone(); listener.name = details.name.clone();
            listener.creation_time = details.creation_time.clone(); listener.service_key = details.service_key.clone();
            listener.run_token = details.run_token.clone(); listener.ownership_verified = details.ownership_verified; listener.inspection = details.inspection.clone(); continue;
        }
        if Instant::now() > deadline { listener.inspection = "Inspection time budget reached; refresh to retry".into(); continue; }
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, listener.pid) };
        if raw.is_null() { listener.inspection = format!("Process exited or Windows denied access: {}", std::io::Error::last_os_error()); }
        else {
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut created = FILETIME::default(); let mut exit = FILETIME::default(); let mut kernel = FILETIME::default(); let mut user = FILETIME::default();
            let mut path = vec![0u16; 32768]; let mut length = path.len() as u32; let mut status = 0;
            let identified = unsafe { GetProcessTimes(handle.as_raw_handle(), &mut created, &mut exit, &mut kernel, &mut user) != 0
                && QueryFullProcessImageNameW(handle.as_raw_handle(), 0, path.as_mut_ptr(), &mut length) != 0
                && GetExitCodeProcess(handle.as_raw_handle(), &mut status) != 0 && status == 259 };
            if identified && (((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) / 10000).saturating_sub(11644473600000) <= result.inspected_at {
                let path = String::from_utf16_lossy(&path[..length as usize]);
                listener.name = path.rsplit('\\').next().map(str::to_string);
                listener.executable = Some(path);
                listener.creation_time = Some(((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64).to_string());
                listener.inspection = "Live process handle: image path and creation time verified. TCP table and process inspection are separate snapshots; refresh before acting.".into();
                listener.ownership_verified = true;
                for (key, job) in &jobs {
                    let membership = job.contains(handle.as_raw_handle());
                    if membership.is_err() { listener.ownership_verified = false; }
                    if membership.unwrap_or(false) {
                        listener.service_key = Some(key.clone());
                        listener.run_token = Some(job.run_token());
                        break;
                    }
                }
            } else { listener.inspection = "Process exited or identity information is inaccessible".into(); }
        }
        cache.insert(listener.pid, listener.clone());
    }
    result.listeners.sort_by_key(|row| (row.port, row.pid, row.address.clone()));
    Ok(result)
}

/// The existing stop path checks this run token under the registry lock.
#[tauri::command]
pub(crate) async fn stop_port_service(state: State<'_, AppState>, service_key: String, run_token: String) -> Result<(), String> {
    crate::stop_owned_service_checked(&state, &service_key, Some(&run_token)).await
}

#[cfg(all(test, windows))]
mod tests {
    #[tokio::test]
    async fn stale_port_run_cannot_stop_missing_or_starting_service() {
        let state = crate::AppState::default();
        let error = crate::stop_owned_service_checked(&state, "project::service", Some("old-run")).await.unwrap_err();
        assert!(error.contains("Service run changed"));
        let (complete, _) = tokio::sync::watch::channel(false);
        let starting = std::sync::Arc::new(crate::Starting { cancelled: std::sync::atomic::AtomicBool::new(false), complete, declared_port: Some(3000) });
        state.processes.lock().unwrap().insert("project::service".into(), crate::ProcessEntry::Starting(starting.clone()));
        assert!(crate::stop_owned_service_checked(&state, "project::service", Some("old-run")).await.is_err());
        assert!(!starting.cancelled.load(std::sync::atomic::Ordering::SeqCst));
    }
}
