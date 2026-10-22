use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use super::project_archive::{export_project_bundle, import_project_bundle};
use super::project_state::{upsert_project_record, ProjectRecord};
use crate::database;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

const BAIDU_AUTH_URL: &str = "https://openapi.baidu.com/oauth/2.0/authorize";
const BAIDU_TOKEN_URL: &str = "https://openapi.baidu.com/oauth/2.0/token";
const BAIDU_FILE_API: &str = "https://pan.baidu.com/rest/2.0/xpan/file";
const BAIDU_MULTIMEDIA_API: &str = "https://pan.baidu.com/rest/2.0/xpan/multimedia";
const BAIDU_UPLOAD_URL: &str = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
const BAIDU_USER_API: &str = "https://pan.baidu.com/rest/2.0/xpan/nas";
const BAIDU_CHUNK_SIZE: usize = 4 * 1024 * 1024;
const BAIDU_DEFAULT_FOLDER: &str = "/apps/LenTalk";

const PROVIDER_BAIDU: &str = "baidu";

/// 应用凭据。留空时需要在云空间面板中填写自有开放平台 Client ID / Secret。
const DEFAULT_BAIDU_CLIENT_ID: &str = "";
const DEFAULT_BAIDU_CLIENT_SECRET: &str = "";

struct ProviderConfig {
    display: &'static str,
    setting_key: &'static str,
    default_client_id: &'static str,
    default_client_secret: &'static str,
}

fn provider_config(provider: &str) -> Result<ProviderConfig, String> {
    match provider {
        PROVIDER_BAIDU => Ok(ProviderConfig {
            display: "百度网盘",
            setting_key: "cloud_drive.baidu",
            default_client_id: DEFAULT_BAIDU_CLIENT_ID,
            default_client_secret: DEFAULT_BAIDU_CLIENT_SECRET,
        }),
        _ => Err(format!("不支持的云盘平台: {provider}")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDriveConfig {
    pub provider: String,
    pub client_id: String,
    pub client_secret: String,
    pub account_name: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: i64,
    pub drive_id: Option<String>,
    pub folder_path: Option<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDriveAuthInit {
    pub kind: String,
    pub url: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDriveStatus {
    pub provider: String,
    pub connected: bool,
    pub has_credentials: bool,
    pub account_name: Option<String>,
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUploadSummary {
    pub provider: String,
    pub file_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDriveFileEntry {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
    pub fs_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRestoreSummary {
    pub provider: String,
    pub project_id: String,
    pub project_name: String,
    pub size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudUploadProgress {
    provider: String,
    phase: String,
    percent: u8,
    message: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn load_config(app: &AppHandle, provider: &str) -> Result<Option<CloudDriveConfig>, String> {
    let descriptor = provider_config(provider)?;
    let conn = database::open(app)?;
    match database::get_setting(&conn, descriptor.setting_key)? {
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("云盘配置解析失败: {error}")),
        None => Ok(None),
    }
}

fn save_config(app: &AppHandle, config: &CloudDriveConfig) -> Result<(), String> {
    let descriptor = provider_config(&config.provider)?;
    let conn = database::open(app)?;
    let raw = serde_json::to_string(config).map_err(|error| format!("云盘配置序列化失败: {error}"))?;
    database::put_setting(&conn, descriptor.setting_key, &raw)
}

fn merge_credentials(config: &mut CloudDriveConfig, client_id: &str, client_secret: &str) {
    if !client_id.trim().is_empty() {
        config.client_id = client_id.trim().to_string();
    }
    if !client_secret.trim().is_empty() {
        config.client_secret = client_secret.trim().to_string();
    }
}

fn token_expired(config: &CloudDriveConfig) -> bool {
    now_ms() >= config.expires_at_ms.saturating_sub(60_000)
}

fn status_from_config(config: &CloudDriveConfig) -> CloudDriveStatus {
    CloudDriveStatus {
        provider: config.provider.clone(),
        connected: config_connected(config),
        has_credentials: !config.client_id.trim().is_empty() && !config.client_secret.trim().is_empty(),
        account_name: config.account_name.clone(),
        folder_path: config.folder_path.clone(),
    }
}

fn config_connected(config: &CloudDriveConfig) -> bool {
    !config.access_token.is_empty()
}

fn emit_progress(
    app: &AppHandle,
    provider: &str,
    phase: &str,
    percent: u8,
    message: impl Into<String>,
) {
    let payload = CloudUploadProgress {
        provider: provider.to_string(),
        phase: phase.to_string(),
        percent,
        message: message.into(),
    };
    let _ = app.emit("cloud-upload-progress", payload);
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

async fn baidu_exchange(form: &[(&str, String)]) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(BAIDU_TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|error| format!("百度网盘授权请求失败: {error}"))?;
    let status = response.status();
    let payload: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("百度网盘授权响应解析失败（HTTP {status}）: {error}"))?;
    if let Some(error) = payload.error.as_deref() {
        return Err(format!(
            "百度网盘授权失败: {error} {}",
            payload.error_description.as_deref().unwrap_or("")
        ));
    }
    if payload.access_token.is_empty() {
        return Err(format!("百度网盘授权失败：未返回 access_token（HTTP {status}）"));
    }
    Ok(payload)
}

async fn baidu_exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<TokenResponse, String> {
    baidu_exchange(&[
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("redirect_uri", "oob".to_string()),
    ])
    .await
}

async fn baidu_refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(BAIDU_TOKEN_URL)
        .query(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .send()
        .await
        .map_err(|error| format!("百度网盘刷新令牌请求失败: {error}"))?;
    let status = response.status();
    let payload: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("百度网盘刷新令牌响应解析失败（HTTP {status}）: {error}"))?;
    if let Some(error) = payload.error.as_deref() {
        return Err(format!(
            "百度网盘刷新令牌失败: {error} {}",
            payload.error_description.as_deref().unwrap_or("")
        ));
    }
    Ok(payload)
}

async fn baidu_fetch_account(access_token: &str) -> Option<String> {
    let client = reqwest::Client::new();
    let response = client
        .get(BAIDU_USER_API)
        .query(&[("method", "uinfo"), ("access_token", access_token)])
        .send()
        .await
        .ok()?;
    let payload: serde_json::Value = response.error_for_status().ok()?.json().await.ok()?;
    payload
        .get("netdisk_name")
        .or_else(|| payload.get("baidu_name"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn empty_config(provider: &str) -> Result<CloudDriveConfig, String> {
    let descriptor = provider_config(provider)?;
    Ok(CloudDriveConfig {
        provider: provider.to_string(),
        client_id: descriptor.default_client_id.to_string(),
        client_secret: descriptor.default_client_secret.to_string(),
        account_name: None,
        access_token: String::new(),
        refresh_token: None,
        expires_at_ms: 0,
        drive_id: None,
        folder_path: Some(if provider == PROVIDER_BAIDU {
            BAIDU_DEFAULT_FOLDER.to_string()
        } else {
            String::new()
        }),
        updated_at_ms: now_ms(),
    })
}

async fn exchange_authorization_code(
    app: &AppHandle,
    provider: &str,
    code: &str,
) -> Result<CloudDriveConfig, String> {
    let mut config = load_config(app, provider)?.unwrap_or(empty_config(provider)?);
    if config.client_id.trim().is_empty() || config.client_secret.trim().is_empty() {
        return Err("尚未配置云盘应用凭据，请在云空间面板填写 Client ID 和 Client Secret。".to_string());
    }

    let token = baidu_exchange_code(&config.client_id, &config.client_secret, code).await?;

    config.access_token = token.access_token;
    if token.refresh_token.as_deref().unwrap_or("").is_empty() {
        config.refresh_token = config.refresh_token.clone();
    } else {
        config.refresh_token = token.refresh_token;
    }
    config.expires_at_ms = now_ms() + token.expires_in.unwrap_or(3600).saturating_mul(1000);
    config.updated_at_ms = now_ms();

    config.account_name = baidu_fetch_account(&config.access_token).await;
    if config.folder_path.as_deref().unwrap_or("").is_empty() {
        config.folder_path = Some(BAIDU_DEFAULT_FOLDER.to_string());
    }

    save_config(app, &config)?;
    Ok(config)
}

async fn refresh_token_if_needed(
    app: &AppHandle,
    config: &CloudDriveConfig,
) -> Result<CloudDriveConfig, String> {
    if !token_expired(config) || config.refresh_token.as_deref().unwrap_or("").is_empty() {
        return Ok(config.clone());
    }

    let mut updated = config.clone();
    let token = baidu_refresh(
        &updated.client_id,
        &updated.client_secret,
        updated.refresh_token.as_deref().unwrap_or(""),
    )
    .await?;
    updated.access_token = token.access_token;
    if token.refresh_token.as_deref().unwrap_or("").is_empty() {
        updated.refresh_token = config.refresh_token.clone();
    } else {
        updated.refresh_token = token.refresh_token;
    }
    updated.expires_at_ms = now_ms() + token.expires_in.unwrap_or(3600).saturating_mul(1000);
    updated.updated_at_ms = now_ms();
    save_config(app, &updated)?;
    Ok(updated)
}

#[tauri::command]
pub async fn cloud_drive_begin_authorize(
    app: AppHandle,
    provider: String,
) -> Result<CloudDriveAuthInit, String> {
    let config = load_config(&app, &provider)?.unwrap_or(empty_config(&provider)?);
    if config.client_id.trim().is_empty() || config.client_secret.trim().is_empty() {
        return Err(format!(
            "{} 尚未配置应用凭据，请先在云空间面板填写 Client ID 和 Client Secret。",
            provider_config(&provider)?.display
        ));
    }

    let state = Uuid::new_v4().to_string();
    let (kind, url) = match provider.as_str() {
        PROVIDER_BAIDU => {
            let mut url = reqwest::Url::parse(BAIDU_AUTH_URL)
                .map_err(|error| format!("授权地址生成失败: {error}"))?;
            url.query_pairs_mut()
                .append_pair("response_type", "code")
                .append_pair("client_id", &config.client_id)
                .append_pair("redirect_uri", "oob")
                .append_pair("scope", "netdisk")
                .append_pair("display", "page")
                .append_pair("state", &state);
            ("paste".to_string(), url.to_string())
        }
        _ => return Err(format!("不支持的云盘平台: {provider}")),
    };

    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|error| format!("无法打开授权页面: {error}"))?;

    Ok(CloudDriveAuthInit { kind, url, state })
}

#[tauri::command]
pub async fn cloud_drive_authorize_complete(
    app: AppHandle,
    provider: String,
    code: String,
) -> Result<CloudDriveStatus, String> {
    let config = exchange_authorization_code(&app, &provider, code.trim()).await?;
    Ok(status_from_config(&config))
}

#[tauri::command]
pub fn cloud_drive_status(app: AppHandle, provider: String) -> Result<CloudDriveStatus, String> {
    match load_config(&app, &provider)? {
        Some(config) => Ok(status_from_config(&config)),
        None => Ok(CloudDriveStatus {
            provider,
            connected: false,
            has_credentials: false,
            account_name: None,
            folder_path: None,
        }),
    }
}

#[tauri::command]
pub fn cloud_drive_set_credentials(
    app: AppHandle,
    provider: String,
    client_id: String,
    client_secret: String,
) -> Result<CloudDriveStatus, String> {
    let mut config = load_config(&app, &provider)?.unwrap_or(empty_config(&provider)?);
    merge_credentials(&mut config, &client_id, &client_secret);
    config.updated_at_ms = now_ms();
    save_config(&app, &config)?;
    Ok(status_from_config(&config))
}

#[tauri::command]
pub fn cloud_drive_set_folder(
    app: AppHandle,
    provider: String,
    folder_path: String,
) -> Result<CloudDriveStatus, String> {
    let mut config = load_config(&app, &provider)?
        .ok_or_else(|| "尚未授权，请先完成授权后再设置上传目录。".to_string())?;
    let cleaned = folder_path.trim().trim_matches('/');
    if cleaned.is_empty() {
        return Err("上传目录不能为空。".to_string());
    }
    let normalized = if provider == PROVIDER_BAIDU && !cleaned.starts_with("apps/") {
        format!("/apps/{cleaned}")
    } else {
        format!("/{cleaned}")
    };
    config.folder_path = Some(normalized);
    config.updated_at_ms = now_ms();
    save_config(&app, &config)?;
    Ok(status_from_config(&config))
}

#[tauri::command]
pub fn cloud_drive_disconnect(app: AppHandle, provider: String) -> Result<(), String> {
    let descriptor = provider_config(&provider)?;
    let conn = database::open(&app)?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        rusqlite::params![descriptor.setting_key],
    )
    .map_err(|error| format!("无法清除云盘配置: {error}"))?;
    Ok(())
}

fn temp_upload_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录: {error}"))?
        .join("cloud-uploads");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建上传临时目录: {error}"))?;
    Ok(directory)
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other => other,
        })
        .take(80)
        .collect()
}

fn md5_hex(bytes: &[u8]) -> String {
    format!("{:x}", md5::compute(bytes))
}

fn read_baidu_blocks(path: &PathBuf) -> Result<Vec<(u64, usize)>, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取项目压缩包: {error}"))?;
    let mut blocks = Vec::new();
    let mut offset: u64 = 0;
    let mut buffer = vec![0u8; BAIDU_CHUNK_SIZE];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| format!("读取项目压缩包失败: {error}"))?;
        if size == 0 {
            break;
        }
        blocks.push((offset, size));
        offset += size as u64;
        if size < BAIDU_CHUNK_SIZE {
            break;
        }
    }
    Ok(blocks)
}

fn baidu_error_message(payload: &serde_json::Value) -> String {
    payload
        .get("error_msg")
        .or_else(|| payload.get("err_msg"))
        .or_else(|| payload.get("message"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| payload.to_string())
}

fn baidu_errno(payload: &serde_json::Value) -> i64 {
    payload
        .get("errno")
        .or_else(|| payload.get("error_code"))
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

fn baidu_errno_hint(payload: &serde_json::Value) -> &'static str {
    match baidu_errno(payload) {
        2 => "（参数错误：请确认目录为 /apps/产品名称，产品名称=申请接入时填写的名称；若目录不对，可在云空间面板修改目录后重试）",
        -7 => "（路径不在应用目录下：百度网盘仅允许上传到 /apps/产品名称，请先在云空间面板修改目录）",
        _ => "",
    }
}

async fn upload_to_baidu(
    app: &AppHandle,
    config: &CloudDriveConfig,
    zip_path: &PathBuf,
    file_name: &str,
    size: u64,
) -> Result<CloudUploadSummary, String> {
    let client = reqwest::Client::new();
    let access_token = &config.access_token;
    let folder = config
        .folder_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(BAIDU_DEFAULT_FOLDER)
        .trim_end_matches('/');
    let target_path = format!("{}/{}", folder, sanitize_file_name(file_name));

    emit_progress(app, PROVIDER_BAIDU, "preparing", 8, "正在计算百度网盘分块校验...");
    let blocks = read_baidu_blocks(zip_path)?;
    let mut block_hashes = Vec::with_capacity(blocks.len());
    {
        let mut file = File::open(zip_path).map_err(|error| format!("无法读取项目压缩包: {error}"))?;
        for (offset, block_size) in &blocks {
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(*offset))
                .map_err(|error| format!("跳过数据块失败: {error}"))?;
            let mut buffer = vec![0u8; *block_size];
            file.read_exact(&mut buffer)
                .map_err(|error| format!("读取数据块失败: {error}"))?;
            block_hashes.push(md5_hex(&buffer));
        }
    }
    let block_list_json = serde_json::to_string(&block_hashes)
        .map_err(|error| format!("百度网盘分块列表编码失败: {error}"))?;

    let precreate_response = client
        .post(BAIDU_FILE_API)
        .query(&[("method", "precreate"), ("access_token", access_token)])
        .header("User-Agent", "pan.baidu.com")
        .form(&[
            ("path", target_path.clone()),
            ("size", size.to_string()),
            ("isdir", "0".to_string()),
            ("autoinit", "1".to_string()),
            ("rtype", "1".to_string()),
            ("block_list", block_list_json.clone()),
        ])
        .send()
        .await
        .map_err(|error| format!("百度网盘创建上传任务失败: {error}"))?;
    let precreate_status = precreate_response.status();
    let precreate_payload: serde_json::Value = precreate_response
        .json()
        .await
        .map_err(|error| format!("百度网盘创建上传任务响应解析失败（HTTP {precreate_status}）: {error}"))?;
    if baidu_errno(&precreate_payload) != 0 {
        return Err(format!(
            "百度网盘创建上传任务失败: {}{}",
            baidu_error_message(&precreate_payload),
            baidu_errno_hint(&precreate_payload)
        ));
    }
    let upload_id = precreate_payload
        .get("uploadid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "百度网盘响应中缺少 uploadid。".to_string())?;

    emit_progress(app, PROVIDER_BAIDU, "preparing", 10, "正在获取百度网盘上传节点...");
    let upload_base = baidu_locate_upload(&client, access_token, &target_path, upload_id)
        .await
        .unwrap_or_else(|_| BAIDU_UPLOAD_URL.to_string());

    {
        let mut file = File::open(zip_path).map_err(|error| format!("无法读取项目压缩包: {error}"))?;
        for (partseq, (offset, block_size)) in blocks.iter().enumerate() {
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(*offset))
                .map_err(|error| format!("跳过数据块失败: {error}"))?;
            let mut buffer = vec![0u8; *block_size];
            file.read_exact(&mut buffer)
                .map_err(|error| format!("读取数据块失败: {error}"))?;
            let part = reqwest::multipart::Part::bytes(buffer)
                .file_name("block")
                .mime_str("application/octet-stream")
                .map_err(|error| format!("百度网盘分块构造失败: {error}"))?;
            let form = reqwest::multipart::Form::new().part("file", part);
            let upload_response = client
                .post(format!("{upload_base}/rest/2.0/pcs/superfile2"))
                .query(&[
                    ("method", "upload"),
                    ("access_token", access_token),
                    ("type", "tmpfile"),
                    ("path", target_path.as_str()),
                    ("uploadid", upload_id),
                    ("partseq", &partseq.to_string()),
                ])
                .header("User-Agent", "pan.baidu.com")
                .multipart(form)
                .send()
                .await
                .map_err(|error| format!("百度网盘分块 {} 上传失败: {error}", partseq + 1))?;
            let upload_status = upload_response.status();
            let upload_payload: serde_json::Value = upload_response
                .json()
                .await
                .map_err(|error| {
                    format!("百度网盘分块 {} 响应解析失败（HTTP {upload_status}）: {error}", partseq + 1)
                })?;
            if baidu_errno(&upload_payload) != 0 {
                return Err(format!(
                    "百度网盘分块 {} 上传失败: {}",
                    partseq + 1,
                    baidu_error_message(&upload_payload)
                ));
            }
            let percent = 8 + (((partseq + 1) as u64 * 82) / blocks.len().max(1) as u64) as u8;
            emit_progress(
                app,
                PROVIDER_BAIDU,
                "uploading",
                percent.min(90),
                format!("百度网盘分块上传中 {}/{}", partseq + 1, blocks.len()),
            );
        }
    }

    emit_progress(app, PROVIDER_BAIDU, "completing", 92, "正在完成百度网盘上传...");
    let create_response = client
        .post(BAIDU_FILE_API)
        .query(&[("method", "create"), ("access_token", access_token)])
        .header("User-Agent", "pan.baidu.com")
        .form(&[
            ("path", target_path.clone()),
            ("size", size.to_string()),
            ("isdir", "0".to_string()),
            ("rtype", "1".to_string()),
            ("uploadid", upload_id.to_string()),
            ("block_list", block_list_json.clone()),
        ])
        .send()
        .await
        .map_err(|error| format!("百度网盘完成上传失败: {error}"))?;
    let create_status = create_response.status();
    let create_payload: serde_json::Value = create_response
        .json()
        .await
        .map_err(|error| format!("百度网盘完成上传响应解析失败（HTTP {create_status}）: {error}"))?;
    if baidu_errno(&create_payload) != 0 {
        return Err(format!(
            "百度网盘完成上传失败: {}{}",
            baidu_error_message(&create_payload),
            baidu_errno_hint(&create_payload)
        ));
    }

    Ok(CloudUploadSummary {
        provider: PROVIDER_BAIDU.to_string(),
        file_name: file_name.to_string(),
        size_bytes: size,
    })
}

async fn baidu_locate_upload(
    client: &reqwest::Client,
    access_token: &str,
    target_path: &str,
    upload_id: &str,
) -> Result<String, String> {
    let response = client
        .get("https://d.pcs.baidu.com/rest/2.0/pcs/file")
        .query(&[
            ("method", "locateupload"),
            ("appid", "250528"),
            ("access_token", access_token),
            ("path", target_path),
            ("uploadid", upload_id),
            ("upload_version", "2.0"),
        ])
        .send()
        .await
        .map_err(|error| format!("百度网盘获取上传域名失败: {error}"))?;
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("百度网盘获取上传域名响应解析失败: {error}"))?;
    let server = payload
        .get("servers")
        .and_then(|value| value.as_array())
        .and_then(|servers| servers.iter().find_map(|item| item.get("server")?.as_str()))
        .filter(|url| url.starts_with("https://"))
        .unwrap_or("https://d.pcs.baidu.com")
        .trim_end_matches('/')
        .to_string();
    Ok(server)
}

#[tauri::command]
pub async fn cloud_drive_upload_project(
    app: AppHandle,
    provider: String,
    record: ProjectRecord,
) -> Result<CloudUploadSummary, String> {
    emit_progress(&app, &provider, "prepare", 2, "正在准备项目压缩包...");
    let display = provider_config(&provider)?.display;
    let config = load_config(&app, &provider)?
        .ok_or_else(|| format!("{display} 尚未授权，请先完成授权。"))?;
    let config = refresh_token_if_needed(&app, &config).await?;
    if !config_connected(&config) {
        return Err(format!("{display} 尚未授权，请先完成授权。"));
    }

    let temp_dir = temp_upload_dir(&app)?;
    let safe_name = sanitize_file_name(&record.name);
    if safe_name.trim().is_empty() {
        return Err("项目名称无效，无法导出。".to_string());
    }
    let file_name = format!("{}-{}.zip", safe_name, Uuid::new_v4().simple());
    let zip_path = temp_dir.join(&file_name);

    emit_progress(&app, &provider, "export", 5, "正在导出项目压缩包...");
    export_project_bundle(record.clone(), zip_path.to_string_lossy().to_string())
        .await
        .map_err(|error| format!("项目导出失败: {error}"))?;
    let size = fs::metadata(&zip_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let result = match provider.as_str() {
        PROVIDER_BAIDU => {
            upload_to_baidu(&app, &config, &zip_path, &file_name, size).await
        }
        _ => Err(format!("不支持的云盘平台: {provider}")),
    };

    let _ = fs::remove_file(&zip_path);
    let summary = result?;
    emit_progress(&app, &provider, "complete", 100, "上传完成");
    Ok(summary)
}

fn is_project_zip(name: &str, safe_name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".zip") else {
        return false;
    };
    let prefix = format!("{safe_name}-");
    let Some(uuid_part) = stem.strip_prefix(&prefix) else {
        return false;
    };
    uuid_part.len() == 32 && uuid_part.chars().all(|character| character.is_ascii_hexdigit())
}

/// 列出云盘指定目录下的项目压缩包版本。
/// project_name 为空时列出全部项目；非空时只列出该项目的版本。
#[tauri::command]
pub async fn cloud_drive_list_versions(
    app: AppHandle,
    provider: String,
    project_name: String,
) -> Result<Vec<CloudDriveFileEntry>, String> {
    let display = provider_config(&provider)?.display;
    let config = load_config(&app, &provider)?
        .ok_or_else(|| format!("{display} 尚未授权，请先完成授权。"))?;
    let config = refresh_token_if_needed(&app, &config).await?;
    if !config_connected(&config) {
        return Err(format!("{display} 尚未授权，请先完成授权。"));
    }

    let folder = config
        .folder_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(BAIDU_DEFAULT_FOLDER)
        .trim_end_matches('/');
    let client = reqwest::Client::new();
    let response = client
        .get(BAIDU_FILE_API)
        .query(&[
            ("method", "list"),
            ("access_token", config.access_token.as_str()),
            ("dir", folder),
            ("order", "time"),
            ("desc", "1"),
            ("limit", "1000"),
        ])
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|error| format!("{display} 列出版本请求失败: {error}"))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("{display} 列出版本响应解析失败（HTTP {status}）: {error}"))?;
    if baidu_errno(&payload) != 0 {
        return Err(format!(
            "{display} 列出版本失败: {}{}",
            baidu_error_message(&payload),
            baidu_errno_hint(&payload)
        ));
    }

    let safe_name = sanitize_file_name(project_name.trim());
    let mut entries = Vec::new();
    if let Some(list) = payload.get("list").and_then(|value| value.as_array()) {
        for item in list {
            let Some(name) = item.get("server_filename").and_then(|value| value.as_str()) else {
                continue;
            };
            if !name.ends_with(".zip") {
                continue;
            }
            if !safe_name.is_empty() && !is_project_zip(name, &safe_name) {
                continue;
            }
            let path = item
                .get("path")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let fs_id = item
                .get("fs_id")
                .map(|value| value.to_string())
                .unwrap_or_default();
            let modified_at_sec = item
                .get("server_mtime")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let size_bytes = item.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
            entries.push(CloudDriveFileEntry {
                path,
                name: name.to_string(),
                size_bytes,
                modified_at_ms: modified_at_sec.saturating_mul(1000),
                fs_id,
            });
        }
    }

    // 按上传时间升序（旧 -> 新），前端每组取最后一条为最新版本。
    entries.sort_by(|left, right| {
        left.modified_at_ms
            .cmp(&right.modified_at_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

/// 从云盘下载指定版本的项目压缩包并覆盖导入到本地。
/// path 为云盘完整路径（用于日志与展示），fs_id 用于获取直链。
#[tauri::command]
pub async fn cloud_drive_restore_project(
    app: AppHandle,
    provider: String,
    path: String,
    fs_id: String,
) -> Result<CloudRestoreSummary, String> {
    let display = provider_config(&provider)?.display;
    let config = load_config(&app, &provider)?
        .ok_or_else(|| format!("{display} 尚未授权，请先完成授权。"))?;
    let config = refresh_token_if_needed(&app, &config).await?;
    if !config_connected(&config) {
        return Err(format!("{display} 尚未授权，请先完成授权。"));
    }
    if fs_id.trim().is_empty() {
        return Err("缺少云盘文件标识，无法恢复。".to_string());
    }

    emit_progress(
        &app,
        &provider,
        "restore",
        5,
        format!("正在获取云盘下载链接（{}）...", path.rsplit('/').next().unwrap_or(&path)),
    );
    let client = reqwest::Client::new();
    // filemetas 要求 fsids 为数字数组（如 [123456]），字符串数组会返回
    // errno 2 / "fsids error"。直接按原始数字文本拼 JSON 数组，
    // 避免大数经 serde_json 转成 f64 科学计数法导致丢精度。
    let fsid_raw = fs_id.trim();
    if fsid_raw.is_empty() || !fsid_raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{display} 文件标识无效，无法恢复。"));
    }
    let fsids_json = format!("[{fsid_raw}]");
    let metas_response = client
        .get(BAIDU_MULTIMEDIA_API)
        .query(&[
            ("method", "filemetas"),
            ("access_token", config.access_token.as_str()),
            ("fsids", fsids_json.as_str()),
            ("dlink", "1"),
        ])
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|error| format!("{display} 获取下载链接请求失败: {error}"))?;
    let metas_status = metas_response.status();
    let metas_payload: serde_json::Value = metas_response
        .json()
        .await
        .map_err(|error| format!("{display} 获取下载链接响应解析失败（HTTP {metas_status}）: {error}"))?;
    if baidu_errno(&metas_payload) != 0 {
        return Err(format!(
            "{display} 获取下载链接失败: {}",
            baidu_error_message(&metas_payload)
        ));
    }
    let file_meta = metas_payload
        .get("list")
        .and_then(|value| value.as_array())
        .and_then(|list| list.first())
        .ok_or_else(|| format!("{display} 未找到对应的云盘文件。"))?;
    let dlink = file_meta
        .get("dlink")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("{display} 响应中缺少下载直链。"))?;
    let size_bytes = file_meta.get("size").and_then(|value| value.as_u64()).unwrap_or(0);

    // filemetas 返回的 dlink 必须拼接当前用户的 access_token 才能下载，
    // 否则百度返回 31045（user not exists）。
    let mut download_url = reqwest::Url::parse(dlink)
        .map_err(|error| format!("{display} 下载直链无效: {error}"))?;
    download_url
        .query_pairs_mut()
        .append_pair("access_token", &config.access_token);

    let temp_dir = temp_upload_dir(&app)?;
    let zip_path = temp_dir.join(format!("restore-{}.zip", Uuid::new_v4().simple()));
    emit_progress(
        &app,
        &provider,
        "restore",
        12,
        format!("正在下载云盘版本（{:.1} MB）...", size_bytes as f64 / 1024.0 / 1024.0),
    );

    let download_result: Result<u64, String> = async {
        // 百度直链对 User-Agent / Referer 校验严格，不同组合的 CDN 策略不同，
        // 逐个尝试：先是官方文档组合，再是云管家客户端组合（社区实测可用）。
        let header_sets: [(&str, &str); 2] = [
            ("pan.baidu.com", "https://pan.baidu.com/"),
            (
                "netdisk;4.6.2.0;PC;PC-Windows;10.0.10240;WindowsBaiduYunGuanJia",
                "http://pan.baidu.com/disk/home",
            ),
        ];
        let mut response: Option<reqwest::Response> = None;
        let mut last_status: Option<reqwest::StatusCode> = None;
        let mut last_failure: Option<reqwest::Response> = None;
        for (attempt, (user_agent, referer)) in header_sets.iter().enumerate() {
            let resp = client
                .get(download_url.as_str())
                .header("User-Agent", *user_agent)
                .header("Referer", *referer)
                .send()
                .await
                .map_err(|error| format!("{display} 下载项目压缩包失败: {error}"))?;
            let is_anti_hotlink_html = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|content_type| content_type.contains("text/html"))
                .unwrap_or(false);
            last_status = Some(resp.status());
            if resp.status().is_success() && !is_anti_hotlink_html {
                response = Some(resp);
                break;
            }
            if attempt == header_sets.len() - 1 {
                last_failure = Some(resp);
            }
        }
        let response = match response {
            Some(response) => response,
            None => {
                // 全部尝试失败时，把最后一次响应的拒绝正文带出来，便于定位原因。
                let body_hint = if let Some(resp) = last_failure {
                    match resp.text().await {
                        Ok(body) => {
                        let snippet: String = body
                            .chars()
                            .map(|ch| if ch.is_control() { ' ' } else { ch })
                            .take(240)
                            .collect();
                        if snippet.trim().is_empty() {
                            String::new()
                        } else {
                            format!("，响应：{snippet}")
                        }
                        }
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                };
                let status_text = last_status
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "未知".to_string());
                return Err(format!("{display} 下载项目压缩包失败（HTTP {status_text}）{body_hint}"));
            }
        };
        let total = response.content_length().unwrap_or(0);
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&zip_path)
            .await
            .map_err(|error| format!("无法创建临时文件: {error}"))?;
        let mut received: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("{display} 下载数据流中断: {error}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入临时文件失败: {error}"))?;
            received += chunk.len() as u64;
            if total > 0 {
                let percent = (8 + ((received as f64 / total as f64) * 82.0) as u64) as u8;
                emit_progress(
                    &app,
                    &provider,
                    "restore",
                    percent.min(90),
                    format!("正在下载云盘版本... {:.1} MB / {:.1} MB", received as f64 / 1024.0 / 1024.0, total as f64 / 1024.0 / 1024.0),
                );
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("写入临时文件失败: {error}"))?;
        Ok(received)
    }
    .await;

    let received = match download_result {
        Ok(received) => received,
        Err(error) => {
            let _ = fs::remove_file(&zip_path);
            return Err(error);
        }
    };
    if received == 0 {
        let _ = fs::remove_file(&zip_path);
        return Err(format!("{display} 下载内容为空，已取消恢复。"));
    }

    emit_progress(&app, &provider, "restore", 92, "正在解包并写入本地项目...");
    let zip_path_string = zip_path.to_string_lossy().to_string();
    let import_app = app.clone();
    let record = tokio::task::spawn_blocking(move || import_project_bundle(import_app, zip_path_string))
        .await
        .map_err(|error| format!("项目解包任务异常: {error}"))?
        .map_err(|error| format!("项目解包失败: {error}"))?;

    let upsert_app = app.clone();
    let record_for_upsert = record.clone();
    tokio::task::spawn_blocking(move || upsert_project_record(upsert_app, record_for_upsert))
        .await
        .map_err(|error| format!("项目写入任务异常: {error}"))?
        .map_err(|error| format!("项目写入失败: {error}"))?;

    let _ = fs::remove_file(&zip_path);
    emit_progress(&app, &provider, "complete", 100, "恢复完成");
    Ok(CloudRestoreSummary {
        provider,
        project_id: record.id,
        project_name: record.name,
        size_bytes,
    })
}
