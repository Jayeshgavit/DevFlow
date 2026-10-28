//! Shared provider contracts for catalogs, chat and explicit compatibility checks.
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

pub fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|_| "Could not create the provider connection.".into())
}
pub fn completion_url(provider: &str) -> &'static str {
    if provider == "openrouter" { "https://openrouter.ai/api/v1/chat/completions" }
    else { "https://integrate.api.nvidia.com/v1/chat/completions" }
}
pub fn catalog_url(provider: &str) -> &'static str {
    if provider == "openrouter" { "https://openrouter.ai/api/v1/models/user" }
    else { "https://integrate.api.nvidia.com/v1/models" }
}
pub fn request(client: &reqwest::Client, provider: &str, key: &str, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
    let request = client.request(method, url).bearer_auth(key.trim()).header("User-Agent", "DevFlow/0.1.0");
    if provider == "openrouter" { request.header("HTTP-Referer", "https://devflow.local").header("X-Title", "DevFlow") }
    else { request }
}
pub async fn body(response: reqwest::Response, cap: usize) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Provider response was interrupted.")?;
        if bytes.len() + chunk.len() > cap { return Err("Provider response exceeded its safety limit.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Provider returned an unreadable response.".into())
}

#[derive(Debug)]
pub struct Failure { pub message: String, pub unavailable: bool, pub retry_after: Option<u64> }
pub fn error(provider: &str, http: u16, value: &Value, retry: Option<u64>) -> Failure {
    let err = &value["error"];
    let code = err["code"].as_u64().or_else(|| err["code"].as_str().and_then(|s|s.parse().ok()))
        .filter(|n| (400..600).contains(n)).unwrap_or(http as u64) as u16;
    // Provider bodies may echo source or credentials. Inspect only; emit fixed explanations.
    let source = err["metadata"]["limit_source"].as_str().unwrap_or("");
    let text = err["message"].as_str().or_else(|| value["detail"].as_str()).or_else(||value["message"].as_str()).unwrap_or("").to_ascii_lowercase();
    let (message, unavailable) = match (code, source) {
        (402, "openrouter_in_flight_budget") => ("OpenRouter's in-flight spending budget is occupied. Wait for settlement before retrying.", false),
        (402 | 403, "openrouter_key_limit") => ("The OpenRouter API key spending limit is exhausted. Check account limits or raise the key budget.", false),
        (403, "openrouter_guardrail_budget" | "openrouter_workspace_budget") => ("An OpenRouter workspace or guardrail spending budget is exhausted. Check account limits and its reset time.", false),
        (402, _) if text.contains("max_tokens") || err["metadata"]["reason"] == "weight_exceeds_budget" => ("OpenRouter cannot reserve the requested output budget. Lower Response limit/prompt size or add credits; retrying unchanged will not help.", false),
        (402, _) => ("Provider credits are insufficient for this request. Check account limits/balance; changing models does not reset account quotas.", false),
        (401, _) => ("Provider rejected the API key. Verify it in Manage Key.", false),
        (403, _) => ("Provider denied account permissions or a policy/guardrail blocked the request. Check account settings.", false),
        (429, _) => ("Provider rate or request quota reached. Wait for the provider reset; model checks also consume requests. No automatic retry was made.", false),
        (404, _) if provider == "openrouter" => ("OpenRouter has no endpoint matching this model, tools or account routing/privacy settings. Refresh models; check tool support and provider settings.", true),
        (404, _) => ("NVIDIA does not serve this model ID for the current account/endpoint. Refresh the live catalog and select an accessible model; catalog presence alone does not grant access.", true),
        (410, _) => ("This model endpoint has been retired. Refresh the live catalog and select another model.", true),
        (400 | 405 | 422, _) => ("Provider rejected the request parameters or tool schema for this model. Chat-only mode may work; no model was substituted.", true),
        (408 | 504, _) => ("Provider timed out. Availability is unconfirmed; retry later.", false),
        (500..=599, _) => ("Provider is temporarily unavailable or has no matching route. Availability is unconfirmed; retry later.", false),
        _ => ("Provider returned an unsuccessful response. Availability is unconfirmed.", false),
    };
    let retry_after = retry.or(if code == 429 { Some(60) } else { None });
    let suffix = retry_after.map(|seconds|format!(" Retry after at least {seconds} seconds.")).unwrap_or_default();
    Failure { message: format!("HTTP {code}: {message}{suffix}"), unavailable, retry_after }
}
pub fn retry_after(response: &reqwest::Response) -> Option<u64> {
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    response.headers().get("Retry-After").and_then(|v|v.to_str().ok()).and_then(|v|retry_seconds(v,now))
}
fn retry_seconds(value:&str, now:u64) -> Option<u64> {
    if let Ok(seconds)=value.trim().parse::<u64>() {return Some(seconds.min(86400));}
    // RFC 9110 also permits an IMF-fixdate HTTP date. No new date dependency needed.
    let p:Vec<_>=value.split_whitespace().collect();
    if p.len()!=6 || p[5]!="GMT" {return None;}
    let day=p[1].parse::<i64>().ok()?;
    let month=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].iter().position(|m|*m==p[2])? as i64+1;
    let year=p[3].parse::<i64>().ok()?;
    let time:Vec<_>=p[4].split(':').map(str::parse::<i64>).collect::<Result<_,_>>().ok()?;
    if !(1970..=9999).contains(&year) || !(1..=31).contains(&day) || time.len()!=3 || !(0..24).contains(&time[0]) || !(0..60).contains(&time[1]) || !(0..60).contains(&time[2]) {return None;}
    let y=year-i64::from(month<=2); let era=y/400; let yoe=y-era*400;
    let mp=month+if month>2{-3}else{9};
    let doy=(153*mp+2)/5+day-1; let doe=yoe*365+yoe/4-yoe/100+doy;
    let days=era*146097+doe-719468;
    let timestamp=days*86400+time[0]*3600+time[1]*60+time[2];
    Some((timestamp.max(0) as u64).saturating_sub(now).min(86400))
}
pub async fn response_error(provider: &str, response: reqwest::Response) -> Failure {
    let code=response.status().as_u16(); let retry=retry_after(&response);
    let value=body(response,32*1024).await.unwrap_or(Value::Null);
    error(provider,code,&value,retry)
}

// No speculative model-specific extras. Tool routing is explicit and shared by checks/chat.
pub fn configure(payload: &mut Value, provider: &str, research: bool) {
    if provider == "nvidia-nim" && matches!(payload["model"].as_str(),Some("openai/gpt-oss-20b" | "openai/gpt-oss-120b")) {
        payload["reasoning_effort"]=json!("low");
    }
    if research {
        payload["tools"] = crate::quick_editor::research::tools();
        payload["tool_choice"] = json!("auto");
        if provider == "openrouter" { payload["provider"] = json!({"require_parameters":true}); }
    }
    // Optional temperature is omitted by default: some reasoning endpoints reject it.
}

pub fn catalog(provider: &str, value: &Value) -> Result<Vec<crate::ai_chat::AiModelInfo>, String> {
    let rows=value["data"].as_array().ok_or("Provider returned an invalid model catalog; no fallback list was substituted.")?;
    if rows.len()>2000 {return Err("Model catalog exceeds the 2,000-entry bound.".into());}
    let mut models=Vec::new(); let mut seen=std::collections::HashSet::new();
    for row in rows {
        let Some(id)=row["id"].as_str().filter(|id|!id.is_empty() && id.len()<=256 && !id.chars().any(char::is_control)) else {continue;};
        if !seen.insert(id.to_string()) {continue;}
        let lower=id.to_ascii_lowercase();
        // NVIDIA's discovery endpoint mixes task families; these are not chat endpoints.
        if provider=="nvidia-nim" && ["embed","rerank","reward","parse","nemoguard","safety","detector","nvclip","gliner","deplot","ising-calibration"].iter().any(|s|lower.contains(s)) {continue;}
        if let Some(outputs)=row["architecture"]["output_modalities"].as_array() {
            if !outputs.iter().any(|v|v=="text") {continue;}
        }
        let supports_tools=row["supported_parameters"].as_array().map(|params|params.iter().any(|p|p=="tools"));
        let zero=|field:&str|row["pricing"][field].as_str().and_then(|s|s.parse::<f64>().ok()).is_some_and(|n|n==0.0);
        let is_free=if provider=="openrouter" {Some(zero("prompt") && zero("completion") && row["pricing"]["request"].as_str().is_none_or(|v|v.parse::<f64>().is_ok_and(|n|n==0.0)))}else{None};
        models.push(crate::ai_chat::AiModelInfo {
            id:id.into(), name:row["name"].as_str().unwrap_or(id).chars().take(200).collect(),
            context_length:row["context_length"].as_u64().and_then(|n|u32::try_from(n).ok()),
            description:row["description"].as_str().map(|s|s.chars().take(500).collect()),
            supports_tools, is_free, is_default:false,
        });
    }
    if provider == "nvidia-nim" {
        if let Some(preferred) = models.iter_mut().find(|m| m.id == "nvidia/nemotron-3.5-bolt-e4b") { preferred.is_default = true; }
    }
    models.sort_by(|a,b| b.is_default.cmp(&a.is_default).then_with(|| b.is_free.cmp(&a.is_free)).then_with(||b.supports_tools.cmp(&a.supports_tools)).then_with(||a.name.cmp(&b.name)));
    if models.is_empty() {return Err("No text/chat candidates were returned by the live provider catalog. No fallback models were substituted.".into());}
    Ok(models)
}

pub fn account_summary(value: &Value) -> Result<String,String> {
    let data=value.get("data").filter(|v|v.is_object()).ok_or("OpenRouter returned invalid account details.")?;
    let mut parts=vec!["OpenRouter key verified (this does not verify a model).".to_string()];
    if let Some(n)=data["limit_remaining"].as_f64().filter(|n|n.is_finite()) {parts.push(format!("Key spending allowance remaining: ${n:.4}."));}
    else {parts.push("No per-key spending cap reported; account balance may still limit requests.".into());}
    if let (Some(remaining),Some(limit))=(data["free_model_daily_requests"]["remaining"].as_u64(),data["free_model_daily_requests"]["limit"].as_u64()) {
        parts.push(format!("Free-model daily requests remaining: {remaining}/{limit} (provider-reported)."));
    }
    if let Some(n)=data["effective_budget"]["remaining_usd"].as_f64().filter(|n|n.is_finite()) {parts.push(format!("Effective spending budget remaining: ${n:.4}."));}
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_catalog_filters_non_chat_and_never_injects_old_models() {
        let v=json!({"data":[{"id":"nvidia/embed-test"},{"id":"openai/gpt-oss-20b"},{"id":"other/chat"}]});
        let m=catalog("nvidia-nim",&v).unwrap();assert_eq!(m.len(),2);assert!(m.iter().any(|m|m.id=="openai/gpt-oss-20b" && !m.is_default));
        assert!(catalog("nvidia-nim",&json!({"data":[]})).is_err());
    }
    #[test]
    fn openrouter_metadata_keeps_free_and_tool_support_distinct_from_availability() {
        let v=json!({"data":[{"id":"a","pricing":{"prompt":"0","completion":"0"},"supported_parameters":["tools"]},{"id":"b","supported_parameters":[]}]});
        let m=catalog("openrouter",&v).unwrap();assert_eq!(m[0].is_free,Some(true));assert_eq!(m[0].supports_tools,Some(true));assert_eq!(m[1].supports_tools,Some(false));
    }
    #[test]
    fn errors_distinguish_budget_rate_routing_and_retirement_without_echoing_data() {
        let e=error("openrouter",402,&json!({"error":{"metadata":{"limit_source":"openrouter_in_flight_budget"}}}),Some(20));
        assert!(!e.unavailable);assert_eq!(e.retry_after,Some(20));assert!(e.message.contains("settlement"));
        assert!(error("nvidia-nim",410,&Value::Null,None).unavailable);
        assert!(error("nvidia-nim",404,&Value::Null,None).message.contains("current account"));
        let e=error("openrouter",200,&json!({"error":{"code":429,"message":"secret-user-content"}}),None);
        assert_eq!(e.retry_after,Some(60));assert!(!e.message.contains("secret-user-content"));
    }
    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(retry_seconds("60",100),Some(60));
        assert_eq!(retry_seconds("Thu, 01 Jan 1970 00:02:00 GMT",100),Some(20));
        assert_eq!(retry_seconds("invalid",100),None);
    }
}
