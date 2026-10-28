//! Explicit, read-only development tool and manifest inspection. No shell or project execution.
use serde::Serialize;
use std::{env, fs, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult { id: String, name: String, status: &'static str, version: Option<String>, location: Option<String>, detail: String }

// Only these fixed executable names and fixed version flags can reach Command.
fn spec(id: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    Some(match id {
        "node" => ("Node.js", "node.exe", &["--version"]), "npm" => ("npm", "npm.exe", &["--version"]),
        "pnpm" => ("pnpm", "pnpm.exe", &["--version"]), "yarn" => ("Yarn", "yarn.exe", &["--version"]),
        "python" => ("Python", "python.exe", &["--version"]), "pip" => ("pip", "pip.exe", &["--version"]),
        "uv" => ("uv", "uv.exe", &["--version"]), "rustc" => ("Rust", "rustc.exe", &["--version"]),
        "cargo" => ("Cargo", "cargo.exe", &["--version"]), "go" => ("Go", "go.exe", &["version"]),
        "java" => ("Java", "java.exe", &["-version"]), "dotnet" => (".NET", "dotnet.exe", &["--version"]),
        "git" => ("Git", "git.exe", &["--version"]), "docker" => ("Docker CLI", "docker.exe", &["--version"]),
        "psql" => ("PostgreSQL CLI", "psql.exe", &["--version"]), "redis" => ("Redis CLI", "redis-cli.exe", &["--version"]),
        "mongo" => ("MongoDB shell", "mongosh.exe", &["--version"]),
        "codex" => ("Codex CLI", "codex.exe", &["--version"]), "claude" => ("Claude CLI", "claude.exe", &["--version"]),
        "gemini" => ("Gemini CLI", "gemini.exe", &["--version"]), "opencode" => ("OpenCode CLI", "opencode.exe", &["--version"]),
        _ => return None,
    })
}

fn executable(name: &str) -> Option<PathBuf> {
    // Never search the working directory or execute .cmd/.bat shims.
    env::var_os("PATH").into_iter().flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file() && fs::canonicalize(path).is_ok_and(|resolved| resolved.is_file() && resolved.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))))
}

async fn inspect(id: String) -> Result<ToolResult, String> {
    let (name, program, args) = spec(&id).ok_or("Unsupported tool.")?;
    let Some(path) = executable(program) else {
        let shim = env::var_os("PATH").into_iter().flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
            .filter(|dir| dir.is_absolute()).any(|dir| dir.join(program.replace(".exe", ".cmd")).is_file());
        return Ok(ToolResult { id, name: name.into(), status: if shim { "unknown" } else { "notFound" }, version: None, location: None, detail: if shim { "A .cmd shim is present on PATH, but scripts are not executed for version checks." } else { "No .exe found on PATH. Other Windows install locations were not checked." }.into() });
    };
    let location = Some(path.to_string_lossy().into_owned());
    let mut command = Command::new(&path);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(ToolResult { id, name: name.into(), status: "checkFailed", version: None, location, detail: "Executable could not be started.".into() }),
    };
    let stdout = child.stdout.take().ok_or("Output pipe unavailable.")?;
    let stderr = child.stderr.take().ok_or("Error pipe unavailable.")?;
    let output = async {
        let mut out = Vec::new(); let mut err = Vec::new();
        let mut bounded_out = stdout.take(4096); let mut bounded_err = stderr.take(4096);
        let (a, b, exit) = tokio::join!(bounded_out.read_to_end(&mut out), bounded_err.read_to_end(&mut err), child.wait());
        (a, b, exit, out, err)
    };
    match timeout(Duration::from_secs(4), output).await {
        Ok((Ok(_), Ok(_), Ok(exit), out, err)) if exit.success() => {
            let raw = if out.is_empty() { err } else { out };
            let candidate = String::from_utf8_lossy(&raw).lines().next().unwrap_or("").trim().chars().take(160).collect::<String>();
            let version = if candidate.chars().all(|c| c.is_ascii_alphanumeric() || " .-+_()/,".contains(c)) { candidate } else { String::new() };
            Ok(ToolResult { id, name: name.into(), status: if version.is_empty() { "unknown" } else { "installed" }, version: (!version.is_empty()).then_some(version), location, detail: "Version from allowlisted executable probe; service state was not checked.".into() })
        }
        Ok(_) => Ok(ToolResult { id, name: name.into(), status: "checkFailed", version: None, location, detail: "Version check exited unsuccessfully or returned unreadable output.".into() }),
        Err(_) => { let _ = child.kill().await; let _ = child.wait().await; Ok(ToolResult { id, name: name.into(), status: "checkFailed", version: None, location, detail: "Version check timed out after 4 seconds.".into() }) }
    }
}

#[tauri::command]
pub async fn check_tool(window: tauri::WebviewWindow, id: String) -> Result<ToolResult, String> {
    if window.label() != "main" { return Err("Available only in the main window.".into()); }
    inspect(id).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement { ecosystem: String, name: String, constraint: String, installed_version: Option<String>, status: &'static str, detail: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRequirements { ecosystems: Vec<String>, dependencies: Vec<Requirement>, notes: Vec<String> }

fn read_manifest(app: &tauri::AppHandle, id: &str, root: &str, file: &str) -> Result<Option<String>, String> {
    let root_path = Path::new(root);
    if !root_path.join(file).exists() { return Ok(None); }
    let (path, _guards) = crate::quick_editor::resolve(app, id, root, file, false)?;
    let (_file, text, _) = crate::quick_editor::open_text_limit(&path, 512 * 1024)
        .map_err(|_| "Manifest is linked, unreadable, binary, or exceeds the 512 KiB limit.".to_string())?;
    Ok(Some(text))
}

fn add(list: &mut Vec<Requirement>, ecosystem: &str, name: &str, constraint: &str) {
    if list.len() >= 1000 || name.is_empty() || name.len() > 160 || name.contains("..")
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-'|'_'|'.'|'@'|'/')) { return; }
    let lower = constraint.to_ascii_lowercase();
    let safe = constraint.len() <= 160 && constraint.chars().all(|c| c.is_ascii_alphanumeric() || " .^~<>=!*+-_,{}\"'".contains(c))
        && !["token", "secret", "password", "credential", "apikey", "api_key"].iter().any(|word| lower.contains(word));
    list.push(Requirement { ecosystem: ecosystem.into(), name: name.into(), constraint: if safe { constraint.into() } else { "Complex declaration omitted".into() }, installed_version: None, status: "unknown", detail: "Declared in a manifest; local installation and constraint satisfaction were not safely verified.".into() });
}

fn parse_requirements(app: &tauri::AppHandle, id: &str, root: &str) -> Result<ProjectRequirements, String> {
    crate::quick_editor::resolve(app, id, root, "", true)?;
    let mut result = ProjectRequirements { ecosystems: Vec::new(), dependencies: Vec::new(), notes: Vec::new() };
    if let Some(text) = read_manifest(app, id, root, "package.json")? {
        result.ecosystems.push("Node.js".into());
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            for section in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] {
                if let Some(items) = value.get(section).and_then(|v| v.as_object()) {
                    for (name, constraint) in items { if let Some(c) = constraint.as_str() { add(&mut result.dependencies, "Node.js", name, c); } }
                }
            }
        } else { result.notes.push("package.json could not be parsed.".into()); }
        for lock in ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"] {
            if Path::new(root).join(lock).exists() { result.notes.push(format!("{lock} present; lockfile versions are not proof of local installation.")); }
        }
    }
    if let Some(text) = read_manifest(app, id, root, "requirements.txt")? {
        result.ecosystems.push("Python".into());
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with('-') || line.contains("://") || line.contains('@') { continue; }
            let end = line.find(['<','>','=','!','~',';','[',' ','#']).unwrap_or(line.len());
            let name = &line[..end];
            if name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-'|'_'|'.')) { add(&mut result.dependencies, "Python", name, line[end..].split('#').next().unwrap_or("").trim()); }
        }
    }
    if let Some(text) = read_manifest(app, id, root, "pyproject.toml")? {
        if !result.ecosystems.contains(&"Python".to_string()) { result.ecosystems.push("Python".into()); }
        result.notes.push("pyproject.toml present; complex TOML dependency groups are not inferred.".into());
        // PEP 621 quoted dependency entries only; skip URLs and dynamic expressions.
        let mut in_deps = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("dependencies") && t.contains('[') { in_deps = true; }
            if in_deps && (t.starts_with('"') || t.starts_with('\'')) {
                let quote = t.chars().next().unwrap();
                if let Some(end) = t[1..].find(quote) { let value = &t[1..end+1]; let split = value.find(['<','>','=','!','~',';','[',' ']).unwrap_or(value.len()); if !value.contains('@') && !value.contains("://") { add(&mut result.dependencies, "Python", &value[..split], &value[split..]); } }
            }
            if in_deps && t.contains(']') { in_deps = false; }
        }
    }
    if let Some(text) = read_manifest(app, id, root, "Cargo.toml")? {
        result.ecosystems.push("Rust".into());
        let mut section = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('[') { section = t == "[dependencies]" || t == "[dev-dependencies]" || t == "[build-dependencies]"; continue; }
            if section { if let Some((name, value)) = t.split_once('=') { add(&mut result.dependencies, "Rust", name.trim(), value.trim()); } }
        }
    }
    if let Some(text) = read_manifest(app, id, root, "go.mod")? {
        result.ecosystems.push("Go".into());
        let mut block = false;
        for line in text.lines() {
            let t = line.trim();
            if t == "require (" { block = true; continue; }
            if block && t == ")" { block = false; continue; }
            if block || t.starts_with("require ") { let words: Vec<_> = t.trim_start_matches("require ").split_whitespace().collect(); if words.len() >= 2 { add(&mut result.dependencies, "Go", words[0], words[1]); } }
        }
    }
    // Only a directly readable, unlinked local package manifest proves a Node package version.
    // Lockfiles, global packages, and virtual stores do not establish installation here.
    for dependency in result.dependencies.iter_mut().filter(|item| item.ecosystem == "Node.js") {
        if !dependency.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-'|'_'|'.'|'@'|'/'))
            || dependency.name.contains("..") || dependency.name.starts_with('/') || dependency.name.matches('/').count() > 1 { continue; }
        let file = format!("node_modules/{}/package.json", dependency.name);
        let Some(text) = read_manifest(app, id, root, &file).ok().flatten() else { continue; };
        let Some(version) = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_owned)) else { continue; };
        if version.len() > 80 || !version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.'|'-'|'+'|'_')) { continue; }
        dependency.installed_version = Some(version.clone());
        let exact = dependency.constraint.trim_start_matches('=').trim();
        if !exact.is_empty() && exact.chars().all(|c| c.is_ascii_digit() || c == '.') {
            dependency.status = if exact == version { "satisfied" } else { "mismatch" };
            dependency.detail = "Direct local package version compared with an exact declared version.".into();
        } else { dependency.detail = "Direct local package version found; this version range was not evaluated.".into(); }
    }
    Ok(result)
}

#[tauri::command]
pub async fn check_project_requirements(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String) -> Result<ProjectRequirements, String> {
    if window.label() != "main" { return Err("Available only in the main window.".into()); }
    tauri::async_runtime::spawn_blocking(move || parse_requirements(&app, &project_id, &expected_root)).await.map_err(|_| "Project inspection failed.")?
}
