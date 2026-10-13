//! 生成媒体的落盘位置解析。
//!
//! 生成结果以前一律埋在 `AppData/LenTalk/images` 里：用户既找不到自己刚生成的文件，
//! 也没法整包备份。默认改到「系统下载文件夹 / LenTalk」并允许在
//! 「设置 → 通用 → 默认落盘位置」里改，是让「我刚生成的那个视频在哪」有一个直觉答案。
//!
//! 目录结构按媒体类型分子目录：
//!
//! ```text
//! <落盘根目录>/
//!   images/<md5>.<ext>
//!   videos/<md5>.<ext>
//!   audio/<md5>.<ext>
//! ```
//!
//! 文件名用内容 md5，所以同一份字节只会落一次盘。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};

use crate::database;

/// `app_settings` 表里的键名。前端「设置 → 通用」直接读写它。
/// 值为空串表示「用默认位置」。
pub const MEDIA_OUTPUT_DIR_SETTING_KEY: &str = "media.output-dir";

/// 系统下载目录下自动创建的专用文件夹名。
pub const MEDIA_OUTPUT_FOLDER_NAME: &str = "LenTalk";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

impl MediaKind {
    /// 全部类型。资源清理（GC）要按这个顺序把每个目录都扫一遍 ——
    /// 只扫 `images/` 就是「视频越攒越多」的根因。
    pub const ALL: [MediaKind; 3] = [MediaKind::Image, MediaKind::Video, MediaKind::Audio];

    pub fn subdirectory(self) -> &'static str {
        match self {
            MediaKind::Image => "images",
            MediaKind::Video => "videos",
            MediaKind::Audio => "audio",
        }
    }
}

/// 按扩展名判定媒体类型 —— 落盘时用它决定进哪个子目录。
///
/// 认不出来的一律当图片：这是唯一的既有行为，宁可放错子目录，也不要写进一个新目录
/// 让旧逻辑找不到文件。
pub fn kind_for_extension(extension: &str) -> MediaKind {
    let ext = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "flv" | "wmv" | "mpg" | "mpeg" | "ts" => {
            MediaKind::Video
        }
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "amr" => MediaKind::Audio,
        _ => MediaKind::Image,
    }
}

/// 未配置时的默认落盘根目录：`<系统下载文件夹>/LenTalk`。
///
/// 取不到系统下载目录（少见，比如被组策略禁用）时回退到 AppData —— 落盘必须永远有一个
/// 可用位置，不能因为取不到下载目录就把生成结果丢了。
pub fn default_output_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(downloads) = app.path().download_dir() {
        return Ok(downloads.join(MEDIA_OUTPUT_FOLDER_NAME));
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位落盘目录（下载目录与 AppData 均不可用）: {error}"))?;
    Ok(app_data.join(MEDIA_OUTPUT_FOLDER_NAME))
}

/// 从设置值里解析出一个可用的根目录。
///
/// 设置是纯文本存的（`save_app_setting` 不做 JSON 包装），但手工粘贴常会带上一对引号或
/// 首尾空白；相对路径一律忽略 —— 相对路径会随进程工作目录漂移，比「用默认值」更糟。
fn normalize_configured_root(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

fn configured_output_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let conn = database::open(app)?;
    let stored = database::get_setting(&conn, MEDIA_OUTPUT_DIR_SETTING_KEY)?;
    Ok(normalize_configured_root(stored.as_deref()))
}

/// 当前生效的落盘根目录：设置优先，否则用默认。
pub fn output_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(configured_output_root(app)?.unwrap_or(default_output_root(app)?))
}

/// 已经登记进 asset 协议作用域的目录（避免每次落盘都往 scope 里塞一遍让它无限增长）。
static ALLOWED_MEDIA_DIRS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 让 WebView 的 `asset://` 协议能读到这个目录。
///
/// `tauri.conf.json` 的 `app.security.assetProtocol.scope` 只放开了
/// `$APPDATA/$APPLOCALDATA/$TEMP`。落盘位置既然可以改到「系统下载文件夹」甚至用户自选的
/// 任意目录，就必须在运行时把目录也加进作用域 —— 否则文件**写得进去、却显示不出来**：
/// `convertFileSrc` 出的 `asset://` 会被协议处理器拒绝，表现为黑屏/空白，而且不会有
/// 任何报错，极难排查。
fn allow_asset_access(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let key = dir.to_string_lossy().to_string();
    let cache = ALLOWED_MEDIA_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(guard) = cache.lock() {
        if guard.contains(&key) {
            return Ok(());
        }
    }

    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|error| format!("无法为落盘目录 {} 开放本地读取权限: {error}", dir.display()))?;

    if let Ok(mut guard) = cache.lock() {
        guard.insert(key);
    }
    Ok(())
}

/// 某类媒体当前生效的落盘目录，不存在则创建，并确保 WebView 读得到。
pub fn media_dir(app: &AppHandle, kind: MediaKind) -> Result<PathBuf, String> {
    let dir = output_root(app)?.join(kind.subdirectory());
    fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建媒体落盘目录 {}: {error}", dir.display()))?;
    allow_asset_access(app, &dir)?;
    Ok(dir)
}

/// 启动时把当前生效的落盘目录登记进 asset 协议作用域。
///
/// **必须在启动时做一次**，不能只依赖落盘那一刻：重启后打开已有工程、还没生成任何新东西时，
/// 画布上已有的图片/视频会因为目录不在作用域内而读不出来（黑屏且无报错）。
pub fn register_asset_scope(app: &AppHandle) -> Result<(), String> {
    for kind in MediaKind::ALL {
        media_dir(app, kind)?;
    }
    Ok(())
}

/// 「设置 → 通用」用它显示未配置时实际会用的默认路径。
#[tauri::command]
pub fn resolve_default_media_output_dir(app: AppHandle) -> Result<String, String> {
    Ok(default_output_root(&app)?.to_string_lossy().to_string())
}

/// 「设置 → 通用」用它显示当前生效的路径（未配置时即默认路径）。
#[tauri::command]
pub fn resolve_media_output_dir(app: AppHandle) -> Result<String, String> {
    Ok(output_root(&app)?.to_string_lossy().to_string())
}

/// 校验并保存落盘位置；空串 = 恢复默认。
///
/// 当场建目录 + 试写一次，路径不存在或没权限立刻报错，而不是等下一次生成才失败
/// —— 那时候用户已经把设置页关了，只会看到一个莫名其妙的落盘错误。
#[tauri::command]
pub fn save_media_output_dir(app: AppHandle, value: String) -> Result<String, String> {
    let trimmed = value.trim().trim_matches('"').trim().to_string();
    let conn = database::open(&app)?;

    let resolved = if trimmed.is_empty() {
        database::put_setting(&conn, MEDIA_OUTPUT_DIR_SETTING_KEY, "")?;
        default_output_root(&app)?
    } else {
        let path = PathBuf::from(&trimmed);
        if !path.is_absolute() {
            return Err("落盘位置必须是绝对路径".to_string());
        }
        fs::create_dir_all(&path)
            .map_err(|error| format!("无法创建落盘目录 {}: {error}", path.display()))?;
        let probe = path.join(".lentalk-write-test");
        fs::write(&probe, b"")
            .map_err(|error| format!("落盘目录不可写（{}）: {error}", path.display()))?;
        let _ = fs::remove_file(&probe);
        database::put_setting(&conn, MEDIA_OUTPUT_DIR_SETTING_KEY, &trimmed)?;
        path
    };

    // 新目录要能读。旧目录**故意不从作用域里摘掉** —— 改过落盘位置之后，
    // 老工程里指向旧目录的那些文件还得继续显示得出来。
    register_asset_scope(&app)?;
    Ok(resolved.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_extensions() {
        assert_eq!(kind_for_extension("mp4"), MediaKind::Video);
        assert_eq!(kind_for_extension(".MP4"), MediaKind::Video);
        assert_eq!(kind_for_extension(" mov "), MediaKind::Video);
        assert_eq!(kind_for_extension("mp3"), MediaKind::Audio);
        assert_eq!(kind_for_extension("wav"), MediaKind::Audio);
        assert_eq!(kind_for_extension("png"), MediaKind::Image);
        assert_eq!(kind_for_extension("jpg"), MediaKind::Image);
        // 认不出来时保留旧的「都算图片」行为。
        assert_eq!(kind_for_extension(""), MediaKind::Image);
        assert_eq!(kind_for_extension("weird"), MediaKind::Image);
    }

    #[test]
    fn subdirectories_are_distinct() {
        assert_eq!(MediaKind::Image.subdirectory(), "images");
        assert_eq!(MediaKind::Video.subdirectory(), "videos");
        assert_eq!(MediaKind::Audio.subdirectory(), "audio");
    }

    #[test]
    fn blank_or_relative_settings_fall_back_to_default() {
        assert!(normalize_configured_root(None).is_none());
        assert!(normalize_configured_root(Some("")).is_none());
        assert!(normalize_configured_root(Some("   ")).is_none());
        // 相对路径会随工作目录漂移，必须当作"没设置"。
        assert!(normalize_configured_root(Some("outputs")).is_none());
        assert!(normalize_configured_root(Some("./outputs")).is_none());
    }

    #[test]
    fn strips_pasted_quotes_and_whitespace() {
        // 用平台自己的绝对路径，避免测试绑死在 Windows 的 `D:\` 上（项目也发 macOS 包）。
        let dir = std::env::temp_dir().join("LenTalk");
        let raw = dir.to_string_lossy().to_string();

        assert_eq!(
            normalize_configured_root(Some(&format!("  \"{raw}\"  "))),
            Some(dir.clone())
        );
        assert_eq!(normalize_configured_root(Some(&raw)), Some(dir));
    }
}
