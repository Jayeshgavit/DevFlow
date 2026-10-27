//! Transition-only, memory-only editor handoff. Never touches service state.
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session { pub owner: String, pub snapshot: Option<Value>, pub revision: u64 }
impl Session {
    pub(crate) fn check_writer(&self, label: &str, lease: u64) -> Result<(), String> {
        let owner = if self.owner.is_empty() { "main" } else if self.owner == "floating" { "quick-editor" } else { "" };
        if label != owner || lease != self.revision { return Err("This editor window no longer owns the write session. Your draft has not been saved.".into()); }
        Ok(())
    }
    fn reset(&mut self) { self.owner.clear(); self.snapshot = None; self.revision += 1; }

    fn begin(&mut self, snapshot: Value) -> Result<(), String> {
        snapshot_valid(&snapshot)?;
        if !self.owner.is_empty() { return Err("An editor handoff is already active.".into()); }
        *self = Self { owner: "opening".into(), snapshot: Some(snapshot), revision: self.revision + 1 };
        Ok(())
    }
    fn ready(&mut self) -> Result<(), String> {
        if self.owner != "opening" { return Err("No editor handoff is pending.".into()); }
        self.owner = "floating".into();
        // The floating window now owns the live drafts. Release the initial copy.
        self.snapshot = None;
        Ok(())
    }
    fn receive(&mut self, snapshot: Value) -> Result<(), String> {
        snapshot_valid(&snapshot)?;
        if self.owner != "floating" { return Err("Editor is already being transferred.".into()); }
        *self = Self { owner: "docking".into(), snapshot: Some(snapshot), revision: self.revision };
        Ok(())
    }
}
#[derive(Default)]
pub struct EditorWindow(pub Mutex<Session>);
fn caller(window: &tauri::WebviewWindow, expected: &str) -> Result<(), String> {
    if window.label() == expected { Ok(()) } else { Err("Editor window operation is not available here.".into()) }
}
fn snapshot_valid(snapshot: &Value) -> Result<(), String> {
    if !snapshot.is_object() || !snapshot["tabs"].is_array() || snapshot.to_string().len() > 64 * 1024 * 1024 {
        return Err("Invalid or oversized editor session.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn editor_writer_lease(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<u64, String> {
    let state = app.state::<EditorWindow>();
    let session = state.0.lock().map_err(|e| e.to_string())?;
    session.check_writer(window.label(), session.revision)?;
    Ok(session.revision)
}
#[tauri::command]
pub fn editor_window_session(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Session, String> {
    if !["main", "quick-editor"].contains(&window.label()) { return Err("Unknown editor window.".into()); }
    Ok(app.state::<EditorWindow>().0.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command]
pub async fn editor_float(app: tauri::AppHandle, window: tauri::WebviewWindow, snapshot: Value) -> Result<(), String> {
    caller(&window, "main")?; snapshot_valid(&snapshot)?;
    {
        let state = app.state::<EditorWindow>();
        let mut session = state.0.lock().map_err(|e| e.to_string())?;
        session.begin(snapshot)?;
    }
    let result = tauri::WebviewWindowBuilder::new(&app, "quick-editor", tauri::WebviewUrl::App("index.html?window=quick-editor".into()))
        .title("Quick Editor — DevFlow").inner_size(1000.0, 740.0).min_inner_size(620.0, 480.0).resizable(true).visible(false).build();
    match result {
        Ok(editor) => {
            let handle = app.clone();
            editor.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = handle.emit_to("main", "logs-window-closed", "quick-editor");
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = handle.emit_to("quick-editor", "editor-close", ());
                }
            });
            Ok(())
        }
        Err(error) => { app.state::<EditorWindow>().0.lock().map_err(|e| e.to_string())?.reset(); Err(error.to_string()) }
    }
}
#[tauri::command]
pub fn editor_window_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    caller(&window, "quick-editor")?;
    let state = app.state::<EditorWindow>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.owner != "opening" { return Err("No editor handoff is pending.".into()); }
    window.show().map_err(|e| e.to_string())?;
    session.ready()?;
    let _ = window.set_focus();
    Ok(())
}
#[tauri::command]
pub fn editor_close(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    caller(&window, "quick-editor")?;
    let state = app.state::<EditorWindow>();
    {
        let session = state.0.lock().map_err(|e| e.to_string())?;
        if session.owner != "floating" { return Err("Wait for the editor transfer to finish before closing.".into()); }
    }
    // Called only after the editor's unsaved-change guard approves.
    window.destroy().map_err(|e| e.to_string())?;
    state.0.lock().map_err(|e| e.to_string())?.reset();
    app.emit_to("main", "editor-closed", ()).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn editor_dock(app: tauri::AppHandle, window: tauri::WebviewWindow, snapshot: Value) -> Result<(), String> {
    caller(&window, "quick-editor")?; snapshot_valid(&snapshot)?;
    let state = app.state::<EditorWindow>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.owner != "floating" { return Err("Editor is already being transferred.".into()); }
    // Notify before committing: the receiving handler reads only after this lock is released.
    app.emit_to("main", "editor-docked", ()).map_err(|e| e.to_string())?;
    session.receive(snapshot)?;
    Ok(())
}
#[tauri::command]
pub fn editor_accept_dock(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    caller(&window, "main")?;
    let state = app.state::<EditorWindow>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.owner != "docking" { return Err("No docked editor is pending.".into()); }
    if let Some(editor) = app.get_webview_window("quick-editor") { editor.destroy().map_err(|e| e.to_string())?; }
    session.reset();
    let _ = window.set_focus();
    Ok(())
}
#[tauri::command]
pub fn editor_recover_opening(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Session, String> {
    caller(&window, "main")?;
    let state = app.state::<EditorWindow>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.owner != "opening" { return Err("The floating editor is active. Use its Dock control to return safely.".into()); }
    if let Some(editor) = app.get_webview_window("quick-editor") { editor.destroy().map_err(|e| e.to_string())?; }
    let recovered = session.clone();
    session.reset();
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_owner_handoff_retains_latest_unsaved_content() {
        let initial = serde_json::json!({"tabs": [{"text": "draft"}], "active": "a.ts"});
        let updated = serde_json::json!({"tabs": [{"text": "floating edits"}], "active": "b.ts"});
        let mut session = Session::default();
        assert!(session.ready().is_err());
        assert!(session.receive(updated.clone()).is_err());
        session.begin(initial.clone()).unwrap();
        assert_eq!(session.snapshot, Some(initial.clone()));
        assert!(session.begin(initial.clone()).is_err());
        session.ready().unwrap();
        assert_eq!(session.owner, "floating");
        assert!(session.snapshot.is_none());
        assert!(session.begin(initial).is_err());
        session.receive(updated.clone()).unwrap();
        assert_eq!(session.owner, "docking");
        assert_eq!(session.snapshot, Some(updated.clone()));
        assert!(session.receive(updated.clone()).is_err());
        assert_eq!(session.snapshot, Some(updated));
    }
    #[test]
    fn failed_transition_keeps_recoverable_drafts() {
        let initial = serde_json::json!({"tabs": [{"text": "keep me"}]});
        let mut session = Session::default();
        session.begin(initial.clone()).unwrap();
        assert!(session.receive(Value::Null).is_err());
        assert_eq!(session.owner, "opening");
        assert_eq!(session.snapshot, Some(initial));
    }
    #[test]
    fn stale_windows_cannot_write_after_handoffs() {
        let mut session = Session::default();
        assert!(session.check_writer("main", 0).is_ok());
        assert!(session.check_writer("quick-editor", 0).is_err());
        session.begin(serde_json::json!({"tabs": []})).unwrap();
        assert!(session.check_writer("main", 0).is_err());
        session.ready().unwrap();
        assert!(session.check_writer("quick-editor", session.revision).is_ok());
        session.receive(serde_json::json!({"tabs": []})).unwrap();
        assert!(session.check_writer("quick-editor", session.revision).is_err());
        session.reset();
        assert!(session.check_writer("main", 0).is_err());
        assert!(session.check_writer("main", session.revision).is_ok());
    }
    #[test]
    fn rejects_invalid_sessions() {
        assert!(snapshot_valid(&serde_json::json!({"tabs": []})).is_ok());
        assert!(snapshot_valid(&serde_json::json!({"tabs": "invalid"})).is_err());
        assert!(snapshot_valid(&Value::Null).is_err());
    }
}
