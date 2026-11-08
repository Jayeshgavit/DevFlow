//! Bounded, explicit explorer actions. No shell commands or deletion API.
use super::*;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{collections::BTreeMap, time::{Duration, Instant}};

const FILE_LIMIT: u64 = 256 * 1024;
const TOTAL_LIMIT: usize = 2 * 1024 * 1024;
const ENTRY_LIMIT: usize = 2000;
const FILE_COUNT: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Export { text: String, warnings: Vec<String>, files: usize }

const COPY_BUDGETS: [usize; 5] = [16_384, 65_536, 131_072, 262_144, 524_288];
const COPY_HEADER: &str = "Review the following source context. Identify every changed or new file by its project-relative path. Folder exports are filtered snapshots, not complete projects.\n";

fn readable_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    // Extended-only names (reserved devices, trailing dots/spaces, etc.) must
    // retain their prefix: stripping it would change Win32 path interpretation.
    let ordinary = |parts: &str| parts.split('\\').filter(|part| !part.is_empty()).all(|part| valid_name(part).is_ok());
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        if ordinary(unc) { return format!(r"\\{unc}"); }
    }
    if let Some(drive) = value.strip_prefix(r"\\?\") {
        if drive.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && drive.as_bytes().get(1) == Some(&b':') && drive.as_bytes().get(2) == Some(&b'\\') && ordinary(&drive[3..]) { return drive.to_string(); }
    }
    value.into_owned()
}

pub(super) fn excluded(path: &str) -> bool {
    path.split('/').any(|part| {
        let p = part.to_ascii_lowercase();
        matches!(p.as_str(), "node_modules"|".git"|".hg"|".svn"|"dist"|"build"|"target"|"out"|"coverage"|".next"|".nuxt"|".output"|".cache"|".turbo"|".venv"|"venv"|"__pycache__"|".pytest_cache"|".mypy_cache"|".ruff_cache"|".yarn"|".pnpm-store"|".parcel-cache"|".svelte-kit"|".vercel"|".netlify"|"bin"|"obj"|".gradle"|"vendor"|".aws"|".ssh"|".kube"|"secrets"|"credentials"|"certs"|"keys"|".npmrc"|".pypirc"|".netrc"|".git-credentials"|"package-lock.json"|"pnpm-lock.yaml"|"yarn.lock"|"cargo.lock")
            || p.starts_with(".env") || p.starts_with(".devflow-") || p.starts_with("id_rsa") || p.starts_with("id_ed25519")
            || p.contains("secret") || p.contains("credential") || p.contains("private-key") || p.contains("private_key") || p.contains("service_account") || p.contains("firebase-adminsdk") || p == ".dockercfg" || p == ".bash_history" || p == ".mysql_history" || p == ".psql_history" || p.ends_with(".tfstate") || p.ends_with(".tfvars") || p.contains("service-account") || p.starts_with("appsettings")
            || [".pem", ".key", ".pfx", ".p12", ".keystore", ".jks", ".cert", ".crt", ".map", ".min.js", ".min.css", ".generated.ts", ".g.cs", ".bak", ".tmp", ".log"].iter().any(|suffix| p.ends_with(suffix))
    })
}
pub(super) fn language(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    Some(match name.rsplit('.').next().unwrap_or("") {
        "ts"|"tsx" => "typescript", "js"|"jsx"|"mjs"|"cjs" => "javascript", "py"|"pyi" => "python",
        "rs" => "rust", "json" => "json", "css"|"scss"|"less" => "css", "html"|"htm"|"svg"|"xml" => "xml",
        "md"|"markdown" => "markdown", "txt"|"csv"|"tsv" => "text", "toml" => "toml", "yaml"|"yml" => "yaml",
        "sql" => "sql", "sh"|"bash" => "bash", "ps1"|"psm1" => "powershell", "c"|"h"|"cpp"|"hpp" => "cpp",
        "cs" => "csharp", "go" => "go", "java" => "java", "kt" => "kotlin", "rb" => "ruby", "php" => "php",
        "vue"|"svelte" => "html", _ if matches!(name.as_str(), "dockerfile"|"makefile"|".gitignore"|"license") => "text",
        _ => return None,
    })
}
pub(super) fn sensitive_content(text: &str) -> bool {
    crate::ai_chat::unsafe_outgoing_content(text) || text.contains('\0')
}
fn file_block(path: &str, text: &str) -> String {
    // Delimiter length cannot collide with a fence in the source text.
    let fence = "`".repeat(text.split(|c| c != '`').map(str::len).max().unwrap_or(0).max(2) + 1);
    format!("\n--- FILE ---\nFILE: {path}\nNAME: {}\nLANGUAGE: {}\nCONTENT:\n{fence}{}\n{text}\n{fence}\n--- END FILE ---\n", path.rsplit('/').next().unwrap_or(path), language(path).unwrap_or("text"), language(path).unwrap_or("text"))
}
fn local_ignore(directory: &Path) -> Result<Option<Gitignore>, String> {
    let path = directory.join(".gitignore");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot safely read .gitignore; copying stopped.".into()),
        Ok(metadata) if linked(&metadata) || metadata.len() > 64 * 1024 => return Err("Unsafe or oversized .gitignore; copying stopped.".into()),
        _ => {}
    }
    let (_file, text, _) = open_text(&path).map_err(|_| "Cannot safely read .gitignore; copying stopped.")?;
    let mut builder = GitignoreBuilder::new(directory);
    for line in text.lines() { builder.add_line(Some(path.clone()), line).map_err(|_| "Invalid .gitignore pattern; copying stopped.")?; }
    builder.build().map(Some).map_err(|_| "Cannot compile .gitignore; copying stopped.".into())
}
fn ignored(rules: &[Gitignore], path: &Path, directory: bool) -> bool {
    for rule in rules.iter().rev() {
        let found = rule.matched(path, directory);
        if found.is_ignore() { return true; }
        if found.is_whitelist() { return false; }
    }
    false
}
struct Collector {
    root: PathBuf, tree: String, contents: String, files: usize, entries: usize, bytes: usize,
    skipped: BTreeMap<&'static str, usize>, start: Instant, stopped: bool, ai: bool, clipboard: bool, budget: usize, reviews: Vec<String>, omissions: Vec<String>,
}
impl Collector {
    fn skip(&mut self, reason: &'static str) { *self.skipped.entry(reason).or_default() += 1; }
    fn limit(&mut self) -> bool {
        if self.stopped { return true; }
        if self.entries >= ENTRY_LIMIT || (self.ai && self.files >= FILE_COUNT) || self.bytes >= TOTAL_LIMIT || self.tree.len() >= 128 * 1024 || self.start.elapsed() > Duration::from_secs(5) {
            self.skip("Traversal/output limit reached; remaining entries omitted"); self.stopped = true;
        }
        self.stopped
    }
    fn omit(&mut self, relative: &str, reason: &str) { self.omissions.push(format!("{relative}: {reason}")); }
    fn file(&mut self, path: &Path, relative: &str, draft: Option<&str>) -> Result<bool, String> {
        if !self.ai { self.files += 1; return Ok(true); }
        if language(relative).is_none() { self.skip("Unsupported/generated/binary file types"); return Ok(false); }
        let metadata = fs::symlink_metadata(path).map_err(|_| "Cannot inspect file.")?;
        if linked(&metadata) || !metadata.is_file() { self.skip("Linked or nonregular files"); return Ok(false); }
        if metadata.len() > if self.clipboard { MAX_BYTES } else { FILE_LIMIT } || draft.is_some_and(|value| value.len() as u64 > if self.clipboard { MAX_BYTES } else { FILE_LIMIT }) { self.skip(if self.clipboard { "Files above trusted 2 MiB read limit" } else { "Files above 256 KiB" }); return Ok(false); }
        let (_file, disk, _) = open_text(path)?;
        if disk.len() as u64 > if self.clipboard { MAX_BYTES } else { FILE_LIMIT } { self.skip(if self.clipboard { "Files above trusted 2 MiB read limit" } else { "Files above 256 KiB" }); return Ok(false); }
        let content = draft.unwrap_or(&disk);
        if self.clipboard {
            if content.len() > self.budget { self.skip("Source exceeds selected budget"); return Ok(false); }
            let safe = crate::ai_chat::prepare_content(content)?;
            let block = file_block(relative, &safe.content);
            // Reserve room for tree/omission metadata; final assembled bytes are checked again.
            if self.contents.len() + self.tree.len() + block.len() + COPY_HEADER.len() + 2048 > self.budget {
                self.skip("Budget exceeded; choose a larger budget or copy specific files/selected code");
                return Ok(false);
            }
            if !safe.lines.is_empty() { self.reviews.push(format!("{relative}: sanitized source lines {:?}", safe.lines)); }
            self.contents.push_str(&block); self.bytes += content.len(); self.files += 1;
            return Ok(true);
        }
        if content.contains('\0') || sensitive_content(&disk) || sensitive_content(content) { self.skip("Potentially sensitive or binary content"); return Ok(false); }
        if self.bytes + content.len() > TOTAL_LIMIT { self.skip("Total content limit reached; file omitted"); self.stopped = true; return Ok(false); }
        if self.ai { self.contents.push_str(&file_block(relative, content)); }
        self.bytes += content.len(); self.files += 1;
        Ok(true)
    }
    fn walk(&mut self, directory: &Path, rules: &mut Vec<Gitignore>, prefix: &str, depth: usize) -> Result<(), String> {
        if depth > 24 { self.skip("Folders deeper than 24 levels"); return Ok(()); }
        let _guards = guard_directories(directory)?;
        let before = rules.len();
        if self.ai { if let Some(rule) = local_ignore(directory)? { rules.push(rule); } }
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|_| "Cannot read folder.")? {
            if self.limit() { break; }
            self.entries += 1;
            let entry = entry.map_err(|_| "Cannot read directory entry.")?;
            let relative = entry.path().strip_prefix(&self.root).map_err(|_| "Path outside project.")?.to_str().ok_or("Non UTF-8 path.")?.replace('\\', "/");
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "Cannot inspect directory entry.")?;
            let prune = if self.ai { excluded(&relative) } else { metadata.is_dir() && matches!(entry.file_name().to_str(), Some("node_modules" | ".git" | ".next" | "dist" | "build" | "target" | ".cache" | ".venv" | "__pycache__")) };
            if validate_relative(&relative).is_err() || prune { self.omit(&relative, "excluded path"); self.skip("Sensitive, generated, dependency or cache paths"); continue; }
            if linked(&metadata) { self.omit(&relative, "linked path"); self.skip("Symlinks or junctions"); continue; }
            if self.ai && ignored(rules, &entry.path(), metadata.is_dir()) { self.omit(&relative, "gitignored"); self.skip("Gitignored entries"); continue; }
            entries.push((entry.path(), relative, metadata.is_dir()));
        }
        entries.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
        let count = entries.len();
        for (index, (path, relative, directory)) in entries.into_iter().enumerate() {
            if self.limit() { break; }
            let last = index + 1 == count;
            let name = relative.rsplit('/').next().unwrap_or(&relative);
            if directory {
                self.tree.push_str(&format!("{prefix}{}{name}/\n", if last { "└── " } else { "├── " }));
                self.walk(&path, rules, &format!("{prefix}{}", if last { "    " } else { "│   " }), depth + 1)?;
            } else {
                match self.file(&path, &relative, None) {
                    Ok(true) => self.tree.push_str(&format!("{prefix}{}{name}\n", if last { "└── " } else { "├── " })),
                    Ok(false) => { self.omit(&relative, "not included (type, size or budget)"); }, Err(_) => { self.omit(&relative, "unreadable, binary or cannot safely sanitize"); self.skip("Unreadable, binary or unsafe files"); },
                }
            }
        }
        rules.truncate(before);
        Ok(())
    }
}
#[cfg(test)]
fn export(root: &Path, relative: &str, mode: &str, draft: Option<&str>) -> Result<Export, String> {
    export_budget(root, relative, mode, draft, 65_536)
}
fn export_budget(root: &Path, relative: &str, mode: &str, draft: Option<&str>, budget: usize) -> Result<Export, String> {
    validate_relative(relative)?;
    if mode != "tree" && excluded(relative) { return Err("Copy blocked: sensitive, generated or excluded path.".into()); }
    let target = root.join(relative);
    let directory = !matches!(mode, "file" | "attachment" | "copy-file" | "copy-slice");
    let _guards = guard_directories(if directory { &target } else { target.parent().ok_or("Invalid file path.")? })?;
    let canonical = fs::canonicalize(&target).map_err(|_| "Path unavailable.")?;
    if !canonical.starts_with(root) || linked(&fs::symlink_metadata(&target).map_err(|e| e.to_string())?) { return Err("Linked or outside-project paths are blocked.".into()); }
    let mut collector = Collector { root: root.to_owned(), tree: format!("{}/\n", if relative.is_empty() { "." } else { relative }), contents: String::new(), files: 0, entries: 0, bytes: 0, skipped: BTreeMap::new(), start: Instant::now(), stopped: false, ai: mode != "tree", clipboard: mode.starts_with("copy-"), budget, reviews: vec![], omissions: vec![] };
    let mut rules = Vec::new();
    let mut parent = root.to_owned();
    // Load only in-project ancestor ignore rules; never inspect user/global config.
    if mode != "tree" { if let Some(rule) = local_ignore(&parent)? { rules.push(rule); } }
    let parent_relative = if directory { relative } else { relative.rsplit_once('/').map(|(p, _)| p).unwrap_or("") };
    for part in parent_relative.split('/').filter(|p| !p.is_empty()) {
        parent.push(part);
        if ignored(&rules, &parent, true) { return Err("Copy blocked: folder is ignored by .gitignore.".into()); }
        if mode != "tree" && parent != target { if let Some(rule) = local_ignore(&parent)? { rules.push(rule); } }
    }
    if directory {
        collector.walk(&target, &mut rules, "", 0)?;
    } else {
        if ignored(&rules, &target, false) { return Err("Copy blocked: file is ignored by .gitignore.".into()); }
        if mode == "copy-file" || mode == "copy-slice" {
            if language(relative).is_none() { return Err("Unsupported AI source file type.".into()); }
            let (_file, disk, _) = open_text(&target)?;
            let source = draft.unwrap_or(&disk);
            if source.len() > budget { return Err("Copy exceeds selected budget. Choose a larger budget or selected code. Nothing was truncated.".into()); }
            let safe = crate::ai_chat::prepare_content(source)?;
            let warnings = if safe.lines.is_empty() { vec![] } else { vec![format!("{relative}: sanitized source lines {:?}", safe.lines)] };
            let text = if mode == "copy-slice" { safe.content } else { format!("{COPY_HEADER}Source: disk file\n{}", file_block(relative, &safe.content)) };
            if text.len() > budget { return Err("Copy exceeds selected budget. Choose a larger budget, specific files, or selected code. Nothing was truncated.".into()); }
            return Ok(Export { text, warnings, files: 1 });
        }
        if mode == "attachment" {
            if language(relative).is_none() { return Err("Unsupported AI source file type.".into()); }
            let (_file, disk, _) = open_text(&target)?;
            if disk.len() as u64 > FILE_LIMIT || draft.is_some_and(|v| v.len() as u64 > FILE_LIMIT) { return Err("Attachment exceeds 256 KiB.".into()); }
            // Inspect disk even when a draft/selection is supplied. Private keys
            // remain blocked; only the reviewed snapshot leaves this boundary.
            crate::ai_chat::prepare_content(&disk)?;
            let safe = crate::ai_chat::prepare_content(draft.unwrap_or(&disk))?;
            let warnings = if safe.lines.is_empty() { vec![] } else { vec![format!("Sanitized source lines: {:?}. Review sanitized content before sending.", safe.lines)] };
            return Ok(Export { text: safe.content, warnings, files: 1 });
        }
        validate_ai_file(&target, relative, draft)?;
        if !collector.file(&target, relative, draft)? { return Err("Copy blocked: sensitive, unsupported, binary or oversized file.".into()); }
    }
    let warnings: Vec<String> = collector.skipped.iter().map(|(reason, count)| format!("{reason}: {count}")).collect();
    let mut text = if mode == "file" { std::mem::take(&mut collector.contents) } else { format!("FOLDER NAME: {}\nFOLDER: {}\n\nTREE:\n{}{}", target.file_name().unwrap_or_default().to_string_lossy(), if relative.is_empty() { "." } else { relative }, collector.tree, collector.contents) };
    if !warnings.is_empty() { text.push_str("\nWARNINGS (copy is filtered or incomplete):\n"); text.push_str(&warnings.join("\n")); text.push('\n'); }
    let mut warnings = warnings;
    if collector.clipboard {
        if !collector.omissions.is_empty() { text.push_str("\nOMITTED FILES / SUBTREES (not a complete project):\n"); text.push_str(&collector.omissions.join("\n")); }
        if collector.files == 0 { return Err("No eligible complete files fit this folder export. Choose a larger budget, a smaller folder, a specific file or selected code. Use Copy Folder Tree for names only.".into()); }
        warnings.extend(collector.reviews);
        text.insert_str(0, &format!("{COPY_HEADER}Source: disk files\n"));
        if text.len() > budget { return Err("Folder output exceeds selected budget including metadata. Choose a larger budget, a smaller folder, specific files or selected code. Nothing was copied or truncated.".into()); }
    }
    Ok(Export { text, warnings, files: collector.files })
}

fn validate_ai_file(path: &Path, relative: &str, draft: Option<&str>) -> Result<(), String> {
    if language(relative).is_none() { return Err(format!("{relative}: unsupported AI source file type.")); }
    if excluded(relative) { return Err("AI context blocked: sensitive, generated or excluded path.".into()); }
    let (_file, disk, _) = open_text(path).map_err(|_| "AI context blocked: file is unavailable, binary, or over the 2 MiB editor limit.")?;
    if draft.is_some_and(|text| text.len() as u64 > MAX_BYTES) { return Err("AI context blocked: draft exceeds the 2 MiB editor limit.".into()); }
    for (label, text) in [("disk file", disk.as_str()), ("draft", draft.unwrap_or(""))] {
        if let Some((line, reason)) = crate::ai_chat::outgoing_content_issue(text) {
            return Err(format!("Attachment blocked: {reason} in {label} on line {line}. Remove the sensitive value or choose another file."));
        }
        if text.contains('\0') { return Err("Attachment blocked: binary content.".into()); }
    }
    Ok(())
}

#[tauri::command]
pub async fn editor_export(app: tauri::AppHandle, project_id: String, expected_root: String, path: String, mode: String, draft: Option<String>, budget: Option<usize>) -> Result<Export, String> {
    if !["file", "folder", "tree", "validate", "attachment", "copy-file", "copy-folder", "copy-slice", "name", "relative", "full"].contains(&mode.as_str()) { return Err("Unknown copy action.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _root_guards) = resolve(&app, &project_id, &expected_root, "", true)?;
        let budget = budget.unwrap_or(65_536);
        if !COPY_BUDGETS.contains(&budget) { return Err("Unsupported clipboard budget.".into()); }
        if matches!(mode.as_str(), "name" | "relative" | "full") {
            let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
            let text = match mode.as_str() {
                "name" => target.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                "relative" => if path.is_empty() { ".".into() } else { path },
                _ => readable_path(&target),
            };
            return Ok(Export { text, warnings: vec![], files: 0 });
        }
        if mode == "validate" {
            let (target, _target_guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
            validate_ai_file(&target, &path, draft.as_deref())?;
            return Ok(Export { text: String::new(), warnings: vec![], files: 1 });
        }
        let (_target, _target_guards) = resolve(&app, &project_id, &expected_root, &path, !matches!(mode.as_str(), "file" | "attachment" | "copy-file" | "copy-slice"))?;
        let mut result = export_budget(&root, &path, &mode, draft.as_deref(), budget)?;
        if !matches!(mode.as_str(), "attachment" | "copy-file" | "copy-folder" | "copy-slice") { result.text = format!("PROJECT: {}\n{}", root.file_name().unwrap_or_default().to_string_lossy(), result.text); }
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}
pub(super) fn valid_name(name: &str) -> Result<(), String> {
    validate_relative(name)?;
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    if name.is_empty() || name.encode_utf16().count() > 255 || name.contains('/') || name.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) || (stem.starts_with("COM") || stem.starts_with("LPT")) && stem[3..].chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c)) {
        return Err("Choose a single valid Windows filename (no reserved device names).".into());
    }
    Ok(())
}
fn create(target: &Path, directory: bool) -> Result<(), String> {
    if directory { fs::create_dir(target).map_err(|e| e.to_string()) } else { OpenOptions::new().write(true).create_new(true).open(target).and_then(|f| f.sync_all()).map_err(|e| e.to_string()) }
}
fn rename(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        if unsafe { MoveFileExW(wide(source).as_ptr(), wide(destination).as_ptr(), 0) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(())
    }
    #[cfg(not(windows))] { let _ = (source, destination); Err("Safe rename is currently supported on Windows only.".into()) }
}
#[tauri::command]
pub async fn editor_mutate(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, path: String, action: String, name: String, lease: u64, create_parents: Option<bool>) -> Result<String, String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.state::<crate::editor_window::EditorWindow>();
        let session = owner.0.lock().map_err(|e| e.to_string())?;
        session.check_writer(&label, lease)?;
        let state = app.state::<QuickEditor>();
        let _lock = state.0.lock().map_err(|e| e.to_string())?;
        if action == "rename" { valid_name(&name)?; }
        else { validate_relative(&name)?; for part in name.split('/') { valid_name(part)?; } }
        if excluded(&name) { return Err("Sensitive or generated destinations cannot be created here.".into()); }
        if action == "rename" {
            if path.is_empty() { return Err("The saved project root cannot be renamed here.".into()); }
            let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            let (_parent, _parent_guards) = resolve(&app, &project_id, &expected_root, parent, true)?;
            // Resolve as a file: lock parents, but not the folder being moved.
            let (source, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
            let destination = source.with_file_name(&name);
            if destination.exists() { return Err("A file or folder with that name already exists.".into()); }
            rename(&source, &destination)?;
            Ok(if parent.is_empty() { name } else { format!("{parent}/{name}") })
        } else if action == "file" || action == "folder" {
            let mut relative = path.clone();
            let parts: Vec<&str> = name.split('/').collect();
            let mut retained = Vec::new();
            for part in &parts[..parts.len() - 1] {
                let (parent, guards) = resolve(&app, &project_id, &expected_root, &relative, true)?;
                retained.extend(guards);
                let target = parent.join(part);
                if !target.exists() {
                    if create_parents != Some(true) { return Err("Parent folder is missing. Enable Create Missing Directories to confirm creation.".into()); }
                    fs::create_dir(&target).map_err(|e| e.to_string())?;
                }
                relative = if relative.is_empty() { part.to_string() } else { format!("{relative}/{part}") };
            }
            let (parent, _guards) = resolve(&app, &project_id, &expected_root, &relative, true)?;
            create(&parent.join(parts.last().ok_or("Filename missing")?), action == "folder")?;
            Ok(if path.is_empty() { name } else { format!("{path}/{name}") })
        } else { Err("Unknown file action.".into()) }
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn editor_reveal(app: tauri::AppHandle, project_id: String, expected_root: String, path: String, directory: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, directory)?;
        #[cfg(windows)] {
            let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
            let argument = crate::windows_path_argument(&target);
            std::process::Command::new(system.join("explorer.exe")).arg(if directory { argument } else { format!("/select,{argument}") }).spawn().map(|_| ()).map_err(|e| e.to_string())
        }
        #[cfg(not(windows))] { let _ = target; Err("Reveal is available on Windows only.".into()) }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture { fn new() -> Self { let path = std::env::temp_dir().join(crate::project_storage::new_id("devflow-copy-test-").unwrap()); fs::create_dir(&path).unwrap(); Self(fs::canonicalize(path).unwrap()) } }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn clipboard_tree_is_metadata_only_even_with_private_keys_and_invalid_ignore() {
        let f = Fixture::new();
        fs::write(f.0.join("guide.md"), "-----BEGIN PRIVATE KEY-----\nDO_NOT_READ").unwrap();
        fs::write(f.0.join("image.bin"), [0, 255]).unwrap();
        fs::write(f.0.join(".env"), "PRIVATE_VALUE").unwrap();
        fs::write(f.0.join(".gitignore"), [0, 255]).unwrap();
        fs::create_dir(f.0.join("node_modules")).unwrap();
        let result = export(&f.0, "", "tree", None).unwrap();
        for name in ["guide.md", "image.bin", ".env", ".gitignore"] { assert!(result.text.contains(name)); }
        assert!(!result.text.contains("DO_NOT_READ")); assert!(!result.text.contains("PRIVATE_VALUE"));
        assert_eq!(result.files, 4);
    }
    #[test]
    fn clipboard_docs_and_placeholders_reuse_shared_policy() {
        let f = Fixture::new();
        let source = "Explain bearer authentication and authorization headers\nAuthorization: Bearer YOUR_TOKEN\nconst api_key = process.env.API_KEY;\n";
        fs::write(f.0.join("guide.md"), source).unwrap();
        let result = export_budget(&f.0, "guide.md", "copy-file", None, 16_384).unwrap();
        assert!(result.text.contains(source)); assert!(result.warnings.is_empty());
    }
    #[test]
    fn clipboard_sanitizes_source_and_drafts_without_modifying_disk() {
        let f = Fixture::new();
        let original = "const token = 'YOUR_TOKEN';\nconst password = 'actual-secret-value';\n";
        fs::write(f.0.join("auth.ts"), original).unwrap();
        let result = export_budget(&f.0, "auth.ts", "copy-file", None, 65_536).unwrap();
        assert!(!result.text.contains("actual-secret-value")); assert!(result.text.contains("[redacted]"));
        assert!(result.warnings[0].contains("[2]"));
        assert_eq!(fs::read_to_string(f.0.join("auth.ts")).unwrap(), original);
        let draft = "const password = 'draft-private-value';";
        let result = export_budget(&f.0, "auth.ts", "copy-slice", Some(draft), 65_536).unwrap();
        assert_eq!(result.text, "const password = '[redacted]';");
        for unsafe_text in ["-----BEGIN PRIVATE KEY-----\nprivate-value", "api_key = \"\"\"private-value"] {
            assert!(export_budget(&f.0, "auth.ts", "copy-slice", Some(unsafe_text), 65_536).is_err());
        }
        fs::write(f.0.join(".env"), "YOUR_TOKEN").unwrap();
        assert!(export_budget(&f.0, ".env", "copy-file", None, 65_536).is_err());
    }
    #[test]
    fn clipboard_utf8_budgets_include_fences_and_never_truncate() {
        let f = Fixture::new();
        fs::write(f.0.join("unicode.md"), "hello").unwrap();
        for budget in COPY_BUDGETS {
            let source = "λ".repeat(budget / 2);
            assert!(export_budget(&f.0, "unicode.md", "copy-slice", Some(&source), budget).is_ok());
            assert!(export_budget(&f.0, "unicode.md", "copy-file", Some(&source), budget).is_err());
            assert!(export_budget(&f.0, "unicode.md", "copy-slice", Some(&(source + "x")), budget).is_err());
        }
        fs::write(f.0.join("unicode.md"), "x".repeat(300_000)).unwrap();
        assert!(export_budget(&f.0, "unicode.md", "copy-file", None, 524_288).is_ok());
        assert!(export_budget(&f.0, "unicode.md", "copy-file", None, 262_144).is_err());
    }
    #[test]
    fn clipboard_folder_omits_whole_files_and_reports_paths() {
        let f = Fixture::new();
        fs::write(f.0.join("a.ts"), "const a = true;").unwrap();
        fs::write(f.0.join("large.ts"), "x".repeat(17_000)).unwrap();
        fs::write(f.0.join("auth.md"), "Authorization: Bearer AbCd01234567890123456789").unwrap();
        let result = export_budget(&f.0, "", "copy-folder", None, 16_384).unwrap();
        assert_eq!(result.files, 2); assert!(result.text.len() <= 16_384);
        assert!(result.text.contains("large.ts: not included")); assert!(!result.text.contains(&"x".repeat(100)));
        assert!(!result.text.contains("AbCd01234567890123456789")); assert!(!result.warnings.is_empty());
        assert!(export_budget(&f.0, "../outside", "copy-folder", None, 16_384).is_err());
    }
    #[test]
    fn clipboard_windows_paths_preserve_unc_and_normal_names() {
        assert_eq!(readable_path(Path::new(r"\\?\C:\work\src\file.ts")), r"C:\work\src\file.ts");
        assert_eq!(readable_path(Path::new(r"\\?\UNC\server\share\file.ts")), r"\\server\share\file.ts");
        assert_eq!(readable_path(Path::new(r"\\server\share\file.ts")), r"\\server\share\file.ts");
        for path in [r"\\?\C:\work\trailing.", r"\\?\C:\work\NUL", r"\\?\UNC\server\share\trailing "] {
            assert_eq!(readable_path(Path::new(path)), path);
        }
    }
    #[test]
    fn recursive_copy_filters_sensitive_ignored_generated_and_binary_files() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("src")).unwrap(); fs::create_dir(f.0.join("node_modules")).unwrap();
        for (name, content) in [("src/Header.tsx", "export const Header = () => 'hello';"), (".env", "DO_NOT_COPY_ENV"), ("secret.json", "DO_NOT_COPY_SECRET"), ("src/token.ts", "const password = 'DO_NOT_COPY_PASSWORD'"), ("ignored.ts", "DO_NOT_COPY_IGNORED"), ("node_modules/a.ts", "DO_NOT_COPY_MODULE"), (".gitignore", "ignored.ts\n.gitignore\n"), ("src/.gitignore", "omit.ts\n"), ("src/omit.ts", "DO_NOT_COPY_NESTED")] { fs::write(f.0.join(name), content).unwrap(); }
        fs::write(f.0.join("src/image.ts"), [0, 1, 2]).unwrap();
        let result = export(&f.0, "", "folder", None).unwrap();
        assert!(result.text.contains("src/Header.tsx")); assert!(result.text.contains("'hello'")); assert!(result.text.contains("LANGUAGE: typescript"));
        assert!(!result.text.contains("DO_NOT_COPY")); assert!(!result.text.contains("image.ts")); assert!(!result.warnings.is_empty());
        assert!(export(&f.0, "src/omit.ts", "file", None).is_err());
        assert!(export(&f.0, ".env", "file", None).is_err());
        assert!(export(&f.0, "src/Header.tsx", "file", Some("api_key='blocked'")).is_err());
    }
    #[test]
    fn context_safety_attachment_sanitizes_without_disk_changes_and_blocks_sensitive_files() {
        let f = Fixture::new();
        let original = "Authorization: Bearer AbCd01234567890123456789\nnext();\n";
        fs::write(f.0.join("auth.md"), original).unwrap();
        let result = export(&f.0, "auth.md", "attachment", None).unwrap();
        assert_eq!(result.text, "Authorization: Bearer [redacted]\nnext();\n");
        assert!(result.warnings[0].contains("[1]"));
        assert_eq!(fs::read_to_string(f.0.join("auth.md")).unwrap(), original);
        for path in [".env", "private.key", "credentials.json", "id_rsa"] {
            fs::write(f.0.join(path), "YOUR_TOKEN").unwrap();
            assert!(export(&f.0, path, "attachment", None).is_err());
        }
        fs::write(f.0.join("auth.md"), "-----BEGIN PRIVATE KEY-----\nprivate-value").unwrap();
        assert!(export(&f.0, "auth.md", "attachment", Some("safe draft")).is_err());
        assert!(export(&f.0, "../auth.md", "attachment", None).is_err());
    }
    #[test]
    fn nested_ignore_negation_and_ignored_parent_are_respected() {
        let f = Fixture::new(); fs::create_dir(f.0.join("src")).unwrap();
        fs::write(f.0.join(".gitignore"), "*.ts\n!src/keep.ts\n").unwrap();
        fs::write(f.0.join("src/keep.ts"), "const keep = true;").unwrap();
        fs::write(f.0.join("src/skip.ts"), "omit_this").unwrap();
        let result = export(&f.0, "src", "folder", None).unwrap();
        assert!(result.text.contains("const keep = true")); assert!(!result.text.contains("omit_this"));
        fs::write(f.0.join(".gitignore"), "src/\n").unwrap();
        assert!(export(&f.0, "src", "folder", None).is_err());
    }
    #[test]
    fn copy_limits_entries_and_files_and_never_reads_outside_root() {
        let f = Fixture::new();
        for i in 0..120 { fs::write(f.0.join(format!("file{i:03}.ts")), "const a = 1;").unwrap(); }
        let result = export(&f.0, "", "folder", None).unwrap();
        assert_eq!(result.files, FILE_COUNT); assert!(result.text.contains("limit"));
        assert!(export(&f.0, "../elsewhere", "folder", None).is_err());
        assert!(export(&f.0, "C:/elsewhere", "folder", None).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_reparse_point_is_never_traversed() {
        use std::os::windows::fs::symlink_dir;
        let f = Fixture::new(); let outside = Fixture::new();
        fs::write(outside.0.join("private.ts"), "OUTSIDE_CONTENT").unwrap();
        // Windows may require Developer Mode or symlink privilege.
        match symlink_dir(&outside.0, f.0.join("link")) {
            Ok(()) => {
                let result = export(&f.0, "", "folder", None).unwrap();
                assert!(!result.text.contains("OUTSIDE_CONTENT")); assert!(result.text.contains("Symlinks or junctions"));
                assert!(export(&f.0, "link", "folder", None).is_err());
                fs::remove_dir(f.0.join("link")).unwrap();
            }
            Err(error) if error.raw_os_error() == Some(1314) => eprintln!("Symlink traversal test unavailable: Windows privilege not held"),
            Err(error) => panic!("Could not create test link: {error}"),
        }
    }
    #[test]
    fn oversized_files_are_omitted_not_silently_truncated() {
        let f = Fixture::new(); fs::write(f.0.join("large.ts"), vec![b'a'; FILE_LIMIT as usize + 1]).unwrap();
        let result = export(&f.0, "", "folder", None).unwrap(); assert_eq!(result.files, 0); assert!(result.text.contains("256 KiB"));
    }
    #[test]
    fn rejects_unsafe_names_and_create_never_overwrites() {
        for name in ["", "../x", "a/b", "file:stream", "CON", "nul.txt", "a?b", "COM1.log", "LPT¹", "file.", "file "] { assert!(valid_name(name).is_err(), "{name}"); }
        assert!(valid_name("Header.tsx").is_ok());
        let f = Fixture::new(); let path = f.0.join("keep.txt"); fs::write(&path, "keep").unwrap(); assert!(create(&path, false).is_err()); assert_eq!(fs::read_to_string(path).unwrap(), "keep");
    }
    #[cfg(windows)]
    #[test]
    fn rename_preserves_existing_destination() {
        let f = Fixture::new(); let a = f.0.join("a.ts"); let b = f.0.join("b.ts"); fs::write(&a, "a").unwrap(); fs::write(&b, "b").unwrap();
        assert!(rename(&a, &b).is_err()); assert_eq!(fs::read_to_string(&a).unwrap(), "a"); assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }
}
