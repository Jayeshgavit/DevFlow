use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}};
use tauri::{Emitter, Manager, State};
use tokio::{io::{AsyncBufReadExt, AsyncRead, BufReader}, process::{Child, Command}};
mod launcher;
#[cfg(windows)]
mod windows_job;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Service { id: String, name: String, cwd: String, program: String, args: Vec<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project { id: String, name: String, root: String, services: Vec<Service> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine { project_id: String, service_id: String, stream: String, message: String }
struct Running {
 child: Arc<tokio::sync::Mutex<Child>>,
 #[cfg(windows)]
 job: Arc<windows_job::WindowsJob>,
}
struct Starting {
 cancelled: AtomicBool,
 complete: tokio::sync::watch::Sender<bool>,
}
enum ProcessEntry { Starting(Arc<Starting>), Running(Running) }
#[derive(Default)]
struct AppState { processes: Mutex<HashMap<String, ProcessEntry>>, exiting: AtomicBool, projects_loaded: Mutex<bool> }
struct StartGuard<'a> { state: &'a AppState, key: String, starting: Arc<Starting>, committed: bool }
impl<'a> StartGuard<'a> {
 fn reserve(state: &'a AppState, key: String) -> Result<Self, String> {
  let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if state.exiting.load(Ordering::SeqCst) { return Err("DevFlow is closing; service was not started.".into()); }
  match processes.get(&key) {
   Some(ProcessEntry::Starting(_)) => return Err("Service is already starting".into()),
   Some(ProcessEntry::Running(_)) => return Err("Service already started".into()),
   None => {}
  }
  let (complete, _) = tokio::sync::watch::channel(false);
  let starting = Arc::new(Starting { cancelled: AtomicBool::new(false), complete });
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
    ProcessEntry::Running(running) => Some(running.job.clone()),
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
fn stream_pipe<R>(pipe: Option<R>, app: &tauri::AppHandle, project_id: &str, service_id: &str, stream: &'static str)
where R: AsyncRead + Unpin + Send + 'static {
 if let Some(pipe) = pipe {
  let app = app.clone();
  let project_id = project_id.to_string();
  let service_id = service_id.to_string();
  tauri::async_runtime::spawn(async move {
   let mut lines = BufReader::new(pipe).lines();
   while let Ok(Some(message)) = lines.next_line().await {
    let _ = app.emit("service-log", LogLine { project_id: project_id.clone(), service_id: service_id.clone(), stream: stream.into(), message });
   }
  });
 }
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
 let projects = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
 *loaded = true;
 Ok(projects)
}
#[tauri::command]
fn save_projects(app: tauri::AppHandle, state: State<'_, AppState>, projects: Vec<Project>) -> Result<(), String> {
 let loaded = state.projects_loaded.lock().map_err(|_| "Project storage unavailable")?;
 if !*loaded { return Err("Projects have not loaded successfully. Retry Load before saving.".into()); }
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
#[tauri::command]
async fn start_service(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String, service: Service) -> Result<(), String> {
 let key = process_key(&project_id, &service.id);
 let mut reservation = StartGuard::reserve(&state, key.clone())?;
 let cwd = std::fs::canonicalize(&service.cwd).map_err(|e| format!("Working directory '{}' is unavailable: {e}", service.cwd))?;
 if !cwd.is_dir() { return Err(format!("Working directory '{}' is not a folder.", service.cwd)); }
 let executable = launcher::resolve_program(&service.program, &cwd)?;
 #[cfg(windows)]
 let mut command = if launcher::script_kind(&executable)? == "powershell" {
  let shell = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32/WindowsPowerShell/v1.0/powershell.exe");
  let mut command = Command::new(shell);
  command.args(["-NoProfile", "-NonInteractive", "-File"]).arg(&executable);
  command
 } else { Command::new(&executable) };
 #[cfg(not(windows))]
 let mut command = Command::new(&executable);
 command.args(&service.args).current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
 #[cfg(windows)]
 let (mut child, job) = windows_job::spawn_contained(&mut command)
  .map_err(|e| format!("Could not start {} using '{}': {}", service.name, executable.display(), e))?;
 #[cfg(not(windows))]
 let mut child = command.spawn().map_err(|e| format!("Could not start {} using '{}': {}", service.name, executable.display(), e))?;
 let stdout = child.stdout.take();
 let stderr = child.stderr.take();
 let child = Arc::new(tokio::sync::Mutex::new(child));
 let running = Running { child: child.clone(), #[cfg(windows)] job: job.clone() };
 if let Err(error) = reservation.commit(running) {
  #[cfg(windows)]
  drop(job);
  drop(child);
  return Err(error);
 }
 stream_pipe(stdout, &app, &project_id, &service.id, "stdout");
 stream_pipe(stderr, &app, &project_id, &service.id, "stderr");
 let app_clone = app.clone(); let project_clone = project_id.clone(); let service_clone = service.id.clone();
 tauri::async_runtime::spawn(async move {
  let mut root_status = None;
  loop {
   tokio::time::sleep(std::time::Duration::from_millis(500)).await;
   if root_status.is_none() { root_status = { let mut c = child.lock().await; c.try_wait().ok().flatten() }; }
   #[cfg(windows)]
   let tree_empty = matches!(job.active_processes(), Ok(0));
   #[cfg(not(windows))]
   let tree_empty = true;
   if root_status.is_some() && tree_empty {
    let state = app_clone.state::<AppState>();
    if let Ok(mut processes) = state.processes.lock() {
     let same = matches!(processes.get(&key), Some(ProcessEntry::Running(running)) if Arc::ptr_eq(&running.child, &child));
     if same { processes.remove(&key); }
    }
    let _ = app_clone.emit("service-log", LogLine { project_id: project_clone, service_id: service_clone, stream: "system".into(), message: format!("Process exited: {}", root_status.unwrap()) });
    break;
   }
  }
 });
 Ok(())
}
#[tauri::command]
async fn stop_service(state: State<'_, AppState>, project_id: String, service_id: String) -> Result<(), String> {
 let key = process_key(&project_id, &service_id);
 stop_owned_service(&state, &key).await
}
async fn stop_owned_service(state: &AppState, key: &str) -> Result<(), String> {
 enum StopTarget { Starting(tokio::sync::watch::Receiver<bool>), Running(Arc<tokio::sync::Mutex<Child>>, #[cfg(windows)] Arc<windows_job::WindowsJob>) }
 let target = {
  let processes = state.processes.lock().map_err(|_| "State unavailable")?;
  match processes.get(key) {
   Some(ProcessEntry::Starting(starting)) => {
    starting.cancelled.store(true, Ordering::SeqCst);
    StopTarget::Starting(starting.complete.subscribe())
   }
   Some(ProcessEntry::Running(running)) => StopTarget::Running(running.child.clone(), #[cfg(windows)] running.job.clone()),
   None => return Err("Service not running".into()),
  }
 };
 let running = match target {
  StopTarget::Starting(mut complete) => {
   tokio::time::timeout(std::time::Duration::from_secs(5), complete.wait_for(|done| *done))
    .await.map_err(|_| "Timed out waiting for service startup to cancel.".to_string())?
    .map_err(|_| "Service startup cancellation was interrupted.".to_string())?;
   return Ok(());
  }
  #[cfg(windows)]
  StopTarget::Running(child, job) => (child, job),
  #[cfg(not(windows))]
  StopTarget::Running(child) => (child,),
 };
 #[cfg(windows)] {
  let (child, job) = running;
  job.terminate().map_err(|e| format!("Could not stop service Job Object: {e}"))?;
  let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
  loop {
   if job.active_processes().map_err(|e| format!("Could not check service cleanup: {e}"))? == 0 { break; }
   if tokio::time::Instant::now() >= deadline { return Err("Timed out waiting for the service process tree to stop.".into()); }
   tokio::time::sleep(std::time::Duration::from_millis(25)).await;
  }
  let mut c = child.lock().await;
  c.wait().await.map_err(|e| format!("Could not reap stopped service: {e}"))?;
  let mut processes = state.processes.lock().map_err(|_| "State unavailable")?;
  if matches!(processes.get(key), Some(ProcessEntry::Running(current)) if Arc::ptr_eq(&current.child, &child)) { processes.remove(key); }
 }
 #[cfg(not(windows))] { let (child,) = running; child.lock().await.kill().await.map_err(|e| e.to_string())?; }
 Ok(())
}
#[tauri::command]
fn running_services(state: State<'_, AppState>) -> Result<Vec<String>, String> {
 let processes = state.processes.lock().map_err(|_| "State unavailable")?;
 Ok(processes.iter().filter_map(|(key, entry)| matches!(entry, ProcessEntry::Running(_)).then(|| key.clone())).collect())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(AppState::default())
 .invoke_handler(tauri::generate_handler![load_projects, save_projects, detect_project, start_service, stop_service, running_services, open_directory])
 .build(tauri::generate_context!()).expect("error while building DevFlow")
 .run(|app, event| {
  #[cfg(windows)]
  if let tauri::RunEvent::Exit = event { app.state::<AppState>().shutdown_jobs(); }
  #[cfg(not(windows))]
  { let _ = (app, event); }
 });
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
  let first = StartGuard::reserve(&state, "test::service".into()).unwrap();
  assert_eq!(StartGuard::reserve(&state, "test::service".into()).err().as_deref(), Some("Service is already starting"));
  drop(first);
  assert!(StartGuard::reserve(&state, "test::service".into()).is_ok());
 }

 #[test]
 fn shutdown_cancels_an_in_flight_reservation() {
  let state = AppState::default();
  let first = StartGuard::reserve(&state, "test::service".into()).unwrap();
  state.shutdown_jobs();
  assert!(first.starting.cancelled.load(Ordering::SeqCst));
  assert_eq!(StartGuard::reserve(&state, "test::service".into()).err().as_deref(), Some("DevFlow is closing; service was not started."));
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
  state.processes.lock().unwrap().insert("test::service".into(), ProcessEntry::Running(Running { child: Arc::new(tokio::sync::Mutex::new(child)), job }));
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
