use md5;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::database;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLibraryRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCategoryRecord {
    pub id: String,
    pub library_id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetRecord {
    pub id: String,
    pub library_id: String,
    pub category_id: Option<String>,
    pub name: String,
    pub media_type: String,
    pub source_path: String,
    pub preview_image_url: Option<String>,
    pub aspect_ratio: Option<String>,
    pub source_file_name: Option<String>,
    pub tags: Vec<String>,
    pub created_at: i64,
    // ── 电影工作室镜像字段 ──────────────────────────────────────────────
    // 电影工作室（提示词工作室）会把角色 / 地点 / 道具资产镜像进素材库，
    // 前端靠这几个字段把镜像条目还原成电影资产。结构体必须显式声明它们，
    // 否则 serde 反序列化时会静默丢弃（落库一次就丢一次），
    // 导致节点上的「场景站位 / 场景角色候选」候选列表在重启后变空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cinematic_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cinematic_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cinematic_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cinematic_description_zh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cinematic_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLibraryStateRecord {
    pub libraries: Vec<AssetLibraryRecord>,
    pub categories: Vec<AssetCategoryRecord>,
    pub assets: Vec<LibraryAssetRecord>,
    pub active_library_id: String,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    Ok(dir)
}

fn legacy_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("asset-library.json"))
}

fn default_state() -> AssetLibraryStateRecord {
    let library = AssetLibraryRecord {
        id: "library-default".to_string(),
        name: "我的素材库".to_string(),
        created_at: 0,
    };
    AssetLibraryStateRecord {
        categories: vec![
            AssetCategoryRecord {
                id: "category-characters".to_string(),
                library_id: library.id.clone(),
                name: "角色".to_string(),
                created_at: 0,
            },
            AssetCategoryRecord {
                id: "category-scenes".to_string(),
                library_id: library.id.clone(),
                name: "场景".to_string(),
                created_at: 0,
            },
            AssetCategoryRecord {
                id: "category-props".to_string(),
                library_id: library.id.clone(),
                name: "道具".to_string(),
                created_at: 0,
            },
        ],
        libraries: vec![library],
        assets: Vec::new(),
        active_library_id: "library-default".to_string(),
    }
}

fn normalize_state(mut state: AssetLibraryStateRecord) -> AssetLibraryStateRecord {
    if state.libraries.is_empty() {
        return default_state();
    }

    state.libraries.retain(|library| !library.id.trim().is_empty());
    if state.libraries.is_empty() {
        return default_state();
    }

    let valid_library_ids: std::collections::HashSet<String> = state
        .libraries
        .iter()
        .map(|library| library.id.clone())
        .collect();
    state.categories.retain(|category| {
        !category.id.trim().is_empty() && valid_library_ids.contains(&category.library_id)
    });
    let valid_category_ids: std::collections::HashSet<String> = state
        .categories
        .iter()
        .map(|category| category.id.clone())
        .collect();
    state.assets.retain(|asset| {
        !asset.id.trim().is_empty()
            && !asset.source_path.trim().is_empty()
            && valid_library_ids.contains(&asset.library_id)
    });
    for asset in &mut state.assets {
        if asset
            .category_id
            .as_ref()
            .is_some_and(|category_id| !valid_category_ids.contains(category_id))
        {
            asset.category_id = None;
        }
        asset.tags.retain(|tag| !tag.trim().is_empty());
        asset.tags.sort();
        asset.tags.dedup();
    }
    if !valid_library_ids.contains(&state.active_library_id) {
        state.active_library_id = state.libraries[0].id.clone();
    }
    state
}

fn restore_quarantined_asset_file(
    images_dir: &PathBuf,
    quarantine_dir: &PathBuf,
    stored_path: &str,
) -> Result<(), String> {
    let target = PathBuf::from(stored_path);
    if target.exists() || target.parent() != Some(images_dir.as_path()) {
        return Ok(());
    }

    let Some(file_name) = target.file_name() else {
        return Ok(());
    };
    let quarantined = quarantine_dir.join(file_name);
    if quarantined.is_file() {
        std::fs::rename(&quarantined, &target)
            .map_err(|error| format!("Failed to restore quarantined asset file: {error}"))?;
    }
    Ok(())
}

fn restore_quarantined_asset_files(
    app: &AppHandle,
    state: &AssetLibraryStateRecord,
) -> Result<(), String> {
    let images_dir = app_data_dir(app)?.join("images");
    let quarantine_dir = images_dir.join(".quarantine");
    if !quarantine_dir.is_dir() {
        return Ok(());
    }

    for asset in &state.assets {
        restore_quarantined_asset_file(&images_dir, &quarantine_dir, &asset.source_path)?;
        if let Some(preview_path) = asset.preview_image_url.as_deref() {
            restore_quarantined_asset_file(&images_dir, &quarantine_dir, preview_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_asset_library_state(app: AppHandle) -> Result<AssetLibraryStateRecord, String> {
    let conn = database::open(&app)?;
    if let Some(value) = database::get_setting(&conn, "asset-library")? {
        let state = serde_json::from_str::<AssetLibraryStateRecord>(&value)
            .map_err(|error| format!("Failed to parse asset library: {error}"))?;
        restore_quarantined_asset_files(&app, &state)?;
        return Ok(normalize_state(state));
    }

    let path = legacy_state_path(&app)?;
    if path.exists() {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read legacy asset library: {error}"))?;
        let parsed_state = serde_json::from_str::<AssetLibraryStateRecord>(&text)
            .map_err(|error| format!("Failed to parse legacy asset library: {error}"))?;
        restore_quarantined_asset_files(&app, &parsed_state)?;
        let state = normalize_state(parsed_state);
        let value = serde_json::to_string(&state)
            .map_err(|error| format!("Failed to encode asset library: {error}"))?;
        database::put_setting(&conn, "asset-library", &value)?;
        let backup = path.with_extension(format!("json.migrated-{}.bak", std::process::id()));
        std::fs::rename(&path, backup)
            .map_err(|error| format!("Failed to archive legacy asset library: {error}"))?;
        return Ok(state);
    }
    Ok(default_state())
}

#[tauri::command]
pub fn save_asset_library_state(
    app: AppHandle,
    state: AssetLibraryStateRecord,
) -> Result<AssetLibraryStateRecord, String> {
    let normalized = normalize_state(state);
    let value = serde_json::to_string(&normalized)
        .map_err(|error| format!("Failed to encode asset library: {error}"))?;
    let conn = database::open(&app)?;
    database::put_setting(&conn, "asset-library", &value)?;
    Ok(normalized)
}

fn safe_extension(extension: &str) -> String {
    let normalized: String = extension
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        "bin".to_string()
    } else if normalized == "jpeg" {
        "jpg".to_string()
    } else {
        normalized
    }
}

#[tauri::command]
pub fn persist_library_asset_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Asset bytes are empty".to_string());
    }
    let directory = app_data_dir(&app)?.join("library-assets");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create asset directory: {error}"))?;
    let filename = format!("{:x}.{}", md5::compute(&bytes), safe_extension(&extension));
    let path = directory.join(filename);
    if !path.exists() {
        std::fs::write(&path, bytes)
            .map_err(|error| format!("Failed to persist asset file: {error}"))?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// 分块写入备份资产。每个分块单独经过 IPC，避免大视频一次性序列化成巨大数组。
#[tauri::command]
pub fn persist_library_asset_binary_chunk(
    app: AppHandle,
    bytes: Vec<u8>,
    file_id: String,
    extension: String,
    chunk_index: u32,
    is_last: bool,
) -> Result<Option<String>, String> {
    if bytes.is_empty() {
        return Err("Asset chunk is empty".to_string());
    }
    let safe_id: String = file_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(80)
        .collect();
    if safe_id.is_empty() {
        return Err("Asset chunk file id is empty".to_string());
    }

    let directory = app_data_dir(&app)?.join("library-assets");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create asset directory: {error}"))?;
    let path = directory.join(format!("backup-{}.{}", safe_id, safe_extension(&extension)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    if chunk_index == 0 {
        options.truncate(true);
    } else {
        options.append(true);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Failed to open backup asset file: {error}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|error| format!("Failed to write backup asset chunk: {error}"))?;
    file.flush()
        .map_err(|error| format!("Failed to flush backup asset chunk: {error}"))?;
    if is_last {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// 从用户在原生文件选择器中选中的本地路径复制媒体文件，避免大文件经 IPC 转成字节数组。
#[tauri::command]
pub fn persist_library_asset_file(
    app: AppHandle,
    source_path: String,
    extension: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path.trim());
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Failed to read source media file: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected media source is not a file".to_string());
    }

    let directory = app_data_dir(&app)?.join("library-assets");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create asset directory: {error}"))?;
    let filename = format!("{}.{}", Uuid::new_v4(), safe_extension(&extension));
    let destination = directory.join(filename);
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Failed to copy media asset: {error}"))?;

    Ok(destination.to_string_lossy().to_string())
}

/// 将素材库备份写入用户在原生保存对话框中选择的路径。
///
/// 这里不能使用前端 fs 插件的 writeFile：插件的 capability scope 只覆盖
/// `$HOME` / `$TEMP`，而保存对话框允许用户选择任意本地目录（例如 D 盘）。
#[tauri::command]
pub fn write_library_backup(
    bytes: Vec<u8>,
    destination_path: String,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Library backup bytes are empty".to_string());
    }
    let destination = PathBuf::from(destination_path.trim());
    if destination.as_os_str().is_empty() {
        return Err("Library backup destination is empty".to_string());
    }
    std::fs::write(&destination, bytes)
        .map_err(|error| format!("Failed to write library backup: {error}"))?;
    Ok(destination.to_string_lossy().to_string())
}

/**
 * 为视频生成缩略图 PNG, 存到视频同目录。成功返回缩略图绝对路径, 失败返回 None(调用方回退)。
 *
 * macOS 用系统 QuickLook(qlmanage) 抽帧; 其它平台用随包分发的 ffmpeg 抽帧。
 * 早期版本在非 macOS 平台直接返回 None 交给前端 <video>+canvas 抽帧, 但 WebView2 在
 * loadeddata 之后画布仍可能是全透明的(帧尚未提交到合成器), 存下来的就是一张空白封面。
 */
#[tauri::command]
pub fn extract_video_thumbnail(
    app: AppHandle,
    video_path: String,
) -> Result<Option<String>, String> {
    let source = std::path::Path::new(&video_path);
    if !source.exists() {
        return Ok(None);
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "Video path has no file name".to_string())?
        .to_string_lossy()
        .to_string();
    let parent = source
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("/tmp"));
    // macOS 的 qlmanage 只能产出 PNG; 其它平台用 JPEG —— 封面不需要透明通道, 同尺寸下
    // 体积约为 PNG 的二十分之一(480 宽的 PNG 抽帧图接近 700KB)。
    let thumbnail_extension = if cfg!(target_os = "macos") { "png" } else { "jpg" };
    let output = parent.join(format!("{file_name}.{thumbnail_extension}"));

    // 已生成过直接返回
    if output.exists() {
        return Ok(Some(output.to_string_lossy().to_string()));
    }

    // qlmanage 是 macOS 专用 QuickLook 抽帧工具; 其他平台返回 None 由前端回退 canvas 截图。
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("qlmanage")
            .args(["-t", "-s", "480", "-o"])
            .arg(parent)
            .arg(&video_path)
            .status()
            .map_err(|error| format!("Failed to run qlmanage: {error}"))?;

        if status.success() && output.exists() {
            return Ok(Some(output.to_string_lossy().to_string()));
        }
        Ok(None)
    }

    // 其它平台: 用随包 ffmpeg 抽第 0.1s 的画面(避开部分视频开头的纯色淡入)。
    #[cfg(not(target_os = "macos"))]
    {
        let Some(ffmpeg) = crate::commands::video_cfr::resolve_ffmpeg_path(&app) else {
            return Ok(None);
        };
        // 宽度限制 480: 节点封面用不到全分辨率, 也避免 4K 源抽出上千万像素的 PNG。
        let status = std::process::Command::new(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-ss", "0.1"])
            .arg("-i")
            .arg(&video_path)
            .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"])
            .arg(&output)
            .status()
            .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;

        if status.success() && output.exists() {
            return Ok(Some(output.to_string_lossy().to_string()));
        }
        Ok(None)
    }
}
