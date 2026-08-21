use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
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

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
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
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

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
        .no_proxy()
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

    async fn options_status(client: &reqwest::Client, url: String, api_key: &str) -> u16 {
        let mut request = client.request(reqwest::Method::OPTIONS, url);
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        request.send().await.map(|response| response.status().as_u16()).unwrap_or(0)
    }

    let (images_status, responses_status, chat_status, videos_status) = tokio::join!(
        options_status(&client, format!("{}/v1/images/generations", normalized_base_url), &api_key),
        options_status(&client, format!("{}/v1/responses", normalized_base_url), &api_key),
        options_status(&client, format!("{}/v1/chat/completions", normalized_base_url), &api_key),
        options_status(&client, format!("{}/v1/videos/generations", normalized_base_url), &api_key),
    );
    let has_gpt_image = models.iter().any(|model| model.to_ascii_lowercase().contains("gpt-image"));
    // OPTIONS is often handled by a gateway-wide CORS middleware, so its
    // status is diagnostic only. 当某协议端点可明确访问(非 404)时优先推断:
    // chat/responses 均不可用或全部不可用时回退 generic images 低置信默认。
    fn probe_available(status: u16) -> bool {
        status != 0 && status != 404
    }
    let image_protocol = if probe_available(chat_status) && !probe_available(images_status) {
        "chat"
    } else if probe_available(responses_status) && !probe_available(images_status) {
        "responses"
    } else {
        "images"
    };
    let image_reference_field = if has_gpt_image { "input_image" } else { "image" };
    let image_reference_encoding = if has_gpt_image { "raw_base64" } else { "data_url" };

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
            "confidence": "low",
            "imageProtocol": image_protocol,
            "imageReferenceField": image_reference_field,
            "imageReferenceEncoding": image_reference_encoding,
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
) -> Result<ProviderHttpResponseDto, String> {
    let parsed_url = reqwest::Url::parse(url.trim())
        .map_err(|error| format!("Invalid provider URL: {}", error))?;
    let http_method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|error| format!("Invalid provider HTTP method: {}", error))?;

    let client = reqwest::Client::builder().no_proxy().build().unwrap_or_else(|_| reqwest::Client::new());
    let mut request = client.request(http_method, parsed_url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(json_body) = body {
        request = request.json(&json_body);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {}", error))?;
    let status = response.status().as_u16();
    let response_body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read provider response: {}", error))?;
    Ok(ProviderHttpResponseDto {
        status,
        body: response_body,
    })
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

    if provider.supports_task_resume() {
        match provider.submit_task(req).await.map_err(|e| e.to_string())? {
            ProviderTaskSubmission::Succeeded(image_source) => {
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "succeeded",
                    true,
                    None,
                    None,
                    Some(image_source.as_str()),
                    None,
                )?;
            }
            ProviderTaskSubmission::Queued(handle) => {
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
                    None,
                    None,
                )?;
            }
        }
        return Ok(job_id);
    }

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
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30 * 60),
            spawned_provider.generate(req),
        )
        .await
        .map_err(|_| AIError::TaskFailed("generation timed out after 30 minutes".to_string()))
        .and_then(|result| result);
        let update_result = match result {
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
        };
        if let Err(error) = update_result {
            info!("Failed to update non-resumable generation job: {}", error);
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

        let interrupted_message = "job interrupted by app restart".to_string();
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
