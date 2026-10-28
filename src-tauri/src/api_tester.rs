//! User-operated, main-window-only loopback HTTP and guarded discovery source reads.
use std::{collections::HashSet, net::{IpAddr, SocketAddr}, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use futures_util::StreamExt;
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue}, Method, Url};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::oneshot;

const REQUEST_LIMIT: usize = 256 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;
const STORAGE_LIMIT: u64 = 4 * 1024 * 1024;
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row { pub id: String, pub enabled: bool, pub key: String, pub value: String, pub secret: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub method: String, pub url: String, pub params: Vec<Row>, pub headers: Vec<Row>,
    pub body_mode: String, pub body: String, pub form: Vec<Row>, pub body_secret: bool,
    pub auth: String, pub token: String, pub username: String, pub password: String, pub timeout_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    kind: String, message: String, status: Option<u16>, status_label: String,
    duration_ms: u64, size: usize, headers: Vec<(String, String)>, body: String, truncated: bool,
}
impl Outcome {
    fn error(kind: &str, message: &str) -> Self {
        Self { kind: kind.into(), message: message.into(), status: None, status_label: String::new(), duration_ms: 0, size: 0, headers: vec![], body: String::new(), truncated: false }
    }
}
struct Slot { id: String, project: String, sender: oneshot::Sender<()>, receiver: Option<oneshot::Receiver<()>> }
#[derive(Default)]
pub struct ApiTester { active: Mutex<Option<Slot>>, closed: AtomicBool }
impl ApiTester {
    pub fn cancel_all(&self) { if let Ok(mut active) = self.active.lock() { if let Some(slot) = active.take() { let _ = slot.sender.send(()); } } }
    pub fn shutdown(&self) { self.closed.store(true, Ordering::Release); self.cancel_all(); }
}
fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("API Tester is available in the main window only.".into()); } Ok(())
}
fn project_path(app: &tauri::AppHandle, project: &str) -> Result<std::path::PathBuf, String> {
    if project.is_empty() || project.len() > 100 { return Err("Invalid project identifier.".into()); }
    let projects: Vec<crate::Project> = serde_json::from_slice(&std::fs::read(crate::storage_path(app)?).map_err(|_| "Could not read saved projects.")?).map_err(|_| "Could not read saved projects.")?;
    if !projects.iter().any(|p| p.id == project) { return Err("Save this project before using API Tester storage or sending requests.".into()); }
    let key: String = project.bytes().map(|b| format!("{b:02x}")).collect();
    Ok(app.path().app_data_dir().map_err(|_| "App data directory unavailable.")?.join("api-tester-v1").join(format!("project-{key}.json")))
}
#[tauri::command]
pub async fn api_tester_prepare(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, ApiTester>, project_id: String, request_id: String) -> Result<(), String> {
    main_only(&window)?;
    let project = project_id.clone();
    tauri::async_runtime::spawn_blocking(move || project_path(&app, &project)).await.map_err(|_| "Saved project validation failed.")??;
    if request_id.is_empty() || request_id.len() > 100 { return Err("Invalid request identifier.".into()); }
    let mut active = state.active.lock().map_err(|_| "Request state unavailable.")?;
    if state.closed.load(Ordering::Acquire) { return Err("The API Tester window is closed.".into()); }
    if active.is_some() { return Err("A request is already active. Cancel it first.".into()); }
    let (sender, receiver) = oneshot::channel();
    *active = Some(Slot { id: request_id, project: project_id, sender, receiver: Some(receiver) }); Ok(())
}
#[tauri::command]
pub fn api_tester_cancel(window: tauri::WebviewWindow, state: tauri::State<'_, ApiTester>, request_id: String) -> Result<(), String> {
    main_only(&window)?;
    let mut active = state.active.lock().map_err(|_| "Request state unavailable.")?;
    if active.as_ref().is_some_and(|s| s.id == request_id) { if let Some(slot) = active.take() { let _ = slot.sender.send(()); } } Ok(())
}
fn validate_url(text: &str) -> Result<Url, Outcome> {
    let fail = || Outcome::error("invalidUrl", "Use an HTTP(S) URL at localhost, 127.0.0.1, or [::1], without URL credentials or fragments.");
    if text.len() > 8192 || text.chars().any(|ch| ch.is_control() || ch.is_whitespace()) { return Err(fail()); }
    let url = Url::parse(text).map_err(|_| fail())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) || url.port_or_known_default() == Some(0) { return Err(fail()); }
    Ok(url)
}
fn valid_request(request: &Request) -> Result<(), Outcome> {
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&request.method.as_str())
        || !["none", "json", "text", "form"].contains(&request.body_mode.as_str())
        || !["none", "bearer", "basic", "headers"].contains(&request.auth.as_str())
        || !(1..=120).contains(&request.timeout_seconds) { return Err(Outcome::error("validation", "Invalid method, body, authorization, or timeout (1–120 seconds).")); }
    if request.body.len() > 128 * 1024 || request.params.len() > 100 || request.headers.len() > 100 || request.form.len() > 100
        || request.params.iter().chain(request.headers.iter()).chain(request.form.iter()).any(|r| r.id.is_empty() || r.id.len() > 100 || r.key.len() > 2048 || r.value.len() > 65536)
        || serde_json::to_vec(request).map_or(true, |b| b.len() > REQUEST_LIMIT) { return Err(Outcome::error("limit", "Request exceeds the 256 KiB / 100 rows per table limit.")); }
    Ok(())
}
async fn execute(request: Request) -> Result<Outcome, Outcome> {
    valid_request(&request)?;
    let mut url = validate_url(&request.url)?;
    for row in request.params.iter().filter(|r| r.enabled && !r.key.is_empty()) { url.query_pairs_mut().append_pair(&row.key, &row.value); }
    if url.as_str().len() > 8192 { return Err(Outcome::error("limit", "Encoded URL exceeds 8 KiB.")); }
    // Pin localhost to literal loopback addresses: never consult DNS, system proxies,
    // environment proxies, or follow a server-controlled Location header.
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses = [SocketAddr::new(IpAddr::from([127, 0, 0, 1]), port), SocketAddr::new(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST), port)];
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs("localhost", &addresses).connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(request.timeout_seconds)).build()
        .map_err(|_| Outcome::error("transport", "Could not initialize the HTTP client."))?;
    let mut headers = HeaderMap::new();
    for row in request.headers.iter().filter(|r| r.enabled && !r.key.is_empty()) {
        let name = HeaderName::from_bytes(row.key.as_bytes()).map_err(|_| Outcome::error("validation", "A header name is malformed. Use an HTTP token without spaces."))?;
        if ["host", "content-length", "transfer-encoding", "connection", "proxy-authorization", "proxy-connection", "upgrade", "trailer"].contains(&name.as_str()) { return Err(Outcome::error("validation", "Host, framing, connection, and proxy headers are managed by the HTTP client.")); }
        if headers.contains_key(&name) { return Err(Outcome::error("validation", "Duplicate enabled headers are ambiguous. Combine them into one row.")); }
        let mut value = HeaderValue::from_str(&row.value).map_err(|_| Outcome::error("validation", "A header value is malformed. Remove line breaks and control characters."))?;
        value.set_sensitive(true); headers.insert(name, value);
    }
    if matches!(request.auth.as_str(), "bearer" | "basic") && headers.contains_key("authorization") { return Err(Outcome::error("validation", "Use either the Authorization tab or an Authorization header, not both.")); }
    let body = match request.body_mode.as_str() {
        "json" => { serde_json::from_str::<serde_json::Value>(&request.body).map_err(|_| Outcome::error("validation", "Body is not valid JSON. Check quoted keys, commas, and brackets."))?; request.body.clone() },
        "text" => request.body.clone(),
        "form" => { let mut form_url = Url::parse("http://localhost/").map_err(|_| Outcome::error("validation", "Could not encode form."))?; for row in request.form.iter().filter(|r| r.enabled && !r.key.is_empty()) { form_url.query_pairs_mut().append_pair(&row.key, &row.value); } form_url.query().unwrap_or("").to_string() },
        _ => String::new(),
    };
    let header_size: usize = headers.iter().map(|(name, value)| name.as_str().len() + value.as_bytes().len()).sum();
    if body.len() + url.as_str().len() + header_size + request.token.len() + request.username.len() + request.password.len() > REQUEST_LIMIT {
        return Err(Outcome::error("limit", "Encoded request exceeds 256 KiB. Reduce parameters, headers, or body content."));
    }
    let content_type = match request.body_mode.as_str() { "json" => Some("application/json"), "text" => Some("text/plain; charset=utf-8"), "form" => Some("application/x-www-form-urlencoded"), _ => None };
    if let Some(expected) = content_type {
        if let Some(actual) = headers.get("content-type") {
            let actual = actual.to_str().unwrap_or("").split(';').next().unwrap_or("").trim();
            let expected_base = expected.split(';').next().unwrap_or("");
            if request.body_mode != "text" && !actual.eq_ignore_ascii_case(expected_base) && !(request.body_mode == "json" && actual.to_ascii_lowercase().ends_with("+json")) { return Err(Outcome::error("validation", "Content-Type conflicts with the selected body mode.")); }
        } else { headers.insert("content-type", HeaderValue::from_static(expected)); }
    }
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| Outcome::error("validation", "Unsupported HTTP method."))?;
    let mut builder = client.request(method, url).headers(headers);
    if request.auth == "bearer" {
        if request.token.is_empty() { return Err(Outcome::error("validation", "Enter a session-only Bearer token.")); }
        if request.token.chars().any(|ch| ch.is_whitespace() || ch.is_control()) { return Err(Outcome::error("validation", "Bearer token cannot contain whitespace or control characters.")); }
        builder = builder.bearer_auth(&request.token);
    } else if request.auth == "basic" {
        if request.username.is_empty() || request.username.contains(':') { return Err(Outcome::error("validation", "Enter a session-only Basic username without a colon.")); }
        builder = builder.basic_auth(&request.username, Some(&request.password));
    }
    if request.body_mode != "none" { builder = builder.body(body); }
    let response = builder.send().await.map_err(transport)?;
    if !response.remote_addr().is_some_and(|addr| addr.ip().is_loopback()) { return Err(Outcome::error("blocked", "The connected destination was not loopback.")); }
    let status = response.status();
    let mut response_headers = Vec::new(); let mut header_bytes = 0;
    for (name, value) in response.headers() {
        header_bytes += name.as_str().len() + value.as_bytes().len();
        if header_bytes > 64 * 1024 { return Err(Outcome::error("limit", "Response headers exceed 64 KiB.")); }
        response_headers.push((name.to_string(), value.to_str().unwrap_or("[non-text header]").to_string()));
    }
    let mut stream = response.bytes_stream(); let mut bytes = Vec::new(); let mut truncated = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(transport)?;
        let remaining = RESPONSE_LIMIT - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining { truncated = true; break; }
    }
    Ok(Outcome { kind: "completed".into(), message: if truncated { "Response stopped at the 1 MiB limit; body is incomplete.".into() } else { String::new() }, status: Some(status.as_u16()), status_label: status.canonical_reason().unwrap_or("").into(), duration_ms: 0, size: bytes.len(), headers: response_headers, body: String::from_utf8_lossy(&bytes).into_owned(), truncated })
}
fn transport(error: reqwest::Error) -> Outcome {
    // Never stringify a reqwest error: it can contain the request URL and secrets.
    if error.is_timeout() { Outcome::error("timeout", "Request timed out. Check the service and request timeout.") }
    else if error.is_connect() {
        use std::error::Error;
        let mut source: Option<&(dyn Error + 'static)> = Some(&error);
        while let Some(cause) = source { if cause.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::ConnectionRefused) { return Outcome::error("refused", "Connection refused. Check that the service is running at this host and port."); } source = cause.source(); }
        Outcome::error("connection", "Could not connect. Check host, port, and the HTTPS certificate. Certificate verification remains enabled.")
    } else { Outcome::error("transport", "HTTP transport failed while sending or reading the response.") }
}
#[tauri::command]
pub async fn api_tester_send(window: tauri::WebviewWindow, state: tauri::State<'_, ApiTester>, project_id: String, request_id: String, request: Request) -> Result<Outcome, String> {
    main_only(&window)?;
    let receiver = {
        let mut active = state.active.lock().map_err(|_| "Request state unavailable.")?;
        let Some(slot) = active.as_mut().filter(|s| s.id == request_id && s.project == project_id) else { return Ok(Outcome::error("canceled", "Request canceled.")); };
        slot.receiver.take().ok_or("Request has already started.")?
    };
    let start = Instant::now();
    let timeout = Duration::from_secs(request.timeout_seconds.clamp(1, 120));
    let mut result = tokio::select! {
        biased;
        _ = receiver => Outcome::error("canceled", "Request canceled."),
        result = tokio::time::timeout(timeout, execute(request)) => match result {
            Ok(Ok(value)) => value, Ok(Err(error)) => error, Err(_) => Outcome::error("timeout", "Request timed out.")
        }
    };
    result.duration_ms = start.elapsed().as_millis() as u64;
    if let Ok(mut active) = state.active.lock() { if active.as_ref().is_some_and(|s| s.id == request_id) { *active = None; } }
    Ok(result)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Saved { id: String, name: String, collection: String, request: Request }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History { id: String, timestamp: u64, method: String, url: String, duration_ms: u64, result: String, request: Request }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Store { version: u32, project_id: String, revision: u64, requests: Vec<Saved>, collections: Vec<String>, history: Vec<History>, last_selected: Option<String> }
fn read_store(path: &std::path::Path, project: &str) -> Result<Store, String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store { version: 1, project_id: project.into(), revision: 0, requests: vec![], collections: vec![], history: vec![], last_selected: None }),
        Err(_) => Err("Could not read API Tester storage. No data was overwritten.".into()),
        Ok(meta) => {
            if meta.len() > STORAGE_LIMIT { return Err("API Tester file exceeds 4 MiB. No data was overwritten.".into()); }
            let mut store: Store = serde_json::from_slice(&std::fs::read(path).map_err(|_| "Could not read API Tester storage.")?).map_err(|_| "Invalid API Tester file. No automatic repair was attempted.")?;
            validate_store(&store, project)?; sanitize_store(&mut store)?; Ok(store)
        }
    }
}
fn sensitive(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["auth", "token", "secret", "password", "passwd", "cookie", "api-key", "api_key", "apikey", "credential", "session", "signature"].iter().any(|word| key.contains(word))
}
fn safe_url(text: &str) -> Result<String, String> {
    if text.is_empty() { return Ok(String::new()); }
    let mut url = validate_url(text).map_err(|_| "Saved URL must be an HTTP(S) loopback URL without credentials.")?;
    // Query values in the URL are always session-only. Use nonsecret Params rows to persist values.
    let keys: Vec<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
    if !keys.is_empty() { url.set_query(None); for key in keys { url.query_pairs_mut().append_pair(&key, ""); } }
    Ok(url.to_string())
}
fn sanitize(request: &mut Request) -> Result<(), String> {
    valid_request(request).map_err(|_| "Invalid saved request or request size limit exceeded.")?;
    request.token.clear(); request.username.clear(); request.password.clear(); request.url = safe_url(&request.url)?;
    for row in request.headers.iter_mut().chain(request.params.iter_mut()).chain(request.form.iter_mut()) {
        if row.secret || sensitive(&row.key) { row.secret = true; row.value.clear(); }
    }
    if request.auth == "headers" { for header in &mut request.headers { header.value.clear(); header.secret = true; } }
    if request.body_secret || body_has_secret(&request.body) { request.body_secret = true; request.body.clear(); }
    Ok(())
}
fn body_has_secret(body: &str) -> bool {
    fn scan(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(map) => map.iter().any(|(key, value)| sensitive(key) || scan(value)),
            serde_json::Value::Array(values) => values.iter().any(scan),
            _ => false,
        }
    }
    if serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| scan(&value)) { return true; }
    let lower = body.to_ascii_lowercase();
    ["bearer ", "-----begin", "password", "api_key", "api-key", "access_token", "refresh_token", "client_secret", "authorization"].iter().any(|marker| lower.contains(marker))
}
fn validate_store(store: &Store, project: &str) -> Result<(), String> {
    if store.version != 1 || store.project_id != project { return Err("Unsupported schema or mismatched project. Storage was not modified.".into()); }
    let mut ids = HashSet::new();
    if store.requests.len() > 100 || store.collections.len() > 30 || store.history.len() > 30
        || store.collections.iter().any(|n| n.trim().is_empty() || n.chars().count() > 100)
        || store.collections.iter().collect::<HashSet<_>>().len() != store.collections.len()
        || store.requests.iter().any(|r| r.id.is_empty() || r.id.len() > 100 || !ids.insert(&r.id) || r.name.trim().is_empty() || r.name.chars().count() > 200 || (!r.collection.is_empty() && !store.collections.contains(&r.collection)))
        || store.history.iter().any(|h| h.id.is_empty() || h.id.len() > 100 || h.result.len() > 100 || h.timestamp > 4_102_444_800_000)
        || store.last_selected.as_ref().is_some_and(|id| !store.requests.iter().any(|r| &r.id == id)) { return Err("Invalid API Tester collection or storage limits exceeded (100 requests, 30 collections, 30 history entries).".into()); }
    Ok(())
}
fn sanitize_store(store: &mut Store) -> Result<(), String> {
    for saved in &mut store.requests { sanitize(&mut saved.request)?; }
    for history in &mut store.history {
        sanitize(&mut history.request)?;
        // History retains request configuration, never transient values or response bodies.
        history.request.body.clear(); history.request.body_secret = true;
        for row in history.request.headers.iter_mut().chain(history.request.params.iter_mut()).chain(history.request.form.iter_mut()) { row.value.clear(); row.secret = true; }
        history.method = history.request.method.clone();
        let mut url = validate_url(&history.request.url).map_err(|_| "Invalid request history URL.")?;
        for row in history.request.params.iter().filter(|row| row.enabled && !row.key.is_empty()) { url.query_pairs_mut().append_pair(&row.key, ""); }
        history.url = url.to_string();
    } Ok(())
}
#[tauri::command]
pub async fn api_tester_load(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String) -> Result<Store, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = STORAGE_LOCK.lock().map_err(|_| "Storage unavailable.")?;
        read_store(&project_path(&app, &project_id)?, &project_id)
    }).await.map_err(|_| "API Tester storage task failed.")?
}
#[tauri::command]
pub async fn api_tester_save(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, store: Store) -> Result<Store, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || save_store(&app, &project_id, store)).await.map_err(|_| "API Tester storage task failed.")?
}
fn save_store(app: &tauri::AppHandle, project_id: &str, mut store: Store) -> Result<Store, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Storage unavailable.")?;
    let path = project_path(app, project_id)?; validate_store(&store, project_id)?;
    if read_store(&path, project_id)?.revision != store.revision { return Err("API Tester storage changed. Reopen API Tester before saving. Your current draft remains in memory.".into()); }
    sanitize_store(&mut store)?;
    store.revision = store.revision.checked_add(1).ok_or("Storage revision overflow.")?;
    let data = serde_json::to_vec(&store).map_err(|_| "Could not serialize API Tester configuration.")?;
    if data.len() as u64 > STORAGE_LIMIT { return Err("API Tester storage exceeds 4 MiB. Remove unused requests.".into()); }
    let directory = path.parent().ok_or("Invalid storage location.")?;
    std::fs::create_dir_all(directory).map_err(|_| "Could not create API Tester storage directory.")?;
    let temp = path.with_extension(format!("{}.tmp", crate::project_storage::new_id("api-")?));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "Could not create API Tester temporary file.")?;
        file.write_all(&data).and_then(|_| file.sync_all()).map_err(|_| "Could not write API Tester storage.")?; drop(file);
        #[cfg(windows)] {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
            let wide = |p: &std::path::Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            if unsafe { MoveFileExW(wide(&temp).as_ptr(), wide(&path).as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err("Could not replace API Tester storage. Previous data remains intact.".into()); }
        }
        #[cfg(not(windows))] std::fs::rename(&temp, &path).map_err(|_| "Could not replace API Tester storage.")?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); } result?; Ok(store)
}

/// Bounded read-only discovery input, using the saved-root and reparse guards.
#[tauri::command]
pub async fn api_tester_source(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, path: String) -> Result<String, String> {
    main_only(&window)?;
    if !["py", "js", "mjs", "cjs", "ts"].iter().any(|extension| path.ends_with(&format!(".{extension}"))) { return Err("Unsupported discovery source.".into()); }
    if path.split('/').any(|part| part.starts_with('.') || ["node_modules", "dist", "build", "target", "vendor", "venv", "__pycache__"].contains(&part)) { return Err("Excluded discovery path.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let (target, _guards) = crate::quick_editor::resolve(&app, &project_id, &expected_root, &path, false)?;
        let (_file, text, _) = crate::quick_editor::open_text_limit(&target, 128 * 1024)?;
        Ok(text)
    }).await.map_err(|_| "Discovery read failed.")?
}
