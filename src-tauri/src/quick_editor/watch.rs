//! Advisory Windows directory notifications. Paths in events come only from the
//! reviewed open-tab registration, never from untrusted filesystem event names.
use tauri::{Emitter, Manager};

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Change { generation: String, lease: u64, paths: Vec<String>, failed: bool }

#[cfg(windows)]
mod native {
    use super::*;
    use std::{os::windows::ffi::OsStrExt, sync::Arc, time::{Duration, Instant}};
    use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT}, Storage::FileSystem::{FindFirstChangeNotificationW, FindNextChangeNotification, FindCloseChangeNotification, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_CHANGE_ATTRIBUTES}, System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE}};

    struct Stop(usize);
    impl Drop for Stop { fn drop(&mut self) { unsafe { CloseHandle(self.0 as HANDLE); } } }
    pub struct Watch(Arc<Stop>);
    impl Drop for Watch { fn drop(&mut self) { unsafe { SetEvent(self.0.0 as HANDLE); } } }
    struct Directory { handle: usize, paths: Vec<String> }
    impl Drop for Directory { fn drop(&mut self) { unsafe { FindCloseChangeNotification(self.handle as HANDLE); } } }

    pub fn start(app: tauri::AppHandle, label: String, lease: u64, generation: String, directories: Vec<(std::path::PathBuf, Vec<String>)>) -> Result<Watch, String> {
        let mut watched = Vec::new();
        for (path, paths) in directories {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let handle = unsafe { FindFirstChangeNotificationW(wide.as_ptr(), 0, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_ATTRIBUTES) };
            if handle == INVALID_HANDLE_VALUE { return Err("External file monitoring could not watch a file's parent folder. Use Reload Disk Version or reopen the tab to retry.".into()); }
            watched.push(Directory { handle: handle as usize, paths });
        }
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if handle.is_null() { return Err("External file monitoring could not create a cancellation event.".into()); }
        let stop = Arc::new(Stop(handle as usize));
        let worker_stop = stop.clone();
        std::thread::Builder::new().name("editor-file-notifications".into()).spawn(move || {
            let handles: Vec<HANDLE> = std::iter::once(worker_stop.0 as HANDLE).chain(watched.iter().map(|d| d.handle as HANDLE)).collect();
            let mut pending = std::collections::BTreeSet::new();
            let mut first: Option<Instant> = None;
            let mut last = Instant::now();
            loop {
                let timeout = first.map(|at| Duration::from_millis(180).saturating_sub(last.elapsed()).min(Duration::from_millis(750).saturating_sub(at.elapsed())).as_millis() as u32).unwrap_or(INFINITE);
                let result = unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, timeout) };
                if result == 0 { break; }
                let mut failed = false;
                if result == WAIT_TIMEOUT {
                    // Debounced quiet interval, bounded even under continuous writes.
                } else if let Some(directory) = watched.get(result.wrapping_sub(1) as usize) {
                    pending.extend(directory.paths.iter().cloned());
                    failed = unsafe { FindNextChangeNotification(directory.handle as HANDLE) } == 0;
                    first.get_or_insert_with(Instant::now); last = Instant::now();
                    if !failed && first.is_some_and(|at| at.elapsed() < Duration::from_millis(750)) { continue; }
                } else {
                    pending.extend(watched.iter().flat_map(|d| d.paths.iter().cloned())); failed = true;
                }
                if !pending.is_empty() {
                    let state = app.state::<crate::editor_window::EditorWindow>();
                    let Ok(session) = state.0.lock() else { break };
                    if session.check_writer(&label, lease).is_err() { break; }
                    let _ = app.emit_to(&label, "editor-files-changed", Change { generation: generation.clone(), lease, paths: pending.iter().cloned().collect(), failed });
                    pending.clear(); first = None;
                }
                if failed { break; }
            }
        }).map_err(|e| e.to_string())?;
        Ok(Watch(stop))
    }
}
#[cfg(windows)]
pub use native::Watch;
#[cfg(not(windows))]
pub struct Watch;

#[tauri::command]
pub fn editor_watch_files(app: tauri::AppHandle, window: tauri::WebviewWindow, lease: u64, generation: String, project_id: String, expected_root: String, paths: Vec<String>) -> Result<(), String> {
    let state = app.state::<crate::editor_window::EditorWindow>();
    let session = state.0.lock().map_err(|e| e.to_string())?;
    session.check_writer(window.label(), lease)?;
    if paths.len() > 20 || generation.len() > 128 { return Err("Invalid file monitoring registration.".into()); }
    let mut registration = state.1.lock().map_err(|e| e.to_string())?;
    registration.take();
    if paths.is_empty() { return Ok(()); }
    let mut directories: Vec<(std::path::PathBuf, Vec<String>)> = Vec::new();
    let mut directory_guards = Vec::new();
    for path in paths {
        super::validate_relative(&path)?;
        if path.is_empty() { return Err("Expected an open file path.".into()); }
        // Resolving the parent permits continued monitoring when a file is missing.
        // No file event can authorize access; editor_read repeats all guards.
        let parent = path.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
        if path.split('/').any(|part| matches!(part.to_ascii_lowercase().as_str(), "node_modules" | ".git" | ".next" | "target" | "dist" | "build")) { continue; }
        let (directory, _guards) = super::resolve(&app, &project_id, &expected_root, parent, true)?;
        directory_guards.extend(_guards);
        if let Some((_, files)) = directories.iter_mut().find(|(p, _)| p.to_string_lossy().eq_ignore_ascii_case(&directory.to_string_lossy())) { files.push(path); }
        else { directories.push((directory, vec![path])); }
    }
    if directories.is_empty() { return Ok(()); }
    #[cfg(windows)] { *registration = Some((generation.clone(), native::start(app.clone(), window.label().into(), lease, generation, directories)?)); Ok(()) }
    #[cfg(not(windows))] { let _ = (generation, directories); Err("Automatic file monitoring is currently available on Windows. Manual reload remains available.".into()) }
}

#[tauri::command]
pub fn editor_unwatch_files(app: tauri::AppHandle, window: tauri::WebviewWindow, lease: u64, generation: String) -> Result<(), String> {
    let state = app.state::<crate::editor_window::EditorWindow>();
    let session = state.0.lock().map_err(|e| e.to_string())?;
    session.check_writer(window.label(), lease)?;
    let mut registration = state.1.lock().map_err(|e| e.to_string())?;
    if registration.as_ref().is_some_and(|(current, _)| current == &generation) { registration.take(); }
    Ok(())
}
