use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CredentialStatus {
    pub provider: String,
    pub has_key: bool,
    pub masked: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TestConnectionResult {
    pub provider: String,
    pub success: bool,
    pub message: String,
}

pub fn normalize_provider(provider: &str) -> Result<&'static str, String> {
    match provider.trim().to_lowercase().as_str() {
        "openrouter" => Ok("openrouter"),
        "nvidia-nim" | "nvidia_nim" | "nvidia" => Ok("nvidia-nim"),
        other => Err(format!("Unsupported AI provider: {other}")),
    }
}

pub fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    let len = trimmed.len();
    if len <= 8 {
        return "••••••••".to_string();
    }
    let prefix_len = if trimmed.starts_with("sk-or-v1-") {
        9
    } else if trimmed.starts_with("sk-") {
        3
    } else if trimmed.starts_with("nvapi-") {
        6
    } else {
        3.min(len / 4)
    };
    let prefix = &trimmed[..prefix_len];
    let suffix = &trimmed[len - 4..];
    format!("{prefix}••••{suffix}")
}

#[cfg(windows)]
fn target_name(provider: &str) -> Result<String, String> {
    let normalized = normalize_provider(provider)?;
    match normalized {
        "openrouter" => Ok("DevFlow/ai_key/openrouter".to_string()),
        "nvidia-nim" => Ok("DevFlow/ai_key/nvidia_nim".to_string()),
        _ => Err("Invalid provider".to_string()),
    }
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let target = target_name(provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if key.len() > 1024 {
        return Err("API key exceeds maximum length (1024 bytes)".to_string());
    }

    let wide_target = to_wide(&target);
    let mut wide_username = to_wide(provider);
    let mut blob = key.as_bytes().to_vec();

    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: wide_target.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: wide_username.as_mut_ptr(),
    };

    let result = unsafe { CredWriteW(&credential, 0) };
    if result == 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("Windows Credential Manager save failed: {err}"));
    }
    Ok(())
}

#[cfg(windows)]
pub fn get_api_key(provider: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = target_name(provider)?;
    let wide_target = to_wide(&target);
    let mut credential_ptr: *mut CREDENTIALW = std::ptr::null_mut();

    let result = unsafe {
        CredReadW(
            wide_target.as_ptr(),
            CRED_TYPE_GENERIC,
            0,
            &mut credential_ptr,
        )
    };

    if result == 0 {
        let err = std::io::Error::last_os_error();
        // 1168 is ERROR_NOT_FOUND
        if err.raw_os_error() == Some(1168) {
            return Ok(None);
        }
        return Err(format!("Windows Credential Manager read failed: {err}"));
    }

    if credential_ptr.is_null() {
        return Ok(None);
    }

    let cred = unsafe { &*credential_ptr };
    let slice = unsafe {
        std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
    };
    let key = String::from_utf8(slice.to_vec())
        .map_err(|e| format!("Stored credential encoding invalid: {e}"))?;

    unsafe {
        CredFree(credential_ptr as *const _);
    }

    Ok(Some(key))
}

#[cfg(windows)]
pub fn delete_api_key(provider: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = target_name(provider)?;
    let wide_target = to_wide(&target);

    let result = unsafe { CredDeleteW(wide_target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if result == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(1168) {
            return Err(format!("Windows Credential Manager delete failed: {err}"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_api_key(_provider: &str, _key: &str) -> Result<(), String> {
    Err("Secure credential storage is only available on Windows".to_string())
}

#[cfg(not(windows))]
pub fn get_api_key(_provider: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn delete_api_key(_provider: &str) -> Result<(), String> {
    Ok(())
}

pub fn get_credential_status(provider: &str) -> Result<CredentialStatus, String> {
    let norm = normalize_provider(provider)?;
    let maybe_key = get_api_key(norm)?;
    match maybe_key {
        Some(key) => Ok(CredentialStatus {
            provider: norm.to_string(),
            has_key: true,
            masked: Some(mask_key(&key)),
        }),
        None => Ok(CredentialStatus {
            provider: norm.to_string(),
            has_key: false,
            masked: None,
        }),
    }
}

