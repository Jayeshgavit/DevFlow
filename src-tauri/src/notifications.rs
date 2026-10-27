use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DiagnosticKind { PortConflict, LogCollection }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceDiagnostic<'a> { project_id: &'a str, service_id: &'a str, kind: DiagnosticKind }

pub(crate) fn diagnostic(app: &tauri::AppHandle, project: &str, service: &str, kind: DiagnosticKind) {
    let _ = app.emit("service-diagnostic", ServiceDiagnostic { project_id: project, service_id: service, kind });
}

// Only explicit bind diagnostics qualify. A port number or arbitrary stderr is insufficient.
pub(crate) fn reports_port_conflict(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    text.contains("eaddrinuse") || text.contains("address already in use")
        || text.contains("only one usage of each socket address")
}

#[derive(Default)]
pub(crate) struct DesktopAlerts(std::sync::Mutex<Option<std::time::Instant>>);

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), tauri_plugin_notification::Error> {
    let handle = app.clone();
    app.notification().on_action(move |action| {
        if let Some(id) = action.notification().and_then(|notification| notification.extra().get("incidentId")).and_then(|id| id.as_str()) {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = handle.emit("notification-open", id);
        }
    })
}

/// No caller-controlled content reaches the lock screen. Delivery errors return to the in-app center.
#[tauri::command]
pub(crate) fn show_desktop_notification(app: tauri::AppHandle, incident_id: String) -> Result<(), String> {
    if incident_id.len() != 36 || !incident_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("Invalid incident identifier".into());
    }
    let state = app.state::<DesktopAlerts>();
    let mut last = state.0.lock().map_err(|_| "Desktop notifications unavailable")?;
    if last.is_some_and(|time| time.elapsed() < std::time::Duration::from_secs(10)) { return Ok(()); }
    *last = Some(std::time::Instant::now());
    app.notification().builder().title("DevFlow needs your attention")
        .body("A workspace incident was recorded. Open DevFlow notifications to review related logs.")
        .extra("incidentId", incident_id)
        .show().map_err(|_| "Windows could not display the notification. Check notification settings.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_explicit_port_conflict_evidence() {
        for message in ["Error: listen EADDRINUSE: address already in use :::3000", "Only one usage of each socket address is normally permitted"] {
            assert!(reports_port_conflict(message));
        }
        for message in ["stderr: server listening on port 3000", "connection refused", "Port unavailable: access denied", "no output", "error: invalid token"] {
            assert!(!reports_port_conflict(message));
        }
    }
}
