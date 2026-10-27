//! Bounded text actions; file writes are possible only through a native Save dialog.
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

fn check_window(window: &tauri::WebviewWindow, project_id: Option<&str>) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "quick-editor" { return Ok(()); }
    if let Some(id) = project_id {
        let expected = format!("logs-{}", id.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>());
        if label == expected { return Ok(()); }
    } else if label.starts_with("logs-") { return Ok(()); }
    Err("This window cannot perform log actions.".into())
}

#[tauri::command]
pub async fn logs_copy(window: tauri::WebviewWindow, text: String) -> Result<(), String> {
    check_window(&window, None)?;
    if text.is_empty() || text.len() > 64 * 1024 * 1024 || text.contains('\0') { return Err("Clipboard text is empty, too large, or contains a null character.".into()); }
    #[cfg(windows)] {
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        tauri::async_runtime::spawn_blocking(move || clipboard(owner, &text)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))] { Err("Native log clipboard is supported on Windows.".into()) }
}

#[cfg(windows)]
fn clipboard(owner: usize, text: &str) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::GlobalFree, System::{DataExchange::{OpenClipboard, CloseClipboard, EmptyClipboard, SetClipboardData}, Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE}}};
    let utf16: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // Allocate before opening/emptying the clipboard, preserving it on allocation failure.
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, utf16.len() * 2);
        if memory.is_null() { return Err("Could not allocate clipboard memory.".into()); }
        let pointer = GlobalLock(memory) as *mut u16;
        if pointer.is_null() { GlobalFree(memory); return Err("Could not lock clipboard memory.".into()); }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), pointer, utf16.len());
        GlobalUnlock(memory);
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(owner as _) != 0 { opened = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened { GlobalFree(memory); return Err("Windows clipboard is busy. Try copying again.".into()); }
        let success = EmptyClipboard() != 0 && !SetClipboardData(13, memory).is_null(); // CF_UNICODETEXT
        CloseClipboard();
        // On success Windows owns the allocation.
        if !success { GlobalFree(memory); return Err("Windows could not write the clipboard. Try again.".into()); }
    }
    Ok(())
}

#[tauri::command]
pub async fn logs_export(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, text: String) -> Result<bool, String> {
    check_window(&window, Some(&project_id))?;
    if text.is_empty() || text.len() > 64 * 1024 * 1024 { return Err("Log export is empty or exceeds 64 MiB.".into()); }
    let project = super::load_projects(app.clone(), app.state())?.into_iter().find(|p| p.id == project_id).ok_or("Save the project before exporting logs.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let name: String = project.name.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).take(80).collect();
        let Some(file) = app.dialog().file().set_parent(&window).set_title("Export logs — review for sensitive information before sharing").set_file_name(format!("{name}-logs.txt")).add_filter("UTF-8 text", &["txt"]).blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, text.as_bytes()).map_err(|e| format!("Could not export logs: {e}"))?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn logs_verify_location(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, path: String, line: usize) -> Result<bool, String> {
    check_window(&window, Some(&project_id))?;
    tauri::async_runtime::spawn_blocking(move || super::quick_editor::verify_log_location(&app, &project_id, &expected_root, &path, line)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn logs_open_location(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, path: String, line: usize) -> Result<(), String> {
    check_window(&window, Some(&project_id))?;
    let handle = app.clone(); let id = project_id.clone(); let file = path.clone();
    if !tauri::async_runtime::spawn_blocking(move || super::quick_editor::verify_log_location(&handle, &id, &expected_root, &file, line)).await.map_err(|e| e.to_string())?? { return Err("File or line is no longer available inside this project.".into()); }
    let target = super::logs_window::editor_target(&app)?;
    let location = serde_json::json!({ "projectId": project_id, "path": path, "line": line });
    *app.state::<super::logs_window::LogsWindows>().location.lock().map_err(|e| e.to_string())? = Some(location.clone());
    app.emit_to(target, "logs-open-location", location).map_err(|e| e.to_string())?;
    if let Some(editor) = app.get_webview_window(target) { let _ = editor.unminimize(); let _ = editor.set_focus(); }
    Ok(())
}

#[tauri::command]
pub fn logs_take_location(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<serde_json::Value>, String> {
    if window.label() != super::logs_window::editor_target(&app)? { return Err("This window does not own Quick Editor.".into()); }
    Ok(app.state::<super::logs_window::LogsWindows>().location.lock().map_err(|e| e.to_string())?.take())
}
