//! Native log views only. Service ownership and output collection stay unchanged.
use std::{collections::HashSet, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct LogsWindows {
    pub(crate) location: Mutex<Option<serde_json::Value>>,
    opening: Mutex<HashSet<String>>,
    pending: Mutex<HashSet<String>>,
}

fn label(project_id: &str) -> String {
    format!("logs-{}", project_id.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

fn project(app: &tauri::AppHandle, id: &str) -> Result<super::Project, String> {
    super::load_projects(app.clone(), app.state()).and_then(|projects| projects.into_iter().find(|project| project.id == id).ok_or_else(|| "Project no longer exists.".into()))
}

fn own_project(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<super::Project, String> {
    super::load_projects(app.clone(), app.state())?.into_iter().find(|project| label(&project.id) == window.label()).ok_or_else(|| "Unknown logs window or removed project.".into())
}

pub(crate) fn editor_target(app: &tauri::AppHandle) -> Result<&'static str, String> {
    let state = app.state::<super::editor_window::EditorWindow>();
    let session = state.0.lock().map_err(|e| e.to_string())?;
    match session.owner.as_str() {
        "" => Ok("main"),
        "floating" => Ok("quick-editor"),
        _ => Err("Wait for the editor transfer to finish, then retry docking.".into()),
    }
}

#[tauri::command]
pub async fn logs_float(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String) -> Result<(), String> {
    if !["main", "quick-editor"].contains(&window.label()) { return Err("Open logs from DevFlow or Quick Editor.".into()); }
    let project = project(&app, &project_id)?;
    let name = label(&project_id);
    let state = app.state::<LogsWindows>();
    {
        let mut opening = state.opening.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = app.get_webview_window(&name) {
            existing.unminimize().map_err(|e| e.to_string())?;
            existing.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        if !opening.insert(name.clone()) { return Err("Logs window is already opening. Try again shortly.".into()); }
    }
    // Hex is safe for labels and URLs; project lookup uses the native window label.
    let result = tauri::WebviewWindowBuilder::new(&app, &name, tauri::WebviewUrl::App(format!("index.html?window=logs&project={}", name).into()))
        .title(format!("{} — Logs — DevFlow", project.name)).inner_size(1000.0, 640.0).min_inner_size(480.0, 360.0).resizable(true).build();
    state.opening.lock().map_err(|e| e.to_string())?.remove(&name);
    let logs = result.map_err(|e| e.to_string())?;
    let handle = app.clone();
    logs.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Ok(mut pending) = handle.state::<LogsWindows>().pending.lock() { pending.remove(&project_id); }
            let _ = handle.emit_to("main", "logs-window-closed", &name);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn logs_project(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<super::Project, String> { own_project(&app, &window) }

#[tauri::command]
pub fn logs_dock(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let project = own_project(&app, &window)?;
    let target = editor_target(&app)?;
    app.state::<LogsWindows>().pending.lock().map_err(|e| e.to_string())?.insert(project.id.clone());
    app.emit_to(target, "logs-dock-requested", &project.id).map_err(|e| e.to_string())?;
    if let Some(editor) = app.get_webview_window(target) { let _ = editor.unminimize(); let _ = editor.set_focus(); }
    Ok(())
}

#[tauri::command]
pub fn logs_pending(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    if window.label() != editor_target(&app)? { return Err("This window does not own Quick Editor.".into()); }
    Ok(app.state::<LogsWindows>().pending.lock().map_err(|e| e.to_string())?.iter().cloned().collect())
}

#[tauri::command]
pub fn logs_accept_dock(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String) -> Result<(), String> {
    if window.label() != editor_target(&app)? { return Err("This window does not own Quick Editor.".into()); }
    let state = app.state::<LogsWindows>();
    // Do not hold the pending lock during destruction (Destroyed also takes it).
    if !state.pending.lock().map_err(|e| e.to_string())?.contains(&project_id) { return Err("No log docking request is pending.".into()); }
    if let Some(logs) = app.get_webview_window(&label(&project_id)) { logs.destroy().map_err(|e| e.to_string())?; }
    state.pending.lock().map_err(|e| e.to_string())?.remove(&project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_are_unambiguous_and_window_safe() {
        assert_ne!(label("a/b"), label("a-b"));
        assert_ne!(label("a"), label("A"));
        assert!(label("project: 日本語").chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
