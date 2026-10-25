use std::path::{Path, PathBuf};

pub(crate) fn resolve_program(program: &str, cwd: &Path) -> Result<PathBuf, String> {
    let program = program.trim();
    if program.is_empty() { return Err("Enter an executable before starting this service.".into()); }
    if program.contains('"') || program.contains('\0') {
        return Err("Executable must be a path or command name, without quotes.".into());
    }
    let requested = Path::new(program);
    if requested.is_absolute() || requested.components().count() > 1 {
        let path = if requested.is_absolute() { requested.to_path_buf() } else { cwd.join(requested) };
        return find_file(&path).ok_or_else(|| format!("Executable '{}' was not found. Check the service command and working directory.", program));
    }
    #[cfg(windows)]
    let extensions: &[&str] = &["exe", "com", "cmd", "bat", "ps1"];
    #[cfg(not(windows))]
    let extensions: &[&str] = &[];
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    resolve_on_path(program, &path_var, extensions).ok_or_else(|| format!("Executable '{}' was not found on DevFlow's PATH. Install it or enter its full path, then restart DevFlow if PATH changed.", program))
}

fn resolve_on_path(program: &str, path_var: &std::ffi::OsStr, extensions: &[&str]) -> Option<PathBuf> {
    let requested = Path::new(program);
    for folder in std::env::split_paths(path_var) {
        let candidate = folder.join(program);
        if requested.extension().is_none() {
            for extension in extensions {
                let candidate = folder.join(format!("{program}.{extension}"));
                if let Some(found) = find_file(&candidate) { return Some(found); }
            }
        }
        if let Some(found) = find_file(&candidate) { return Some(found); }
    }
    None
}

fn find_file(path: &Path) -> Option<PathBuf> {
    if path.is_file() { Some(path.to_path_buf()) }
    else if path.extension().is_none() {
        #[cfg(windows)]
        for extension in ["exe", "com", "cmd", "bat", "ps1"] {
            let candidate = path.with_extension(extension);
            if candidate.is_file() { return Some(candidate); }
        }
        None
    } else { None }
}

#[cfg(windows)]
pub(crate) fn script_kind(path: &Path) -> Result<&'static str, String> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "exe" | "com" => Ok("native"),
        "cmd" | "bat" => Ok("batch"),
        "ps1" => Ok("powershell"),
        _ => Err(format!("Unsupported Windows executable type: {}. Use .exe, .com, .cmd, .bat, or .ps1.", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_program_is_actionable() {
        let error = resolve_program("devflow-command-that-does-not-exist", Path::new(".")).unwrap_err();
        assert!(error.contains("PATH"));
    }

    #[cfg(windows)]
    #[test]
    fn finds_windows_launchers_on_path() {
        let root = std::env::temp_dir().join(format!("devflow-launcher-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("sample.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(root.join("script.ps1"), "Write-Output test\r\n").unwrap();
        std::fs::write(root.join("sample"), "shim").unwrap();
        // Avoid changing PATH across parallel tests: use explicit paths for extension behavior.
        let path = std::env::join_paths([&root]).unwrap();
        assert_eq!(resolve_on_path("sample", &path, &["exe", "cmd", "ps1"]).unwrap().extension().unwrap(), "cmd");
        assert_eq!(resolve_program(root.join("script").to_str().unwrap(), &root).unwrap().extension().unwrap(), "ps1");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn batch_launcher_preserves_spaced_argument() {
        let root = std::env::temp_dir().join(format!("devflow spaced launcher {}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("echo-arg.cmd");
        std::fs::write(&script, "@echo off\r\necho ARG:%~1\r\n").unwrap();
        let output = std::process::Command::new(&script).arg("hello world").current_dir(&root).output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("ARG:hello world"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn harmless_service_streams_and_stops() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let root = std::env::temp_dir().join(format!("devflow smoke service {}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("service.cmd");
        std::fs::write(&script, "@echo off\r\necho READY\r\necho WARN 1>&2\r\npowershell.exe -NoProfile -NonInteractive -Command Start-Sleep -Seconds 10\r\n").unwrap();
        let executable = resolve_program(script.to_str().unwrap(), &root).unwrap();
        let mut child = Command::new(executable).current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let pid = child.id();
        let mut stdout = String::new();
        let mut stderr = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut stdout).unwrap();
        BufReader::new(child.stderr.take().unwrap()).read_line(&mut stderr).unwrap();
        assert!(stdout.contains("READY"));
        assert!(stderr.contains("WARN"));
        let stopped = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"]).output().unwrap();
        assert!(stopped.status.success(), "{}", String::from_utf8_lossy(&stopped.stderr));
        assert!(!child.wait().unwrap().success());
        std::fs::remove_dir_all(root).unwrap();
    }
}
