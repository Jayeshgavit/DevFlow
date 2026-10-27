//! Local, bounded history. Only this directory is enumerated, never project trees.
use super::*;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_LIMIT: u64 = 64 * 1024 * 1024;
const RECORD_LIMIT: u64 = 12 * 1024 * 1024 + 64 * 1024; // JSON escaping of a 2 MiB file
const COUNT_LIMIT: usize = 1000;
const PER_FILE: usize = 20;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record { id: String, timestamp: u64, project: String, file: String, path: String, content: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version { id: String, timestamp: u64, path: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History { versions: Vec<Version>, limitation: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison { snapshot: String, current: Document }

fn eligible(path: &str, content: &str) -> bool {
    !actions::excluded(path) && !actions::sensitive_content(content)
        && !path.split('/').any(|part| matches!(part.to_ascii_lowercase().as_str(), ".docker" | ".azure" | ".gnupg" | "gcloud"))
        && ![".der", ".p8", ".ppk"].iter().any(|suffix| path.to_ascii_lowercase().ends_with(suffix))
        && !content.contains('\0') && content.len() as u64 <= MAX_BYTES
}
fn key(target: &Path) -> Result<String, String> {
    let value = fs::canonicalize(target).map_err(|_| "File no longer exists.")?.to_string_lossy().into_owned();
    #[cfg(windows)] { Ok(value.to_lowercase()) }
    #[cfg(not(windows))] { Ok(value) }
}
fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 96 && id.bytes().all(|b| b.is_ascii_hexdigit()) }

// Create each missing directory only after guarding its parent. Reject junctions,
// symlinks, and reparse points in app-data just as in project paths.
fn directory(app: &tauri::AppHandle) -> Result<(PathBuf, Vec<File>), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("file-snapshots-v1");
    let mut current = PathBuf::new();
    let mut guards = Vec::new();
    for component in dir.components() {
        current.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) { continue; }
        match fs::create_dir(&current) {
            Ok(()) => {},
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(format!("Cannot create snapshot storage: {e}")),
        }
        guards.extend(guard_directories(&current)?);
    }
    Ok((dir, guards))
}

fn records(dir: &Path) -> Result<Vec<(PathBuf, Record, u64)>, String> {
    let mut result = Vec::new();
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        if result.len() >= COUNT_LIMIT { return Err("Snapshot entry limit reached; inspect local snapshot storage.".into()); }
        let path = entry.map_err(|e| e.to_string())?.path();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        // A crash during staging leaves at most one incomplete record. It was
        // never published as history and is safe to discard on the next access.
        if path.extension().and_then(|s| s.to_str()) == Some("tmp") && valid_id(stem) {
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if linked(&metadata) || !metadata.is_file() { return Err("Unsafe snapshot staging file.".into()); }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") || !valid_id(stem) {
            return Err("Unexpected file in snapshot storage; inspect it before continuing.".into());
        }
        let entry_metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if linked(&entry_metadata) || !entry_metadata.is_file() { return Err("Linked snapshot records are blocked.".into()); }
        let mut options = OpenOptions::new(); options.read(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if linked(&metadata) || !metadata.is_file() || metadata.len() > RECORD_LIMIT {
            return Err("Unsafe or oversized snapshot record; history is unavailable.".into());
        }
        total += metadata.len();
        if total > STORE_LIMIT { return Err("Snapshot storage exceeds 64 MiB; inspect local snapshot storage.".into()); }
        let mut bytes = Vec::new();
        (&mut file).take(RECORD_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > RECORD_LIMIT { return Err("Snapshot record too large.".into()); }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| "Snapshot storage is damaged; no file was replaced.")?;
        if record.id != stem || record.timestamp > 8_640_000_000_000_000 || validate_relative(&record.path).is_err() || !eligible(&record.path, &record.content) { return Err("Invalid or excluded snapshot record.".into()); }
        result.push((path, record, metadata.len()));
    }
    result.sort_by(|a, b| a.1.timestamp.cmp(&b.1.timestamp).then(a.1.id.cmp(&b.1.id)));
    Ok(result)
}

fn preserve(dir: &Path, project: &str, file: &str, path: &str, content: &str) -> Result<String, String> {
    if !eligible(path, content) { return Ok(String::new()); }
    let mut existing = records(dir)?;
    let record = Record { id: crate::project_storage::new_id("")?, timestamp: SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64,
        project: project.into(), file: file.into(), path: path.into(), content: content.into() };
    let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > RECORD_LIMIT { return Err("Snapshot metadata exceeds the storage limit.".into()); }
    let mut total: u64 = existing.iter().map(|item| item.2).sum();
    let mut matching = existing.iter().filter(|item| item.1.project == project && item.1.file == file).count();
    // Evict oldest versions first, before adding bytes, so even transient growth is bounded.
    while matching >= PER_FILE || total + bytes.len() as u64 > STORE_LIMIT || existing.len() >= COUNT_LIMIT - 1 {
        let index = if matching >= PER_FILE { existing.iter().position(|item| item.1.project == project && item.1.file == file).unwrap() } else { 0 };
        let (old_path, old, size) = existing.remove(index);
        fs::remove_file(old_path).map_err(|e| format!("Could not apply snapshot retention: {e}"))?;
        total -= size;
        if old.project == project && old.file == file { matching -= 1; }
    }
    let destination = dir.join(format!("{}.json", record.id));
    let staging = dir.join(format!("{}.tmp", record.id));
    let mut output = OpenOptions::new().write(true).create_new(true).open(&staging).map_err(|e| e.to_string())?;
    let result = output.write_all(&bytes).and_then(|_| output.sync_all());
    drop(output);
    if let Err(error) = result { let _ = fs::remove_file(&staging); return Err(format!("Snapshot could not be stored; file was not saved: {error}")); }
    fs::rename(&staging, &destination).map_err(|e| format!("Could not publish snapshot; project file was not saved: {e}"))?;
    Ok(record.id)
}

pub(super) fn before_save(app: &tauri::AppHandle, project: &str, target: &Path, path: &str, content: &str) -> Result<String, String> {
    if !eligible(path, content) { return Ok(String::new()); }
    let (dir, _guards) = directory(app)?;
    preserve(&dir, project, &key(target)?, path, content)
}

#[tauri::command]
pub async fn editor_history(app: tauri::AppHandle, project_id: String, expected_root: String, path: String) -> Result<History, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QuickEditor>(); let _lock = state.0.lock().map_err(|_| "Editor storage unavailable.")?;
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
        let (_file, content, _) = open_text(&target)?;
        let allowed = eligible(&path, &content);
        let mut versions = Vec::new();
        if allowed {
            let (dir, _storage_guards) = directory(&app)?;
            let file_key = key(&target)?;
            versions = records(&dir)?.into_iter().rev().filter(|item| item.1.project == project_id && item.1.file == file_key)
                .map(|(_, item, _)| Version { id: item.id, timestamp: item.timestamp, path: item.path }).collect();
        }
        Ok(History { versions, limitation: if allowed { "Up to 20 versions per file; 64 MiB / 999 versions overall. Oldest versions expire. History stays with the original project and path; moved or renamed files start new history." } else { "History excluded for sensitive, generated, dependency, or potentially secret-bearing files." }.into() })
    }).await.map_err(|e| e.to_string())?
}

fn selected(dir: &Path, project: &str, file: &str, id: &str) -> Result<String, String> {
    if !valid_id(id) { return Err("Invalid snapshot identifier.".into()); }
    records(dir)?.into_iter().find(|(_, item, _)| item.project == project && item.file == file && item.id == id)
        .map(|(_, item, _)| item.content).ok_or("Snapshot expired or does not belong to this file.".into())
}

#[tauri::command]
pub async fn editor_snapshot(app: tauri::AppHandle, project_id: String, expected_root: String, path: String, id: String) -> Result<Comparison, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<QuickEditor>(); let _lock = state.0.lock().map_err(|_| "Editor storage unavailable.")?;
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
        let (_file, content, read_only) = open_text(&target)?;
        if !eligible(&path, &content) { return Err("History is excluded for this file.".into()); }
        let (dir, _storage_guards) = directory(&app)?;
        Ok(Comparison { snapshot: selected(&dir, &project_id, &key(&target)?, &id)?, current: Document { line_ending: line_ending(&content).into(), content, read_only } })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn editor_restore(app: tauri::AppHandle, window: tauri::WebviewWindow, lease: u64, project_id: String, expected_root: String, path: String, id: String, expected: String) -> Result<Document, String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.state::<crate::editor_window::EditorWindow>(); let session = owner.0.lock().map_err(|e| e.to_string())?;
        session.check_writer(&label, lease)?;
        let state = app.state::<QuickEditor>(); let _lock = state.0.lock().map_err(|_| "Editor storage unavailable.")?;
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
        if !eligible(&path, &expected) { return Err("Restore is excluded for this file.".into()); }
        let (dir, _storage_guards) = directory(&app)?;
        let file_key = key(&target)?;
        let content = selected(&dir, &project_id, &file_key, &id)?;
        save(&target, &expected, &content, |current| preserve(&dir, &project_id, &file_key, &path, current))?;
        let (_file, content, read_only) = open_text(&target)?;
        Ok(Document { line_ending: line_ending(&content).into(), content, read_only })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_restore_roundtrip_preserves_disk_and_rejects_stale_restore() {
        let fixture = super::super::tests::Fixture::new();
        let dir = fixture.0.join("history"); fs::create_dir(&dir).unwrap();
        let target = fixture.0.join("example.txt");
        let original = "\u{feff}original\r\n日本語\r\n";
        fs::write(&target, original).unwrap();
        let file_key = key(&target).unwrap();
        let snapshot = save(&target, original, "edited\r\n", |current| preserve(&dir, "p", &file_key, "example.txt", current)).unwrap();
        let previous = selected(&dir, "p", &file_key, &snapshot).unwrap();
        assert_eq!(previous, original);
        assert!(save(&target, "stale", &previous, |current| preserve(&dir, "p", &file_key, "example.txt", current)).is_err());
        assert_eq!(records(&dir).unwrap().len(), 1);
        let undo = save(&target, "edited\r\n", &previous, |current| preserve(&dir, "p", &file_key, "example.txt", current)).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), original);
        assert_eq!(selected(&dir, "p", &file_key, &undo).unwrap(), "edited\r\n");
        // Simulate an interrupted snapshot write. Published history stays usable.
        fs::write(dir.join("abcdef.tmp"), "partial").unwrap();
        assert_eq!(records(&dir).unwrap().len(), 2);
        assert!(!dir.join("abcdef.tmp").exists());
    }
    #[test]
    fn bounded_persistent_history_and_identity() {
        let fixture = super::super::tests::Fixture::new();
        for index in 0..24 { preserve(&fixture.0, "project", "root/a.txt", "a.txt", &format!("version {index}")).unwrap(); }
        let saved = records(&fixture.0).unwrap();
        assert_eq!(saved.len(), PER_FILE);
        let id = &saved.last().unwrap().1.id;
        assert!(selected(&fixture.0, "other", "root/a.txt", id).is_err());
        assert!(selected(&fixture.0, "project", "other/a.txt", id).is_err());
        assert!(selected(&fixture.0, "project", "root/a.txt", "../bad").is_err());
        assert!(selected(&fixture.0, "project", "root/a.txt", id).unwrap().starts_with("version "));
    }
    #[test]
    fn sensitive_versions_are_never_written() {
        let fixture = super::super::tests::Fixture::new();
        for (path, text) in [(".env.local", "value"), ("keys/a.key", "value"), ("credentials.json", "value"), ("a.txt", "api_key=example"), ("a.txt", "a\0b")] {
            assert_eq!(preserve(&fixture.0, "p", "f", path, text).unwrap(), "");
        }
        assert_eq!(records(&fixture.0).unwrap().len(), 0);
    }
}
