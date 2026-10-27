use std::{collections::HashSet, fs::OpenOptions, io::Write, path::Path};

use crate::Project;

pub(crate) fn validate_projects(projects: &[Project]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut roots = HashSet::new();
    for project in projects {
        if project.id.trim().is_empty() || project.id.contains("::") {
            return Err("A project has an empty or invalid ID. Correct projects.json before saving.".into());
        }
        if !ids.insert(&project.id) { return Err(format!("Duplicate project ID '{}'.", project.id)); }
        if project.name.trim().is_empty() || project.root.trim().is_empty() || !Path::new(&project.root).is_absolute() {
            return Err(format!("Project '{}' needs a name and an absolute root directory.", project.id));
        }
        let root = std::fs::canonicalize(&project.root).unwrap_or_else(|_| project.root.clone().into());
        #[cfg(windows)]
        let root_key = root.to_string_lossy().replace('/', "\\").to_lowercase();
        #[cfg(not(windows))]
        let root_key = root.to_string_lossy().to_string();
        if !roots.insert(root_key) { return Err(format!("Project '{}' has a root already saved in another project.", project.name)); }
        let mut services = HashSet::new();
        for service in &project.services {
            if service.id.trim().is_empty() || service.id.contains("::") || !services.insert(&service.id) {
                return Err(format!("Project '{}' has an empty, invalid, or duplicate service ID.", project.name));
            }
            if service.name.trim().is_empty() || service.cwd.trim().is_empty() || !Path::new(&service.cwd).is_absolute() {
                return Err(format!("Service '{}' needs a name and an absolute working directory.", service.id));
            }
            if service.program.contains('\0') || service.args.iter().any(|argument| argument.contains('\0')) {
                return Err(format!("Service '{}' contains an invalid NUL character.", service.id));
            }
            if service.port == Some(0) { return Err(format!("Service '{}' needs a port from 1 to 65535.", service.id)); }
            // An empty program is allowed for a newly added service awaiting review.
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn new_id(prefix: &str) -> Result<String, String> {
    use windows_sys::{core::GUID, Win32::System::Com::CoCreateGuid};
    let mut guid = GUID::default();
    let result = unsafe { CoCreateGuid(&mut guid) };
    if result < 0 { return Err(format!("Could not create a project ID (Windows error {result:#x}).")); }
    let tail = guid.data4.iter().map(|part| format!("{part:02x}")).collect::<String>();
    Ok(format!("{prefix}{:08x}{:04x}{:04x}{tail}", guid.data1, guid.data2, guid.data3))
}

#[cfg(not(windows))]
pub(crate) fn new_id(prefix: &str) -> Result<String, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    Ok(format!("{prefix}{nanos:x}{:x}{:x}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)))
}

pub(crate) fn save_file(path: &Path, data: &[u8]) -> Result<(), String> {
    let id = new_id("save-")?;
    let temp = path.with_file_name(format!("projects.{id}.tmp"));
    let backup = path.with_file_name(format!("projects.previous.{id}.json"));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|error| error.to_string())?;
    file.write_all(data).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    drop(file);
    if path.exists() {
        #[cfg(windows)] {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
            let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            std::fs::copy(path, &backup).map_err(|error| format!("Could not preserve the previous projects.json copy: {error}"))?;
            let result = unsafe { MoveFileExW(wide(&temp).as_ptr(), wide(path).as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
            if result == 0 { return Err(format!("Could not replace projects.json ({}). The previous data remains in projects.json and its recoverable copy at {}. No automatic repair was attempted.", std::io::Error::last_os_error(), backup.display())); }
        }
        #[cfg(not(windows))] {
            std::fs::copy(path, &backup).map_err(|error| error.to_string())?;
            std::fs::rename(&temp, path).map_err(|error| error.to_string())?;
        }
    } else {
        std::fs::rename(&temp, path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Service;

    fn fixture(root: &Path) -> Project {
        Project { id: "p1".into(), name: "Example".into(), root: root.to_string_lossy().into(), services: vec![
            Service { id: "web".into(), name: "Web".into(), cwd: root.to_string_lossy().into(), program: String::new(), args: vec![], role: None, framework: None, host: None, port: None, review_note: None, interpreter_path: None, entry_point: None, confidence: None, run_options: vec![], health_check: None },
        ] }
    }

    #[test]
    fn rejects_duplicate_ids_and_roots_but_allows_unfinished_service_drafts() {
        let root = std::env::temp_dir();
        let project = fixture(&root);
        assert!(validate_projects(&[project.clone()]).is_ok());
        assert!(validate_projects(&[project.clone(), project.clone()]).is_err());
        let mut second = project.clone();
        second.id = "p2".into();
        assert!(validate_projects(&[project, second]).is_err());
    }

    #[test]
    fn replacement_keeps_the_previous_project_file() {
        let directory = std::env::temp_dir().join(new_id("devflow-storage-test-").unwrap());
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("projects.json");
        save_file(&path, b"old project data").unwrap();
        save_file(&path, b"new project data").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new project data");
        let backups = std::fs::read_dir(&directory).unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("projects.previous."))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(&backups[0]).unwrap(), b"old project data");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
