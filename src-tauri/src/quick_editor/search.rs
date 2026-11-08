//! Local, cancellable project search. No AI or shell integration.
use super::{guard_directories, linked, open_text, resolve, validate_relative};
use ignore::{gitignore::{Gitignore, GitignoreBuilder}, WalkBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Instant};
use tauri::Manager;

#[derive(Default)]
pub struct SearchState(Mutex<HashMap<String, (String, Arc<AtomicBool>)>>);
impl SearchState {
    pub fn cancel(&self, window: &str, id: Option<&str>) {
        if let Ok(mut searches) = self.0.lock() {
            if searches.get(window).is_some_and(|(current, _)| id.is_none_or(|id| current == id)) {
                if let Some((_, flag)) = searches.remove(window) { flag.store(true, Ordering::Relaxed); }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOptions {
    query: String, case_sensitive: bool, whole_word: bool, regex: bool,
    include: String, exclude: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String, line: usize, column: usize, preview: String, start: usize, end: usize,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    hits: Vec<SearchHit>, files: usize, scanned: usize, skipped: usize,
    limited: bool, cancelled: bool, elapsed_ms: u128,
}

fn pattern(options: &SearchOptions) -> Result<Regex, String> {
    if options.query.is_empty() || options.query.len() > 1024 { return Err("Enter a search query of 1–1,024 UTF-8 bytes.".into()); }
    let source = if options.regex { options.query.clone() } else { regex::escape(&options.query) };
    let source = if options.whole_word { format!(r"\b(?:{source})\b") } else { source };
    RegexBuilder::new(&source).case_insensitive(!options.case_sensitive)
        .size_limit(2 * 1024 * 1024).build().map_err(|e| format!("Invalid search pattern: {e}"))
}
fn globs(root: &Path, text: &str) -> Result<Gitignore, String> {
    if text.len() > 2048 { return Err("File filters are limited to 2,048 bytes.".into()); }
    let mut builder = GitignoreBuilder::new(root);
    for glob in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if glob.starts_with('!') { return Err("Use comma-separated globs without ! prefixes.".into()); }
        builder.add_line(None, glob).map_err(|e| format!("Invalid file filter: {e}"))?;
    }
    builder.build().map_err(|e| e.to_string())
}
fn generated(path: &Path) -> bool {
    path.file_name().and_then(|s| s.to_str()).is_some_and(|name| matches!(name.to_ascii_lowercase().as_str(),
        ".git" | ".hg" | ".svn" | "node_modules" | "target" | "dist" | "build" | ".next" | ".venv" | "venv" | "__pycache__" | "coverage"))
}

fn scan(root: &Path, options: &SearchOptions, cancel: &Arc<AtomicBool>) -> Result<SearchResult, String> {
    let started = Instant::now();
    let regex = pattern(options)?;
    let include = globs(root, &options.include)?;
    let exclude = Arc::new(globs(root, &options.exclude)?);
    let excluded = exclude.clone();
    let filtered = options.include.split(',').any(|glob| !glob.trim().is_empty());
    let mut result = SearchResult::default();
    let mut bytes = 0usize;
    let mut guarded_parent = std::path::PathBuf::new();
    let mut _directory_guards = Vec::new();
    let flag = Arc::new(AtomicBool::new(false));
    let timed_out = flag.clone();
    let cancelled = cancel.clone();
    let mut walker = WalkBuilder::new(root);
    walker.hidden(false).follow_links(false).require_git(false).parents(false).git_global(false).max_depth(Some(64))
        .filter_entry(move |entry| {
            if cancelled.load(Ordering::Relaxed) { return false; }
            if started.elapsed().as_secs() >= 10 { timed_out.store(true, Ordering::Relaxed); return false; }
            entry.depth() == 0 || (!generated(entry.path())
                && !excluded.matched_path_or_any_parents(entry.path(), entry.file_type().is_some_and(|t| t.is_dir())).is_ignore()
                && std::fs::symlink_metadata(entry.path()).is_ok_and(|m| !linked(&m)))
        });
    for (visited, entry) in walker.build().enumerate() {
        if cancel.load(Ordering::Relaxed) { result.cancelled = true; break; }
        if visited >= 20_000 || started.elapsed().as_secs() >= 10 || bytes >= 64 * 1024 * 1024 {
            result.limited = true; break;
        }
        let entry = match entry { Ok(entry) => entry, Err(_) => { result.skipped += 1; continue; } };
        if entry.depth() >= 64 && entry.file_type().is_some_and(|t| t.is_dir()) { result.limited = true; }
        if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
        let path = entry.path();
        if exclude.matched_path_or_any_parents(path, false).is_ignore()
            || (filtered && !include.matched_path_or_any_parents(path, false).is_ignore()) { continue; }
        let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str).map(|s| s.replace('\\', "/")) else { result.skipped += 1; continue; };
        if validate_relative(&relative).is_err() { result.skipped += 1; continue; }
        // Retain ancestor locks throughout the read; never follow a swapped junction.
        let parent = path.parent().ok_or("Invalid search path.")?;
        if guarded_parent != parent {
            let Ok(guards) = guard_directories(parent) else { result.skipped += 1; continue; };
            _directory_guards = guards;
            guarded_parent = parent.to_owned();
        }
        let Ok((_file, content, _)) = open_text(path) else { result.skipped += 1; continue; };
        result.scanned += 1; bytes += content.len();
        let before = result.hits.len();
        let normalized = content.strip_prefix('\u{feff}').unwrap_or(&content).replace("\r\n", "\n").replace('\r', "\n");
        for (index, line) in normalized.lines().enumerate() {
            if cancel.load(Ordering::Relaxed) { result.cancelled = true; break; }
            if started.elapsed().as_secs() >= 10 { result.limited = true; break; }
            for found in regex.find_iter(line) {
                if result.hits.len() >= 1000 { result.limited = true; break; }
                let column = line[..found.start()].chars().count();
                let left = column.saturating_sub(80);
                let preview: String = line.chars().skip(left).take(240).collect();
                let length = line[found.start()..found.end()].chars().count();
                // JS offsets use UTF-16; keep highlighting aligned for non-BMP text.
                let start = preview.chars().take(column - left).map(char::len_utf16).sum();
                let end = preview.chars().take((column - left + length).min(240)).map(char::len_utf16).sum();
                result.hits.push(SearchHit { path: relative.clone(), line: index + 1, column: column + 1, preview, start, end });
            }
            if result.hits.len() >= 1000 { result.limited = true; break; }
        }
        if result.hits.len() > before { result.files += 1; }
        if result.limited || result.cancelled { break; }
    }
    result.limited |= flag.load(Ordering::Relaxed);
    result.cancelled |= cancel.load(Ordering::Relaxed);
    result.elapsed_ms = started.elapsed().as_millis();
    Ok(result)
}

#[tauri::command]
pub async fn editor_search(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, request_id: String, options: SearchOptions) -> Result<SearchResult, String> {
    let label = window.label().to_owned();
    if !matches!(label.as_str(), "main" | "quick-editor") { return Err("Search is available only in the editor workspace.".into()); }
    if request_id.is_empty() || request_id.len() > 100 { return Err("Invalid search request.".into()); }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<SearchState>();
        let mut searches = state.0.lock().map_err(|_| "Search unavailable.")?;
        if let Some((_, previous)) = searches.insert(label.clone(), (request_id.clone(), cancel.clone())) { previous.store(true, Ordering::Relaxed); }
    }
    let cleanup = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (root, _guards) = resolve(&app, &project_id, &expected_root, "", true)?;
        let result = scan(&root, &options, &cancel)?;
        // Reject results if the saved root changed during this scan.
        resolve(&app, &project_id, &expected_root, "", true)?;
        Ok(result)
    }).await.map_err(|e| e.to_string());
    cleanup.state::<SearchState>().cancel(&label, Some(&request_id));
    result?
}

#[tauri::command]
pub fn editor_cancel_search(app: tauri::AppHandle, window: tauri::WebviewWindow, request_id: String) {
    app.state::<SearchState>().cancel(window.label(), Some(&request_id));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFile {
    path: String, expected: super::Document, content: String, matches: usize,
}
#[derive(Serialize)]
pub struct ReplacePreview { files: Vec<ReplaceFile>, matches: usize }

fn append_bounded(output: &mut String, value: &str) -> Result<(), String> {
    if output.len().saturating_add(value.len()) > super::MAX_BYTES as usize {
        return Err("Replacement would exceed the 2 MiB file limit. Narrow the replacement.".into());
    }
    output.push_str(value); Ok(())
}

// Expand one capture at a time so repeated $0 references cannot allocate unbounded text.
fn replacement_text(output: &mut String, captures: &regex::Captures<'_>, mut template: &str, expand: bool) -> Result<(), String> {
    if !expand { return append_bounded(output, template); }
    while let Some(at) = template.find('$') {
        append_bounded(output, &template[..at])?;
        template = &template[at + 1..];
        if let Some(rest) = template.strip_prefix('$') { append_bounded(output, "$")?; template = rest; continue; }
        let braced = template.starts_with('{');
        let candidate = if braced { &template[1..] } else { template };
        let end = candidate.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
        if end == 0 || (braced && candidate.as_bytes().get(end) != Some(&b'}')) { append_bounded(output, "$")?; continue; }
        let name = &candidate[..end];
        let capture = match name.parse::<usize>() { Ok(index) => captures.get(index), Err(_) => captures.name(name) };
        if let Some(value) = capture { append_bounded(output, value.as_str())?; }
        template = &candidate[end + usize::from(braced)..];
    }
    append_bounded(output, template)
}

fn replace_content(content: &str, options: &SearchOptions, replacement: &str, regex: &Regex) -> Result<(String, usize), String> {
    let ending = super::line_ending(content);
    if ending == "mixed" { return Err("Mixed line endings: edit this file individually.".into()); }
    if replacement.len() > 4096 || replacement.contains('\0') { return Err("Replacement must be text under 4 KiB without NUL bytes.".into()); }
    let bom = content.starts_with('\u{feff}');
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content).replace("\r\n", "\n");
    let replacement = replacement.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = String::new();
    let mut matches = 0;
    for part in normalized.split_inclusive('\n') {
        let line = part.strip_suffix('\n').unwrap_or(part);
        let mut last = 0;
        for captures in regex.captures_iter(line) {
            matches += 1;
            if matches > 1000 { return Err("More than 1,000 replacements. Narrow the query or file filters.".into()); }
            let found = captures.get(0).ok_or("Missing search match.")?;
            append_bounded(&mut output, &line[last..found.start()])?;
            replacement_text(&mut output, &captures, &replacement, options.regex)?;
            last = found.end();
        }
        append_bounded(&mut output, &line[last..])?;
        if part.ends_with('\n') { append_bounded(&mut output, "\n")?; }
    }
    if ending == "CRLF" { output = output.replace('\n', "\r\n"); }
    if bom { output.insert(0, '\u{feff}'); }
    if output.len() > super::MAX_BYTES as usize { return Err("Replacement would exceed the 2 MiB file limit.".into()); }
    Ok((output, matches))
}

/// Read-only preparation. Commits reuse editor_save's writer lease, optimistic
/// disk check, pre-save history, and atomic per-file replacement.
#[tauri::command]
pub async fn editor_preview_replace(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, paths: Vec<String>, options: SearchOptions, replacement: String) -> Result<ReplacePreview, String> {
    if !matches!(window.label(), "main" | "quick-editor") { return Err("Replacement is available only in the editor workspace.".into()); }
    if paths.is_empty() || paths.len() > 100 { return Err("Review 1–100 files at a time. Narrow the file filters.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let regex = pattern(&options)?;
        let mut preview = ReplacePreview { files: Vec::new(), matches: 0 };
        let mut seen = std::collections::HashSet::new();
        let mut bytes = 0usize;
        for path in paths {
            if !seen.insert(path.to_lowercase()) { continue; }
            let (target, _guards) = resolve(&app, &project_id, &expected_root, &path, false)?;
            let (_file, original, read_only) = open_text(&target).map_err(|error| format!("{path}: {error}"))?;
            if read_only { return Err(format!("{path} is read-only. Exclude it before replacing.")); }
            let (content, matches) = replace_content(&original, &options, &replacement, &regex).map_err(|error| format!("{path}: {error}"))?;
            if original == content { continue; }
            preview.matches += matches;
            bytes += original.len() + content.len();
            if bytes > 16 * 1024 * 1024 || preview.matches > 1000 { return Err("Replacement preview exceeds 16 MiB or 1,000 matches. Narrow the file filters.".into()); }
            let expected = super::Document { line_ending: super::line_ending(&original).into(), content: original, read_only };
            preview.files.push(ReplaceFile { path, expected, content, matches });
        }
        resolve(&app, &project_id, &expected_root, "", true)?;
        Ok(preview)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_preserves_format_and_bounds_capture_expansion() {
        let mut options = SearchOptions { query: "(hello)".into(), case_sensitive: false, whole_word: false, regex: true, include: String::new(), exclude: String::new() };
        let regex = pattern(&options).unwrap();
        let (text, count) = replace_content("\u{feff}hello\r\nHELLO\r\n", &options, "${1} world $$", &regex).unwrap();
        assert_eq!(text, "\u{feff}hello world $\r\nHELLO world $\r\n"); assert_eq!(count, 2);
        assert_eq!(replace_content("hello\n", &options, "", &regex).unwrap().0, "\n");
        assert!(replace_content("hello\r\nhello\n", &options, "x", &regex).is_err());
        assert!(replace_content(&"hello ".repeat(1001), &options, "x", &regex).is_err());
        options.regex = false; options.query = "hello".into();
        assert_eq!(replace_content("hello", &options, "$1", &pattern(&options).unwrap()).unwrap().0, "$1");
        options.regex = true; options.query = ".*".into();
        assert!(replace_content(&"x".repeat(1024 * 1024), &options, "$0$0$0", &pattern(&options).unwrap()).is_err());
    }
    #[test]
    fn search_modes_and_bounds() {
        let fixture = super::super::tests::Fixture::new();
        std::fs::write(fixture.0.join("example.txt"), "😀 hello HELLO helloworld\nhello").unwrap();
        std::fs::create_dir(fixture.0.join("node_modules")).unwrap();
        std::fs::write(fixture.0.join("node_modules/ignored.txt"), "hello").unwrap();
        std::fs::write(fixture.0.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(fixture.0.join("ignored.txt"), "hello").unwrap();
        std::fs::write(fixture.0.join("binary.txt"), b"hello\0").unwrap();
        let mut options = SearchOptions { query: "hello".into(), case_sensitive: false, whole_word: true, regex: false, include: "*.txt".into(), exclude: String::new() };
        let result = scan(&fixture.0, &options, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(result.hits.len(), 3);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.hits[0].start, 3); // surrogate pair + space
        options.case_sensitive = true;
        assert_eq!(scan(&fixture.0, &options, &Arc::new(AtomicBool::new(false))).unwrap().hits.len(), 2);
        options.regex = true; options.query = "h.llo".into();
        assert_eq!(scan(&fixture.0, &options, &Arc::new(AtomicBool::new(false))).unwrap().hits.len(), 2);
        options.regex = true; options.query = "[".into(); assert!(pattern(&options).is_err());
        options.query = "hello".into(); options.exclude = "*.txt".into();
        assert!(scan(&fixture.0, &options, &Arc::new(AtomicBool::new(false))).unwrap().hits.is_empty());
        assert!(scan(&fixture.0, &options, &Arc::new(AtomicBool::new(true))).unwrap().cancelled);
        options.exclude.clear(); options.regex = false;
        std::fs::write(fixture.0.join("example.txt"), "hello\n".repeat(1002)).unwrap();
        let capped = scan(&fixture.0, &options, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(capped.hits.len(), 1000);
        assert!(capped.limited);
    }
}
