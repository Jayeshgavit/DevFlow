//! Trusted workspace persistence; never exposed as a model tool.
use serde::{Deserialize, Serialize};
use tauri::Manager;
static CANDIDATE: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Serialize, Deserialize, Default)]
pub struct History { revision: u64, #[serde(default)] location: String, chats: Vec<Chat> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chat { id: String, title: String, provider: String, model: String, draft: String, updated: u64, messages: Vec<Message> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message { id: String, role: String, content: String, timestamp: u64, #[serde(default)] status: Option<String> }
fn location(app: &tauri::AppHandle, project: &str) -> Result<std::path::PathBuf, String> {
    let projects: Vec<crate::Project> = serde_json::from_slice(&std::fs::read(crate::storage_path(app)?).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if !projects.iter().any(|p| p.id == project) { return Err("Project is no longer saved.".into()); }
    // Encode every byte, so IDs cannot introduce paths or Windows device names.
    let key: String = project.bytes().map(|b| format!("{b:02x}")).collect();
    if key.len() > 200 { return Err("Project identifier too long.".into()); }
    let dir = directory(app)?;
    let config = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-chat-storage.json");
    if config.exists() && !dir.is_dir() { return Err("Custom history directory is unavailable. Reconnect the drive or select another location in Settings.".into()); }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("project-{key}.json")))
}
fn read(path: &std::path::Path) -> Result<History, String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(History::default()),
        Err(e) => Err(e.to_string()),
        Ok(m) => { if m.len() > 8 * 1024 * 1024 { return Err("History exceeds the 8 MiB project limit.".into()); }
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }
    }
}
#[tauri::command]
pub fn chat_history_load(app: tauri::AppHandle, project_id: String) -> Result<History, String> {
    let _lock = LOCK.lock().map_err(|_| "History lock unavailable")?;
    let path = location(&app, &project_id)?;
    let mut history = read(&path)?; history.location = path.display().to_string(); Ok(history)
}
#[tauri::command]
pub fn chat_history_save(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, lease: u64, history: History) -> Result<u64, String> {
    let session = app.state::<crate::editor_window::EditorWindow>();
    let session = session.0.lock().map_err(|_| "Editor lock unavailable")?;
    session.check_writer(window.label(), lease)?;
    let _lock = LOCK.lock().map_err(|_| "History lock unavailable")?;
    let path = location(&app, &project_id)?;
    if history.location != path.display().to_string() { return Err("Chat storage changed. Reopen DevFlow before saving. Current messages remain in memory.".into()); }
    if read(&path)?.revision != history.revision { return Err("History changed in another window. Reopen the editor before saving; current messages remain in memory.".into()); }
    if history.chats.len() > 100 { return Err("100 conversation limit reached. Export and explicitly delete older chats.".into()); }
    for chat in &history.chats {
        if chat.title.len() > 500 || chat.messages.iter().any(|m| m.role != "user" && m.role != "assistant") { return Err("Invalid conversation.".into()); }
    }
    let next = History { revision: history.revision.checked_add(1).ok_or("History revision overflow")?, location: history.location, chats: history.chats };
    let data = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    if data.len() > 8 * 1024 * 1024 { return Err("8 MiB history limit reached. Export and explicitly delete older chats. Nothing was pruned.".into()); }
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", crate::project_storage::new_id("chat-")?));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&data).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)] {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
            let wide = |p: &std::path::Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            if unsafe { MoveFileExW(wide(&temp).as_ptr(), wide(&path).as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        }
        #[cfg(not(windows))] std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result?;
    Ok(next.revision)
}

fn directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = base.join("ai-chat-storage.json");
    match std::fs::read(config) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(base.join("ai-chats-v1")),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
pub fn chat_storage_location(app: tauri::AppHandle) -> Result<String, String> { Ok(directory(&app)?.display().to_string()) }
#[tauri::command]
pub async fn chat_storage_pick(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if window.label() != "main" { return Err("Change storage in main Settings.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app.dialog().file().set_parent(&window).set_title("Choose AI chat storage — avoid Git and synchronized folders").blocking_pick_folder() else { return Ok(None); };
        let path = folder.into_path().map_err(|e| e.to_string())?;
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.is_dir() { return Err("Choose an available local directory.".into()); }
        let display = path.display().to_string();
        *CANDIDATE.lock().map_err(|_| "Storage picker unavailable")? = Some(path);
        Ok(Some(display))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn chat_storage_apply(app: tauri::AppHandle, window: tauri::WebviewWindow, migrate: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("Change storage in main Settings.".into()); }
    let _lock = LOCK.lock().map_err(|_| "History lock unavailable")?;
    let destination = CANDIDATE.lock().map_err(|_| "Storage picker unavailable")?.take().ok_or("Choose a folder first.")?;
    let source = directory(&app)?;
    if destination == source { return Ok(()); }
    // An existing history location is never merged or overwritten implicitly.
    if std::fs::read_dir(&destination).map_err(|e| e.to_string())?.next().is_some() { return Err("Choose an empty directory to avoid overwriting existing data.".into()); }
    let probe = destination.join(".devflow-write-probe");
    let f = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|e| format!("Destination is not writable: {e}"))?;
    f.sync_all().map_err(|e| e.to_string())?; drop(f); std::fs::remove_file(probe).map_err(|e| e.to_string())?;
    if migrate && !source.is_dir() { return Err("Original storage is unavailable. Reconnect it before migrating history.".into()); }
    if migrate && source.exists() {
        for entry in std::fs::read_dir(&source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name(); let name = name.to_string_lossy();
            if !name.starts_with("project-") || !name.ends_with(".json") { continue; }
            if entry.file_type().map_err(|e| e.to_string())?.is_symlink() { return Err("Linked history files cannot be migrated.".into()); }
            let _ = read(&entry.path())?;
            let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            use std::io::Write;
            let target = destination.join(name.as_ref());
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            if std::fs::read(target).map_err(|e| e.to_string())? != bytes { return Err("Migration verification failed. Original history remains intact.".into()); }
        }
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    crate::project_storage::save_file(&base.join("ai-chat-storage.json"), &serde_json::to_vec(&destination).map_err(|e| e.to_string())?)?;
    Ok(())
}
#[tauri::command]
pub async fn chat_history_export(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, chat_id: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if window.label() != "main" && window.label() != "quick-editor" { return Err("Export unavailable in this window.".into()); }
    let history = chat_history_load(app.clone(), project_id)?;
    let chat = history.chats.into_iter().find(|c| c.id == chat_id).ok_or("Save this conversation before exporting.")?;
    let mut text = format!("# {}\n\nDate (Unix milliseconds): {}\nProvider: {}\nModel: {}\n", chat.title, chat.updated, chat.provider, chat.model);
    for message in chat.messages { text.push_str(&format!("\n## {}\n\n{}\n", message.role, message.content)); }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().set_parent(&window).set_title("Export conversation — may contain sensitive code or logs").set_file_name("conversation.md").add_filter("Markdown", &["md"]).blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|e| e.to_string())?;
        use std::io::Write;
        // Refuse existing files even if the dialog approves replacement.
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("Choose a new filename; existing exports are never overwritten: {e}"))?;
        file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}
