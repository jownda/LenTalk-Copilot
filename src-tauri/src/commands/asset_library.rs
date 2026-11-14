use md5;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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

/// 设置键：素材库根目录（纯文本绝对路径；空值 = 用默认位置）。
///
/// 素材原文件是这套应用里体积最大的一块（本机 1.5 GB / 真机常见 5~7 GB），用户经常想
/// 整体放到别的盘。默认位置是 `app_data/library-assets`，可在
/// 「设置 → 通用 → 素材库位置」改。改根目录**只影响之后导入的素材** —— 已有记录存的是
/// 绝对路径，想真正搬走要用「迁移现有素材」（见 `migrate_library_files`）。
pub const LIBRARY_DIR_SETTING_KEY: &str = "asset.library-dir";

/// 素材库根目录的缓存。
///
/// 每次导入都要解析一次根目录，而 `database::open` 会跑一轮建表/迁移检查，
/// 逐文件调用时开销放大得厉害 —— 缓存起来，改设置时清掉。
static LIBRARY_ROOT_CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// 已经登记进 asset 协议作用域的素材库目录（避免重复登记让它无限增长）。
static ALLOWED_LIBRARY_DIRS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn normalize_directory_setting(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    // 相对路径会随进程工作目录漂移，比「用默认值」更糟。
    path.is_absolute().then_some(path)
}

fn default_library_directory(app: &AppHandle) -> Result<PathBuf, String> {
    crate::commands::storage_paths::default_library_dir(app)
}

fn compute_library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let conn = database::open(app)?;
    let stored = database::get_setting(&conn, LIBRARY_DIR_SETTING_KEY)?;
    if let Some(path) = normalize_directory_setting(stored.as_deref()) {
        return Ok(path);
    }
    default_library_directory(app)
}

/// 当前生效的素材库根目录：设置优先，否则 AppData 下的默认位置。
pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = LIBRARY_ROOT_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(path) = guard.as_ref() {
            return Ok(path.clone());
        }
    }
    let resolved = compute_library_root(app)?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(resolved.clone());
    }
    Ok(resolved)
}

/// 让 WebView 的 `asset://` 协议能读到素材库目录。
///
/// 默认位置在 `$APPDATA` 下，配置文件里的作用域本来就覆盖；但根目录一旦改到别的盘，
/// 就必须在运行时补登记 —— 否则文件**写得进去、却显示不出来**，而且没有任何报错。
fn allow_library_asset_access(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let key = dir.to_string_lossy().to_string();
    let cache = ALLOWED_LIBRARY_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(guard) = cache.lock() {
        if guard.contains(&key) {
            return Ok(());
        }
    }

    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|error| format!("无法为素材库目录 {} 开放本地读取权限: {error}", dir.display()))?;

    if let Ok(mut guard) = cache.lock() {
        guard.insert(key);
    }
    Ok(())
}

/// 启动时把当前素材库目录登记进 asset 作用域（失败只记日志，不阻断启动）。
pub fn register_asset_scope(app: &AppHandle) -> Result<(), String> {
    let root = library_root(app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("无法创建素材库目录 {}: {error}", root.display()))?;
    allow_library_asset_access(app, &root)
}

fn legacy_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("asset-library.json"))
}

/// 素材库整体状态在 `app_settings` 里的键。媒体桥接模块也要读写同一份数据。
pub(crate) const ASSET_LIBRARY_SETTING_KEY: &str = "asset-library";

pub(crate) fn default_state() -> AssetLibraryStateRecord {
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
            AssetCategoryRecord {
                id: "category-audio".to_string(),
                library_id: library.id.clone(),
                name: "音频".to_string(),
                created_at: 0,
            },
        ],
        libraries: vec![library],
        assets: Vec::new(),
        active_library_id: "library-default".to_string(),
    }
}

pub(crate) fn normalize_state(mut state: AssetLibraryStateRecord) -> AssetLibraryStateRecord {
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
    if let Some(value) = database::get_setting(&conn, ASSET_LIBRARY_SETTING_KEY)? {
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
        database::put_setting(&conn, ASSET_LIBRARY_SETTING_KEY, &value)?;
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
    database::put_setting(&conn, ASSET_LIBRARY_SETTING_KEY, &value)?;
    Ok(normalized)
}

/// 素材库受管目录：原素材文件都放在这里。
///
/// 只有落在这个目录下的文件才允许被「重命名素材」改写 —— 用户从外面拖进来的文件
/// （画布临时目录、项目 bundle 等）一律不碰。
fn library_asset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = library_root(app)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create asset directory: {error}"))?;
    allow_library_asset_access(app, &directory)?;
    Ok(directory)
}

/// 把任意素材名收敛成安全的文件名主干（不含扩展名）。
///
/// 素材库条目名是用户随手写的，可能带 `/ : ? *` 这类在 Windows / macOS 上非法、
/// 或会让路径跑到别的目录的字符，所以落盘前必须净化。净化规则要**稳定**：
/// 同名素材每次算出来的结果必须一样，否则「启动时对齐文件名」会反复改名。
pub(crate) fn sanitize_file_stem(raw: &str) -> String {
    let mut mapped = String::with_capacity(raw.len());
    for character in raw.chars() {
        if character.is_control() {
            continue;
        }
        match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => mapped.push('-'),
            _ => mapped.push(character),
        }
    }
    // 折叠连续空白：文件名里的多空格没有意义，还会让对齐逻辑误判。
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|character: char| character == '.' || character == ' ');
    // 太长的主干在部分文件系统上会被截断，截断后名字就永远对不上，先在 80 字符处收口。
    let limited: String = trimmed.chars().take(80).collect();
    let limited = limited
        .trim_end_matches(|character: char| character == '.' || character == ' ')
        .to_string();
    if limited.is_empty() {
        return "素材".to_string();
    }
    // Windows 保留设备名：叫 `CON` / `NUL` 的文件根本创建不出来。
    const RESERVED_NAMES: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if RESERVED_NAMES.contains(&limited.to_ascii_lowercase().as_str()) {
        return format!("_{limited}");
    }
    limited
}

/// 在目录里挑一个不冲突的目标路径：`名字.ext` → `名字 (2).ext` → ...
fn unique_asset_destination(directory: &PathBuf, stem: &str, extension: &str) -> PathBuf {
    let first = directory.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for index in 2..=9999u32 {
        let candidate = directory.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem} ({}).{extension}", Uuid::new_v4()))
}

/// 计算新素材的落盘路径。`file_stem` 为空（备份恢复等内部场景）时退回内容哈希。
fn resolve_asset_destination(
    directory: &PathBuf,
    bytes: &[u8],
    extension: &str,
    file_stem: Option<&str>,
) -> PathBuf {
    let Some(stem) = file_stem.map(str::trim).filter(|stem| !stem.is_empty()) else {
        return directory.join(format!("{:x}.{extension}", md5::compute(bytes)));
    };
    let stem = sanitize_file_stem(stem);
    let candidate = directory.join(format!("{stem}.{extension}"));
    // 同名且内容完全一致 → 复用（重复导入同一张图不会多出一份副本）。
    if candidate.is_file() && std::fs::read(&candidate).map(|existing| existing == bytes).unwrap_or(false) {
        return candidate;
    }
    unique_asset_destination(directory, &stem, extension)
}

pub(crate) fn safe_extension(extension: &str) -> String {
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
pub async fn persist_library_asset_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
    file_stem: Option<String>,
) -> Result<String, String> {
    // 写盘 + 冲突比对（可能逐字节读完整个同名文件）都在阻塞线程池里做。
    tauri::async_runtime::spawn_blocking(move || {
        persist_library_asset_binary_blocking(app, bytes, extension, file_stem)
    })
    .await
    .map_err(|error| format!("保存素材失败: {error}"))?
}

fn persist_library_asset_binary_blocking(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
    file_stem: Option<String>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Asset bytes are empty".to_string());
    }
    let directory = library_asset_directory(&app)?;
    let extension = safe_extension(&extension);
    let path = resolve_asset_destination(&directory, &bytes, &extension, file_stem.as_deref());
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

    let directory = library_asset_directory(&app)?;
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
pub async fn persist_library_asset_file(
    app: AppHandle,
    source_path: String,
    extension: String,
    file_stem: Option<String>,
) -> Result<String, String> {
    // 复制的是整段视频/图片文件（可能几百 MB），磁盘 IO 会阻塞命令线程。
    tauri::async_runtime::spawn_blocking(move || {
        persist_library_asset_file_blocking(app, source_path, extension, file_stem)
    })
    .await
    .map_err(|error| format!("保存素材文件失败: {error}"))?
}

fn persist_library_asset_file_blocking(
    app: AppHandle,
    source_path: String,
    extension: String,
    file_stem: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(source_path.trim());
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Failed to read source media file: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected media source is not a file".to_string());
    }

    let directory = library_asset_directory(&app)?;
    let extension = safe_extension(&extension);
    let destination = match file_stem
        .as_deref()
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
    {
        Some(stem) => unique_asset_destination(&directory, &sanitize_file_stem(stem), &extension),
        // 没给主干名（备份恢复等内部路径）时沿用 uuid，保证不与用户文件撞名。
        None => directory.join(format!("{}.{extension}", Uuid::new_v4())),
    };
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Failed to copy media asset: {error}"))?;

    Ok(destination.to_string_lossy().to_string())
}

/// 重命名素材库里的原素材文件，让磁盘文件名和素材库条目名保持一致。
///
/// 只接受 `app_data/library-assets/` 下的直接子文件：这条命令属于「素材库内部维护」，
/// 不能变成任意路径改名的后门。扩展名保持不变（改名只改名，不改格式）。
/// `keep_source = true` 时改为复制 —— 当多条素材共用一个文件时，搬走文件会让
/// 另一条素材的引用失效。
#[tauri::command]
pub fn rename_library_asset_file(
    app: AppHandle,
    source_path: String,
    file_stem: String,
    keep_source: bool,
) -> Result<String, String> {
    let directory = library_asset_directory(&app)?;
    let source = PathBuf::from(source_path.trim());
    if source.parent() != Some(directory.as_path()) {
        return Err("素材文件不在素材库目录内，跳过改名".to_string());
    }
    if !source.is_file() {
        return Err("素材源文件已不存在".to_string());
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_string();
    let stem = sanitize_file_stem(&file_stem);
    let current_stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if current_stem == stem {
        return Ok(source.to_string_lossy().to_string());
    }

    let destination = unique_asset_destination(&directory, &stem, &extension);
    if keep_source {
        std::fs::copy(&source, &destination)
            .map_err(|error| format!("Failed to copy asset file: {error}"))?;
    } else {
        std::fs::rename(&source, &destination)
            .map_err(|error| format!("Failed to rename asset file: {error}"))?;
    }
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
pub async fn extract_video_thumbnail(
    app: AppHandle,
    video_path: String,
) -> Result<Option<String>, String> {
    // 抽帧要起 ffmpeg/qlmanage 子进程并解码，属阻塞活；导入一批视频时
    // 逐个占主线程会直接把界面拖死。
    tauri::async_runtime::spawn_blocking(move || extract_video_thumbnail_blocking(app, video_path))
        .await
        .map_err(|error| format!("生成视频封面失败: {error}"))?
}

pub(crate) fn extract_video_thumbnail_blocking(
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
        let mut command = std::process::Command::new(ffmpeg);
        // Windows 下不隐藏会弹出黑框命令行窗口。
        crate::commands::video_cfr::hide_child_console(&mut command);
        let status = command
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDirectoryInfo {
    pub root: String,
    pub default_root: String,
    pub is_custom: bool,
}

fn library_directory_info(app: &AppHandle) -> Result<LibraryDirectoryInfo, String> {
    let root = library_root(app)?;
    let default_root = default_library_directory(app)?;
    Ok(LibraryDirectoryInfo {
        is_custom: root != default_root,
        root: root.to_string_lossy().to_string(),
        default_root: default_root.to_string_lossy().to_string(),
    })
}

/// 当前素材库位置（设置页显示用）。
#[tauri::command]
pub fn resolve_library_directory(app: AppHandle) -> Result<LibraryDirectoryInfo, String> {
    library_directory_info(&app)
}

/// 改素材库根目录；`path` 传空串表示恢复默认位置。
///
/// 只改「以后往哪写」：已有素材记录里存的是绝对路径，不会被这次修改动到。
/// 真要连文件一起搬走，紧跟着调 `migrate_library_files`（它会返回旧→新路径映射，
/// 前端用它把工程/模板里的引用一并改写）。
#[tauri::command]
pub fn set_library_directory(app: AppHandle, path: String) -> Result<LibraryDirectoryInfo, String> {
    let trimmed = path.trim().trim_matches('"').trim().to_string();
    let conn = database::open(&app)?;

    if trimmed.is_empty() {
        database::put_setting(&conn, LIBRARY_DIR_SETTING_KEY, "")?;
    } else {
        let target = PathBuf::from(&trimmed);
        if !target.is_absolute() {
            return Err("素材库位置必须是绝对路径（例如 D:\\lentalk素材库）".to_string());
        }
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("无法创建素材库目录 {}: {error}", target.display()))?;
        // 先试写一次：不可写要当场报错，而不是等用户导入素材时才失败。
        let probe = target.join(".lentalk-write-probe");
        std::fs::write(&probe, b"ok")
            .map_err(|error| format!("素材库目录不可写 {}: {error}", target.display()))?;
        let _ = std::fs::remove_file(&probe);
        allow_library_asset_access(&app, &target)?;
        database::put_setting(&conn, LIBRARY_DIR_SETTING_KEY, &trimmed)?;
    }

    // 设置变了，缓存的旧根目录立刻作废。
    if let Some(cache) = LIBRARY_ROOT_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = None;
        }
    }
    library_directory_info(&app)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMigrationReport {
    pub target_root: String,
    /// 旧路径 → 新路径。前端拿它改写素材记录、画布节点、工程与模板里的引用。
    pub path_map: std::collections::HashMap<String, String>,
    pub copied_files: usize,
    pub skipped_files: usize,
    pub copied_bytes: u64,
    pub failed: Vec<String>,
}

/// 把「不在当前根目录下」的素材原文件复制进当前根目录，返回旧→新映射。
///
/// 只复制、不删除：旧文件留在原处，用户确认没问题后自己清理即可 —— 迁移做一半断电
/// 也不会丢素材。目标目录已有同名同大小文件时直接跳过（视作上次已复制过）。
#[tauri::command]
pub async fn migrate_library_files(app: AppHandle) -> Result<LibraryMigrationReport, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_library_files_blocking(&app))
        .await
        .map_err(|error| format!("素材迁移任务执行失败: {error}"))?
}

fn migrate_library_files_blocking(app: &AppHandle) -> Result<LibraryMigrationReport, String> {
    let root = library_root(app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("无法创建素材库目录 {}: {error}", root.display()))?;
    allow_library_asset_access(app, &root)?;

    let state = load_asset_library_state(app.clone())?;
    let mut report = LibraryMigrationReport {
        target_root: root.to_string_lossy().to_string(),
        path_map: std::collections::HashMap::new(),
        copied_files: 0,
        skipped_files: 0,
        copied_bytes: 0,
        failed: Vec::new(),
    };

    for asset in &state.assets {
        let source = PathBuf::from(asset.source_path.trim());
        if asset.source_path.trim().is_empty() || !source.is_file() {
            continue;
        }
        if source.parent() == Some(root.as_path()) {
            continue;
        }
        let Some(name) = source.file_name() else {
            continue;
        };
        let destination = root.join(name);
        if destination == source {
            continue;
        }
        let source_size = source.metadata().map(|meta| meta.len()).unwrap_or(0);
        if destination.is_file() {
            let existing = destination.metadata().map(|meta| meta.len()).unwrap_or(0);
            if existing == source_size {
                report
                    .path_map
                    .insert(asset.source_path.clone(), destination.to_string_lossy().to_string());
                report.skipped_files += 1;
                continue;
            }
        }
        match std::fs::copy(&source, &destination) {
            Ok(bytes) => {
                report
                    .path_map
                    .insert(asset.source_path.clone(), destination.to_string_lossy().to_string());
                report.copied_files += 1;
                report.copied_bytes += bytes;
            }
            Err(error) => report
                .failed
                .push(format!("{}: {error}", asset.source_path)),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_path_and_reserved_characters() {
        assert_eq!(sanitize_file_stem("画布图片 10:08:32"), "画布图片 10-08-32");
        assert_eq!(sanitize_file_stem("a/b\\c*d?e\"f<g>h|i"), "a-b-c-d-e-f-g-h-i");
        assert_eq!(sanitize_file_stem("  多   空格  "), "多 空格");
        // 首尾的点和空格在 Windows / macOS 上都不合法
        assert_eq!(sanitize_file_stem("..封面. ."), "封面");
        assert_eq!(sanitize_file_stem("   "), "素材");
        assert_eq!(sanitize_file_stem("...."), "素材");
        // Windows 保留设备名不能直接当文件名
        assert_eq!(sanitize_file_stem("con"), "_con");
        assert_eq!(sanitize_file_stem("NUL"), "_NUL");
    }

    #[test]
    fn sanitize_is_stable_and_bounded() {
        let once = sanitize_file_stem("商品头图");
        assert_eq!(once, sanitize_file_stem(&once));
        let long = sanitize_file_stem(&"长".repeat(200));
        assert_eq!(long.chars().count(), 80);
        assert_eq!(long, sanitize_file_stem(&long));
    }

    #[test]
    fn destination_uses_stem_and_dedupes_suffixes() {
        let dir = std::env::temp_dir().join(format!("lentalk-asset-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let extension = safe_extension("png");

        let first = resolve_asset_destination(&dir, b"one", &extension, Some("商品头图"));
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "商品头图.png");
        std::fs::write(&first, b"one").expect("write first");

        // 同名但内容不同 → 追加序号, 不覆盖已有素材
        let second = resolve_asset_destination(&dir, b"two", &extension, Some("商品头图"));
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "商品头图 (2).png");

        // 同名同内容 → 复用同一个文件
        let reused = resolve_asset_destination(&dir, b"one", &extension, Some("商品头图"));
        assert_eq!(reused, first);

        // 未给主干名(备份恢复)时退回内容哈希
        let hashed = resolve_asset_destination(&dir, b"three", &extension, None);
        assert_eq!(
            hashed.file_name().unwrap().to_string_lossy(),
            format!("{:x}.png", md5::compute(b"three"))
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
