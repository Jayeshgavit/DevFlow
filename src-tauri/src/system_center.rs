//! Least-privilege Windows monitoring. No arbitrary commands or deletion paths.
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, mem::size_of, os::windows::{ffi::{OsStrExt, OsStringExt}, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, path::{Path, PathBuf}, ptr, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, State};
use windows_sys::Win32::{Foundation::*, Security::*, Storage::FileSystem::*, System::{Com::CoTaskMemFree, Diagnostics::ToolHelp::*, JobObjects::IsProcessInJob, Performance::*, ProcessStatus::*, SystemInformation::*, Threading::*}, UI::Shell::*};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessInfo {
    pid: u32, name: String, path: Option<String>, created: Option<String>,
    cpu: Option<f64>, memory: Option<u64>, deny_reason: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriveInfo { name: String, total: Option<u64>, free: Option<u64>, error: Option<String> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuInfo { name: String, utilization: Option<f64>, dedicated_used: Option<u64>, dedicated_total: Option<u64>, shared_used: Option<u64>, shared_total: Option<u64>, note: Option<String> }
#[derive(Clone)]
struct GpuAdapter { luid: u64, name: String, dedicated_total: Option<u64>, shared_total: Option<u64> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    sampled_at: u64, cpu: Option<f64>, cpu_name: String, logical_processors: u32,
    memory_total: u64, memory_available: u64, uptime_seconds: u64,
    processes: Vec<ProcessInfo>, drives: Vec<DriveInfo>, drives_age_seconds: u64, drives_error: Option<String>,
    gpus: Vec<GpuInfo>, gpu_error: Option<String>,
}
#[derive(Default)]
struct MonitorCache {
    sampled: Option<Instant>, cpu_ticks: Option<(u64, u64)>,
    process_ticks: HashMap<(u32, u64), u64>, processes: Vec<ProcessInfo>,
    drives: Vec<DriveInfo>, drives_sampled: Option<Instant>, drives_error: Option<String>,
    gpu_adapters: Vec<GpuAdapter>, gpu_counters: Option<GpuCounters>, gpu_error: Option<String>,
}
struct GpuCounters { query: PDH_HQUERY, engines: Option<PDH_HCOUNTER>, dedicated: Option<PDH_HCOUNTER>, shared: Option<PDH_HCOUNTER>, limitations: Vec<String> }
unsafe impl Send for GpuCounters {}
impl Drop for GpuCounters { fn drop(&mut self) { unsafe { PdhCloseQuery(self.query); } } }
#[derive(Default)]
pub(crate) struct SystemCenter {
    monitor: Arc<Mutex<MonitorCache>>,
    maintenance: Arc<Mutex<()>>,
    scan: Arc<Mutex<Option<Scan>>>,
    cancel: Arc<AtomicBool>,
}
fn os_error(context: &str) -> String { format!("{context}: {}", std::io::Error::last_os_error()) }
fn wide(path: &Path) -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() }
fn owned(handle: HANDLE) -> Result<OwnedHandle, String> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE { Err(os_error("Windows access failed")) }
    else { Ok(unsafe { OwnedHandle::from_raw_handle(handle) }) }
}
fn ticks(value: FILETIME) -> u64 { ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64 }
fn process_times(handle: HANDLE) -> Result<(u64, u64), String> {
    let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 { return Err(os_error("Cannot read process identity")); }
    Ok((ticks(created), ticks(kernel).saturating_add(ticks(user))))
}
fn process_path(handle: HANDLE) -> Result<String, String> {
    let mut buffer = vec![0u16; 32768]; let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 { return Err(os_error("Executable path unavailable")); }
    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}
fn user_token(handle: HANDLE) -> Result<Vec<usize>, String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 { return Err(os_error("Cannot verify process owner")); }
    let token = owned(token)?; let mut needed = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, ptr::null_mut(), 0, &mut needed); }
    if needed == 0 || needed > 65536 { return Err("Process owner is unavailable".into()); }
    // usize storage keeps TOKEN_USER aligned; embedded SID lives in this buffer.
    let mut data = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, data.as_mut_ptr().cast(), needed, &mut needed) } == 0 { return Err(os_error("Cannot verify process owner")); }
    Ok(data)
}
fn same_user(handle: HANDLE) -> Result<(), String> {
    let process = user_token(handle)?; let current = user_token(unsafe { GetCurrentProcess() })?;
    let left = unsafe { &*(process.as_ptr() as *const TOKEN_USER) }; let right = unsafe { &*(current.as_ptr() as *const TOKEN_USER) };
    if unsafe { EqualSid(left.User.Sid, right.User.Sid) } == 0 { return Err("Another user's process; End Task is disabled".into()); }
    Ok(())
}
fn devflow_family() -> Result<HashSet<u32>, String> {
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 { return Err(os_error("Cannot verify DevFlow process family")); }
    let mut parents = HashMap::new();
    loop {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            if unsafe { GetLastError() } != ERROR_NO_MORE_FILES { return Err(os_error("Cannot verify DevFlow process family")); }
            break;
        }
    }
    let own = std::process::id(); let mut family = HashSet::from([own]);
    // Also protect the host/launcher ancestors and WebView/other DevFlow children.
    let mut ancestor = own;
    while let Some(parent) = parents.get(&ancestor) { if *parent == 0 || !family.insert(*parent) { break; } ancestor = *parent; }
    for pid in parents.keys() {
        let mut cursor = *pid; let mut visited = HashSet::new();
        while visited.insert(cursor) {
            if cursor == own { family.insert(*pid); break; }
            match parents.get(&cursor) { Some(parent) if *parent != 0 => cursor = *parent, _ => break }
        }
    }
    Ok(family)
}
fn system_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() { return Err(os_error("Windows system directory unavailable")); }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length])))
}
fn eligible(handle: HANDLE, pid: u32, path: &str, family: &HashSet<u32>) -> Result<(), String> {
    if pid <= 4 || family.contains(&pid) { return Err("Windows, DevFlow, or its host/process family; cannot end task".into()); }
    same_user(handle)?;
    let mut critical = 0;
    if unsafe { IsProcessCritical(handle, &mut critical) } == 0 || critical != 0 { return Err("Critical status unavailable or system-critical process".into()); }
    let mut protection = PROCESS_PROTECTION_LEVEL_INFORMATION::default();
    if unsafe { GetProcessInformation(handle, ProcessProtectionLevelInfo, (&mut protection as *mut PROCESS_PROTECTION_LEVEL_INFORMATION).cast(), size_of::<PROCESS_PROTECTION_LEVEL_INFORMATION>() as u32) } == 0 || protection.ProtectionLevel != PROTECTION_LEVEL_NONE { return Err("Protected process or protection status unavailable".into()); }
    let mut in_job = 0;
    if unsafe { IsProcessInJob(handle, ptr::null_mut(), &mut in_job) } == 0 { return Err("Job membership unavailable; cannot end task".into()); }
    if in_job != 0 { return Err("Job-managed process. For DevFlow services use Projects → Stop; generic End Task is disabled".into()); }
    // Windows-owned service tokens are also rejected by the current-user SID check.
    let system = system_directory()?;
    let windows = system.parent().ok_or("Windows directory unavailable")?.to_string_lossy().to_lowercase();
    if path.to_lowercase().starts_with(&(windows + "\\")) { return Err("Windows executable; End Task is disabled".into()); }
    Ok(())
}
fn cpu_name() -> String {
    #[cfg(target_arch = "x86_64")]
    {
        use std::arch::x86_64::__cpuid;
        if __cpuid(0x80000000).eax >= 0x80000004 {
            let mut bytes = Vec::new();
            for leaf in 0x80000002..=0x80000004 { let r = __cpuid(leaf); for n in [r.eax, r.ebx, r.ecx, r.edx] { bytes.extend_from_slice(&n.to_le_bytes()); } }
            return String::from_utf8_lossy(&bytes).trim_matches('\0').trim().to_string();
        }
    }
    std::env::consts::ARCH.into()
}
fn drives() -> Result<Vec<DriveInfo>, String> {
    let mask = unsafe { GetLogicalDrives() }; let mut result = Vec::new();
    if mask == 0 { return Err(os_error("Local drive enumeration failed")); }
    for letter in 0..26 {
        if mask & (1 << letter) == 0 { continue; }
        let name = format!("{}:\\", (b'A' + letter as u8) as char); let path = wide(Path::new(&name));
        if unsafe { GetDriveTypeW(path.as_ptr()) } != 3 { continue; } // DRIVE_FIXED: no network/removable probe.
        let (mut available, mut total, mut free) = (0, 0, 0);
        let ok = unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, &mut total, &mut free) } != 0;
        result.push(DriveInfo { name, total: ok.then_some(total), free: ok.then_some(free), error: (!ok).then(|| os_error("Drive unavailable")) });
    }
    Ok(result)
}
fn dxgi_adapters() -> Result<Vec<GpuAdapter>, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND};
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(|error| format!("DXGI factory unavailable: {error}"))?;
    let mut adapters = Vec::new(); let mut seen = HashSet::new();
    for index in 0..64 {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(format!("DXGI adapter enumeration failed: {error}")),
        };
        let desc = unsafe { adapter.GetDesc1() }.map_err(|error| format!("DXGI adapter details unavailable: {error}"))?;
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 { continue; }
        let end = desc.Description.iter().position(|value| *value == 0).unwrap_or(desc.Description.len());
        let luid = ((desc.AdapterLuid.HighPart as u32 as u64) << 32) | desc.AdapterLuid.LowPart as u64;
        let name = String::from_utf16_lossy(&desc.Description[..end]).trim().to_string();
        if name.is_empty() || !seen.insert(luid) { continue; }
        adapters.push(GpuAdapter { luid, name, dedicated_total: (desc.DedicatedVideoMemory > 0).then_some(desc.DedicatedVideoMemory as u64), shared_total: (desc.SharedSystemMemory > 0).then_some(desc.SharedSystemMemory as u64) });
    }
    if adapters.is_empty() { Err("DXGI reported no hardware display adapters".into()) } else { Ok(adapters) }
}
impl GpuCounters {
    fn open() -> Result<Self, String> {
        let mut query = ptr::null_mut();
        let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
        if status != ERROR_SUCCESS { return Err(format!("GPU performance query unavailable (PDH {status:#x})")); }
        let add = |path: &str| {
            let path: Vec<u16> = format!("{path}\0").encode_utf16().collect(); let mut counter = ptr::null_mut();
            let status = unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) };
            (status == ERROR_SUCCESS).then_some(counter).ok_or(status)
        };
        let engine = add("\\GPU Engine(*)\\Utilization Percentage");
        let dedicated = add("\\GPU Adapter Memory(*)\\Dedicated Usage");
        let shared = add("\\GPU Adapter Memory(*)\\Shared Usage");
        if engine.is_err() && dedicated.is_err() && shared.is_err() {
            unsafe { PdhCloseQuery(query); }
            return Err(format!("GPU performance counters unavailable (engine {:#x}, dedicated {:#x}, shared {:#x})", engine.unwrap_err(), dedicated.unwrap_err(), shared.unwrap_err()));
        }
        let mut limitations = Vec::new();
        if let Err(status) = engine { limitations.push(format!("utilization counter unavailable (PDH {status:#x})")); }
        if let Err(status) = dedicated { limitations.push(format!("dedicated-memory counter unavailable (PDH {status:#x})")); }
        if let Err(status) = shared { limitations.push(format!("shared-memory counter unavailable (PDH {status:#x})")); }
        Ok(Self { query, engines: engine.ok(), dedicated: dedicated.ok(), shared: shared.ok(), limitations })
    }
    fn collect(&self) -> Result<(HashMap<u64, f64>, HashMap<u64, u64>, HashMap<u64, u64>, Option<String>), String> {
        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != ERROR_SUCCESS { return Err(format!("GPU performance sample failed (PDH {status:#x})")); }
        let mut limitations = self.limitations.clone();
        let mut values = |counter: Option<PDH_HCOUNTER>, metric: &str| match counter {
            Some(counter) => pdh_values(counter).unwrap_or_else(|error| { limitations.push(format!("{metric}: {error}")); Vec::new() }),
            None => Vec::new(),
        };
        let engine_items = values(self.engines, "utilization");
        let dedicated_items = values(self.dedicated, "dedicated memory");
        let shared_items = values(self.shared, "shared memory");
        let mut engines: HashMap<(u64, u32, u32), f64> = HashMap::new();
        for (name, value) in engine_items {
            if let (Some(luid), Some(physical), Some(engine)) = (instance_luid(&name), instance_number(&name, "phys"), instance_number(&name, "eng")) {
                *engines.entry((luid, physical, engine)).or_default() += value.max(0.0);
            }
        }
        let mut utilization: HashMap<u64, f64> = HashMap::new();
        for ((luid, _, _), value) in engines { utilization.entry(luid).and_modify(|current| *current = current.max(value)).or_insert(value); }
        utilization.values_mut().for_each(|value| *value = value.clamp(0.0, 100.0));
        let aggregate_memory = |items: Vec<(String, f64)>| {
            let mut nodes: HashMap<(u64, u32), u64> = HashMap::new();
            for (name, value) in items { if let (Some(luid), Some(physical)) = (instance_luid(&name), instance_number(&name, "phys")) { nodes.entry((luid, physical)).and_modify(|current| *current = (*current).max(value.max(0.0) as u64)).or_insert(value.max(0.0) as u64); } }
            let mut adapters = HashMap::new();
            for ((luid, _), value) in nodes { let total = adapters.entry(luid).or_insert(0u64); *total = total.saturating_add(value); }
            adapters
        };
        Ok((utilization, aggregate_memory(dedicated_items), aggregate_memory(shared_items), (!limitations.is_empty()).then(|| limitations.join("; "))))
    }
}
fn pdh_values(counter: PDH_HCOUNTER) -> Result<Vec<(String, f64)>, String> {
    let mut bytes = 0; let mut count = 0;
    let status = unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut bytes, &mut count, ptr::null_mut()) };
    if status != PDH_MORE_DATA { return Err(format!("GPU counter data unavailable (PDH {status:#x})")); }
    let mut storage = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    let status = unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut bytes, &mut count, storage.as_mut_ptr().cast()) };
    if status != ERROR_SUCCESS { return Err(format!("GPU counter formatting failed (PDH {status:#x})")); }
    let items = unsafe { std::slice::from_raw_parts(storage.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, count as usize) };
    let mut result = Vec::new();
    for item in items {
        if item.szName.is_null() || !matches!(item.FmtValue.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA) { continue; }
        let mut length = 0usize; unsafe { while length < 1024 && *item.szName.add(length) != 0 { length += 1; } }
        if length == 1024 { continue; }
        let value = unsafe { item.FmtValue.Anonymous.doubleValue };
        if value.is_finite() { result.push((String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(item.szName, length) }), value)); }
    }
    Ok(result)
}
fn instance_luid(name: &str) -> Option<u64> {
    let parts: Vec<_> = name.split('_').collect(); let index = parts.iter().position(|part| part.eq_ignore_ascii_case("luid"))?;
    let high = u32::from_str_radix(parts.get(index + 1)?.trim_start_matches("0x"), 16).ok()?;
    let low = u32::from_str_radix(parts.get(index + 2)?.trim_start_matches("0x"), 16).ok()?;
    Some(((high as u64) << 32) | low as u64)
}
fn instance_number(name: &str, marker: &str) -> Option<u32> {
    let parts: Vec<_> = name.split('_').collect(); let index = parts.iter().position(|part| part.eq_ignore_ascii_case(marker))?;
    parts.get(index + 1)?.parse().ok()
}
fn sample_gpus(cache: &mut MonitorCache, refresh_hardware: bool) -> (Vec<GpuInfo>, Option<String>) {
    if refresh_hardware || cache.gpu_adapters.is_empty() {
        let adapter_error = match dxgi_adapters() { Ok(adapters) => { cache.gpu_adapters = adapters; None }, Err(error) => { cache.gpu_adapters.clear(); Some(error) } };
        let counter_error = match GpuCounters::open() { Ok(counters) => { cache.gpu_counters = Some(counters); None }, Err(error) => { cache.gpu_counters = None; Some(error) } };
        cache.gpu_error = match (adapter_error, counter_error) { (Some(left), Some(right)) => Some(format!("{left}; {right}")), (Some(error), None) | (None, Some(error)) => Some(error), (None, None) => None };
    }
    let sample = cache.gpu_counters.as_ref().map(GpuCounters::collect);
    let (utilization, dedicated, shared, sample_error) = match sample { Some(Ok((utilization, dedicated, shared, note))) => (utilization, dedicated, shared, note), Some(Err(error)) => (HashMap::new(), HashMap::new(), HashMap::new(), Some(error)), None => (HashMap::new(), HashMap::new(), HashMap::new(), cache.gpu_error.clone()) };
    let gpus = cache.gpu_adapters.iter().map(|adapter| GpuInfo { name: adapter.name.clone(), utilization: utilization.get(&adapter.luid).copied(), dedicated_used: dedicated.get(&adapter.luid).copied(), dedicated_total: adapter.dedicated_total, shared_used: shared.get(&adapter.luid).copied(), shared_total: adapter.shared_total, note: sample_error.clone() }).collect();
    (gpus, if cache.gpu_adapters.is_empty() { cache.gpu_error.clone().or(sample_error) } else { None })
}
fn sample(cache: &mut MonitorCache, force_hardware: bool) -> Result<Snapshot, String> {
    let now = Instant::now(); let elapsed = cache.sampled.map(|before| now.duration_since(before).as_secs_f64()).filter(|seconds| *seconds > 0.1 && *seconds < 10.0);
    let cores = unsafe { GetActiveProcessorCount(0xffff) }.max(1);
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    let cpu_ticks = (unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0).then(|| (ticks(idle), ticks(kernel) + ticks(user)));
    // GetSystemTimes covers only the calling processor group on >64-core hosts.
    let cpu = cpu_ticks.zip(cache.cpu_ticks).filter(|_| elapsed.is_some() && cores <= 64).and_then(|((idle, total), (old_idle, old_total))| {
        let total_delta = total.checked_sub(old_total)?; let idle_delta = idle.checked_sub(old_idle)?;
        (total_delta > 0).then(|| (100.0 * (1.0 - idle_delta as f64 / total_delta as f64)).clamp(0.0, 100.0))
    });
    let mut memory = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 { return Err(os_error("RAM measurement failed")); }
    let family = devflow_family();
    let handle = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    if unsafe { Process32FirstW(handle.as_raw_handle(), &mut entry) } == 0 { return Err(os_error("Process enumeration failed")); }
    let mut processes = Vec::new(); let mut current_ticks = HashMap::new();
    loop {
        let length = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
        let mut info = ProcessInfo { pid: entry.th32ProcessID, name: String::from_utf16_lossy(&entry.szExeFile[..length]), path: None, created: None, cpu: None, memory: None, deny_reason: Some("Process inaccessible or exited".into()) };
        if let Ok(process) = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, info.pid) }) {
            let h = process.as_raw_handle();
            if let Ok((created, used)) = process_times(h) {
                info.created = Some(created.to_string());
                if let (Some(seconds), Some(previous)) = (elapsed, cache.process_ticks.get(&(info.pid, created))) { info.cpu = Some((used.saturating_sub(*previous) as f64 / (seconds * 10_000_000.0 * cores as f64) * 100.0).clamp(0.0, 100.0)); }
                current_ticks.insert((info.pid, created), used);
                if let Ok(path) = process_path(h) { info.deny_reason = match &family { Ok(family) => eligible(h, info.pid, &path, family).err(), Err(error) => Some(error.clone()) }; info.path = Some(path); }
            }
            let mut counters = PROCESS_MEMORY_COUNTERS { cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
            if unsafe { GetProcessMemoryInfo(h, &mut counters, size_of::<PROCESS_MEMORY_COUNTERS>() as u32) } != 0 { info.memory = Some(counters.WorkingSetSize as u64); }
            else if let Ok(memory_handle) = owned(unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, info.pid) }) {
                // A PID can disappear/recycle between these opens; never attach another process's RAM.
                if info.created.as_ref().is_some_and(|created| process_times(memory_handle.as_raw_handle()).ok().map(|v| v.0.to_string()).as_ref() == Some(created)) && unsafe { GetProcessMemoryInfo(memory_handle.as_raw_handle(), &mut counters, size_of::<PROCESS_MEMORY_COUNTERS>() as u32) } != 0 { info.memory = Some(counters.WorkingSetSize as u64); }
            }
        }
        processes.push(info);
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32NextW(handle.as_raw_handle(), &mut entry) } == 0 {
            if unsafe { GetLastError() } != ERROR_NO_MORE_FILES { return Err(os_error("Process enumeration interrupted")); }
            break;
        }
    }
    if force_hardware || cache.drives_sampled.is_none_or(|before| now.duration_since(before) >= Duration::from_secs(60)) {
        match drives() { Ok(drives) => { cache.drives = drives; cache.drives_error = None; }, Err(error) => { cache.drives.clear(); cache.drives_error = Some(error); } }
        cache.drives_sampled = Some(now);
    }
    let (gpus, gpu_error) = sample_gpus(cache, force_hardware);
    cache.sampled = Some(now); cache.cpu_ticks = cpu_ticks; cache.process_ticks = current_ticks; cache.processes = processes.clone();
    static CPU_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    Ok(Snapshot { sampled_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64, cpu, cpu_name: CPU_NAME.get_or_init(cpu_name).clone(), logical_processors: cores, memory_total: memory.ullTotalPhys, memory_available: memory.ullAvailPhys, uptime_seconds: unsafe { GetTickCount64() } / 1000, processes, drives: cache.drives.clone(), drives_age_seconds: cache.drives_sampled.map_or(0, |before| now.duration_since(before).as_secs()), drives_error: cache.drives_error.clone(), gpus, gpu_error })
}
#[tauri::command]
pub(crate) async fn system_snapshot(state: State<'_, SystemCenter>, force_hardware: bool) -> Result<Snapshot, String> {
    let cache = state.monitor.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = cache.try_lock().map_err(|_| "A system refresh is already running")?;
        sample(&mut cache, force_hardware)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn system_end_task(app: tauri::AppHandle, state: State<'_, SystemCenter>, pid: u32, created: String) -> Result<String, String> {
    let cache = state.monitor.clone(); let lock = state.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = lock.try_lock().map_err(|_| "Another maintenance operation is running")?;
        let expected = cache.try_lock().map_err(|_| "System refresh in progress; review and try End Task again")?.processes.iter().find(|p| p.pid == pid && p.created.as_ref() == Some(&created)).cloned().ok_or("Process identity changed. Refresh and review again.")?;
        if let Some(reason) = expected.deny_reason { return Err(reason); }
        let lifecycle = app.state::<crate::AppState>();
        let registry = lifecycle.processes.lock().map_err(|_| "Service registry unavailable")?;
        if registry.values().any(|entry| matches!(entry, crate::ProcessEntry::Starting(_))) { return Err("A DevFlow service is starting. Wait for startup before using End Task.".into()); }
        let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) })?;
        let h = process.as_raw_handle(); let actual = process_times(h)?.0.to_string(); let path = process_path(h)?;
        if actual != created || expected.path.as_deref() != Some(&path) || Path::new(&path).file_name().map(|n| n.to_string_lossy().to_lowercase()) != Some(expected.name.to_lowercase()) { return Err("Process identity changed; nothing was terminated".into()); }
        eligible(h, pid, &path, &devflow_family()?)?;
        if unsafe { WaitForSingleObject(h, 0) } != WAIT_TIMEOUT { return Err("Process already exited or cannot be inspected".into()); }
        if unsafe { TerminateProcess(h, 1) } == 0 { return Err(os_error("End Task failed")); }
        drop(registry); // Do not delay the project lifecycle while waiting for OS exit.
        if unsafe { WaitForSingleObject(h, 3000) } != WAIT_OBJECT_0 { return Err("Termination requested, but exit was not confirmed within three seconds. Refresh to inspect.".into()); }
        Ok(format!("Ended {} (PID {pid}). Only the selected process was terminated.", expected.name))
    }).await.map_err(|e| e.to_string())?
}

// Nonrecursive cleanup uses server-held IDs, exclusive file handles, and delete-by-handle.
const MIN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const SCAN_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CANDIDATES: usize = 1000;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate { id: usize, path: String, bytes: u64 }
#[derive(Clone, PartialEq)]
struct FileIdentity { volume: u32, index: u64, modified: u64, size: u64, links: u32 }
struct ScannedFile { preview: Candidate, path: PathBuf, identity: FileIdentity }
struct Scan { id: String, created: Instant, root: PathBuf, root_identity: FileIdentity, files: Vec<ScannedFile> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupCategory {
    id: String, name: String, description: String, safety: String, status: String,
    candidate_count: usize, bytes: u64, root: Option<String>, age_days: Option<u32>, note: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanPreview {
    id: String, root: String, files: Vec<Candidate>, skipped: usize, limited: bool, age_days: u32,
    categories: Vec<CleanupCategory>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupResult { removed: usize, bytes_removed: u64, skipped: usize, cancelled: bool, details: Vec<String> }
fn file_info(handle: HANDLE) -> Result<(FileIdentity, u32), String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 { return Err(os_error("File identity unavailable")); }
    Ok((FileIdentity { volume: info.dwVolumeSerialNumber, index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64, modified: ticks(info.ftLastWriteTime), size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64, links: info.nNumberOfLinks }, info.dwFileAttributes))
}
fn open_file(path: &Path, delete: bool, directory: bool) -> Result<OwnedHandle, String> {
    let flags = FILE_FLAG_OPEN_REPARSE_POINT | if directory { FILE_FLAG_BACKUP_SEMANTICS } else { 0 };
    let share = if directory { FILE_SHARE_READ | FILE_SHARE_WRITE } else { 0 };
    owned(unsafe { CreateFileW(wide(path).as_ptr(), FILE_READ_ATTRIBUTES | if delete { DELETE } else { 0 }, share, ptr::null(), OPEN_EXISTING, flags, ptr::null_mut()) })
}
fn temp_root() -> Result<PathBuf, String> {
    let mut path = ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut path) };
    if result < 0 || path.is_null() { return Err("Current-user Local AppData is unavailable".into()); }
    let mut length = 0; unsafe { while *path.add(length) != 0 { length += 1; } }
    let root = PathBuf::from(std::ffi::OsString::from_wide(unsafe { std::slice::from_raw_parts(path, length) })).join("Temp");
    unsafe { CoTaskMemFree(path.cast()); }
    let drive = root.ancestors().last().ok_or("Temp drive unavailable")?;
    if !root.is_absolute() || root.to_string_lossy().starts_with("\\\\") || unsafe { GetDriveTypeW(wide(drive).as_ptr()) } != 3 { return Err("Only current-user Temp on a fixed local drive is supported".into()); }
    Ok(root)
}
fn pin_root(root: &Path) -> Result<Vec<OwnedHandle>, String> {
    let mut handles = Vec::new();
    // Hold ancestors without FILE_SHARE_DELETE, preventing rename/path swaps during the operation.
    for path in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let handle = open_file(path, false, true)?;
        let (_, attributes) = file_info(handle.as_raw_handle())?;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err("Temp path contains a reparse point or non-directory; cleanup refused".into()); }
        if path.join(".git").exists() || path.join(".env").exists() { return Err("Temp path is within a Git/project environment; cleanup refused".into()); }
        handles.push(handle);
    }
    Ok(handles)
}
fn protect_projects(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let path = config.join("projects.json");
    let projects: Vec<crate::Project> = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| "Cannot verify project exclusions; project storage is invalid")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Cannot verify project exclusions: {error}")),
    };
    let canonical = std::fs::canonicalize(root).map_err(|e| e.to_string())?.to_string_lossy().to_lowercase();
    let protected = projects.iter().flat_map(|p| std::iter::once(p.root.as_str()).chain(p.services.iter().map(|s| s.cwd.as_str()))).map(PathBuf::from).chain(std::iter::once(config));
    for directory in protected {
        let directory = std::fs::canonicalize(&directory).map_err(|_| format!("Cannot verify protected directory {}; cleanup refused", directory.display()))?.to_string_lossy().to_lowercase();
        if canonical == directory || canonical.starts_with(&(directory.clone() + "\\")) || directory.starts_with(&(canonical.clone() + "\\")) { return Err("Temp overlaps a project, service, or DevFlow configuration directory; cleanup refused".into()); }
    }
    Ok(())
}
fn valid_candidate(path: &Path, identity: &FileIdentity, attributes: u32) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let extension = path.extension().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().saturating_add(11_644_473_600).saturating_mul(10_000_000);
    let sensitive_name = [".env", ".git", ".db", ".sqlite", ".mdb", ".accdb", ".sql", "database", "settings", "config", "profile", "backup", ".bak"].iter().any(|pattern| name.contains(pattern));
    attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN) == 0
        && attributes & FILE_ATTRIBUTE_TEMPORARY != 0
        && identity.links == 1 && matches!(extension.as_str(), "tmp" | "temp") && !name.starts_with('.') && !sensitive_name
        && identity.modified < now.saturating_sub(MIN_AGE.as_secs() * 10_000_000)
}
fn cleanup_categories(root: &Path, files: &[ScannedFile]) -> Vec<CleanupCategory> {
    let bytes = files.iter().map(|file| file.preview.bytes).sum();
    vec![
        CleanupCategory {
            id: "user-temp".into(), name: "User temporary files".into(),
            description: "Old top-level .tmp and .temp files in the current user's Windows Temp folder.".into(),
            safety: "Supported · conservative 7-day threshold".into(), status: "supported".into(),
            candidate_count: files.len(), bytes, root: Some(root.to_string_lossy().into_owned()), age_days: Some(7), note: None,
        },
        CleanupCategory {
            id: "safe-user-cache".into(), name: "Safe user cache files".into(),
            description: "No narrowly verified disposable application cache is configured for automatic deletion.".into(),
            safety: "Unsupported · no files will be deleted".into(), status: "unsupported".into(),
            candidate_count: 0, bytes: 0, root: None, age_days: None, note: Some("Browser profiles, sessions, cookies, passwords, and application databases are never treated as disposable.".into()),
        },
        CleanupCategory {
            id: "windows-thumbnail-cache".into(), name: "Windows thumbnail cache".into(),
            description: "Use Windows-supported cleanup tools when thumbnail cache cleanup is needed.".into(),
            safety: "Windows-managed · DevFlow does not delete it".into(), status: "managed".into(),
            candidate_count: 0, bytes: 0, root: None, age_days: None, note: Some("Locked Explorer databases are not force-deleted.".into()),
        },
        CleanupCategory {
            id: "windows-managed".into(), name: "Windows-managed cleanup".into(),
            description: "Review Storage Settings or Disk Cleanup for Windows-owned cleanup categories.".into(),
            safety: "Windows-managed · review required".into(), status: "managed".into(),
            candidate_count: 0, bytes: 0, root: None, age_days: None, note: Some("DevFlow does not silently delete Windows Update caches, restore points, or driver packages.".into()),
        },
        CleanupCategory {
            id: "prefetch".into(), name: "Prefetch".into(),
            description: "Windows manages Prefetch to improve application startup.".into(),
            safety: "Not eligible · no automatic cleanup".into(), status: "unsupported".into(),
            candidate_count: 0, bytes: 0, root: None, age_days: None, note: Some("Prefetch is not counted in reclaimable space.".into()),
        },
    ]
}
#[tauri::command]
pub(crate) async fn scan_temp_files(app: tauri::AppHandle, state: State<'_, SystemCenter>) -> Result<ScanPreview, String> {
    let lock = state.maintenance.clone(); let stored = state.scan.clone(); let cancel = state.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| "Another maintenance operation is running")?;
        cancel.store(false, Ordering::SeqCst); *stored.lock().map_err(|_| "Scan storage unavailable")? = None;
        let root = temp_root()?; let pins = pin_root(&root)?; protect_projects(&app, &root)?;
        let root_identity = file_info(pins.last().ok_or("Temp unavailable")?.as_raw_handle())?.0;
        let id = crate::project_storage::new_id("scan-")?;
        let mut scan = Scan { id: id.clone(), created: Instant::now(), root: root.clone(), root_identity, files: Vec::new() };
        let mut skipped = 0; let mut limited = false;
        for (visited, entry) in std::fs::read_dir(&root).map_err(|e| e.to_string())?.enumerate() {
            if cancel.load(Ordering::SeqCst) { return Err("Temporary-file scan cancelled; no files were deleted".into()); }
            if visited >= 10000 || scan.files.len() >= MAX_CANDIDATES { limited = true; break; }
            let entry = match entry { Ok(entry) => entry, Err(_) => { skipped += 1; continue; } };
            let path = entry.path();
            let candidate = (|| {
                let handle = open_file(&path, false, false)?; let (identity, attributes) = file_info(handle.as_raw_handle())?;
                if !valid_candidate(&path, &identity, attributes) { return Err("Excluded".into()); }
                Ok::<_, String>(ScannedFile { preview: Candidate { id: scan.files.len(), path: path.to_string_lossy().into_owned(), bytes: identity.size }, path, identity })
            })();
            match candidate { Ok(file) => scan.files.push(file), Err(_) => skipped += 1 }
        }
        let categories = cleanup_categories(&root, &scan.files);
        let preview = ScanPreview { id, root: root.to_string_lossy().into_owned(), files: scan.files.iter().map(|file| file.preview.clone()).collect(), skipped, limited, age_days: 7, categories };
        *stored.lock().map_err(|_| "Scan storage unavailable")? = Some(scan);
        Ok(preview)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn scan_cleanup(app: tauri::AppHandle, state: State<'_, SystemCenter>) -> Result<ScanPreview, String> {
    scan_temp_files(app, state).await
}

#[tauri::command]
pub(crate) async fn clean_selected_cleanup(app: tauri::AppHandle, state: State<'_, SystemCenter>, scan_id: String, categories: Vec<String>) -> Result<CleanupResult, String> {
    if categories.iter().any(|category| category != "user-temp") || !categories.iter().any(|category| category == "user-temp") {
        return Err("Only the supported User temporary files category can be cleaned automatically".into());
    }
    let selected = {
        let stored = state.scan.lock().map_err(|_| "Scan storage unavailable")?;
        let scan = stored.as_ref().ok_or("Scan cleanup categories first")?;
        if scan.id != scan_id { return Err("Scan expired or changed; scan and review again".into()); }
        scan.files.iter().map(|file| file.preview.id).collect()
    };
    clean_temp_files(app, state, scan_id, selected).await
}
#[tauri::command]
pub(crate) async fn clean_temp_files(app: tauri::AppHandle, state: State<'_, SystemCenter>, scan_id: String, selected: Vec<usize>) -> Result<CleanupResult, String> {
    let lock = state.maintenance.clone(); let stored = state.scan.clone(); let cancel = state.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| "Another maintenance operation is running")?;
        cancel.store(false, Ordering::SeqCst);
        let mut storage = stored.lock().map_err(|_| "Scan storage unavailable")?;
        let scan = storage.as_ref().ok_or("Scan temporary files first")?;
        if scan.id != scan_id || scan.created.elapsed() > SCAN_TTL { return Err("Scan expired or changed; scan and review again".into()); }
        if selected.len() > MAX_CANDIDATES { return Err("Too many selected candidates".into()); }
        let ids: HashSet<_> = selected.into_iter().collect();
        if ids.is_empty() || ids.len() > MAX_CANDIDATES || ids.iter().any(|id| *id >= scan.files.len()) { return Err("Select valid files from the current scan".into()); }
        let scan = storage.take().ok_or("Scan unavailable")?; drop(storage); // Single use, even on partial failure.
        let root = temp_root()?; if root != scan.root { return Err("Temp location changed; scan again".into()); }
        let pins = pin_root(&root)?; protect_projects(&app, &root)?;
        let identity = file_info(pins.last().ok_or("Temp unavailable")?.as_raw_handle())?.0;
        if identity.volume != scan.root_identity.volume || identity.index != scan.root_identity.index { return Err("Temp directory identity changed; scan again".into()); }
        let mut result = CleanupResult { removed: 0, bytes_removed: 0, skipped: 0, cancelled: false, details: Vec::new() };
        for file in scan.files.into_iter().filter(|f| ids.contains(&f.preview.id)) {
            if cancel.load(Ordering::SeqCst) { result.cancelled = true; result.skipped = ids.len() - result.removed; break; }
            let deletion = (|| {
                if file.path.parent() != Some(root.as_path()) { return Err("Outside approved temp root".into()); }
                let handle = open_file(&file.path, true, false)?;
                let (identity, attributes) = file_info(handle.as_raw_handle())?;
                if identity != file.identity || !valid_candidate(&file.path, &identity, attributes) { return Err("File changed, is recent, or is excluded".into()); }
                let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
                if unsafe { SetFileInformationByHandle(handle.as_raw_handle(), FileDispositionInfo, (&disposition as *const FILE_DISPOSITION_INFO).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 { return Err(os_error("Windows refused deletion")); }
                // Exclusive handle ensures no other open file handle delays deletion.
                drop(handle);
                Ok::<_, String>(identity.size)
            })();
            match deletion {
                Ok(bytes) => { result.removed += 1; result.bytes_removed += bytes; }
                Err(error) => { result.skipped += 1; if result.details.len() < 30 { result.details.push(format!("{}: {error}", file.preview.path)); } }
            }
        }
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn cancel_system_maintenance(state: State<'_, SystemCenter>) { state.cancel.store(true, Ordering::SeqCst); }

#[tauri::command]
pub(crate) async fn flush_dns_cache(state: State<'_, SystemCenter>) -> Result<String, String> {
    let lock = state.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| "Another maintenance operation is running")?;
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new(system_directory()?.join("ipconfig.exe")).arg("/flushdns").creation_flags(CREATE_NO_WINDOW).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err("DNS flush timed out; success was not confirmed".into()); }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !status.success() { return Err(format!("Windows DNS flush failed ({status}). Permissions may be required. No elevation was requested.")); }
        Ok("Windows ipconfig /flushdns completed successfully. This clears the DNS resolver cache; it does not change CPU or RAM performance.".into())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn open_storage_tool(tool: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match tool.as_str() {
            "settings" => {
                let verb = wide(Path::new("open")); let uri = wide(Path::new("ms-settings:storagesense"));
                let result = unsafe { ShellExecuteW(ptr::null_mut(), verb.as_ptr(), uri.as_ptr(), ptr::null(), ptr::null(), 1) } as isize;
                if result <= 32 { return Err(format!("Windows could not open Storage Settings (code {result})")); }
            }
            "disk-cleanup" => {
                use std::os::windows::process::CommandExt;
                let program = system_directory()?.join("cleanmgr.exe");
                if !program.is_file() { return Err("Windows Disk Cleanup is unavailable on this installation".into()); }
                std::process::Command::new(program).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e| e.to_string())?;
            }
            _ => return Err("Unknown storage tool".into()),
        }
        Ok("Launch requested. Review and approve any cleanup inside the Windows tool; DevFlow has not deleted anything.".into())
    }).await.map_err(|e| e.to_string())?
}

fn validate_local_url(url: &str) -> Result<(), String> {
    if url.chars().any(|value| value.is_control() || value.is_whitespace()) { return Err("Local URL contains invalid characters".into()); }
    let scheme_length = if url.get(..7).is_some_and(|value| value.eq_ignore_ascii_case("http://")) { 7 }
        else if url.get(..8).is_some_and(|value| value.eq_ignore_ascii_case("https://")) { 8 }
        else { return Err("Only HTTP(S) local URLs can be opened".into()); };
    let authority = url[scheme_length..].split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') { return Err("Credentials are not allowed in local URLs".into()); }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']').ok_or("Invalid IPv6 loopback URL")?;
        let tail = &rest[end + 1..];
        let port = if tail.is_empty() { None } else { Some(tail.strip_prefix(':').ok_or("Invalid IPv6 loopback URL")?) };
        (&rest[..end], port)
    } else if let Some((host, port)) = authority.rsplit_once(':') { (host, Some(port)) }
    else { (authority, None) };
    if !host.eq_ignore_ascii_case("localhost") && host != "127.0.0.1" && host != "::1" { return Err("Only loopback URLs can be opened".into()); }
    if let Some(port) = port { if port.parse::<u16>().ok().filter(|value| *value > 0).is_none() { return Err("Invalid local URL port".into()); } }
    Ok(())
}

#[tauri::command]
pub(crate) fn open_local_url(url: String) -> Result<(), String> {
    validate_local_url(&url)?;
    let verb = wide(Path::new("open"));
    let target = wide(Path::new(&url));
    let result = unsafe { ShellExecuteW(ptr::null_mut(), verb.as_ptr(), target.as_ptr(), ptr::null(), ptr::null(), 1) } as isize;
    if result <= 32 { return Err(format!("Windows could not open the local URL (code {result})")); }
    Ok(())
}
