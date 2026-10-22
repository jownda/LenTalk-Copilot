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
use crate::ai::providers::video_protocols::is_retryable_submit_failure;
use crate::ai::{
    AIProvider, GenerateRequest, GenerateVideoRequest, ProviderRegistry, ProviderTaskHandle,
    ProviderTaskPollResult, ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

/// 「请求还没送达平台」的在飞表 —— 只有在这个窗口里取消才拦得住。
///
/// 每个在飞的视频提交挂一个 watch 通道。`cancel_generate_video_job` 把值置 `true`
/// (或直接把 sender 摘掉), 提交侧的 `select!` 就放弃继续等 provider: 底层 HTTP 请求
/// 随 future 一起被丢弃, 平台收不到完整请求, 不会建任务、不会计费。
///
/// provider 一返回(平台受理 / 拿到 task_id), 表项立刻移除 —— 前端轮询看到
/// `cancelable: false`, 「取消生成」入口随之消失。
///
/// **只在内存里**: 应用重启后拦不住上一个进程已经发出的请求, 这与事实一致, 不能让
/// 落库状态撒谎说"还能取消"。
static VIDEO_JOB_CANCEL_SENDERS: std::sync::OnceLock<
    Arc<RwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
> = std::sync::OnceLock::new();

/// 取消成功后落在任务表 `error` 列上的说明。前端按 `status == "canceled"` 自己出文案,
/// 这条主要是给日志与排查用的。
const VIDEO_JOB_CANCELED_MESSAGE: &str = "已取消生成（请求未送达模型平台）";

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

fn video_job_cancel_senders(
) -> &'static Arc<RwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>> {
    VIDEO_JOB_CANCEL_SENDERS.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

/// 这个任务现在还能不能取消(请求还没送达平台)。
async fn video_job_is_cancelable(job_id: &str) -> bool {
    video_job_cancel_senders().read().await.contains_key(job_id)
}

/// 等「用户取消」信号。sender 被显式摘除(取消命令的正常路径)同样算取消。
async fn wait_video_job_cancel(rx: &mut tokio::sync::watch::Receiver<bool>) {
    let already_canceled = *rx.borrow();
    if already_canceled {
        return;
    }
    // sender 被丢弃时 `changed()` 返回 Err —— 那正是"取消命令把表项摘了"的情形。
    let _ = rx.changed().await;
}

/// 视频任务的「任务类别」标识 —— 落在 `ai_generation_jobs.provider_id` 上。
///
/// 它**不是**注册表里的 provider 名: 视频与图片共用同一个 OpenAI 兼容 provider
/// (`submit_generate_video_job` 取的就是 `openai-compatible`)。查任务表时必须先
/// 归一化, 见 `resolve_job_provider`。
const VIDEO_JOB_PROVIDER_ID: &str = "video-openai-compatible";

/// 提交视频任务遇到**平台侧抖动**时的最大尝试次数。
///
/// 3 次(首次 + 2 次重试、退避 1s / 3s)是针对中转平台 5xx/429 的经验值: 够吃掉一次
/// 瞬时抖动, 又不至于让用户在明显故障时白等太久。**只有平台回过话的错误才算抖动**
/// (判据见 `video_protocols::is_retryable_submit_failure`), 纯网络层错误不重试。
const VIDEO_SUBMIT_MAX_ATTEMPTS: usize = 3;

/// 提交重试的退避时长。抖动通常是秒级的, 不必指数增长。
fn video_submit_retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(if attempt <= 1 { 1_000 } else { 3_000 })
}

/// 把任务表里的 `provider_id` 解析成注册表中的 provider。
///
/// 为什么必须归一化: 视频任务行落的是 `video-openai-compatible`, 而注册表里只有
/// `openai-compatible`。直接 `get_provider(record.provider_id)` 会返回 None, 于是
/// **每一次续查都在这里报错** —— 前端 observer 把这次 IPC 失败当成"临时故障"
/// 吞掉后 2 秒重试, 结果是提交之后一次成功轮询都不会发生: 任务状态永远停在
/// `running`(库里 `updated_at == created_at` 就是它的指纹)、界面永远转圈, 而平台
/// 侧照跑照计费, 成片永久收不回。(实测 2026-09-23 的知鸟任务即为此因。)
fn resolve_job_provider(provider_id: &str) -> Option<Arc<dyn AIProvider>> {
    let registry = get_registry();
    if let Some(provider) = registry.get_provider(provider_id) {
        return Some(Arc::clone(provider));
    }
    let registry_name = match provider_id {
        VIDEO_JOB_PROVIDER_ID => "openai-compatible",
        _ => return None,
    };
    registry.get_provider(registry_name).map(Arc::clone)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub image_count: Option<u32>,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateVideoRequestDto {
    pub prompt: String,
    pub model: String,
    pub duration: u32,
    pub aspect_ratio: String,
    pub video_resolution: Option<String>,
    pub image_mode: Option<String>,
    pub reference_images: Option<Vec<String>>,
    pub reference_audio: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    /// `true` ⇒ 这次 `error` 只是**诊断文本**(查询时的网络抖动 / 5xx / 平台回话慢),
    /// 平台任务仍在跑, 前端必须继续轮询。
    ///
    /// 为什么需要这个字段: 前端曾拿 `error` 的文本做子串匹配, 而诊断文本
    /// `binghuo-video 查询失败(网络): error sending request for url (...)` 里带着
    /// 「失败」二字 ⇒ 一次网络抖动就把已计费、已跑到 14 分钟的长任务判死, 并清掉
    /// job id —— 平台照跑照计费, 成片永久收不回(2026-09-23 11:53 实证)。
    /// 只有后端知道「这个 Err 是可重试的」, 所以由后端显式声明, 前端不再猜。
    #[serde(default)]
    pub transient: bool,
    /// `true` ⇒ 这次提交的请求**还没送到平台**, 此刻 `cancel_generate_video_job` 能拦住。
    ///
    /// 视频任务一旦被平台受理(拿到 task_id 开始出片), 中止只会丢掉已经计费的结果,
    /// 所以那时必须回落成 `false` —— 前端据此收掉「取消生成」入口。判据是后端的
    /// 在飞表(`VIDEO_JOB_CANCEL_SENDERS`), 前端不猜。
    #[serde(default)]
    pub cancelable: bool,
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
        transient: false,
        cancelable: false,
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
    //
    // ⚠️ 这里**不加** `read_timeout`: 非流式响应在生成结束前一个字节都不发,
    // 加了短读超时会把正常的长生成直接掐断。空闲判死只对 `request_provider_stream`
    // 有意义(流式响应本该持续吐字节)。连接阶段的超时对两者都安全。
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .timeout(PROVIDER_TOTAL_TIMEOUT)
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
    fields: Option<HashMap<String, String>>,
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
    let mut form = reqwest::multipart::Form::new().part(field_name, part);
    for (key, value) in fields.unwrap_or_default() {
        form = form.text(key, value);
    }
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

/// 建立连接的上限。中转平台挂死时通常卡在 TCP/TLS 阶段, 20 秒足够区分。
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 流式响应"连续多久没有任何字节"判死。
///
/// 为什么需要它: 部分中转渠道的 TCP 连接一直活着却再也不吐数据, 只有 15 分钟总超时
/// 兜底的话, 前端「提示词工作室 → 生成提示词」会一直停在「生成中…」, 用户只能干等,
/// 也分不清是模型在长考还是渠道死了。健康渠道的首字节通常在几秒内到达。
const PROVIDER_STREAM_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// 单次请求的硬上限, 给合法的长提示词生成留足时间。
const PROVIDER_TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        // 流式响应必须能及时发现"管道还在、上游已经不给数据"的渠道。
        // 只靠 15 分钟总超时的话, 前端会一直停在「生成中…」, 用户只能干等。
        .read_timeout(PROVIDER_STREAM_READ_TIMEOUT)
        .timeout(PROVIDER_TOTAL_TIMEOUT)
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
            // 区分"连不上 / 等不到响应头"与普通失败。前者是渠道挂死最常见的样子,
            // 报错要让用户知道是网络侧超时而不是提示词有问题。
            let message = if error.is_connect() {
                format!(
                    "无法连接上游（{} 秒内未建立连接），请检查网络或更换渠道：{}",
                    PROVIDER_CONNECT_TIMEOUT.as_secs(),
                    error
                )
            } else if error.is_timeout() {
                format!(
                    "等待上游响应超时（{} 秒内没有收到响应头），已中断，可重试",
                    PROVIDER_TOTAL_TIMEOUT.as_secs()
                )
            } else {
                format!("Provider request failed: {}", error)
            };
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
                // read_timeout 命中的就是「渠道挂死」: TCP 还在, 上游一个字都不给。
                // 这种情况必须尽快失败, 否则按钮会一直停在「生成中…」。
                let message = if error.is_timeout() {
                    format!(
                        "上游 {} 秒没有返回任何数据，已中断，可重试",
                        PROVIDER_STREAM_READ_TIMEOUT.as_secs()
                    )
                } else {
                    format!("Failed to read provider response: {}", error)
                };
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
        image_count: request.image_count,
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

/// 将通用 OpenAI 兼容视频请求交给 Tauri 后端执行。命令立即返回本地任务 ID，
/// 结果由 get_generate_video_job 查询；这样画布切换、节点卸载不会取消平台任务。
#[tauri::command]
pub async fn submit_generate_video_job(
    app: AppHandle,
    request: GenerateVideoRequestDto,
) -> Result<String, String> {
    if !request.model.starts_with("custom:") {
        return Err("视频生成仅支持自定义平台(custom:*)模型".to_string());
    }
    let provider = get_registry()
        .get_provider("openai-compatible")
        .cloned()
        .ok_or_else(|| "OpenAI compatible provider not found".to_string())?;
    let job_id = Uuid::new_v4().to_string();
    insert_generation_job(&app, &job_id, VIDEO_JOB_PROVIDER_ID, "running", false, None, None, None, None)?;
    active_non_resumable_job_ids().write().await.insert(job_id.clone());

    let native_request = GenerateVideoRequest {
        prompt: request.prompt,
        model: request.model,
        duration: request.duration,
        aspect_ratio: request.aspect_ratio,
        video_resolution: request.video_resolution,
        image_mode: request.image_mode,
        reference_images: request.reference_images,
        reference_audio: request.reference_audio,
        extra_params: request.extra_params,
    };
    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    // 可恢复通道: 提交后立刻把平台 task_id 与查询元数据落库, 本地任务随即结束。
    // 这样应用重启后 get_generate_video_job 仍能凭 task_id 续查到成片, 而不是把
    // 仍在平台生成(且已计费)的任务判成「中断」逼用户重新提交、二次扣费。
    let use_resumable_video_task = provider.supports_video_task_resume();
    // 打开「可取消窗口」: 从这一刻到 provider 返回为止, 用户取消都能真的拦住请求。
    // 必须在 spawn 之前建表 —— 命令的用户可能比任务轮询还快。
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    video_job_cancel_senders()
        .write()
        .await
        .insert(spawned_job_id.clone(), cancel_tx);
    tauri::async_runtime::spawn(async move {
        let mut cancel_rx = cancel_rx;
        let update = if use_resumable_video_task {
            // 平台侧抖动(5xx / 408 / 429)时重试提交。实机 2026-09-23 13:49 炳火提交返回
            // HTTP 503「服务暂时不可用，请稍后重试」—— 提交侧原先对任何 Err 都直接落
            // failed, 用户只能重提; 而重提要重新上传素材, 还可能二次扣费。
            //
            // 只重试「平台回过话的服务端抖动」(`is_retryable_submit_failure`),
            // 纯网络层错误不重试: 请求可能已经送达并被计费。
            let mut attempt = 0usize;
            let mut submission = Err(AIError::TaskFailed("视频任务提交未执行".to_string()));
            let mut canceled_by_user = false;
            while attempt < VIDEO_SUBMIT_MAX_ATTEMPTS {
                attempt += 1;
                // `biased;` 让"真实结果"优先被检查: 请求已经返回就绝不能被同时到达的
                // 取消信号抢走 —— 那会把平台已经建好(且已计费)的任务丢掉, 成片永久
                // 收不回。只有在请求确实还没完成时, 取消才生效(future 被丢弃 ⇒
                // 底层 HTTP 请求中断 ⇒ 平台收到的是残缺请求, 不会建任务)。
                tokio::select! {
                    biased;
                    outcome = tokio::time::timeout(
                        Duration::from_secs(30 * 60),
                        provider.submit_video_task(native_request.clone()),
                    ) => {
                        submission = outcome
                            .map_err(|_| AIError::TaskFailed("视频任务提交超时(30 分钟)".to_string()))
                            .and_then(|result| result);
                    }
                    _ = wait_video_job_cancel(&mut cancel_rx) => {
                        canceled_by_user = true;
                        break;
                    }
                }
                match &submission {
                    Err(error)
                        if attempt < VIDEO_SUBMIT_MAX_ATTEMPTS
                            && is_retryable_submit_failure(error) =>
                    {
                        let delay = video_submit_retry_delay(attempt);
                        info!(
                            "视频提交遇到平台侧抖动(第 {} 次尝试), {}ms 后进行第 {} 次尝试: {}",
                            attempt,
                            delay.as_millis(),
                            attempt + 1,
                            error
                        );
                        tokio::time::sleep(delay).await;
                    }
                    _ => break,
                }
            }
            if canceled_by_user {
                info!("视频任务 {} 在送达平台前被用户取消", spawned_job_id);
                update_generation_job(
                    &app_handle,
                    &spawned_job_id,
                    "canceled",
                    None,
                    Some(VIDEO_JOB_CANCELED_MESSAGE),
                )
            } else {
                // 重试过的瞬时错误不再以 `Provider error: …` 的形式抛给用户(那是内部措辞),
                // 换成一条直的说明, 并注明重试过几次。
                let submission = match submission {
                    Err(AIError::Provider(message)) => Err(AIError::TaskFailed(if attempt > 1 {
                        format!("{}（平台侧抖动，已自动重试 {} 次仍失败）", message, attempt - 1)
                    } else {
                        message
                    })),
                    other => other,
                };
                match submission {
                    Ok(ProviderTaskSubmission::Succeeded(video_url)) => {
                        update_generation_job(&app_handle, &spawned_job_id, "succeeded", Some(&video_url), None)
                    }
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
                        update_generation_job(&app_handle, &spawned_job_id, "failed", None, Some(message.as_str()))
                    }
                }
            }
        } else {
            let mut canceled_by_user = false;
            let mut result = Err(AIError::TaskFailed("视频任务提交未执行".to_string()));
            // 同样的取舍: `biased;` 先看真实结果, 只有请求确实还没完成时取消才生效。
            tokio::select! {
                biased;
                outcome = provider.generate_video(native_request) => {
                    result = outcome;
                }
                _ = wait_video_job_cancel(&mut cancel_rx) => {
                    canceled_by_user = true;
                }
            }
            if canceled_by_user {
                info!("视频任务 {} 在送达平台前被用户取消", spawned_job_id);
                update_generation_job(
                    &app_handle,
                    &spawned_job_id,
                    "canceled",
                    None,
                    Some(VIDEO_JOB_CANCELED_MESSAGE),
                )
            } else {
                match result {
                    Ok(video_url) => update_generation_job(&app_handle, &spawned_job_id, "succeeded", Some(&video_url), None),
                    Err(error) => update_generation_job(&app_handle, &spawned_job_id, "failed", None, Some(&error.to_string())),
                }
            }
        };
        if let Err(error) = update { info!("Failed to update video generation job: {}", error); }
        // 关掉「可取消窗口」: provider 已返回(平台受理)或任务已结束, 再取消只会丢掉
        // 已经计费的结果。摘表后前端下一次轮询就会拿到 `cancelable: false`。
        video_job_cancel_senders().write().await.remove(&spawned_job_id);
        active_non_resumable_job_ids().write().await.remove(&spawned_job_id);
    });
    Ok(job_id)
}

#[tauri::command]
pub async fn get_generate_video_job(app: AppHandle, job_id: String) -> Result<GenerationJobStatusDto, String> {
    // 视频任务与图片共用同一套任务表, 但可恢复任务的续查通道不同: 视频必须走
    // poll_video_task, 否则拿图片的轮询实现去查视频 task_id 只会得到错误。
    let mut dto = get_generation_job_status(app, job_id.clone(), true).await?;
    // 「取消生成」只在请求还没送达平台时有意义 —— 判据完全由后端的在飞表说了算,
    // 前端不猜。任务一被平台受理(或已结束), 这里就是 false, 取消入口随之消失。
    dto.cancelable = dto.status == "running" && video_job_is_cancelable(job_id.as_str()).await;
    Ok(dto)
}

/// 中止一次**还没送达平台**的视频任务。
///
/// 返回 `"canceled"` 表示确实拦下来了(提交侧会在 provider 调用前放弃等待, 请求随
/// future 一起中断); 返回 `"too_late"` 表示平台已经受理或任务已结束 —— 调用方必须
/// 据此收掉取消入口, **不能谎报成功**, 否则用户以为取消了、平台照跑照计费。
#[tauri::command]
pub async fn cancel_generate_video_job(job_id: String) -> Result<String, String> {
    let sender = video_job_cancel_senders()
        .read()
        .await
        .get(job_id.as_str())
        .cloned();
    let Some(sender) = sender else {
        return Ok("too_late".to_string());
    };
    // 摘表 + 置位双保险: 提交侧 `changed()` 在"收到 true"和"sender 被丢弃"两种情况下
    // 都会立刻返回, 无论它此刻落在哪一个分支上都能拦下来。
    video_job_cancel_senders().write().await.remove(job_id.as_str());
    let _ = sender.send(true);
    info!("视频任务 {} 的取消请求被接受(请求尚未送达平台)", job_id);
    Ok("canceled".to_string())
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    get_generation_job_status(app, job_id, false).await
}

/// 生成任务状态的统一读取实现。`video` 决定可恢复任务走哪条 provider 续查通道。
async fn get_generation_job_status(
    app: AppHandle,
    job_id: String,
    video: bool,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            transient: false,
            cancelable: false,
        });
    };

    // `canceled` 同样是终态: 漏掉它会导致下面「非可恢复任务 + 不在在飞表」的分支把
    // 刚刚取消掉的任务改写成「应用退出时任务中断」。
    if record.status == "succeeded" || record.status == "failed" || record.status == "canceled" {
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

    let provider = match resolve_job_provider(record.provider_id.as_str()) {
        Some(provider) => provider,
        None => {
            // 前端 observer 会把这次 IPC 失败当成"临时故障"吞掉并无限重试, 所以这里
            // 必须留下后端日志 —— 否则「平台生成完了却一直卡在生成界面」将毫无线索。
            tracing::warn!(
                "Generation job {} references unknown provider '{}'; polling cannot continue",
                record.job_id,
                record.provider_id
            );
            return Err(format!("Provider not found for job: {}", record.provider_id));
        }
    };

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

    let handle = ProviderTaskHandle {
        task_id,
        metadata: task_meta,
    };
    let poll_result = if video {
        provider.poll_video_task(handle).await
    } else {
        provider.poll_task(handle).await
    };

    match poll_result {
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
                transient: false,
                cancelable: false,
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
                transient: false,
                cancelable: false,
            })
        }
        Err(AIError::TaskFailed(message))
        | Err(AIError::InvalidRequest(message))
        | Err(AIError::TaskNotFound(message))
        | Err(AIError::ModelNotSupported(message)) => {
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
                transient: false,
                cancelable: false,
            })
        }
        // 可重试错误(网络抖动 / 5xx / 平台回话慢): 任务保持 running, 交给下一轮轮询。
        // `transient: true` 是给前端的硬信号 —— 这里 `error` 装的是诊断文本, 前端
        // 不得据此判定终态(文本里可能带「失败」「timeout」等词, 那是我们自己的措辞)。
        Err(error) => Ok(GenerationJobStatusDto {
            job_id: record.job_id,
            status: "running".to_string(),
            result: None,
            error: Some(error.to_string()),
            transient: true,
            cancelable: false,
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
        image_count: request.image_count,
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
    use super::{
        cancel_generate_video_job, request_explicitly_uses_async_mode, resolve_job_provider,
        video_job_cancel_senders, video_job_is_cancelable, wait_video_job_cancel,
        VIDEO_JOB_PROVIDER_ID,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::Duration;
    use uuid::Uuid;

    /// 视频任务行落的是「任务类别」`video-openai-compatible`, 注册表里只有
    /// `openai-compatible`。这条归一化缺失时, 每一次视频续查都会在这里返回 None,
    /// 表现为「平台生成完了但软件一直卡在生成界面」。
    #[test]
    fn video_job_provider_alias_resolves_to_openai_compatible() {
        let resolved = resolve_job_provider(VIDEO_JOB_PROVIDER_ID)
            .expect("video 任务类别必须能解析到 provider");
        assert_eq!(resolved.name(), "openai-compatible");
        assert!(resolve_job_provider("openai-compatible").is_some());
    }

    #[test]
    fn unknown_job_provider_is_rejected() {
        assert!(resolve_job_provider("not-a-provider").is_none());
        assert!(resolve_job_provider("video-not-registered").is_none());
    }

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

    // ------------------------------------------------------------------
    // 「可取消窗口」
    //
    // 产品要求: 请求还没送到平台时可以取消, 平台一受理按钮就消失。后端这一侧的关键
    // 性质只有两条 —— **取消必须立刻叫醒等待中的提交**(否则按下去要等 provider 自己
    // 超时, 那是 30 分钟), 以及**窗口关掉之后不能再谎报取消成功**。
    // ------------------------------------------------------------------

    fn unique_job_id(prefix: &str) -> String {
        format!("{prefix}-{}", Uuid::new_v4())
    }

    #[tokio::test]
    async fn cancel_command_wakes_the_pending_submit_immediately() {
        let job_id = unique_job_id("cancel-test");
        let (sender, receiver) = tokio::sync::watch::channel(false);
        video_job_cancel_senders()
            .write()
            .await
            .insert(job_id.clone(), sender);
        assert!(video_job_is_cancelable(job_id.as_str()).await);

        // 提交侧正在 provider 调用上等待。
        let pending = tokio::spawn(async move {
            let mut receiver = receiver;
            wait_video_job_cancel(&mut receiver).await;
        });

        assert_eq!(cancel_generate_video_job(job_id.clone()).await.unwrap(), "canceled");
        // 窗口立刻关闭 —— 前端下一次轮询就会拿到 `cancelable: false` 并收掉按钮。
        assert!(!video_job_is_cancelable(job_id.as_str()).await);
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("取消必须立刻唤醒等待中的提交, 而不是等 provider 自己超时")
            .unwrap();
    }

    #[tokio::test]
    async fn second_cancel_attempt_is_too_late() {
        let job_id = unique_job_id("cancel-twice");
        let (sender, _receiver) = tokio::sync::watch::channel(false);
        video_job_cancel_senders()
            .write()
            .await
            .insert(job_id.clone(), sender);

        assert_eq!(cancel_generate_video_job(job_id.clone()).await.unwrap(), "canceled");
        // 第二次必须回 too_late: 调用方据此收掉入口, 不能重复告诉用户"已取消"。
        assert_eq!(cancel_generate_video_job(job_id).await.unwrap(), "too_late");
    }

    #[tokio::test]
    async fn cancel_command_reports_too_late_for_jobs_outside_the_window() {
        // 从没登记过的任务(平台已受理 / 应用重启后上个进程的任务): 必须如实回 too_late。
        assert_eq!(
            cancel_generate_video_job(unique_job_id("unknown")).await.unwrap(),
            "too_late"
        );
    }

    #[tokio::test]
    async fn waiter_returns_immediately_when_already_canceled() {
        let (_sender, mut receiver) = tokio::sync::watch::channel(true);
        tokio::time::timeout(Duration::from_secs(1), wait_video_job_cancel(&mut receiver))
            .await
            .expect("已经取消过的任务不该让等待侧再挂住");
    }

    #[tokio::test]
    async fn dropping_the_sender_also_wakes_the_waiter() {
        // 提交流水线正常收尾时会把表项摘掉(sender 被丢弃) —— 等待侧不能因此永久挂住。
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        drop(sender);
        tokio::time::timeout(Duration::from_secs(1), wait_video_job_cancel(&mut receiver))
            .await
            .expect("sender 被丢弃也必须唤醒等待侧");
    }

    #[tokio::test]
    async fn cancel_survives_concurrent_requests_for_distinct_jobs() {
        let first = unique_job_id("cancel-a");
        let second = unique_job_id("cancel-b");
        let (first_sender, _first_receiver) = tokio::sync::watch::channel(false);
        let (second_sender, _second_receiver) = tokio::sync::watch::channel(false);
        {
            let mut senders = video_job_cancel_senders().write().await;
            senders.insert(first.clone(), first_sender);
            senders.insert(second.clone(), second_sender);
        }

        assert_eq!(cancel_generate_video_job(first.clone()).await.unwrap(), "canceled");
        // 取消 A 不能顺手把 B 的窗口也关掉(连点会同时挂多个下游任务)。
        assert!(video_job_is_cancelable(second.as_str()).await);
        assert_eq!(cancel_generate_video_job(second.clone()).await.unwrap(), "canceled");
    }
}
