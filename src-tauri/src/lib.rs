use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, process::Stdio, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}};
use tauri::{Emitter, Manager, State};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWriteExt}, net::TcpStream, process::{Child, Command}};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
mod launcher;
mod notifications;
mod project_storage;
mod quick_editor;
mod editor_window;
mod logs_window;
mod log_actions;
mod service_output;
#[cfg_attr(not(windows), path = "system_center_unavailable.rs")]
mod system_center;
#[cfg(windows)]
mod windows_job;
mod ai_credentials;
mod ai_chat;
mod chat_history;
mod ai_model_check;
mod ai_provider;
mod api_tester;
mod developer_environment;
mod port_manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunOption { id: String, label: String, program: String, args: Vec<String>, verified: bool, source: String, explanation: String, #[serde(default, skip_serializing_if = "Option::is_none")] interpreter_path: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] entry_point: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckConfig { enabled: bool, host: String, #[serde(default, skip_serializing_if = "Option::is_none")] port: Option<u16>, path: String, interval_seconds: u16, timeout_seconds: u16, expected_status_min: u16, expected_status_max: u16 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Service { id: String, name: String, cwd: String, program: String, args: Vec<String>, #[serde(default, skip_serializing_if = "Option::is_none")] role: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] framework: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] host: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] port: Option<u16>, #[serde(default, skip_serializing_if = "Option::is_none")] review_note: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] interpreter_path: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] entry_point: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] confidence: Option<String>, #[serde(default)] run_options: Vec<RunOption>, #[serde(default, skip_serializing_if = "Option::is_none")] health_check: Option<HealthCheckConfig> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthSnapshot { status: String, checked_at: Option<u64>, status_code: Option<u16>, response_ms: Option<u64>, error: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project { id: String, name: String, root: String, services: Vec<Service> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine { project_id: String, service_id: String, stream: String, message: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceExit { project_id: String, service_id: String, exit_code: Option<i32>, status: String, stop_requested: bool, run_id: String }
#[derive(Clone)]
struct Running {
 child: Arc<tokio::sync::Mutex<Child>>,
 #[cfg(windows)]
 job: Arc<windows_job::WindowsJob>,
 stop_requested: Arc<AtomicBool>,
 stop_lock: Arc<tokio::sync::Mutex<()>>,
 declared_port: Option<u16>,
}
struct Starting {
 cancelled: AtomicBool,
 complete: tokio::sync::watch::Sender<bool>,
 declared_port: Option<u16>,
}
enum ProcessEntry { Starting(Arc<Starting>), Running(Running), Stopping(Running) }
impl ProcessEntry {
 fn declared_port(&self) -> Option<u16> {
  match self { Self::Starting(value) => value.declared_port, Self::Running(value) | Self::Stopping(value) => value.declared_port }
 }
}
#[derive(Default)]
struct AppState { processes: Mutex<HashMap<String, ProcessEntry>>, exiting: AtomicBool, projects_loaded: Mutex<bool> }
struct StartGuard<'a> { state: &'a AppState, key: String, starting: Arc<Starting>, committed: bool }
impl<'a> StartGuard<'a> {
 fn reserve(state: &'a AppState, key: String, declared_port: Option<u16>) -> Result<Self, String> {
  let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if state.exiting.load(Ordering::SeqCst) { return Err("DevFlow is closing; service was not started.".into()); }
  match processes.get(&key) {
   Some(ProcessEntry::Starting(_)) => return Err("Service is already starting".into()),
   Some(ProcessEntry::Running(_)) => return Err("Service already started".into()),
   Some(ProcessEntry::Stopping(_)) => return Err("Service is stopping".into()),
   None => {}
  }
  if let Some(port) = declared_port {
   if processes.iter().any(|(other, entry)| other != &key && entry.declared_port() == Some(port)) {
    return Err(format!("Port {port} is already declared by another DevFlow service. Review the commands before starting."));
   }
  }
  let (complete, _) = tokio::sync::watch::channel(false);
  let starting = Arc::new(Starting { cancelled: AtomicBool::new(false), complete, declared_port });
  processes.insert(key.clone(), ProcessEntry::Starting(starting.clone()));
  Ok(Self { state, key, starting, committed: false })
 }
 fn commit(&mut self, running: Running) -> Result<(), String> {
  let mut processes = self.state.processes.lock().map_err(|_| "State unavailable")?;
  if self.state.exiting.load(Ordering::SeqCst) || self.starting.cancelled.load(Ordering::SeqCst) {
   return Err("Service start was cancelled.".into());
  }
  if !matches!(processes.get(&self.key), Some(ProcessEntry::Starting(current)) if Arc::ptr_eq(current, &self.starting)) {
   return Err("Service start reservation was lost.".into());
  }
  processes.insert(self.key.clone(), ProcessEntry::Running(running));
  self.committed = true;
  self.starting.complete.send_replace(true);
  Ok(())
 }
}
impl Drop for StartGuard<'_> {
 fn drop(&mut self) {
  if self.committed { return; }
  if let Ok(mut processes) = self.state.processes.lock() {
   if matches!(processes.get(&self.key), Some(ProcessEntry::Starting(current)) if Arc::ptr_eq(current, &self.starting)) {
    processes.remove(&self.key);
   }
  }
  self.starting.complete.send_replace(true);
 }
}
#[cfg(windows)]
impl AppState {
 fn shutdown_jobs(&self) {
  self.exiting.store(true, Ordering::SeqCst);
  if let Ok(mut processes) = self.processes.lock() {
   let jobs: Vec<_> = processes.values().filter_map(|entry| match entry {
    ProcessEntry::Starting(starting) => { starting.cancelled.store(true, Ordering::SeqCst); None }
    ProcessEntry::Running(running) | ProcessEntry::Stopping(running) => {
     running.stop_requested.store(true, Ordering::SeqCst);
     Some(running.job.clone())
    }
   }).collect();
   processes.clear();
   drop(processes);
   for job in jobs {
    if let Err(error) = job.terminate() { eprintln!("Could not terminate a service Job Object during exit: {error}"); }
   }
  }
 }
}
fn process_key(project: &str, service: &str) -> String { format!("{}::{}", project, service) }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputBatch<'a> { project_id: &'a str, service_id: &'a str, stream: &'a str, run_id: &'a str, lines: Vec<service_output::OutputLine> }
fn stream_pipe<R>(pipe: Option<R>, app: &tauri::AppHandle, project_id: &str, service_id: &str, stream: &'static str, run_id: &str) -> Option<tauri::async_runtime::JoinHandle<()>>
where R: AsyncRead + Unpin + Send + 'static {
 pipe.map(|pipe| {
  let app = app.clone(); let project_id = project_id.to_owned(); let service_id = service_id.to_owned(); let run_id = run_id.to_owned();
  tauri::async_runtime::spawn(async move {
   let mut port_reported = false;
   let result = service_output::collect(pipe, |lines| {
    if !port_reported && lines.iter().any(|line| notifications::reports_port_conflict(&line.message)) {
     port_reported = true;
     notifications::diagnostic(&app, &project_id, &service_id, notifications::DiagnosticKind::PortConflict);
    }
    let _ = app.emit("service-log-batch", OutputBatch { project_id: &project_id, service_id: &service_id, stream, run_id: &run_id, lines });
   }).await;
   if let Err(error) = result {
    notifications::diagnostic(&app, &project_id, &service_id, notifications::DiagnosticKind::LogCollection);
    let _ = app.emit("service-log", LogLine { project_id, service_id, stream: "system".into(), message: format!("Could not read {stream} output: {error}") });
   }
  })
 })
}
async fn finish_output(task: &mut Option<tauri::async_runtime::JoinHandle<()>>) -> bool {
 if let Some(task) = task {
  if tokio::time::timeout(std::time::Duration::from_secs(2), &mut *task).await.is_err() { task.abort(); return false; }
 }
 true
}
fn storage_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
 let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
 std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
 Ok(dir.join("projects.json"))
}
#[tauri::command]
fn load_projects(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Vec<Project>, String> {
 let mut loaded = state.projects_loaded.lock().map_err(|_| "Project storage unavailable")?;
 *loaded = false;
 let path = storage_path(&app)?;
 if !path.exists() { *loaded = true; return Ok(vec![]); }
 let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
 let projects: Vec<Project> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
 project_storage::validate_projects(&projects)?;
 *loaded = true;
 Ok(projects)
}
#[tauri::command]
fn save_projects(app: tauri::AppHandle, state: State<'_, AppState>, projects: Vec<Project>) -> Result<(), String> {
 let loaded = state.projects_loaded.lock().map_err(|_| "Project storage unavailable")?;
 if !*loaded { return Err("Projects have not loaded successfully. Retry Load before saving.".into()); }
 project_storage::validate_projects(&projects)?;
 let path = storage_path(&app)?;
 let data = serde_json::to_vec_pretty(&projects).map_err(|e| e.to_string())?;
 project_storage::save_file(&path, &data)
}
fn service_role(folder: &str, framework: &str) -> String {
 if matches!(framework, "Next.js" | "Vite/React" | "Vite" | "React") { return "frontend".into(); }
 if matches!(framework, "Node/Express" | "FastAPI" | "Flask" | "Django") { return "backend".into(); }
 match folder {
  "frontend" | "client" | "web" | "portal" => "frontend".into(),
  "backend" | "server" | "api" => "backend".into(),
  _ => "other".into(),
 }
}

fn node_dependency(value: &serde_json::Value, name: &str) -> bool {
 value.pointer(&format!("/dependencies/{name}")).is_some() || value.pointer(&format!("/devDependencies/{name}")).is_some()
}

fn node_service(dir: &Path, id: &str, name: &str) -> Option<Service> {
 let package = dir.join("package.json");
 if !package.is_file() { return None; }
 let cwd = dir.to_str()?.to_string();
 let value: serde_json::Value = match std::fs::read(&package).ok().and_then(|raw| serde_json::from_slice(&raw).ok()) {
  Some(value) => value,
  None => return Some(Service { id: id.into(), name: name.into(), cwd, program: String::new(), args: vec![], role: Some(service_role(id, "Node.js")), framework: Some("Node.js".into()), host: None, port: None, review_note: Some("package.json could not be parsed. Review this service before configuring a command.".into()), interpreter_path: None, entry_point: None, confidence: Some("low".into()), run_options: vec![], health_check: None }),
 };
 let script = ["dev", "start"].into_iter().find(|script| value.pointer(&format!("/scripts/{script}")).and_then(|entry| entry.as_str()).is_some_and(|command| !command.trim().is_empty()));
 let framework = if node_dependency(&value, "next") { "Next.js" }
  else if node_dependency(&value, "vite") && node_dependency(&value, "react") { "Vite/React" }
  else if node_dependency(&value, "vite") { "Vite" }
  else if node_dependency(&value, "express") { "Node/Express" }
  else if node_dependency(&value, "react") { "React" }
  else { "Node.js" };
 let role = Some(service_role(id, framework));
 match script {
  Some(script) => {
   let command = value.pointer(&format!("/scripts/{script}")).and_then(|entry| entry.as_str()).unwrap_or_default();
   let command_args = command.split_whitespace().map(String::from).collect::<Vec<_>>();
   let port = launcher::declared_port(&command_args).ok().flatten();
   let (program, args) = if dir.join("pnpm-lock.yaml").is_file() { ("pnpm", vec!["run", script]) }
    else if dir.join("yarn.lock").is_file() { ("yarn", vec![script]) }
    else { ("npm", vec!["run", script]) };
   let program = program.to_string();
   let args = args.into_iter().map(String::from).collect::<Vec<_>>();
   let run_options = vec![RunOption { id: format!("node-{script}"), label: format!("{script} script"), program: program.clone(), args: args.clone(), verified: true, source: "package.json scripts".into(), explanation: format!("Runs the configured {script} script using the detected package manager."), interpreter_path: None, entry_point: None }];
   Some(Service { id: id.into(), name: name.into(), cwd, program, args, role, framework: Some(framework.into()), host: None, port, review_note: None, interpreter_path: None, entry_point: None, confidence: Some("high".into()), run_options, health_check: None })
  }
  None => Some(Service { id: id.into(), name: name.into(), cwd, program: String::new(), args: vec![], role, framework: Some(framework.into()), host: None, port: None, review_note: Some(format!("{framework} detected, but package.json has no dev or start script. Review the command before starting.")), interpreter_path: None, entry_point: None, confidence: Some("low".into()), run_options: vec![], health_check: None }),
 }
}

fn cargo_service(dir: &Path, id: &str, name: &str) -> Option<Service> {
 let manifest = dir.join("Cargo.toml");
 if !manifest.is_file() { return None; }
 let contents = std::fs::read_to_string(&manifest).ok()?;
 let mut binaries = Vec::new();
 let mut in_bin = false;
 for line in contents.lines() {
  let trimmed = line.trim();
  if trimmed.starts_with("[[bin]]") { in_bin = true; continue; }
  if in_bin && trimmed.starts_with("[") { in_bin = false; }
  if in_bin && trimmed.starts_with("name") {
   if let Some(value) = trimmed.split('=').nth(1).map(str::trim).and_then(|value| value.strip_prefix('"').and_then(|value| value.strip_suffix('"'))) { binaries.push(value.to_string()); in_bin = false; }
  }
 }
 let cwd = dir.to_str()?.to_string();
 let mut run_options = vec![RunOption { id: "cargo-run".into(), label: "cargo run".into(), program: "cargo".into(), args: vec!["run".into()], verified: true, source: "Cargo.toml".into(), explanation: "Runs the Cargo project using its configured default binary target.".into(), interpreter_path: None, entry_point: None }];
 run_options.extend(binaries.into_iter().map(|binary| RunOption { id: format!("cargo-bin-{binary}"), label: format!("cargo run --bin {binary}"), program: "cargo".into(), args: vec!["run".into(), "--bin".into(), binary], verified: true, source: "Cargo.toml [[bin]]".into(), explanation: "Runs the explicitly declared Cargo binary target.".into(), interpreter_path: None, entry_point: None }));
 let first = run_options[0].clone();
 Some(Service { id: id.into(), name: name.into(), cwd, program: first.program, args: first.args, role: Some("other".into()), framework: Some("Rust/Cargo".into()), host: None, port: None, review_note: None, interpreter_path: None, entry_point: None, confidence: Some("high".into()), run_options, health_check: None })
}

fn python_manifest_exists(dir: &Path) -> bool {
 dir.join("pyproject.toml").is_file() || dir.join("Pipfile").is_file() || std::fs::read_dir(dir).ok().is_some_and(|entries| entries.flatten().any(|entry| {
  entry.file_name().to_str().is_some_and(|name| name.starts_with("requirements") && name.ends_with(".txt"))
 }))
}

fn dependency_declared(dir: &Path, project_root: &Path, dependency: &str) -> bool {
 let mut manifests = vec![dir.join("pyproject.toml"), dir.join("Pipfile"), dir.join("requirements.txt")];
 for location in [dir, project_root] {
  if let Ok(entries) = std::fs::read_dir(location) {
   manifests.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("requirements") && name.ends_with(".txt"))
   }));
  }
 }
 if dir != project_root { manifests.extend([project_root.join("pyproject.toml"), project_root.join("Pipfile")]); }
 manifests.into_iter().filter_map(|path| std::fs::read_to_string(path).ok()).any(|contents| contents.lines().any(|line| {
  let line = line.split('#').next().unwrap_or_default().trim().to_ascii_lowercase();
  let boundary = |rest: &str| rest.is_empty() || rest.starts_with(|character: char| matches!(character, ' ' | '\t' | '=' | '<' | '>' | '!' | '~' | '[' | ';' | '@' | '\'' | '"'));
  line.trim_start_matches(['\'', '"']).strip_prefix(dependency).is_some_and(boundary)
   || [format!("\"{dependency}"), format!("'{dependency}")].iter().any(|needle| line.split(needle).skip(1).any(boundary))
 }))
}

fn python_module(dir: &Path, file: &Path) -> Option<String> {
 let relative = file.strip_prefix(dir).ok()?.with_extension("");
 let mut parts = relative.iter().map(|part| part.to_str()).collect::<Option<Vec<_>>>()?;
 if parts.last() == Some(&"__init__") { parts.pop(); }
 (!parts.is_empty() && parts.iter().all(|part| !part.is_empty() && part.chars().all(|character| character == '_' || character.is_ascii_alphanumeric()) && !part.starts_with(|character: char| character.is_ascii_digit())))
  .then(|| parts.join("."))
}

fn python_sources(dir: &Path) -> Vec<PathBuf> {
 let mut sources = Vec::new();
 let Ok(entries) = std::fs::read_dir(dir) else { return sources };
 for entry in entries.flatten() {
  let path = entry.path();
  if path.extension().and_then(|extension| extension.to_str()) == Some("py") { sources.push(path); continue; }
  let ignored = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| matches!(name, ".venv" | "venv" | "tests" | "test" | "migrations" | "__pycache__"));
  if !path.is_dir() || ignored { continue; }
  if let Ok(children) = std::fs::read_dir(path) {
   sources.extend(children.flatten().map(|child| child.path()).filter(|child| child.extension().and_then(|extension| extension.to_str()) == Some("py")));
  }
 }
 sources.sort();
 sources.truncate(128);
 sources
}

fn assigned_app(source: &str, constructors: &[&str]) -> Option<String> {
 source.lines().filter_map(|line| {
  let compact = line.split('#').next()?.split_whitespace().collect::<String>();
  let (left, right) = compact.split_once('=')?;
  let variable = left.split(':').next()?;
  (variable.chars().enumerate().all(|(index, character)| character == '_' || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit()))
   && constructors.iter().any(|constructor| right.contains(constructor))).then(|| variable.to_string())
 }).next()
}

fn imported_app_target(dir: &Path, file: &Path, source: &str, constructors: &[&str]) -> Option<(String, String)> {
 let current_module = python_module(dir, file)?;
 for line in source.lines().map(str::trim) {
  let Some(rest) = line.strip_prefix("from ") else { continue };
  let Some((module, imported)) = rest.split_once(" import ") else { continue };
  let Some(name) = imported.split(',').next().and_then(|value| value.trim().split_whitespace().next()) else { continue };
  if !name.chars().all(|character| character == '_' || character.is_ascii_alphanumeric()) { continue; }
  let target_module = if module.starts_with('.') {
   let mut parts = current_module.split('.').map(str::to_string).collect::<Vec<_>>();
   if file.file_name().and_then(|name| name.to_str()) != Some("__init__.py") { parts.pop(); }
   for _ in module.chars().take_while(|character| *character == '.').skip(1) { parts.pop(); }
   let suffix = module.trim_start_matches('.');
   if !suffix.is_empty() { parts.extend(suffix.split('.').map(str::to_string)); }
   parts.join(".")
  } else { module.to_string() };
  if target_module.is_empty() { continue; }
  let target_path = target_module.split('.').fold(dir.to_path_buf(), |path, part| path.join(part));
  let candidates = [target_path.with_extension("py"), target_path.join("__init__.py")];
  if candidates.iter().filter_map(|path| std::fs::read_to_string(path).ok()).any(|target_source| assigned_app(&target_source, constructors).is_some_and(|variable| variable == name)) {
   return Some((target_module, name.to_string()));
  }
 }
 None
}

fn python_target(dir: &Path, file: &Path, source: &str, constructors: &[&str]) -> Option<String> {
 let variable = assigned_app(source, constructors);
 if let (Some(variable), Some(module)) = (variable, python_module(dir, file)) { return Some(format!("{module}:{variable}")); }
 imported_app_target(dir, file, source, constructors).map(|(module, variable)| format!("{module}:{variable}"))
}

fn python_interpreter(dir: &Path, project_root: &Path) -> Option<String> {
 let mut locations = vec![dir.to_path_buf()];
 if dir != project_root && dir.starts_with(project_root) { locations.push(project_root.to_path_buf()); }
 for location in locations {
  for environment in [".venv", "venv", "env"] {
   let executable = if cfg!(windows) { location.join(environment).join("Scripts/python.exe") } else { location.join(environment).join("bin/python") };
   if executable.is_file() { return Some(executable.to_string_lossy().to_string()); }
  }
 }
 let path_directories = std::env::var_os("PATH").map(|value| std::env::split_paths(&value).collect::<Vec<_>>()).unwrap_or_default();
 for directory in path_directories {
  let executable = directory.join(if cfg!(windows) { "python.exe" } else { "python" });
  if executable.is_file() { return Some(executable.to_string_lossy().to_string()); }
 }
 None
}

fn uvicorn_args(entry_point: &str, host: &str, port: u16) -> Vec<String> {
 vec!["-m".into(), "uvicorn".into(), entry_point.into(), "--reload".into(), "--host".into(), host.into(), "--port".into(), port.to_string()]
}

fn declared_python_endpoint(dir: &Path) -> (Option<String>, Option<u16>) {
 let mut host = None;
 let mut port = None;
 let Ok(entries) = std::fs::read_dir(dir) else { return (host, port) };
 for entry in entries.flatten() {
  let path = entry.path();
  let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
  if !matches!(extension.as_str(), "ps1" | "bat" | "cmd" | "sh" | "yml" | "yaml") { continue; }
  let Ok(contents) = std::fs::read_to_string(path) else { continue };
  if !contents.to_ascii_lowercase().contains("uvicorn") { continue; }
  let tokens = contents.split(|character: char| character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ')')).collect::<Vec<_>>();
  for index in 0..tokens.len() {
   let token = tokens[index];
   if let Some(value) = token.strip_prefix("--host=") { host = Some(value.to_string()); }
   if token == "--host" { host = tokens.get(index + 1).filter(|value| !value.is_empty()).map(|value| (*value).to_string()); }
   if let Some(value) = token.strip_prefix("--port=") { port = value.parse().ok(); }
   if token == "--port" { port = tokens.get(index + 1).and_then(|value| value.parse().ok()); }
  }
 }
 (host, port)
}

fn python_run_options(framework: &str, dir: &Path, sources: &[PathBuf], interpreter: Option<&String>, uvicorn: bool, host: &str, port: u16) -> Vec<RunOption> {
 let mut options = Vec::new();
 let mut targets = HashSet::new();
 let constructors: &[&str] = match framework {
  "FastAPI" => &["FastAPI(", "fastapi.FastAPI("],
  "Flask" => &["Flask(", "flask.Flask("],
  _ => &[],
 };
 for file in sources {
  let Some(source) = std::fs::read_to_string(file).ok() else { continue };
  let Some(entry_point) = python_target(dir, file, &source, constructors) else { continue };
  if !targets.insert(entry_point.clone()) { continue; }
  let is_fastapi = framework == "FastAPI";
  if is_fastapi || framework == "Flask" {
   let args = if is_fastapi { uvicorn_args(&entry_point, host, port) }
    else { vec!["-m".into(), "flask".into(), "--app".into(), entry_point.clone(), "run".into()] };
   options.push(RunOption { id: format!("{}-{}", framework.to_ascii_lowercase(), options.len()), label: format!("{} · {}", if is_fastapi { "Uvicorn" } else { "Flask" }, entry_point), program: interpreter.cloned().unwrap_or_default(), args, verified: interpreter.is_some() && (!is_fastapi || uvicorn), source: if interpreter.is_some() { "Project interpreter or PATH Python".into() } else { "Interpreter not found".into() }, explanation: if is_fastapi { "Runs the detected ASGI module:variable with Python -m uvicorn; --reload watches source files.".into() } else { "Runs the detected Flask application through Python -m flask.".into() }, interpreter_path: interpreter.cloned(), entry_point: Some(entry_point) });
  }
 }
 for file in sources {
  let Some(source) = std::fs::read_to_string(file).ok() else { continue };
  if !source.contains("if __name__ == \"__main__\"") && !source.contains("if __name__ == '__main__'") { continue; }
  let Some(filename) = file.file_name().and_then(|name| name.to_str()) else { continue; };
  options.push(RunOption { id: format!("python-script-{}", options.len()), label: format!("Python script · {filename}"), program: interpreter.cloned().unwrap_or_default(), args: vec![filename.into()], verified: interpreter.is_some(), source: if interpreter.is_some() { "Python interpreter".into() } else { "Interpreter not found".into() }, explanation: "Runs a project script only because it declares a Python main entry point.".into(), interpreter_path: interpreter.cloned(), entry_point: None });
 }
 options.sort_by_key(|option| !option.verified);
 options
}

fn python_service(dir: &Path, project_root: &Path, id: &str, name: &str, forced_framework: Option<&str>) -> Option<Service> {
 let django_manage = dir.join("manage.py");
 let sources = python_sources(dir);
 let has_python_manifest = python_manifest_exists(dir) || dir != project_root && !sources.is_empty() && python_manifest_exists(project_root);
 if !has_python_manifest && !django_manage.is_file() && forced_framework.is_none() { return None; }
 let cwd = dir.to_str()?.to_string();
 let interpreter = python_interpreter(dir, project_root);
 let (declared_host, declared_port) = declared_python_endpoint(&dir);
 let host = declared_host.as_deref().unwrap_or("127.0.0.1");
 let port = declared_port.unwrap_or(8000);
 let project_interpreter = interpreter.as_ref().is_some_and(|value| [
  dir.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" }),
  dir.join(if cfg!(windows) { "venv/Scripts/python.exe" } else { "venv/bin/python" }),
  dir.join(if cfg!(windows) { "env/Scripts/python.exe" } else { "env/bin/python" }),
  project_root.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" }),
  project_root.join(if cfg!(windows) { "venv/Scripts/python.exe" } else { "venv/bin/python" }),
  project_root.join(if cfg!(windows) { "env/Scripts/python.exe" } else { "env/bin/python" }),
 ].iter().any(|candidate| candidate.is_file() && candidate.to_string_lossy() == value.as_str()));
 let fastapi = dependency_declared(dir, project_root, "fastapi");
 let uvicorn = dependency_declared(dir, project_root, "uvicorn");
 let flask = dependency_declared(dir, project_root, "flask");
 let django = dependency_declared(dir, project_root, "django");
 let run_options = python_run_options(forced_framework.or_else(|| fastapi.then_some("FastAPI")).or_else(|| flask.then_some("Flask")).unwrap_or("Python"), &dir, &sources, interpreter.as_ref(), uvicorn, host, port);
 let framework_hint = forced_framework.or_else(|| fastapi.then_some("FastAPI")).or_else(|| flask.then_some("Flask")).or_else(|| django.then_some("Django"));
 let detected = if framework_hint == Some("FastAPI") && (fastapi || forced_framework == Some("FastAPI")) {
  sources.iter().find_map(|file| {
   let source = std::fs::read_to_string(file).ok()?;
   let entry_point = python_target(&dir, file, &source, &["FastAPI(", "fastapi.FastAPI("])?;
   Some(("FastAPI", uvicorn_args(&entry_point, host, port), Some(entry_point)))
  })
 } else if framework_hint == Some("Flask") && (flask || forced_framework == Some("Flask")) {
  sources.iter().find_map(|file| {
   let source = std::fs::read_to_string(file).ok()?;
   let entry_point = python_target(&dir, file, &source, &["Flask(", "flask.Flask("])?;
   Some(("Flask", vec!["-m".into(), "flask".into(), "--app".into(), entry_point.clone(), "run".into()], Some(entry_point)))
  })
 } else if framework_hint == Some("Django") && django_manage.is_file() && (django || forced_framework == Some("Django")) && std::fs::read_to_string(&django_manage).ok().is_some_and(|source| source.contains("DJANGO_SETTINGS_MODULE") && source.contains("execute_from_command_line")) {
  Some(("Django", vec!["manage.py".into(), "runserver".into()], None))
 } else { None };
 if let Some((framework, args, entry_point)) = detected {
  let role = Some(service_role(id, framework));
  return Some(match interpreter {
   Some(program) => Service { id: id.into(), name: name.into(), cwd, program: program.clone(), args, role, framework: Some(framework.into()), host: Some(host.into()), port: Some(port), review_note: if framework == "FastAPI" && !uvicorn { Some("ASGI target verified; uvicorn is not declared in the inspected dependencies. Verify it is installed in the selected interpreter.".into()) } else if !project_interpreter { Some("Using an available PATH Python interpreter; this is not a project venv. Select a project interpreter if one is available.".into()) } else if declared_host.is_none() && declared_port.is_none() { Some("Using default local development host 127.0.0.1 and port 8000; edit them if the project specifies another endpoint.".into()) } else { None }, interpreter_path: Some(program), entry_point, confidence: Some(if project_interpreter { "high" } else { "medium" }.into()), run_options: run_options.clone(), health_check: None },
   None => Service { id: id.into(), name: name.into(), cwd, program: String::new(), args, role, framework: Some(framework.into()), host: Some(host.into()), port: Some(port), review_note: Some(format!("{framework} and its entry point were detected, but no project-local interpreter was found. Select a project interpreter before starting.")), interpreter_path: None, entry_point, confidence: Some("medium".into()), run_options: run_options.clone(), health_check: None },
  });
 }
 let framework = if fastapi || forced_framework == Some("FastAPI") { "FastAPI" } else if flask || forced_framework == Some("Flask") { "Flask" } else if django || forced_framework == Some("Django") { "Django" } else { "Python" };
 let reason = if framework == "FastAPI" && fastapi && !uvicorn { "FastAPI was detected, but uvicorn was not declared in the inspected dependencies.".into() } else { format!("{framework} project detected, but a supported application entry point was not verified.") };
 Some(Service { id: id.into(), name: name.into(), cwd, program: interpreter.clone().unwrap_or_default(), args: vec![], role: Some(service_role(id, framework)), framework: Some(framework.into()), host: None, port: None, review_note: Some(format!("{reason} Enter an ASGI module:variable or review the command before starting.")), interpreter_path: interpreter, entry_point: None, confidence: Some("low".into()), run_options, health_check: None })
}

fn suggested_service(dir: &Path, project_root: &Path, id: &str, name: &str) -> Option<Service> {
 cargo_service(dir, id, name).or_else(|| node_service(dir, id, name)).or_else(|| python_service(dir, project_root, id, name, None))
}

fn scan_services(dir: &Path) -> Vec<Service> {
 let mut services = Vec::new();
 let mut seen = HashSet::new();
 for (folder, label) in [("frontend", "Frontend"), ("backend", "Backend"), ("client", "Client"), ("server", "Server"), ("api", "API"), ("web", "Web"), ("portal", "Portal")] {
  let path = dir.join(folder);
  if path.is_dir() {
   let canonical = std::fs::canonicalize(&path).unwrap_or(path.clone());
   if seen.insert(canonical) { if let Some(s) = suggested_service(&path, dir, folder, label) { services.push(s); } }
  }
 }
 if seen.insert(dir.to_path_buf()) { if let Some(s) = suggested_service(dir, dir, "main", "Application") { services.push(s); } }
 services
}

#[tauri::command]
fn discover_services(root: String) -> Result<Vec<Service>, String> {
 let dir = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
 if !dir.is_dir() { return Err("Select a directory".into()); }
 Ok(scan_services(&dir))
}

#[tauri::command]
fn suggest_service(root: String, project_root: String, framework: String) -> Result<Option<Service>, String> {
 let dir = std::fs::canonicalize(&root).map_err(|e| format!("Working directory is unavailable: {e}"))?;
 std::fs::read_dir(&dir).map_err(|e| format!("Working directory cannot be read: {e}"))?;
 let project = std::fs::canonicalize(&project_root).map_err(|e| format!("Project root is unavailable: {e}"))?;
 if !dir.is_dir() || !project.is_dir() { return Err("Select valid project and service directories".into()); }
 Ok(match framework.as_str() {
  "Auto" => suggested_service(&dir, &dir, "suggested", "Suggested service"),
  "FastAPI" | "Flask" | "Django" => python_service(&dir, &project, "suggested", "Suggested service", Some(&framework)),
  "Next.js" | "Vite/React" | "Node.js" => node_service(&dir, "suggested", "Suggested service"),
  "Rust/Cargo" => cargo_service(&dir, "suggested", "Suggested service"),
  _ => None,
 })
}

#[tauri::command]
fn detect_project(root: String) -> Result<Project, String> {
 let dir = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
 if !dir.is_dir() { return Err("Select a directory".into()); }
 let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Project").to_string();
 let services = scan_services(&dir);
 Ok(Project { id: project_storage::new_id("p")?, name, root: dir.to_string_lossy().to_string(), services })
}
fn validated_directory(path: &str) -> Result<PathBuf, String> {
 let directory = std::fs::canonicalize(path).map_err(|error| format!("Cannot open directory '{}': {}", path, error))?;
 if !directory.is_dir() { return Err(format!("'{}' is not a directory.", path)); }
 Ok(directory)
}
#[cfg(windows)]
fn windows_path_argument(path: &Path) -> String {
 let value = path.to_string_lossy();
 if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { format!(r"\\{}", unc) }
 else { value.strip_prefix(r"\\?\").unwrap_or(&value).to_string() }
}
#[tauri::command]
fn open_in_ai_cli(path: String, cli: String) -> Result<(), String> {
 let directory = validated_directory(&path)?;
 if cli.contains('/')  || cli.contains('\\') || cli.contains('\0') || cli.contains(' ') {
  return Err("CLI name must be a plain command, not a path.".into());
 }
 let cli_name = cli.as_str();
 #[cfg(windows)] {
  let argument_path = windows_path_argument(&directory);
  // Resolve CLI – if not found, return a friendly install message.
  let executable = launcher::resolve_program(cli_name, &directory).map_err(|_| {
   match cli_name {
    "codex" => "Codex CLI not found on PATH. Install it with: npm install -g @openai/codex\nThen authenticate with your OpenAI API key before using it.".to_string(),
    "claude" => "Claude Code CLI not found on PATH. Install it with: npm install -g @anthropic-ai/claude-code\nThen run 'claude' once to authenticate with your Anthropic account.".to_string(),
    other => format!("'{}' was not found on PATH. Install it and restart DevFlow if PATH changed.", other),
   }
  })?;
  // Prefer Windows Terminal; fall back to a new PowerShell window.
  if let Ok(windows_terminal) = launcher::resolve_program("wt.exe", &directory) {
   let result = Command::new(windows_terminal)
    .args(["-w", "new", "-d"]).arg(&argument_path)
    .arg("--").arg(&executable)
    .creation_flags(0x08000000).spawn();
   if result.is_ok() { return Ok(()); }
  }
  let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
  let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
  Command::new(&powershell)
   .args(["-NoExit", "-NoProfile", "-Command"])
   .arg(&executable)
   .current_dir(&directory)
   .creation_flags(0x00000010)
   .spawn()
   .map(|_| ())
   .map_err(|error| format!("Could not open {} in '{}': {}", cli_name, path, error))
 }
 #[cfg(not(windows))] {
  let _ = (directory, cli_name);
  Err(format!("Open in {} is currently supported on Windows only.", cli_name))
 }
}
#[tauri::command]
fn open_directory(path: String, target: String) -> Result<(), String> {
 let directory = validated_directory(&path)?;
 #[cfg(windows)] {
  match target.as_str() {
   "terminal" => {
    let argument_path = windows_path_argument(&directory);
    if let Ok(windows_terminal) = launcher::resolve_program("wt.exe", &directory) {
     let result = Command::new(windows_terminal).args(["-w", "new", "-d"]).arg(&argument_path).current_dir(&directory).creation_flags(0x08000000).spawn();
     if result.is_ok() { return Ok(()); }
    }
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    Command::new(&powershell).args(["-NoExit", "-NoProfile"]).current_dir(&directory).creation_flags(0x00000010).spawn()
     .map(|_| ()).map_err(|error| format!("Could not open a new PowerShell window in '{}': {}", path, error))
   }
   "folder" => {
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Command::new(system_root.join("explorer.exe")).arg(windows_path_argument(&directory)).spawn()
     .map(|_| ()).map_err(|error| format!("Could not open File Explorer for '{}': {}", path, error))
   }
   _ => Err("Unknown directory action.".into()),
  }
 }
 #[cfg(not(windows))] {
  let _ = directory;
  match target.as_str() { "terminal" | "folder" => Err("Directory shortcuts are currently supported on Windows only.".into()), _ => Err("Unknown directory action.".into()) }
 }
}
fn health_result(status: &str, checked_at: Option<u64>, status_code: Option<u16>, response_ms: Option<u64>, error: Option<String>) -> HealthSnapshot {
 HealthSnapshot { status: status.into(), checked_at, status_code, response_ms, error }
}

fn health_now() -> u64 {
 std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or_default()
}

fn valid_health_host(host: &str) -> bool {
 matches!(host.trim().to_ascii_lowercase().as_str(), "127.0.0.1" | "::1")
}

fn valid_health_path(path: &str) -> bool {
 path.starts_with('/') && path.len() <= 512 && !path.contains("//") && !path.contains("..") && !path.chars().any(|character| character.is_control() || character == '\\' || character == ' ')
}

#[tauri::command]
async fn check_service_health(service: Service) -> Result<HealthSnapshot, String> {
 let Some(config) = service.health_check else {
  return Ok(if service.port.is_none() && !matches!(service.role.as_deref(), Some("frontend") | Some("backend")) { health_result("notApplicable", None, None, None, None) } else { health_result("disabled", None, None, None, None) });
 };
 if !config.enabled { return Ok(health_result("disabled", None, None, None, None)); }
 if !valid_health_host(&config.host) { return Ok(health_result("unknown", None, None, None, Some("Health checks are limited to the loopback addresses 127.0.0.1 or ::1.".into()))); }
 if !valid_health_path(&config.path) { return Ok(health_result("unknown", None, None, None, Some("Health path must be a local URL path beginning with / and cannot contain traversal or spaces.".into()))); }
 let port = config.port.or(service.port);
 let Some(port) = port.filter(|value| *value > 0) else { return Ok(health_result("unknown", None, None, None, Some("Configure a verified service port before enabling HTTP health checks.".into()))); };
 if config.interval_seconds == 0 || config.interval_seconds > 3600 || config.timeout_seconds == 0 || config.timeout_seconds > 30 || config.expected_status_min == 0 || config.expected_status_max > 599 || config.expected_status_min > config.expected_status_max {
  return Ok(health_result("unknown", None, None, None, Some("Health interval, timeout, and expected HTTP status range are invalid.".into())));
 }
 let timeout_duration = std::time::Duration::from_secs(config.timeout_seconds.into());
 let address = if config.host.trim() == "::1" { format!("[::1]:{port}") } else { format!("{}:{port}", config.host.trim()) };
 let started = std::time::Instant::now();
 let mut stream = match tokio::time::timeout(timeout_duration, TcpStream::connect(address)).await {
  Ok(Ok(stream)) => stream,
  Ok(Err(error)) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some(format!("Connection failed: {error}")))),
  Err(_) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some("Connection timed out.".into()))),
 };
 let host_header = if config.host.trim() == "::1" { format!("[::1]:{port}") } else { format!("{}:{port}", config.host.trim()) };
 let request = format!("GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: DevFlow-Health/1\r\n\r\n", config.path, host_header);
 match tokio::time::timeout(timeout_duration, stream.write_all(request.as_bytes())).await {
  Ok(Ok(())) => {}
  Ok(Err(error)) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some(format!("Request failed: {error}")))),
  Err(_) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some("Request timed out.".into()))),
 }
 let mut response = Vec::with_capacity(1024);
 let mut buffer = [0u8; 1024];
 loop {
  let read = match tokio::time::timeout(timeout_duration, stream.read(&mut buffer)).await {
   Ok(Ok(0)) => break,
   Ok(Ok(count)) => { response.extend_from_slice(&buffer[..count]); if response.windows(4).any(|window| window == b"\r\n\r\n") || response.len() >= 16 * 1024 { break; } count },
   Ok(Err(error)) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some(format!("Response read failed: {error}")))),
   Err(_) => return Ok(health_result("unhealthy", Some(health_now()), None, Some(started.elapsed().as_millis() as u64), Some("Response timed out.".into()))),
  };
  if read == 0 { break; }
 }
 let status_code = response.split(|byte| *byte == b' ').nth(1).and_then(|value| value.split(|byte| *byte == b' ').next()).and_then(|value| std::str::from_utf8(value).ok()).and_then(|value| value.parse::<u16>().ok());
 let response_ms = Some(started.elapsed().as_millis() as u64);
 let Some(status_code) = status_code else { return Ok(health_result("unhealthy", Some(health_now()), None, response_ms, Some("The endpoint returned an invalid HTTP status line.".into()))); };
 if (config.expected_status_min..=config.expected_status_max).contains(&status_code) { Ok(health_result("healthy", Some(health_now()), Some(status_code), response_ms, None)) }
 else { Ok(health_result("unhealthy", Some(health_now()), Some(status_code), response_ms, Some(format!("Unexpected HTTP status {status_code}.")))) }
}

#[tauri::command]
async fn start_service(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String, service: Service) -> Result<String, String> {
 let key = process_key(&project_id, &service.id);
 if service.id.trim().is_empty() || service.id.contains("::") { return Err("Service has an invalid ID. Review its saved configuration.".into()); }
 if !Path::new(&service.cwd).is_absolute() { return Err("Enter an absolute working directory before starting this service.".into()); }
 if service.args.iter().any(|argument| argument.contains('\0')) { return Err("Service arguments contain an invalid NUL character.".into()); }
 let argument_port = launcher::declared_port(&service.args)?;
 if service.port == Some(0) { return Err("Service port must be from 1 to 65535.".into()); }
 if service.port.is_some() && argument_port.is_some() && service.port != argument_port { return Err("The saved service port conflicts with its --port argument. Review the configuration before starting.".into()); }
 let declared_port = service.port.or(argument_port);
 let mut reservation = StartGuard::reserve(&state, key.clone(), declared_port)?;
 let run_id = project_storage::new_id("run-")?;
 let cwd = std::fs::canonicalize(&service.cwd).map_err(|e| format!("Working directory '{}' is unavailable: {e}", service.cwd))?;
 if !cwd.is_dir() { return Err(format!("Working directory '{}' is not a folder.", service.cwd)); }
 let executable = launcher::resolve_program(&service.program, &cwd)?;
 if let Some(port) = declared_port {
  std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
   if error.kind() == std::io::ErrorKind::AddrInUse { format!("Port {port} is already in use on localhost ({error}). Review the port configuration.") }
   else { format!("Could not bind localhost port {port} ({error}). Check port configuration and permissions; a conflicting process has not been established.") }
  })?;
 }
 #[cfg(windows)]
 let (mut command, append_service_args) = match launcher::script_kind(&executable)? {
  "powershell" => {
   let shell = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32/WindowsPowerShell/v1.0/powershell.exe");
   let mut command = Command::new(shell);
   command.args(["-NoProfile", "-NonInteractive", "-File"]).arg(&executable);
   (command, true)
  }
  "batch" => {
   let shell = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
   let mut command = Command::new(shell);
   let command_line = launcher::batch_command_line(&executable, &service.args)?;
   command.args(["/D", "/S", "/C"]);
   command.as_std_mut().raw_arg(format!(" \"{command_line}\""));
   (command, false)
  }
  _ => (Command::new(&executable), true),
 };
 #[cfg(not(windows))]
 let mut command = Command::new(&executable);
 #[cfg(windows)]
 if append_service_args { command.args(&service.args); }
 #[cfg(not(windows))]
 command.args(&service.args);
 command.current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
 #[cfg(windows)]
 let (mut child, job) = windows_job::spawn_contained(&mut command)
  .map_err(|e| format!("Could not start {} using '{}': {}", service.name, executable.display(), e))?;
 #[cfg(not(windows))]
 let mut child = command.spawn().map_err(|e| format!("Could not start {} using '{}': {}", service.name, executable.display(), e))?;
 let stdout = child.stdout.take();
 let stderr = child.stderr.take();
 let child = Arc::new(tokio::sync::Mutex::new(child));
 let running = Running { child: child.clone(), #[cfg(windows)] job: job.clone(), stop_requested: Arc::new(AtomicBool::new(false)), stop_lock: Arc::new(tokio::sync::Mutex::new(())), declared_port };
 let stop_requested = running.stop_requested.clone();
 if let Err(error) = reservation.commit(running) {
  #[cfg(windows)]
  drop(job);
  drop(child);
  return Err(error);
 }
 let mut stdout_task = stream_pipe(stdout, &app, &project_id, &service.id, "stdout", &run_id);
 let mut stderr_task = stream_pipe(stderr, &app, &project_id, &service.id, "stderr", &run_id);
 let app_clone = app.clone(); let project_clone = project_id.clone(); let service_clone = service.id.clone();
 let launched_run = run_id.clone();
 tauri::async_runtime::spawn(async move {
  let mut root_status = None;
  let mut failure_reported = false;
  loop {
   tokio::time::sleep(std::time::Duration::from_millis(500)).await;
   if root_status.is_none() { root_status = { let mut c = child.lock().await; c.try_wait().ok().flatten() }; }
   if let Some(status) = root_status.filter(|status| !status.success()) {
    if !failure_reported {
     failure_reported = true;
     let intentional = stop_requested.load(Ordering::SeqCst);
     let _ = app_clone.emit("service-exit", ServiceExit { project_id: project_clone.clone(), service_id: service_clone.clone(), exit_code: status.code(), status: status.to_string(), stop_requested: intentional, run_id: launched_run.clone() });
     // A failed launcher must not leave its workers running indefinitely.
     // One cleanup attempt only; on failure the owned job remains stoppable.
     #[cfg(windows)]
     if !intentional {
      if let Err(error) = job.terminate() {
       let _ = app_clone.emit("service-log", LogLine { project_id: project_clone.clone(), service_id: service_clone.clone(), stream: "system".into(), message: format!("Root process failed ({status}); owned process cleanup failed: {error}. Retry Stop.") });
      }
     }
    }
   }
   #[cfg(windows)]
   let tree_empty = matches!(job.active_processes(), Ok(0));
   #[cfg(not(windows))]
   let tree_empty = true;
   if root_status.is_some() && tree_empty {
    let stdout_complete = finish_output(&mut stdout_task).await;
    let stderr_complete = finish_output(&mut stderr_task).await;
    if !stdout_complete || !stderr_complete {
     notifications::diagnostic(&app_clone, &project_clone, &service_clone, notifications::DiagnosticKind::LogCollection);
     let _ = app_clone.emit("service-log", LogLine { project_id: project_clone.clone(), service_id: service_clone.clone(), stream: "system".into(), message: "Output drain timed out after process cleanup; remaining buffered output may be missing.".into() });
    }
    let state = app_clone.state::<AppState>();
    if let Ok(mut processes) = state.processes.lock() {
     let same = matches!(processes.get(&key), Some(ProcessEntry::Running(running) | ProcessEntry::Stopping(running)) if Arc::ptr_eq(&running.child, &child));
     if same { processes.remove(&key); }
    }
    let status = root_status.unwrap();
    let intentional = stop_requested.load(Ordering::SeqCst);
    if !failure_reported { let _ = app_clone.emit("service-exit", ServiceExit { project_id: project_clone.clone(), service_id: service_clone.clone(), exit_code: status.code(), status: status.to_string(), stop_requested: intentional, run_id: launched_run.clone() }); }
    let _ = app_clone.emit("service-log", LogLine { project_id: project_clone, service_id: service_clone, stream: "system".into(), message: format!("Process exited: {status}") });
    break;
   }
  }
 });
 Ok(run_id)
}
#[tauri::command]
async fn stop_service(state: State<'_, AppState>, project_id: String, service_id: String) -> Result<(), String> {
 let key = process_key(&project_id, &service_id);
 stop_owned_service(&state, &key).await
}
async fn stop_owned_service(state: &AppState, key: &str) -> Result<(), String> {
 stop_owned_service_checked(state, key, None).await
}
async fn stop_owned_service_checked(state: &AppState, key: &str, expected_run: Option<&str>) -> Result<(), String> {
 enum StopTarget { Starting(tokio::sync::watch::Receiver<bool>), Running(Running, bool) }
 let target = {
  let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if let Some(expected) = expected_run {
   #[cfg(windows)]
   match processes.get(key) {
    Some(ProcessEntry::Running(run)) if run.job.run_token() == expected => {},
    _ => return Err("Service run changed or stopped. Refresh Port Manager before stopping.".into()),
   }
   #[cfg(not(windows))]
   { let _ = expected; return Err("Port Manager requires Windows".into()); }
  }
  match processes.get(key) {
   Some(ProcessEntry::Starting(starting)) => {
    starting.cancelled.store(true, Ordering::SeqCst);
    StopTarget::Starting(starting.complete.subscribe())
   }
   Some(ProcessEntry::Running(running)) => {
    let running = running.clone();
    let previously_requested = running.stop_requested.swap(true, Ordering::SeqCst);
    processes.insert(key.to_string(), ProcessEntry::Stopping(running.clone()));
    StopTarget::Running(running, previously_requested)
   }
   Some(ProcessEntry::Stopping(running)) => StopTarget::Running(running.clone(), true),
   None => return Err("Service not running".into()),
  }
 };
 let (running, previously_requested) = match target {
  StopTarget::Starting(mut complete) => {
   tokio::time::timeout(std::time::Duration::from_secs(5), complete.wait_for(|done| *done))
    .await.map_err(|_| "Timed out waiting for service startup to cancel.".to_string())?
    .map_err(|_| "Service startup cancellation was interrupted.".to_string())?;
   return Ok(());
  }
  StopTarget::Running(running, previously_requested) => (running, previously_requested),
 };
 let _stop_guard = running.stop_lock.lock().await;
 if let Ok(mut processes) = state.processes.lock() {
  if matches!(processes.get(key), Some(ProcessEntry::Running(current)) if Arc::ptr_eq(&current.child, &running.child)) {
   processes.insert(key.to_string(), ProcessEntry::Stopping(running.clone()));
  }
 }
 let mut termination_sent = false;
 let result: Result<(), String> = async {
 #[cfg(windows)] {
  if running.job.active_processes().map_err(|e| format!("Could not inspect service Job Object: {e}"))? > 0 {
   running.job.terminate().map_err(|e| format!("Could not stop service Job Object: {e}"))?;
   termination_sent = true;
  }
  let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
  loop {
   if running.job.active_processes().map_err(|e| format!("Could not check service cleanup: {e}"))? == 0 { break; }
   if tokio::time::Instant::now() >= deadline { return Err("Timed out waiting for the service process tree to stop.".into()); }
   tokio::time::sleep(std::time::Duration::from_millis(25)).await;
  }
  tokio::time::timeout(std::time::Duration::from_secs(5), async { running.child.lock().await.wait().await })
   .await.map_err(|_| "Timed out reaping the stopped service.".to_string())?
   .map_err(|e| format!("Could not reap stopped service: {e}"))?;
 }
 #[cfg(not(windows))] { running.child.lock().await.kill().await.map_err(|e| e.to_string())?; termination_sent = true; }
 Ok(())
 }.await;
 let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
 if matches!(processes.get(key), Some(ProcessEntry::Stopping(current)) if Arc::ptr_eq(&current.child, &running.child)) {
  if result.is_ok() { processes.remove(key); }
  else if termination_sent { processes.insert(key.to_string(), ProcessEntry::Stopping(running.clone())); }
  else { processes.insert(key.to_string(), ProcessEntry::Running(running.clone())); }
 }
 if result.is_err() && !termination_sent { running.stop_requested.store(previously_requested, Ordering::SeqCst); }
 result
}
#[tauri::command]
fn running_services(state: State<'_, AppState>) -> Result<Vec<String>, String> {
 let processes = state.processes.lock().map_err(|_| "State unavailable")?;
 Ok(processes.iter().filter_map(|(key, entry)| matches!(entry, ProcessEntry::Running(_) | ProcessEntry::Stopping(_)).then(|| key.clone())).collect())
}
#[tauri::command]
fn stopping_services(state: State<'_, AppState>) -> Result<Vec<String>, String> {
 let processes = state.processes.lock().map_err(|_| "State unavailable")?;
 Ok(processes.iter().filter_map(|(key, entry)| matches!(entry, ProcessEntry::Stopping(_)).then(|| key.clone())).collect())
}
fn close_caller(window: &tauri::WebviewWindow) -> Result<(), String> {
 if ["main", "quick-editor"].contains(&window.label()) { Ok(()) } else { Err("Unknown application window.".into()) }
}
#[tauri::command]
fn managed_service_count(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<usize, String> {
 close_caller(&window)?;
 let count = state.processes.lock().map_err(|_| "State unavailable")?.len();
 Ok(count)
}
#[tauri::command]
async fn shutdown_app(app: tauri::AppHandle, window: tauri::WebviewWindow, confirmed: bool) -> Result<(), String> {
 close_caller(&window)?;
 {
  let editor = app.state::<editor_window::EditorWindow>();
  let session = editor.0.lock().map_err(|_| "Editor state unavailable")?;
  let expected = if session.owner == "floating" { "quick-editor" } else if session.owner.is_empty() { "main" } else { return Err("Wait for the editor transfer to finish before exiting.".into()); };
  if window.label() != expected { return Err("The active editor must approve closing first. Try closing DevFlow again.".into()); }
 }
 let state = app.state::<AppState>();
 let keys = {
  let processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if !confirmed && !processes.is_empty() { return Err("A service started while closing. Close again to confirm stopping it.".into()); }
  if state.exiting.swap(true, Ordering::SeqCst) { return Err("DevFlow is already closing.".into()); }
  processes.keys().cloned().collect::<Vec<_>>()
 };
 // Reuse Stop's ownership checks and bounded cleanup; never discover/kill by PID or port.
 let mut failures = Vec::new();
 for key in keys {
  if let Err(error) = stop_owned_service(&state, &key).await {
   let remains = state.processes.lock().map(|processes| processes.contains_key(&key)).unwrap_or(true);
   if remains { failures.push(error); }
  }
 }
 if !failures.is_empty() {
  state.exiting.store(false, Ordering::SeqCst);
  return Err(format!("Some managed services could not be stopped. DevFlow remains open: {}", failures.join("; ")));
 }
 app.exit(0);
 Ok(())
}
#[tauri::command]
async fn ai_set_api_key(provider: String, key: String) -> Result<(), String> {
    ai_credentials::set_api_key(&provider, &key)
}

#[tauri::command]
async fn ai_delete_api_key(provider: String) -> Result<(), String> {
    ai_credentials::delete_api_key(&provider)
}

#[tauri::command]
async fn ai_get_credential_status(provider: String) -> Result<ai_credentials::CredentialStatus, String> {
    ai_credentials::get_credential_status(&provider)
}

#[tauri::command]
async fn ai_test_connection(provider: String) -> Result<ai_credentials::TestConnectionResult, String> {
    ai_chat::test_provider_connection(&provider).await
}

#[tauri::command]
async fn ai_list_models(provider: String) -> Result<Vec<ai_chat::AiModelInfo>, String> {
    ai_chat::list_models(&provider).await
}

#[tauri::command]
async fn ai_start_chat(
    app: tauri::AppHandle,
    state: State<'_, ai_chat::AiChatState>,
    window: tauri::WebviewWindow,
    request: ai_chat::StartChatRequest,
) -> Result<(), String> {
    ai_chat::start_chat_stream(app, &state, window.label(), request).await
}

#[tauri::command]
async fn ai_stop_chat(
    state: State<'_, ai_chat::AiChatState>,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<bool, String> {
    Ok(state.cancel(&format!("{}:{request_id}", window.label())).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_notification::init()).manage(AppState::default())
 .manage(notifications::DesktopAlerts::default())
 .manage(quick_editor::QuickEditor::default())
 .manage(editor_window::EditorWindow::default())
 .manage(logs_window::LogsWindows::default())
  .manage(ai_chat::AiChatState::new())
 .manage(quick_editor::research::ResearchState::default())
 .manage(api_tester::ApiTester::default())
 .on_window_event(|window, event| {
  if window.label() == "main" {
   if matches!(event, tauri::WindowEvent::Destroyed) { window.state::<api_tester::ApiTester>().shutdown(); }
   if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
    window.state::<api_tester::ApiTester>().cancel_all();
    let _ = window.app_handle().emit_to("main", "api-tester-closing", ());
   }
  }
  if matches!(event, tauri::WindowEvent::Destroyed) { window.state::<quick_editor::research::ResearchState>().clear(window.label(), None); }
  if window.label() == "main" {
   if let tauri::WindowEvent::CloseRequested { api, .. } = event {
    api.prevent_close();
    // Ask whichever window owns the live drafts; main close also guards floating edits.
    let floating = window.state::<editor_window::EditorWindow>().0.lock().map(|session| session.owner == "floating").unwrap_or(false);
    let target = if floating { "quick-editor" } else { "main" };
    let _ = window.app_handle().emit_to(target, "app-close-requested", ());
    if floating { if let Some(editor) = window.app_handle().get_webview_window(target) { let _ = editor.set_focus(); } }
   }
  }
 })
 .setup(|app| { notifications::initialize(app.handle())?; Ok(()) })
 .manage(system_center::SystemCenter::default())
 .invoke_handler(tauri::generate_handler![port_manager::inspect_ports, port_manager::stop_port_service, developer_environment::check_tool, developer_environment::check_project_requirements, api_tester::api_tester_source, api_tester::api_tester_prepare, api_tester::api_tester_send, api_tester::api_tester_cancel, api_tester::api_tester_load, api_tester::api_tester_save, chat_history::chat_storage_location, chat_history::chat_storage_pick, chat_history::chat_storage_apply, chat_history::chat_history_export, chat_history::chat_history_load, chat_history::chat_history_save, quick_editor::snapshots::editor_history, quick_editor::snapshots::editor_snapshot, quick_editor::snapshots::editor_restore, quick_editor::actions::editor_export, quick_editor::actions::editor_mutate, quick_editor::paste_new::editor_create_files, quick_editor::actions::editor_reveal, editor_window::editor_writer_lease, editor_window::editor_window_session, editor_window::editor_float, editor_window::editor_window_ready, editor_window::editor_dock, editor_window::editor_accept_dock, editor_window::editor_recover_opening, quick_editor::editor_list, quick_editor::editor_read, quick_editor::editor_save, notifications::show_desktop_notification, load_projects, save_projects, detect_project, discover_services, suggest_service, check_service_health, start_service, stop_service, running_services, stopping_services, open_directory, open_in_ai_cli,
  managed_service_count, shutdown_app, editor_window::editor_close,
  logs_window::logs_float, logs_window::logs_project, logs_window::logs_dock, logs_window::logs_pending, logs_window::logs_accept_dock,
  log_actions::logs_copy, log_actions::logs_export, log_actions::logs_verify_location, log_actions::logs_open_location, log_actions::logs_take_location,
  system_center::system_snapshot, system_center::system_end_task, system_center::scan_temp_files, system_center::clean_temp_files, system_center::scan_cleanup, system_center::clean_selected_cleanup,
  system_center::cancel_system_maintenance, system_center::flush_dns_cache, system_center::open_storage_tool, system_center::open_local_url,
   ai_model_check::ai_check_model, quick_editor::research::ai_research_context, quick_editor::research::ai_clear_research_context, ai_set_api_key, ai_delete_api_key, ai_get_credential_status, ai_test_connection, ai_list_models, ai_start_chat, ai_stop_chat])
 .build(tauri::generate_context!()).expect("error while building DevFlow")
 .run(|app, event| {
  if let tauri::RunEvent::Exit = event { app.state::<api_tester::ApiTester>().shutdown(); }
  #[cfg(windows)]
  if let tauri::RunEvent::Exit = event { app.state::<AppState>().shutdown_jobs(); }
  #[cfg(not(windows))]
  { let _ = (app, event); }
 });
}

#[cfg(test)]
mod detection_tests {
 use super::*;

 #[test]
 fn detects_fastapi_backend_and_vite_portal_from_evidence() {
  let root = std::env::temp_dir().join(project_storage::new_id("devflow-detect-").unwrap());
  std::fs::create_dir_all(root.join("backend")).unwrap();
  std::fs::create_dir_all(root.join("portal")).unwrap();
  let interpreter = if cfg!(windows) { root.join(".venv/Scripts/python.exe") } else { root.join(".venv/bin/python") };
  std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
  let result = (|| {
   std::fs::write(&interpreter, "").unwrap();
   std::fs::write(root.join("backend/requirements.txt"), "fastapi==1.0\nuvicorn>=1.0\n").unwrap();
   std::fs::write(root.join("backend/main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
   std::fs::write(root.join("portal/package.json"), r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"1","vite":"1"}}"#).unwrap();
   let detected = detect_project(root.to_string_lossy().to_string()).unwrap();
   assert_eq!(detected.services.iter().map(|service| service.id.as_str()).collect::<Vec<_>>(), ["backend", "portal"]);
   let backend = detected.services.iter().find(|service| service.id == "backend").unwrap();
   assert!(backend.program.ends_with(if cfg!(windows) { r".venv\Scripts\python.exe" } else { ".venv/bin/python" }));
   assert_eq!(backend.args, ["-m", "uvicorn", "main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]);
   assert_eq!(backend.host.as_deref(), Some("127.0.0.1"));
   assert_eq!(backend.port, Some(8000));
   assert_eq!(backend.framework.as_deref(), Some("FastAPI"));
   assert_eq!(backend.role.as_deref(), Some("backend"));
   let portal = detected.services.iter().find(|service| service.id == "portal").unwrap();
   assert_eq!(portal.program, "npm");
   assert_eq!(portal.args, ["run", "dev"]);
   assert_eq!(portal.framework.as_deref(), Some("Vite/React"));
   assert_eq!(portal.role.as_deref(), Some("frontend"));
  })();
  std::fs::remove_dir_all(&root).unwrap();
  result
 }

 #[test]
 fn populates_fastapi_interpreter_and_app_module_from_fixture() {
  let root = std::env::temp_dir().join(project_storage::new_id("devflow-fastapi-").unwrap());
  let backend = root.join("backend");
  let interpreter = if cfg!(windows) { backend.join(".venv/Scripts/python.exe") } else { backend.join(".venv/bin/python") };
  std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
  std::fs::create_dir_all(backend.join("app")).unwrap();
  let result = (|| {
   std::fs::write(&interpreter, "").unwrap();
   std::fs::write(backend.join("requirements.txt"), "fastapi\nuvicorn\n").unwrap();
   std::fs::write(backend.join("app/main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
   let detected = detect_project(root.to_string_lossy().to_string()).unwrap();
   let service = detected.services.iter().find(|service| service.id == "backend").unwrap();
   assert_eq!(service.framework.as_deref(), Some("FastAPI"));
   assert!(service.program.ends_with(if cfg!(windows) { r".venv\Scripts\python.exe" } else { ".venv/bin/python" }));
   assert_eq!(service.args, ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]);
   assert_eq!(service.entry_point.as_deref(), Some("app.main:app"));
  })();
  std::fs::remove_dir_all(&root).unwrap();
  result
 }
}

#[cfg(all(test, windows))]
mod lifecycle_tests {
 use super::*;
 use std::{os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, time::{Duration, Instant}};
 use windows_sys::Win32::{
  Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
  System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
 };

 #[test]
 fn duplicate_start_is_rejected_until_reservation_is_released() {
  let state = AppState::default();
  let first = StartGuard::reserve(&state, "test::service".into(), None).unwrap();
  assert_eq!(StartGuard::reserve(&state, "test::service".into(), None).err().as_deref(), Some("Service is already starting"));
  drop(first);
  assert!(StartGuard::reserve(&state, "test::service".into(), None).is_ok());
 }

 #[test]
 fn invalid_executable_releases_reservation_without_spawning_or_retrying() {
  let state = AppState::default();
  {
   let _reservation = StartGuard::reserve(&state, "test::missing".into(), None).unwrap();
   assert!(launcher::resolve_program("devflow-missing-p0-fixture", &std::env::temp_dir()).is_err());
  }
  assert!(state.processes.lock().unwrap().is_empty());
  assert!(StartGuard::reserve(&state, "test::missing".into(), None).is_ok());
 }

 fn fixture_command(script: &str) -> Command {
  let shell = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
   .join("System32/WindowsPowerShell/v1.0/powershell.exe");
  let mut command = Command::new(shell);
  command.args(["-NoProfile", "-NonInteractive", "-Command", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
  command
 }

 #[test]
 fn immediate_failure_preserves_exit_code_and_diagnostic_output() {
  tauri::async_runtime::block_on(async {
   let (child, job) = windows_job::spawn_contained(&mut fixture_command("[Console]::Error.WriteLine('fixture: invalid configuration'); exit 1")).unwrap();
   let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output()).await.unwrap().unwrap();
   assert_eq!(output.status.code(), Some(1));
   assert!(String::from_utf8_lossy(&output.stderr).contains("fixture: invalid configuration"));
   assert_eq!(job.active_processes().unwrap(), 0);
  });
 }

 #[test]
 fn repeated_stderr_stays_running_and_stop_does_not_kill_healthy_neighbor() {
  tauri::async_runtime::block_on(async {
   let state = AppState::default();
   let (mut noisy, noisy_job) = windows_job::spawn_contained(&mut fixture_command("while ($true) { [Console]::Error.WriteLine('ValueError: repeated fixture') }")).unwrap();
   let stderr = noisy.stderr.take().unwrap();
   let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
   let observed = count.clone();
   let reader = tauri::async_runtime::spawn(async move { service_output::collect(stderr, |batch| { observed.fetch_add(batch.len(), Ordering::SeqCst); }).await });
   let (healthy, healthy_job) = windows_job::spawn_contained(&mut fixture_command("[Console]::Out.WriteLine('healthy fixture'); Start-Sleep -Seconds 60")).unwrap();
   let mut noisy_guard = StartGuard::reserve(&state, "test::noisy".into(), None).unwrap();
   noisy_guard.commit(Running { child: Arc::new(tokio::sync::Mutex::new(noisy)), job: noisy_job.clone(), stop_requested: Arc::new(AtomicBool::new(false)), stop_lock: Arc::new(tokio::sync::Mutex::new(())), declared_port: None }).unwrap();
   drop(noisy_guard);
   let mut healthy_guard = StartGuard::reserve(&state, "test::healthy".into(), None).unwrap();
   healthy_guard.commit(Running { child: Arc::new(tokio::sync::Mutex::new(healthy)), job: healthy_job.clone(), stop_requested: Arc::new(AtomicBool::new(false)), stop_lock: Arc::new(tokio::sync::Mutex::new(())), declared_port: None }).unwrap();
   drop(healthy_guard);
   // Synchronous reservations model rapid clicks while the first process runs.
   for _ in 0..100 { assert!(StartGuard::reserve(&state, "test::noisy".into(), None).is_err()); }
   tokio::time::timeout(Duration::from_secs(8), async {
    while count.load(Ordering::SeqCst) < 128 { tokio::time::sleep(Duration::from_millis(25)).await; }
   }).await.unwrap();
   assert!(noisy_job.active_processes().unwrap() > 0, "stderr must not be interpreted as process exit");
   let start = Instant::now();
   stop_owned_service(&state, "test::noisy").await.unwrap();
   assert!(start.elapsed() < Duration::from_secs(6));
   assert_eq!(noisy_job.active_processes().unwrap(), 0);
   assert!(healthy_job.active_processes().unwrap() > 0, "Stop killed another service");
   stop_owned_service(&state, "test::healthy").await.unwrap();
   assert!(state.processes.lock().unwrap().is_empty());
   tokio::time::timeout(Duration::from_secs(3), reader).await.unwrap().unwrap().unwrap();
  });
 }

 #[test]
 fn managed_services_cannot_reserve_the_same_declared_port() {
  let state = AppState::default();
  let first = StartGuard::reserve(&state, "first::web".into(), Some(3000)).unwrap();
  assert!(StartGuard::reserve(&state, "second::web".into(), Some(3000)).err().unwrap().contains("Port 3000"));
  drop(first);
  assert!(StartGuard::reserve(&state, "second::web".into(), Some(3000)).is_ok());
 }

 #[test]
 fn shutdown_cancels_an_in_flight_reservation() {
  let state = AppState::default();
  let first = StartGuard::reserve(&state, "test::service".into(), None).unwrap();
  state.shutdown_jobs();
  assert!(first.starting.cancelled.load(Ordering::SeqCst));
  assert_eq!(StartGuard::reserve(&state, "test::service".into(), None).err().as_deref(), Some("DevFlow is closing; service was not started."));
  drop(first);
  assert!(state.processes.lock().unwrap().is_empty());
 }

 struct TestTree { state: AppState, directory: PathBuf, descendant: OwnedHandle }
 impl Drop for TestTree {
  fn drop(&mut self) {
   self.state.shutdown_jobs();
   let _ = std::fs::remove_dir_all(&self.directory);
  }
 }

 fn wait_for_file(path: &Path) -> String {
  let deadline = Instant::now() + Duration::from_secs(8);
  loop {
   if let Ok(value) = std::fs::read_to_string(path) { return value; }
   assert!(Instant::now() < deadline, "descendant did not start within 8 seconds");
   std::thread::sleep(Duration::from_millis(25));
  }
 }

 fn test_tree() -> TestTree {
  let directory = std::env::temp_dir().join(format!("devflow-job-test-{}-{:?}", std::process::id(), std::thread::current().id()));
  std::fs::create_dir_all(&directory).unwrap();
  let script = directory.join("spawn.ps1");
  std::fs::write(&script, "$child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden\r\n[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'descendant.pid'), [string]$child.Id)\r\n").unwrap();
  let shell = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
   .join("System32/WindowsPowerShell/v1.0/powershell.exe");
  let mut command = Command::new(shell);
  command.args(["-NoProfile", "-NonInteractive", "-File"]).arg(&script)
   .current_dir(&directory).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
  let (child, job) = windows_job::spawn_contained(&mut command).unwrap();
  let state = AppState::default();
  state.processes.lock().unwrap().insert("test::service".into(), ProcessEntry::Running(Running { child: Arc::new(tokio::sync::Mutex::new(child)), job, stop_requested: Arc::new(AtomicBool::new(false)), stop_lock: Arc::new(tokio::sync::Mutex::new(())), declared_port: None }));
  let pid: u32 = wait_for_file(&directory.join("descendant.pid")).trim().parse().unwrap();
  let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
  assert!(!handle.is_null(), "could not open spawned descendant: {}", std::io::Error::last_os_error());
  let descendant = unsafe { OwnedHandle::from_raw_handle(handle) };
  assert_eq!(unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) }, WAIT_TIMEOUT);
  TestTree { state, directory, descendant }
 }

 fn assert_root_exited_but_descendant_owned(tree: &TestTree) {
  let deadline = Instant::now() + Duration::from_secs(8);
  loop {
   let processes = tree.state.processes.lock().unwrap();
   let Some(ProcessEntry::Running(running)) = processes.get("test::service") else { panic!("service is not running") };
   let finished = running.child.try_lock().unwrap().try_wait().unwrap().is_some();
   let active = running.job.active_processes().unwrap();
   drop(processes);
   if finished { assert!(active >= 1, "descendant must remain in the job after root exit"); break; }
   assert!(Instant::now() < deadline, "root did not exit within 8 seconds");
   std::thread::sleep(Duration::from_millis(25));
  }
 }

 fn assert_descendant_stopped(tree: &TestTree) {
  assert_eq!(unsafe { WaitForSingleObject(tree.descendant.as_raw_handle(), 5000) }, WAIT_OBJECT_0,
   "descendant remained alive after cleanup");
 }

 #[test]
 fn contained_batch_launcher_preserves_output() {
  let directory = std::env::temp_dir().join(format!("devflow-batch-job-test-{}", std::process::id()));
  std::fs::create_dir_all(&directory).unwrap();
  let script = directory.join("service.cmd");
  std::fs::write(&script, "@echo off\r\necho READY:%~1\r\n").unwrap();
  let mut command = Command::new(&script);
  command.arg("hello world").current_dir(&directory).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
  let (child, job) = windows_job::spawn_contained(&mut command).unwrap();
  let output = tauri::async_runtime::block_on(async {
   tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await.unwrap().unwrap()
  });
  assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
  assert!(String::from_utf8_lossy(&output.stdout).contains("READY:hello world"));
  drop(job);
  std::fs::remove_dir_all(directory).unwrap();
 }

 #[test]
 fn stop_terminates_descendant_after_root_exits() {
  let tree = test_tree();
  assert_root_exited_but_descendant_owned(&tree);
  tauri::async_runtime::block_on(stop_owned_service(&tree.state, "test::service")).unwrap();
  assert_descendant_stopped(&tree);
  assert!(tree.state.processes.lock().unwrap().is_empty());
 }

 #[test]
 fn app_shutdown_terminates_descendant_after_root_exits() {
  let tree = test_tree();
  assert_root_exited_but_descendant_owned(&tree);
  tree.state.shutdown_jobs();
  assert_descendant_stopped(&tree);
  assert!(tree.state.processes.lock().unwrap().is_empty());
 }
}
