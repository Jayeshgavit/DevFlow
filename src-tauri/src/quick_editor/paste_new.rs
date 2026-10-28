//! Human-confirmed new UTF-8 files only. Uses the explorer's root/path/lease guards.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct NewFile { path: String, content: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review { path: String, missing: Vec<String>, existing: bool, error: Option<String>, created: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome { items: Vec<Review>, directories: Vec<String> }

fn inspect(root: &Path, item: &NewFile) -> Review {
    let mut review = Review { path: item.path.clone(), missing: vec![], existing: false, error: None, created: false };
    let mut check = || -> Result<Vec<String>, String> {
        validate_relative(&item.path)?;
        for part in item.path.split('/') { actions::valid_name(part)?; }
        if item.path.len() > 1024 || item.path.split('/').count() > 24 { return Err("Destination is too long or deep.".into()); }
        if actions::excluded(&item.path) { return Err("Sensitive or generated destinations are blocked.".into()); }
        if actions::language(&item.path).is_none() { return Err("Choose a supported source/text file type.".into()); }
        if fs::metadata(root).map_err(|e| e.to_string())?.permissions().readonly() { return Err("Project root is read-only.".into()); }
        if item.content.trim().is_empty() || item.content.len() > 256 * 1024 || item.content.chars().any(|c| c == '\u{fffd}' || (c.is_control() && !matches!(c, '\n'|'\r'|'\t'))) { return Err("Empty, binary, invalid or oversized content (256 KiB maximum).".into()); }
        let mut missing = vec![];
        let parts: Vec<_> = item.path.split('/').collect();
        let mut current = root.to_owned();
        let mut retained = guard_directories(root)?;
        let mut absent = false;
        for (index, part) in parts.iter().enumerate() {
            current.push(part);
            if absent {
                if index < parts.len() - 1 { missing.push(parts[..=index].join("/")); }
                continue;
            }
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if index == parts.len() - 1 { review.existing = true; }
                    if linked(&metadata) { return Err("Linked paths and junctions are blocked.".into()); }
                    if index == parts.len() - 1 { return Err("A file or folder already exists. Open it or use Smart Replace.".into()); }
                    if !metadata.is_dir() { return Err("A parent destination is a file.".into()); }
                    retained.extend(guard_directories(&current)?);
                    if metadata.permissions().readonly() { return Err("Destination folder is read-only.".into()); }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    absent = true;
                    if index < parts.len() - 1 { missing.push(parts[..=index].join("/")); }
                }
                Err(_) => return Err("Destination is inaccessible.".into()),
            }
        }
        Ok(missing)
    };
    // symlink_metadata also detects dangling links; retained parent handles
    // prevent a directory/junction exchange during inspection on Windows.
    match check() { Ok(missing) => review.missing = missing, Err(error) => review.error = Some(error) }
    review
}

#[tauri::command]
pub async fn editor_create_files(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, files: Vec<NewFile>, lease: u64, preview: bool, create_parents: bool) -> Result<Outcome, String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.state::<crate::editor_window::EditorWindow>();
        let session = owner.0.lock().map_err(|e| e.to_string())?;
        session.check_writer(&label, lease)?;
        let state = app.state::<QuickEditor>();
        let _lock = state.0.lock().map_err(|e| e.to_string())?;
        if files.is_empty() || files.len() > 20 || files.iter().map(|f| f.content.len()).sum::<usize>() > 256 * 1024 { return Err("Select 1–20 files totaling at most 256 KiB.".into()); }
        let (root, _root_guards) = resolve(&app, &project_id, &expected_root, "", true)?;
        let mut items: Vec<_> = files.iter().map(|file| inspect(&root, file)).collect();
        for i in 0..files.len() {
            let path = files[i].path.to_lowercase();
            if files.iter().enumerate().any(|(j, other)| i != j && (other.path.to_lowercase() == path || path.starts_with(&(other.path.to_lowercase() + "/")))) {
                items[i].error = Some("Duplicate destination or another selected file occupies a parent path.".into());
            }
        }
        let mut outcome = Outcome { items, directories: vec![] };
        if preview || outcome.items.iter().any(|r| r.error.is_some()) { return Ok(outcome); }
        if !create_parents && outcome.items.iter().any(|r| !r.missing.is_empty()) { return Err("Confirm Create missing directories first.".into()); }
        let mut stopped = false;
        for (file, review) in files.iter().zip(outcome.items.iter_mut()) {
            if stopped { review.error = Some("Not attempted after an earlier failure.".into()); continue; }
            let result = (|| -> Result<(), String> {
                let parts: Vec<_> = file.path.split('/').collect();
                let mut parent = root.clone();
                let mut guards = guard_directories(&parent)?;
                for (index, part) in parts[..parts.len() - 1].iter().enumerate() {
                    parent.push(part);
                    match fs::symlink_metadata(&parent) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create_parents => {
                            fs::create_dir(&parent).map_err(|e| e.to_string())?;
                            outcome.directories.push(parts[..=index].join("/"));
                        }
                        Err(e) => return Err(e.to_string()),
                        Ok(_) => {},
                    }
                    guards.extend(guard_directories(&parent)?);
                }
                let mut output = OpenOptions::new().write(true).create_new(true).open(parent.join(parts.last().ok_or("Filename missing")?)).map_err(|e| e.to_string())?;
                // Mark immediately: a failed write may leave a partial new file. Never delete it.
                review.created = true;
                output.write_all(file.content.as_bytes()).and_then(|_| output.sync_all()).map_err(|e| format!("New file exists but writing failed; inspect its contents: {e}"))?;
                Ok(())
            })();
            if let Err(error) = result { review.error = Some(error); stopped = true; }
        }
        Ok(outcome)
    }).await.map_err(|e| e.to_string())?
}
