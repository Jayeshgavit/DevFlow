//! Deliberately narrow IPC: existing UTF-8 files inside saved project roots only.
use serde::Serialize;
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::Mutex};
use tauri::Manager;
pub(crate) mod actions;
pub(crate) mod snapshots;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
#[derive(Default)]
pub struct QuickEditor(pub Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { name: String, path: String, directory: bool, blocked: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document { content: String, line_ending: String, read_only: bool }

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

// Keep ancestor directories open without delete-sharing on Windows. This prevents
// a directory being exchanged for a junction while an operation is in progress.
fn guard_directories(path: &Path) -> Result<Vec<File>, String> {
    let mut guards = Vec::new();
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) { continue; }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(3).custom_flags(0x02000000 | 0x00200000); // backup semantics, open reparse point
        }
        let file = options.open(&current).map_err(|_| "Cannot safely access a project directory.")?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if linked(&metadata) || !metadata.is_dir() { return Err("Linked directories and junctions are not supported in Quick Editor.".into()); }
        guards.push(file);
    }
    Ok(guards)
}

fn validate_relative(relative: &str) -> Result<(), String> {
    if relative.contains(['\\', ':', '\0']) || relative.split('/').any(|part| part == ".." || part == "." || (!relative.is_empty() && part.is_empty()) || part.ends_with([' ', '.'])) {
        return Err("Use a project-relative path without traversal or alternate streams.".into());
    }
    let relative_path = Path::new(relative);
    if relative_path.components().any(|part| !matches!(part, Component::Normal(_))) { return Err("Invalid relative path.".into()); }
    Ok(())
}

fn resolve(app: &tauri::AppHandle, project_id: &str, expected_root: &str, relative: &str, directory: bool) -> Result<(PathBuf, Vec<File>), String> {
    validate_relative(relative)?;
    let relative_path = Path::new(relative);
    let storage = crate::storage_path(app)?;
    let projects: Vec<crate::Project> = serde_json::from_slice(&fs::read(storage).map_err(|_| "Save the project before using Quick Editor.")?).map_err(|_| "Saved projects could not be read.")?;
    let project = projects.iter().find(|p| p.id == project_id).ok_or("Save this project before using Quick Editor.")?;
    if project.root != expected_root { return Err("Project root differs from its saved configuration. Save or reload the project before using Quick Editor.".into()); }
    let root = PathBuf::from(&project.root);
    if !root.is_absolute() { return Err("Project root must be absolute.".into()); }
    let mut guards = guard_directories(&root)?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let target = root.join(relative_path);
    let parent = if directory { target.as_path() } else { target.parent().ok_or("Invalid file path.")? };
    guards.extend(guard_directories(parent)?);
    let canonical = fs::canonicalize(&target).map_err(|_| "File or folder no longer exists or is inaccessible.")?;
    if !canonical.starts_with(&root) || linked(&fs::symlink_metadata(&target).map_err(|e| e.to_string())?) {
        return Err("Linked paths and files outside the project are blocked.".into());
    }
    Ok((target, guards))
}

fn open_text(path: &Path) -> Result<(File, String, bool), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000); // lock out writers/deletion; do not follow reparse points
    }
    let mut file = options.open(path).map_err(|_| "Cannot open this file. It may be in use or inaccessible.")?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || linked(&metadata) { return Err("Only regular, unlinked text files are supported.".into()); }
    if metadata.len() > MAX_BYTES { return Err("This file exceeds the Quick Editor limit of 2 MiB.".into()); }
    let mut bytes = Vec::new();
    (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES || bytes.contains(&0) { return Err("Binary or oversized file. Choose a UTF-8 text file under 2 MiB.".into()); }
    let content = String::from_utf8(bytes).map_err(|_| "This file is not UTF-8. Quick Editor will not convert its encoding.")?;
    Ok((file, content, metadata.permissions().readonly()))
}

fn line_ending(content: &str) -> &'static str {
    let crlf = content.matches("\r\n").count();
    let lf = content.matches('\n').count();
    let cr = content.matches('\r').count();
    if cr != crlf || (crlf > 0 && crlf != lf) { "mixed" } else if crlf > 0 { "CRLF" } else { "LF" }
}

pub(crate) fn verify_log_location(app: &tauri::AppHandle, project: &str, root: &str, path: &str, line: usize) -> Result<bool, String> {
    if line == 0 { return Ok(false); }
    let (target, _guards) = match resolve(app, project, root, path, false) { Ok(result) => result, Err(_) => return Ok(false) };
    let (_, content, _) = match open_text(&target) { Ok(result) => result, Err(_) => return Ok(false) };
    Ok(line <= content.split('\n').count())
}

#[tauri::command]
pub async fn editor_list(app: tauri::AppHandle, project_id: String, expected_root: String, path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(target).map_err(|e| e.to_string())? {
            if entries.len() >= 5000 { return Err("This folder has more than 5,000 entries. Open a smaller project root.".into()); }
            let entry = entry.map_err(|e| e.to_string())?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { return Err("This folder contains a filename that cannot be represented as UTF-8.".into()); };
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            entries.push(Entry { path: if path.is_empty() { name.clone() } else { format!("{path}/{name}") }, name, directory: metadata.is_dir(), blocked: linked(&metadata) || (!metadata.is_dir() && !metadata.is_file()) });
        }
        entries.sort_by(|a, b| b.directory.cmp(&a.directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn editor_read(app: tauri::AppHandle, project_id: String, expected_root: String, path: String) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
        let (_file, content, read_only) = open_text(&target)?;
        Ok(Document { line_ending: line_ending(&content).into(), content, read_only })
    }).await.map_err(|e| e.to_string())?
}

fn save(path: &Path, expected: &str, content: &str, mut preserve: impl FnMut(&str) -> Result<String, String>) -> Result<String, String> {
    if content.len() as u64 > MAX_BYTES || content.contains('\0') { return Err("Save blocked: content is binary or exceeds 2 MiB.".into()); }
    let (original, current, read_only) = open_text(path)?;
    if current != expected { return Err("File changed on disk. Your edits are intact. Copy them, then reload the disk version before saving.".into()); }
    if read_only || line_ending(&current) == "mixed" { return Err("This file is read-only or has mixed line endings; saving is disabled to preserve it.".into()); }
    if current == content { return Ok(String::new()); }
    let snapshot = preserve(&current)?;
    let id = crate::project_storage::new_id("quick-editor-")?;
    let temp = path.with_file_name(format!(".devflow-{id}.tmp"));
    let backup = path.with_file_name(format!(".devflow-{id}.bak"));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.set_permissions(original.metadata().map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        // Release the read lock only once the replacement has been flushed.
        drop(original);
        let (check_file, disk, _) = open_text(path)?;
        if disk != expected {
            return Err("File changed while saving. No replacement was attempted.".into());
        }
        drop(check_file);
        #[cfg(windows)] {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
            let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            if unsafe { ReplaceFileW(wide(path).as_ptr(), wide(&temp).as_ptr(), wide(&backup).as_ptr(), 0, std::ptr::null(), std::ptr::null()) } == 0 {
                return Err(format!("Windows could not replace the file: {}. Recovery files, if created, remain beside the original ({id}).", std::io::Error::last_os_error()));
            }
        }
        #[cfg(not(windows))] {
            fs::copy(path, &backup).map_err(|e| e.to_string())?;
            fs::rename(&temp, path).map_err(|e| e.to_string())?;
        }
        // ReplaceFile captures the exact replaced bytes. Detect even an external
        // edit in the small interval between releasing the lock and replacement.
        let (_backup_file, replaced, _) = open_text(&backup).map_err(|e| format!("File replacement completed, but recovery verification failed: {e}. Review the disk file and recovery copy at {} before continuing.", backup.display()))?;
        drop(_backup_file);
        if replaced != expected {
            return Err(format!("Concurrent disk change detected during replacement. The replaced version is preserved at {}. Reload and review it before continuing; the disk now contains the requested replacement.", backup.display()));
        }
        fs::remove_file(&backup).map_err(|e| format!("File saved, but temporary replacement backup could not be removed ({}): {e}", backup.display()))?;
        Ok(snapshot)
    })();
    if temp.exists() { let _ = fs::remove_file(&temp); }
    result
}

#[tauri::command]
pub async fn editor_save(app: tauri::AppHandle, window: tauri::WebviewWindow, lease: u64, project_id: String, expected_root: String, path: String, expected: String, content: String) -> Result<String, String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.state::<crate::editor_window::EditorWindow>();
        let session = owner.0.lock().map_err(|e| e.to_string())?;
        session.check_writer(&label, lease)?;
        let state = app.state::<QuickEditor>();
        let _lock = state.0.lock().map_err(|_| "Editor storage unavailable.")?;
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
        save(&target, &expected, &content, |current| snapshots::before_save(&app, &project_id, &target, &path, current))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) struct Fixture(pub(super) PathBuf);
    impl Fixture {
        pub(super) fn new() -> Self {
            let path = std::env::temp_dir().join(crate::project_storage::new_id("devflow-editor-test-").unwrap());
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn rejects_traversal_absolute_paths_streams_and_windows_aliases() {
        for path in ["../secret", "src/../secret", "/etc/passwd", "C:/secret", "src\\file", "file:stream", "src//file", "src/./file", "file.", "file "] {
            assert!(validate_relative(path).is_err(), "{path}");
        }
        assert!(validate_relative("").is_ok());
        assert!(validate_relative("src/Header.tsx").is_ok());
        assert!(validate_relative("docs/日本語.md").is_ok());
    }

    #[test]
    fn unchanged_save_creates_no_recovery_files() {
        let fixture = Fixture::new(); let path = fixture.0.join("same.txt");
        fs::write(&path, "same").unwrap();
        assert_eq!(save(&path, "same", "same", |_| panic!("unchanged content must not be snapshotted")).unwrap(), "");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
    #[test]
    fn stale_save_preserves_disk_content() {
        let fixture = Fixture::new();
        let path = fixture.0.join("example.txt");
        fs::write(&path, "external change").unwrap();
        assert!(save(&path, "old version", "my edit", |_| panic!("stale save must not snapshot")).unwrap_err().contains("changed on disk"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external change");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn snapshot_storage_failure_prevents_replacement() {
        let fixture = Fixture::new(); let path = fixture.0.join("example.txt");
        fs::write(&path, "original").unwrap();
        assert!(save(&path, "original", "edited", |_| Err("Storage full".into())).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn replacement_preserves_previous_bytes_before_writing() {
        let fixture = Fixture::new();
        let path = fixture.0.join("example.txt");
        let before = "\u{feff}original\r\n日本語\r\n";
        let after = "\u{feff}edited\r\n日本語\r\n";
        fs::write(&path, before).unwrap();
        let mut previous = String::new();
        save(&path, before, after, |current| { previous = current.into(); Ok("stored".into()) }).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), after);
        assert_eq!(previous, before);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn refuses_binary_non_utf8_oversized_and_mixed_ending_writes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("example.txt");
        for bytes in [vec![0, 1], vec![0xff], vec![b'x'; MAX_BYTES as usize + 1]] {
            fs::write(&path, bytes).unwrap();
            assert!(open_text(&path).is_err());
        }
        let mixed = "one\r\ntwo\n";
        fs::write(&path, mixed).unwrap();
        assert_eq!(line_ending(mixed), "mixed");
        assert!(save(&path, mixed, "edited", |_| Ok(String::new())).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), mixed);
    }

    #[cfg(windows)]
    #[test]
    fn windows_read_handle_blocks_concurrent_writers_and_deletion() {
        let fixture = Fixture::new();
        let path = fixture.0.join("example.txt");
        fs::write(&path, "original").unwrap();
        let (file, _, _) = open_text(&path).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
        drop(file);
        assert!(OpenOptions::new().write(true).open(&path).is_ok());
    }
}
