use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}};
use tauri::{Emitter, Manager, State};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::{Child, Command}};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Service { id: String, name: String, cwd: String, program: String, args: Vec<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project { id: String, name: String, root: String, services: Vec<Service> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine { project_id: String, service_id: String, stream: String, message: String }
struct Running { child: Arc<tokio::sync::Mutex<Child>> }
#[derive(Default)]
struct AppState { processes: Mutex<HashMap<String, Running>> }
fn process_key(project: &str, service: &str) -> String { format!("{}::{}", project, service) }
fn storage_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
 let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
 std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
 Ok(dir.join("projects.json"))
}
#[tauri::command]
fn load_projects(app: tauri::AppHandle) -> Result<Vec<Project>, String> {
 let path = storage_path(&app)?;
 if !path.exists() { return Ok(vec![]); }
 let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
 serde_json::from_str(&raw).map_err(|e| e.to_string())
}
#[tauri::command]
fn save_projects(app: tauri::AppHandle, projects: Vec<Project>) -> Result<(), String> {
 let path = storage_path(&app)?;
 let data = serde_json::to_vec_pretty(&projects).map_err(|e| e.to_string())?;
 let tmp = path.with_extension("json.tmp");
 std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
 std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
fn suggested_service(dir: &Path, id: &str, name: &str) -> Option<Service> {
 let cwd = dir.to_str()?.to_string();
 let package = dir.join("package.json");
 if package.exists() {
  let value: serde_json::Value = serde_json::from_slice(&std::fs::read(package).ok()?).ok()?;
  if value.pointer("/scripts/dev").and_then(|v| v.as_str()).is_some() {
   let (program, args) = if dir.join("pnpm-lock.yaml").exists() { ("pnpm", vec!["run", "dev"]) }
    else if dir.join("yarn.lock").exists() { ("yarn", vec!["dev"]) }
    else { ("npm", vec!["run", "dev"]) };
   return Some(Service { id: id.into(), name: name.into(), cwd, program: program.into(), args: args.into_iter().map(String::from).collect() });
  }
 }
 if dir.join("requirements.txt").exists() || dir.join("pyproject.toml").exists() {
  let module = if dir.join("main.py").exists() { "main:app" }
   else if dir.join("app/main.py").exists() { "app.main:app" }
   else { return None; };
  let venv = if cfg!(windows) { dir.join(".venv/Scripts/python.exe") } else { dir.join(".venv/bin/python") };
  let python = if venv.exists() { venv.to_string_lossy().to_string() } else { if cfg!(windows) { "python" } else { "python3" }.into() };
  return Some(Service { id: id.into(), name: name.into(), cwd, program: python, args: vec!["-m".into(), "uvicorn".into(), module.into(), "--reload".into()] });
 }
 None
}
#[tauri::command]
fn detect_project(root: String) -> Result<Project, String> {
 let dir = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
 if !dir.is_dir() { return Err("Select a directory".into()); }
 let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Project").to_string();
 let mut services = Vec::new();
 for (folder, label) in [("frontend", "Frontend"), ("backend", "Backend"), ("client", "Client"), ("server", "Server")] {
  let path = dir.join(folder);
  if path.is_dir() { if let Some(s) = suggested_service(&path, folder, label) { services.push(s); } }
 }
 if services.is_empty() { if let Some(s) = suggested_service(&dir, "main", "Application") { services.push(s); } }
 Ok(Project { id: format!("p{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis()), name, root: dir.to_string_lossy().to_string(), services })
}
#[tauri::command]
async fn start_service(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String, service: Service) -> Result<(), String> {
 let key = process_key(&project_id, &service.id);
 {
  let processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if processes.contains_key(&key) { return Err("Service already started".into()); }
 }
 if !Path::new(&service.cwd).is_dir() { return Err("Working directory does not exist".into()); }
 if service.program.trim().is_empty() { return Err("Missing executable".into()); }
 let mut command = Command::new(&service.program);
 command.args(&service.args).current_dir(&service.cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
 #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
 let mut child = command.spawn().map_err(|e| format!("Could not start {}: {}", service.name, e))?;
 let stdout = child.stdout.take();
 let stderr = child.stderr.take();
 let child = Arc::new(tokio::sync::Mutex::new(child));
 {
  let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if processes.contains_key(&key) { return Err("Service already started".into()); }
  processes.insert(key.clone(), Running { child: child.clone() });
 }
 for (pipe, stream) in [(stdout, "stdout"), (stderr, "stderr")] {
  if let Some(pipe) = pipe {
   let app = app.clone(); let project_id = project_id.clone(); let service_id = service.id.clone();
   tauri::async_runtime::spawn(async move {
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(message)) = lines.next_line().await {
     let _ = app.emit("service-log", LogLine { project_id: project_id.clone(), service_id: service_id.clone(), stream: stream.into(), message });
    }
   });
  }
 }
 let app_clone = app.clone(); let project_clone = project_id.clone(); let service_clone = service.id.clone();
 tauri::async_runtime::spawn(async move {
  loop {
   tokio::time::sleep(std::time::Duration::from_millis(500)).await;
   let finished = { let mut c = child.lock().await; c.try_wait().ok().flatten() };
   if let Some(status) = finished {
    let state = app_clone.state::<AppState>();
    if let Ok(mut processes) = state.processes.lock() { processes.remove(&key); }
    let _ = app_clone.emit("service-log", LogLine { project_id: project_clone, service_id: service_clone, stream: "system".into(), message: format!("Process exited: {}", status) });
    break;
   }
  }
 });
 Ok(())
}
#[tauri::command]
async fn stop_service(state: State<'_, AppState>, project_id: String, service_id: String) -> Result<(), String> {
 let key = process_key(&project_id, &service_id);
 let child = {
  let processes = state.processes.lock().map_err(|_| "State unavailable")?;
  processes.get(&key).map(|r| r.child.clone()).ok_or("Service not running")?
 };
 let mut c = child.lock().await;
 #[cfg(windows)] {
  if let Some(pid) = c.id() {
   let output = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output().await.map_err(|e| e.to_string())?;
   if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
  }
 }
 #[cfg(not(windows))] { c.kill().await.map_err(|e| e.to_string())?; }
 Ok(())
}
#[tauri::command]
fn running_services(state: State<'_, AppState>) -> Result<Vec<String>, String> {
 let processes = state.processes.lock().map_err(|_| "State unavailable")?;
 Ok(processes.keys().cloned().collect())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(AppState::default())
 .invoke_handler(tauri::generate_handler![load_projects, save_projects, detect_project, start_service, stop_service, running_services])
 .run(tauri::generate_context!()).expect("error while running DevFlow");
}
