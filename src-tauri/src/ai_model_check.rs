//! Explicit, small provider probes. Never sends project data or executes returned tools.
use crate::{ai_chat::AiChatState, ai_credentials::{get_api_key, normalize_provider}};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::oneshot;

#[derive(Serialize)]
pub struct ModelCheck {
    pub model: String,
    pub status: &'static str,
    pub message: String,
    pub retry_after_seconds: Option<u64>,
    pub stop_batch: bool,
}

fn result(model: &str, status: &'static str, message: &str) -> ModelCheck {
    ModelCheck { model: model.into(), status, message: message.into(), retry_after_seconds:None, stop_batch:false }
}

fn classify(model: &str, status: u16, body: &Value, research: bool) -> ModelCheck {
    let unknown = |message| result(model, "unknown", message);
    match status {
        401 | 403 => return unknown("Key or account permission rejected; model availability is unconfirmed."),
        402 => return unknown("Insufficient provider credits; model availability is unconfirmed."),
        429 => return unknown("Rate limited. Retry later; this does not mean the model is broken."),
        400 | 404 | 405 | 422 => return result(model, "unavailable", if research {
            "Provider rejected this model or the research tool-call probe. Chat may still work."
        } else { "Provider rejected this model's chat probe for the current account." }),
        200..=299 => {},
        _ => return unknown("Provider could not complete the check. Retry later."),
    }
    if body.get("error").is_some() { return unknown("Provider returned an error instead of a completion."); }
    let choice = &body["choices"][0];
    if choice["finish_reason"] == "length" { return unknown("Small probe output budget reached; result is inconclusive."); }
    if research {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct DirectoryArgs { #[serde(default)] path: String, #[serde(default)] offset: usize }
        let valid = choice["message"]["tool_calls"].as_array().is_some_and(|calls| {
            calls.len() == 1 && calls[0]["type"] == "function"
                && calls[0]["id"].as_str().is_some_and(|id| !id.is_empty())
                && calls[0]["function"]["name"] == "list_directory"
                && calls[0]["function"]["arguments"].as_str().and_then(|args| serde_json::from_str::<DirectoryArgs>(args).ok())
                    .is_some_and(|args| args.path.is_empty() && args.offset == 0)
                && matches!(choice["finish_reason"].as_str(), Some("tool_calls" | "stop"))
        });
        return if valid { result(model, "working", "Streaming research tool-call probe passed. No files were read or tools executed.") }
            else { result(model, "unavailable", "No valid research tool call returned. Chat may still work; try a chat-only check.") };
    }
    if choice["finish_reason"] == "stop" && choice["message"]["content"].as_str().is_some_and(|s| !s.trim().is_empty()) {
        result(model, "working", "Streaming chat probe returned a completed text response. Research was not checked.")
    } else { unknown("No completed text response returned; result is inconclusive.") }
}

#[tauri::command]
pub async fn ai_check_model(
    app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, AiChatState>,
    provider: String, model: String, research: bool,
) -> Result<ModelCheck, String> {
    if !matches!(window.label(), "main" | "quick-editor") { return Err("Model checks are unavailable in this window.".into()); }
    let provider = normalize_provider(&provider)?;
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) { return Err("Select a valid model to check.".into()); }
    let key = get_api_key(provider)?.ok_or("Configure a provider API key first.")?;
    // One check per window, and the existing global request cap. ai_stop_chat can cancel it.
    let request_id = format!("{}:model-check", window.label());
    let (tx, mut rx) = oneshot::channel();
    state.register(request_id.clone(), tx).await?;
    let outcome = tokio::select! {
        _ = &mut rx => Err("Model check cancelled.".to_string()),
        _ = async {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if app.get_webview_window(window.label()).is_none() { break; }
            }
        } => Err("Model check cancelled: window closed.".to_string()),
        value = tokio::time::timeout(Duration::from_secs(45), probe(provider, model, &key, research, &state)) => {
            Ok(value.unwrap_or_else(|_| result(model,"unknown","Check timed out. Model availability is unconfirmed.")))
        }
    };
    state.unregister(&request_id).await;
    outcome
}

async fn probe(provider: &str, model: &str, key: &str, research: bool, state:&AiChatState) -> ModelCheck {
    let unknown = |message| {let mut check=result(model,"unknown",message);check.stop_batch=true;check};
    let client = match crate::ai_provider::client(40) {Ok(client)=>client,Err(_)=>return unknown("Could not create the provider connection.")};
    let mut payload = json!({"model":model,"stream":true,"max_tokens":256,
        "messages":[{"role":"user","content":if research {
            "Compatibility check only. Please call list_directory with path empty and offset 0. Do not answer with prose."
        } else {"Compatibility check only. Reply with OK."}}]});
    crate::ai_provider::configure(&mut payload,provider,research);
    if let Err(message)=state.pace_provider(provider).await {return unknown(&message);}
    let response=match crate::ai_provider::request(&client,provider,key,reqwest::Method::POST,crate::ai_provider::completion_url(provider))
        .header("Accept","text/event-stream").json(&payload).send().await {
        Ok(response)=>response,Err(_)=>return unknown("Network error or timeout; model availability is unconfirmed."),
    };
    if !response.status().is_success() {
        let failure=crate::ai_provider::response_error(provider,response).await;
        state.record_failure(provider,&failure).await;
        return ModelCheck{model:model.into(),status:if failure.unavailable{"unavailable"}else{"unknown"},message:failure.message,retry_after_seconds:failure.retry_after,stop_batch:!failure.unavailable};
    }
    let mut stream=response.bytes_stream(); let mut buffer=Vec::new(); let mut bytes_seen=0;
    let mut turn=crate::ai_chat::ProviderTurn::default();
    'stream: while let Some(chunk)=stream.next().await {
        let chunk=match chunk{Ok(chunk)=>chunk,Err(_)=>return unknown("Provider response was interrupted.")};
        bytes_seen+=chunk.len();
        if bytes_seen>64*1024 {return unknown("Probe response exceeded the 64 KiB safety limit.");}
        buffer.extend_from_slice(&chunk);
        while let Some(pos)=buffer.iter().position(|b|*b==b'\n') {
            let line=match String::from_utf8(buffer.drain(..=pos).collect()) {Ok(s)=>s,Err(_)=>return unknown("Invalid provider UTF-8.")};
            if let Some(data)=line.trim_end().strip_prefix("data:") {
                let data=data.trim();
                if data=="[DONE]" {break 'stream;}
                if let Ok(value)=serde_json::from_str::<Value>(data) {
                    if value.get("error").is_some_and(|e|!e.is_null()) {
                        let failure=crate::ai_provider::error(provider,200,&value,None);
                        state.record_failure(provider,&failure).await;
                        return ModelCheck{model:model.into(),status:if failure.unavailable{"unavailable"}else{"unknown"},message:failure.message,retry_after_seconds:failure.retry_after,stop_batch:!failure.unavailable};
                    }
                }
                if turn.ingest(data).is_err() {return result(model,"unknown","Probe output was incomplete, filtered or malformed. Increase Response limit for real chat; this does not prove the model is broken.");}
            }
        }
    }
    if turn.validate(research).is_err() {return result(model,"unknown","Stream ended without a complete valid response. Availability is unconfirmed.");}
    classify(model,200,&turn.completion(),research)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_requires_a_completed_response_and_does_not_imply_research_support() {
        let body = json!({"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]});
        assert_eq!(classify("m",200,&body,false).status,"working");
        assert_eq!(classify("m",200,&body,true).status,"unavailable");
        assert_eq!(classify("m",200,&json!({}),false).status,"unknown");
    }
    #[test]
    fn credentials_credits_rate_limits_and_provider_failures_are_not_model_failures() {
        for code in [401,402,403,429,500,503] {assert_eq!(classify("m",code,&Value::Null,true).status,"unknown");}
        for code in [400,404,422] {assert_eq!(classify("m",code,&Value::Null,true).status,"unavailable");}
    }
    #[test]
    fn research_probe_requires_valid_allowlisted_arguments_and_complete_output() {
        let mut body = json!({"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{
            "id":"call1","type":"function","function":{"name":"list_directory","arguments":"{\"path\":\"\",\"offset\":0}"}
        }]}}]});
        assert_eq!(classify("m",200,&body,true).status,"working");
        body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = json!("{\"path\":\"../outside\"}");
        assert_eq!(classify("m",200,&body,true).status,"unavailable");
        body["choices"][0]["finish_reason"] = json!("length");
        assert_eq!(classify("m",200,&body,true).status,"unknown");
    }
}
