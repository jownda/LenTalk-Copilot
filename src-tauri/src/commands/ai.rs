use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::database;
use crate::ai::providers::build_default_providers;
use crate::ai::providers::openai_compat::OpenAICompatibleProvider;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderHttpResponseDto {
    pub status: u16,
    pub body: String,
    pub body_base64: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProviderStreamEventDto {
    pub kind: String,
    pub status: Option<u16>,
    pub chunk_base64: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: serde_json::Value,
}

#[derive(Debug)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    status: String,
    resumable: bool,
    external_task_id: Option<String>,
    external_task_meta_json: Option<String>,
    result: Option<String>,
    error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn request_explicitly_uses_async_mode(extra_params: Option<&HashMap<String, Value>>) -> bool {
    extra_params
        .and_then(|params| params.get("request_mode"))
        .and_then(|value| value.as_str())
        .map(|value| value.eq_ignore_ascii_case("async"))
        .unwrap_or(false)
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = database::open(app)?;
    ensure_generation_jobs_table(&conn)?;
    Ok(conn)
}

fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          status,
          resumable,
          external_task_id,
          external_task_meta_json,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            job_id,
            provider_id,
            status,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            external_task_meta_json,
            result,
            error,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

fn mark_generation_job_resumable(
    app: &AppHandle,
    job_id: &str,
    external_task_id: &str,
    external_task_meta_json: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = 'running',
          resumable = 1,
          external_task_id = ?1,
          external_task_meta_json = ?2,
          updated_at = ?3
        WHERE job_id = ?4
        "#,
        params![external_task_id, external_task_meta_json, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to mark generation job resumable: {}", e))?;
    Ok(())
}

fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1 WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

fn get_generation_job(app: &AppHandle, job_id: &str) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              status,
              resumable,
              external_task_id,
              external_task_meta_json,
              result,
              error
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            status: row.get(2)?,
            resumable: row.get::<_, i64>(3)? != 0,
            external_task_id: row.get(4)?,
            external_task_meta_json: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(record: &GenerationJobRecord) -> GenerationJobStatusDto {
    GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .or_else(|| {
            // 自定义平台(custom:<id>)统一由 openai-compatible provider 处理
            if provider.starts_with("custom:") {
                registry.get_provider("openai-compatible")
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    // 自定义平台(custom:<id>):按子平台标识存储 key
    if provider.starts_with("custom:") {
        return resolved_provider
            .set_api_key_for(provider.as_str(), api_key)
            .await
            .map_err(|error| error.to_string());
    }

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

/// 仅验证自定义平台 Base URL 是否可达(不需要 API Key)
#[tauri::command]
pub async fn verify_provider_url(base_url: String) -> Result<serde_json::Value, String> {
    let status = OpenAICompatibleProvider::check_url_reachable(&base_url)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "ok": status < 500,
        "status": status,
    }))
}

/// 测试自定义平台连通性并检测协议(带 Key 调 /v1/models)
#[tauri::command]
pub async fn test_provider_connection(
    base_url: String,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let models = OpenAICompatibleProvider::fetch_openai_models(&base_url, &api_key)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "protocol": "openai",
        "models": models,
        "count": models.len(),
    }))
}

/// 从自定义平台拉取模型列表(OpenAI 兼容 /v1/models)
#[tauri::command]
pub async fn fetch_provider_models(
    base_url: String,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let models = OpenAICompatibleProvider::fetch_openai_models(&base_url, &api_key)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "models": models,
        "count": models.len(),
    }))
}

#[tauri::command]
pub async fn chat_completion(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessageDto>,
) -> Result<String, String> {
    let mapped: Vec<(String, serde_json::Value)> = messages
        .into_iter()
        .map(|message| (message.role, message.content))
        .collect();
    OpenAICompatibleProvider::chat_completion(&base_url, &api_key, &model, &mapped)
        .await
        .map_err(|error| error.to_string())
}

/// Probe only metadata/capability endpoints. This command never submits a
/// generation task, so protocol detection cannot create a billable job.
#[tauri::command]
pub async fn detect_provider_capabilities(
    base_url: String,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let normalized_base_url = base_url.trim().trim_end_matches('/').trim_end_matches("/v1").trim_end_matches('/');
    if normalized_base_url.is_empty() {
        return Err("Base URL 为空".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Failed to build probe client: {}", error))?;
    let mut models_request = client.get(format!("{}/v1/models", normalized_base_url));
    if !api_key.trim().is_empty() {
        models_request = models_request.bearer_auth(api_key.trim());
    }
    let models_response = models_request
        .send()
        .await
        .map_err(|error| format!("/v1/models 探测失败: {}", error))?;
    let models_status = models_response.status().as_u16();
    if !models_response.status().is_success() {
        return Err(format!(
            "/v1/models 探测返回 HTTP {} {}",
            models_status,
            models_response.status().canonical_reason().unwrap_or("")
        ));
    }
    let models_payload: serde_json::Value = models_response
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let models = models_payload
        .get("data")
        .and_then(|value| value.as_array())
        .map(|items| {
            items.iter().filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(str::to_string)).collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let is_known_openai_images = {
        let normalized = base_url
            .trim()
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        normalized == "https://www.fhl.mom"
            || normalized == "https://fhl.mom"
            || normalized == "https://sub-proxy-us.65535.space"
    };

    async fn options_status(client: &reqwest::Client, url: String, api_key: &str) -> u16 {
        let mut request = client.request(reqwest::Method::OPTIONS, url);
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        request.send().await.map(|response| response.status().as_u16()).unwrap_or(0)
    }

    let (images_status, responses_status, chat_status, videos_status) = if is_known_openai_images {
        // 已知平台的图片链路由协议确定，不向 Chat/视频端点发探测请求。
        (0, 0, 0, 0)
    } else {
        tokio::join!(
            options_status(&client, format!("{}/v1/images/generations", normalized_base_url), &api_key),
            options_status(&client, format!("{}/v1/responses", normalized_base_url), &api_key),
            options_status(&client, format!("{}/v1/chat/completions", normalized_base_url), &api_key),
            options_status(&client, format!("{}/v1/videos/generations", normalized_base_url), &api_key),
        )
    };
    let has_gpt_image = models.iter().any(|model| model.to_ascii_lowercase().contains("gpt-image"));
    // OPTIONS is often handled by a gateway-wide CORS middleware, so its
    // status is diagnostic only. 当某协议端点可明确访问(非 404)时优先推断:
    // chat/responses 均不可用或全部不可用时回退 generic images 低置信默认。
    fn probe_available(status: u16) -> bool {
        status != 0 && status != 404
    }
    let image_protocol = if is_known_openai_images {
        "images"
    } else if probe_available(chat_status) && !probe_available(images_status) {
        "chat"
    } else if probe_available(responses_status) && !probe_available(images_status) {
        "responses"
    } else {
        "images"
    };
    let image_reference_field = if is_known_openai_images {
        "image"
    } else if has_gpt_image {
        "input_image"
    } else {
        "image"
    };
    let image_reference_encoding = if is_known_openai_images {
        "data_url"
    } else if has_gpt_image {
        "raw_base64"
    } else {
        "data_url"
    };

    Ok(serde_json::json!({
        "ok": models_status < 500,
        "models_status": models_status,
        "models": models,
        "endpoints": {
            "images": { "path": "/v1/images/generations", "options_status": images_status },
            "responses": { "path": "/v1/responses", "options_status": responses_status },
            "chat": { "path": "/v1/chat/completions", "options_status": chat_status },
            "videos": { "path": "/v1/videos/generations", "options_status": videos_status },
        },
        "capabilities": {
            "detectedAt": now_ms(),
            "detectionSource": "probe",
            "confidence": if is_known_openai_images { "high" } else { "low" },
            "imageProtocol": image_protocol,
            "imageReferenceField": image_reference_field,
            "imageReferenceEncoding": image_reference_encoding,
            "imageTransport": if is_known_openai_images { "generations_json" } else { "unknown" },
            "videoSubmitPath": "/v1/videos/generations",
            "videoQueryPath": "/v1/videos/generations/{taskId}",
            "videoReferenceEncoding": "data_url",
            "taskProtocol": "generic",
        },
    }))
}

/// Execute a generic JSON request through the desktop HTTP client.
/// WebView fetch is unavailable for providers that do not enable CORS, while
/// this command keeps the request protocol identical on macOS and Windows.
#[tauri::command]
pub async fn request_provider_json(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<Value>,
    response_encoding: Option<String>,
) -> Result<ProviderHttpResponseDto, String> {
    let parsed_url = reqwest::Url::parse(url.trim())
        .map_err(|error| format!("Invalid provider URL: {}", error))?;
    let http_method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|error| format!("Invalid provider HTTP method: {}", error))?;

    // Prompt compilation/final delivery can legitimately take several minutes.
    // Keep this aligned with the frontend response window while retaining a
    // finite bound for a provider that never completes the request.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut request = client.request(http_method, parsed_url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(json_body) = body {
        request = request.json(&json_body);
    }

    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {}", error))?;
    let status = response.status().as_u16();
    // Keep the bytes already received when a streaming Chat Completions
    // response is cut short. The frontend can then ask the model to continue
    // from that exact partial response instead of starting from zero.
    let mut response_bytes = Vec::new();
    let mut response_read_error = None;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                response_bytes.extend_from_slice(&chunk);
                // Streaming chat gateways may send SSE [DONE] and leave the
                // connection open for heartbeats. Stop at the protocol
                // completion marker so the desktop UI cannot wait forever.
                if response_bytes.windows(b"data: [DONE]".len()).any(|window| window == b"data: [DONE]") {
                    break;
                }
            },
            Ok(None) => break,
            Err(error) => {
                response_read_error = Some(error.to_string());
                break;
            }
        }
    }
    if let Some(error) = response_read_error {
        if status >= 200 && status < 300 && !response_bytes.is_empty() {
            return Ok(ProviderHttpResponseDto {
                status,
                body: if response_encoding.as_deref() == Some("base64") {
                    String::new()
                } else {
                    String::from_utf8_lossy(&response_bytes).into_owned()
                },
                body_base64: (response_encoding.as_deref() == Some("base64"))
                    .then(|| STANDARD.encode(&response_bytes)),
            });
        }
        return Err(format!("Failed to read provider response: {}", error));
    }
    let encode_base64 = response_encoding.as_deref() == Some("base64");
    Ok(ProviderHttpResponseDto {
        status,
        body: if encode_base64 {
            String::new()
        } else {
            String::from_utf8_lossy(&response_bytes).into_owned()
        },
        body_base64: encode_base64.then(|| STANDARD.encode(&response_bytes)),
    })
}

/// Upload one reference asset through the native desktop HTTP client.
/// The API requires multipart/form-data and cannot accept a local path or
/// data URL in a video request.
#[tauri::command]
pub async fn request_provider_multipart(
    url: String,
    headers: HashMap<String, String>,
    field_name: String,
    filename: String,
    content_type: String,
    body_base64: String,
) -> Result<ProviderHttpResponseDto, String> {
    let parsed_url = reqwest::Url::parse(url.trim())
        .map_err(|error| format!("Invalid provider URL: {}", error))?;
    let bytes = STANDARD
        .decode(body_base64.trim())
        .map_err(|error| format!("Invalid multipart body: {}", error))?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&content_type)
        .map_err(|error| format!("Invalid multipart content type: {}", error))?;
    let form = reqwest::multipart::Form::new().part(field_name, part);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut request = client.post(parsed_url).multipart(form);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Provider multipart request failed: {}", error))?;
    let status = response.status().as_u16();
    let response_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read provider multipart response: {}", error))?;
    Ok(ProviderHttpResponseDto {
        status,
        body: String::from_utf8_lossy(&response_bytes).into_owned(),
        body_base64: None,
    })
}

/// Stream an OpenAI-compatible response to the webview one chunk at a time.
/// This is intentionally a small transport primitive: parsing SSE, tracking
/// received text, and deciding whether to resume remain frontend concerns.
#[tauri::command]
pub async fn request_provider_stream(
    app: AppHandle,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<Value>,
    event_name: String,
) -> Result<(), String> {
    let emit = |event: &str,
                status: Option<u16>,
                chunk_base64: Option<String>,
                message: Option<String>| {
        app.emit(
            event_name.as_str(),
            ProviderStreamEventDto {
                kind: event.to_string(),
                status,
                chunk_base64,
                message,
            },
        )
        .map_err(|error| format!("Failed to emit provider stream event: {}", error))
    };

    let parsed_url = reqwest::Url::parse(url.trim())
        .map_err(|error| format!("Invalid provider URL: {}", error))?;
    let http_method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|error| format!("Invalid provider HTTP method: {}", error))?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut request = client.request(http_method, parsed_url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(json_body) = body {
        request = request.json(&json_body);
    }

    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Provider request failed: {}", error);
            let _ = emit("error", None, None, Some(message.clone()));
            return Err(message);
        }
    };
    let status = response.status().as_u16();
    emit("start", Some(status), None, None)?;

    let mut response_tail = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                response_tail.extend_from_slice(&chunk);
                emit("chunk", Some(status), Some(STANDARD.encode(&chunk)), None)?;
                if response_tail
                    .windows(b"data: [DONE]".len())
                    .any(|window| window == b"data: [DONE]")
                {
                    break;
                }
                // Keep only enough tail to detect a marker split across HTTP
                // chunks without retaining the whole model response twice.
                let keep = b"data: [DONE]".len().saturating_sub(1);
                if response_tail.len() > keep {
                    let drain_count = response_tail.len() - keep;
                    response_tail.drain(..drain_count);
                }
            }
            Ok(None) => break,
            Err(error) => {
                let message = format!("Failed to read provider response: {}", error);
                emit("error", Some(status), None, Some(message.clone()))?;
                return Err(message);
            }
        }
    }

    emit("done", Some(status), None, None)?;
    Ok(())
}

#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("Submitting generation job with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .cloned()
        .ok_or_else(|| "Provider not found".to_string())?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    let job_id = Uuid::new_v4().to_string();
    let provider_id = provider.name().to_string();

    // Only opt into an upstream resumable task when the request explicitly
    // asks for async mode. A provider may implement submit_task for both
    // modes, but its sync fallback would otherwise block this command until
    // the image request completes.
    let explicit_async = request_explicitly_uses_async_mode(req.extra_params.as_ref());

    insert_generation_job(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        "running",
        false,
        None,
        None,
        None,
        None,
    )?;
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.insert(job_id.clone());
    }

    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    let spawned_provider = provider.clone();
    let use_resumable_provider_task = explicit_async && provider.supports_task_resume();
    tauri::async_runtime::spawn(async move {
        let update_result = if use_resumable_provider_task {
            let submission = tokio::time::timeout(
                Duration::from_secs(30 * 60),
                spawned_provider.submit_task(req),
            )
            .await
            .map_err(|_| AIError::TaskFailed("generation timed out after 30 minutes".to_string()))
            .and_then(|result| result);

            match submission {
                Ok(ProviderTaskSubmission::Succeeded(image_source)) => update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "succeeded",
                    Some(image_source.as_str()),
                    None,
                ),
                Ok(ProviderTaskSubmission::Queued(handle)) => {
                    let meta_json = handle
                        .metadata
                        .as_ref()
                        .and_then(|value| serde_json::to_string(value).ok());
                    mark_generation_job_resumable(
                        &app_handle,
                        spawned_job_id.as_str(),
                        handle.task_id.as_str(),
                        meta_json.as_deref(),
                    )
                }
                Err(error) => {
                    let message = error.to_string();
                    update_generation_job(
                        &app_handle,
                        spawned_job_id.as_str(),
                        "failed",
                        None,
                        Some(message.as_str()),
                    )
                }
            }
        } else {
            let result = tokio::time::timeout(
                Duration::from_secs(30 * 60),
                spawned_provider.generate(req),
            )
            .await
            .map_err(|_| AIError::TaskFailed("generation timed out after 30 minutes".to_string()))
            .and_then(|result| result);
            match result {
                Ok(image_source) => update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "succeeded",
                    Some(image_source.as_str()),
                    None,
                ),
                Err(error) => {
                    let message = error.to_string();
                    update_generation_job(
                        &app_handle,
                        spawned_job_id.as_str(),
                        "failed",
                        None,
                        Some(message.as_str()),
                    )
                }
            }
        };
        if let Err(error) = update_result {
            info!("Failed to update generation job: {}", error);
        }
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(spawned_job_id.as_str());
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
        });
    };

    if record.status == "succeeded" || record.status == "failed" {
        return Ok(dto_from_record(&record));
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&record));
        }

        let interrupted_message = "应用退出时任务中断，可从节点重试".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(interrupted_message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(interrupted_message);
        return Ok(dto_from_record(&record));
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .cloned()
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&record));
    };

    let task_meta = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    match provider
        .poll_task(ProviderTaskHandle {
            task_id,
            metadata: task_meta,
        })
        .await
    {
        Ok(ProviderTaskPollResult::Running) => {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            Ok(dto_from_record(&record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(image_source),
                error: None,
            })
        }
        Ok(ProviderTaskPollResult::Failed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
            })
        }
        Err(AIError::TaskFailed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
            })
        }
        Err(error) => Ok(GenerationJobStatusDto {
            job_id: record.job_id,
            status: "running".to_string(),
            result: None,
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    provider.generate(req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}

#[cfg(test)]
mod tests {
    use super::request_explicitly_uses_async_mode;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn image_jobs_are_sync_by_default() {
        assert!(!request_explicitly_uses_async_mode(None));
        assert!(!request_explicitly_uses_async_mode(Some(&HashMap::new())));
        assert!(!request_explicitly_uses_async_mode(Some(&HashMap::from([
            ("request_mode".to_string(), json!("sync")),
        ]))));
    }

    #[test]
    fn image_jobs_accept_explicit_async_mode_case_insensitively() {
        assert!(request_explicitly_uses_async_mode(Some(&HashMap::from([
            ("request_mode".to_string(), json!("async")),
        ]))));
        assert!(request_explicitly_uses_async_mode(Some(&HashMap::from([
            ("request_mode".to_string(), json!("ASYNC")),
        ]))));
    }

    #[test]
    fn non_string_request_mode_does_not_enable_async_jobs() {
        assert!(!request_explicitly_uses_async_mode(Some(&HashMap::from([
            ("request_mode".to_string(), json!(true)),
        ]))));
    }
}
