//! Non-Windows builds keep the command surface but never emulate system operations.
#[derive(Default)]
pub(crate) struct SystemCenter;
const UNAVAILABLE: &str = "System Monitor and Maintenance require Windows 10/11";
#[tauri::command]
pub(crate) fn system_snapshot(force_hardware: bool) -> Result<(), String> { let _ = force_hardware; Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn system_end_task(pid: u32, created: String) -> Result<(), String> { let _ = (pid, created); Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn scan_temp_files() -> Result<(), String> { Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn clean_temp_files(scan_id: String, selected: Vec<usize>) -> Result<(), String> { let _ = (scan_id, selected); Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn scan_cleanup() -> Result<(), String> { Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn clean_selected_cleanup(scan_id: String, categories: Vec<String>) -> Result<(), String> { let _ = (scan_id, categories); Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn cancel_system_maintenance() -> Result<(), String> { Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn flush_dns_cache() -> Result<(), String> { Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn open_storage_tool(tool: String) -> Result<(), String> { let _ = tool; Err(UNAVAILABLE.into()) }
#[tauri::command]
pub(crate) fn open_local_url(url: String) -> Result<(), String> { let _ = url; Err(UNAVAILABLE.into()) }
