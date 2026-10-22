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

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tracing::warn;

use crate::database;

/// `app_settings` 表里的键名。前端「设置 → 通用」直接读写它。
/// 值为空串表示「用默认位置」。
pub const MEDIA_OUTPUT_DIR_SETTING_KEY: &str = "media.output-dir";

/// 系统下载目录下自动创建的专用文件夹名。
pub const MEDIA_OUTPUT_FOLDER_NAME: &str = "LenTalk";

/// 用过的落盘根目录（历史，换行分隔）。
///
/// 两个用途，都围绕同一条事实：**画布/工程里存的是绝对路径**。
/// 1. 启动时要把这些目录一并登记进 asset 协议作用域 —— 改过落盘位置之后，老工程里
///    指向旧目录的图片/视频若不登记，`asset://` 会被协议处理器静默拒绝，表现就是
///    「原来的图片全变成损坏图标」，且没有任何报错；
/// 2. 「一键迁移旧素材」以它为源。
///
/// 旧目录**只增不减**：用户随时可能打开一个老工程，不能因为「当前不用了」就把它从
/// 作用域里摘掉。
pub const MEDIA_OUTPUT_DIR_HISTORY_KEY: &str = "media.output-dir-history";

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

/// 解析设置里的路径列表（换行分隔）。空行与相对路径一律丢掉。
fn parse_output_roots(raw: Option<&str>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for line in raw.unwrap_or("").lines() {
        let Some(path) = normalize_configured_root(Some(line)) else {
            continue;
        };
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

/// 历史落盘根目录（去重、按写入顺序）。
fn history_output_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let conn = database::open(app)?;
    let stored = database::get_setting(&conn, MEDIA_OUTPUT_DIR_HISTORY_KEY)?;
    Ok(parse_output_roots(stored.as_deref()))
}

/// 把「刚被换掉的那一个」根目录记进历史。同一个路径不会重复记。
fn remember_output_root(app: &AppHandle, root: &Path) -> Result<(), String> {
    let mut roots = history_output_roots(app)?;
    if roots.iter().any(|existing| existing == root) {
        return Ok(());
    }
    roots.push(root.to_path_buf());
    let serialized = roots
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let conn = database::open(app)?;
    database::put_setting(&conn, MEDIA_OUTPUT_DIR_HISTORY_KEY, &serialized)
}

/// 当前 + 默认 + 历史：三组目录都要保证 WebView 读得到。
///
/// 默认目录也必须在内 —— 把位置从「默认」改成「自定义」时，旧素材全在默认目录里，
/// 而它从来不会出现在历史里（它不是被「换掉」的，是配置为空的自然结果）。
pub fn known_output_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let candidates: Vec<PathBuf> = std::iter::once(output_root(app)?)
        .chain(default_output_root(app).ok())
        .chain(history_output_roots(app)?)
        .collect();
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in candidates {
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    Ok(roots)
}

/// 启动时把**所有已知**落盘目录登记进 asset 协议作用域。
///
/// **必须在启动时做一次**，不能只依赖落盘那一刻：重启后打开已有工程、还没生成任何新东西时，
/// 画布上已有的图片/视频会因为目录不在作用域内而读不出来（黑屏/损坏图标且无报错）。
///
/// ⚠️ 只登记「当前生效目录」是不够的 —— 那正是「改完落盘位置，画布上原来的图片全变成
/// 损坏图标」的根因：老工程里的绝对路径仍指向**旧目录**，而旧目录重启后没被重新登记。
/// 当前 / 默认 / 历史三组目录都要覆盖。
pub fn register_asset_scope(app: &AppHandle) -> Result<(), String> {
    let current = output_root(app)?;
    for root in known_output_roots(app)? {
        let is_current = root == current;
        for kind in MediaKind::ALL {
            let dir = root.join(kind.subdirectory());
            if is_current {
                // 当前目录随时要落盘，必须建出来。
                fs::create_dir_all(&dir)
                    .map_err(|error| format!("无法创建媒体落盘目录 {}: {error}", dir.display()))?;
            } else if !dir.is_dir() {
                // 历史目录只做「存在就读得到」：用户可能是自己删掉的，不替他重建。
                continue;
            }
            if let Err(error) = allow_asset_access(app, &dir) {
                // 历史目录打不开不该拖垮启动，最坏只是那批素材暂时显示不出来。
                warn!("落盘目录未加入 asset 协议作用域 {}: {error}", dir.display());
            }
        }
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
    // 换位置**之前**先把当前生效的根目录记进历史。
    //
    // ⚠️ 顺序不能反：先改设置、再记旧目录的话，中间任何一步失败都会留下「设置已指向新目录、
    // 旧目录却没被记住」的状态 —— 重启后老工程里指向旧目录的图片直接变成损坏图标。
    // 反过来多做一次记录最多只是历史里多一个等于当前值的条目（`known_output_roots` 会去重）。
    if let Ok(previous) = output_root(&app) {
        remember_output_root(&app, &previous)?;
    }
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

/// 一次「旧素材迁移」的结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMigrationReport {
    /// 当前生效的落盘根目录（迁移目标）。
    pub target_root: String,
    /// 参与迁移的旧根目录（不含目标本身）。
    pub source_roots: Vec<String>,
    pub copied_files: usize,
    pub copied_bytes: u64,
    /// 新目录里已有同名文件而跳过 —— 文件名就是内容 md5，同名即同内容。
    pub skipped_files: usize,
    pub failed_files: usize,
}

/// 「设置 → 通用 → 一键迁移旧素材」：把**旧落盘目录**里的素材复制到当前落盘目录。
///
/// 语义刻意是**复制**而不是移动：
///   1. 画布/工程里存的是绝对路径，文件一旦离开旧目录，那些引用立刻失效 —— 用户刚从
///      「图片变损坏图标」里爬出来，不该再赌一次；
///   2. 复制随时可中断，旧目录始终留着一份完整的可回滚副本。
/// 旧目录里的原文件一律保留，由用户确认新目录无误后自行清理。
#[tauri::command]
pub async fn migrate_media_output_files(app: AppHandle) -> Result<MediaMigrationReport, String> {
    let target_root = output_root(&app)?;
    let mut source_roots: Vec<PathBuf> = Vec::new();
    for root in known_output_roots(&app)? {
        if root != target_root && !source_roots.contains(&root) {
            source_roots.push(root);
        }
    }
    // 素材动辄上千个文件、上 GB，全是阻塞 IO，别占住异步运行时。
    tauri::async_runtime::spawn_blocking(move || migrate_roots(&target_root, &source_roots))
        .await
        .map_err(|error| format!("迁移任务异常结束: {error}"))?
}

fn migrate_roots(
    target_root: &Path,
    source_roots: &[PathBuf],
) -> Result<MediaMigrationReport, String> {
    let mut report = MediaMigrationReport {
        target_root: target_root.to_string_lossy().to_string(),
        source_roots: source_roots
            .iter()
            .map(|root| root.to_string_lossy().to_string())
            .collect(),
        ..Default::default()
    };

    for kind in MediaKind::ALL {
        let target_dir = target_root.join(kind.subdirectory());
        fs::create_dir_all(&target_dir)
            .map_err(|error| format!("无法创建落盘目录 {}: {error}", target_dir.display()))?;
        for source_root in source_roots {
            let source_dir = source_root.join(kind.subdirectory());
            if !source_dir.is_dir() {
                continue;
            }
            copy_missing_files(&source_dir, &target_dir, &mut report);
        }
    }
    Ok(report)
}

/// 把 `source_dir` 里目标尚未拥有的文件复制过去；同名直接跳过（文件名是内容 md5）。
fn copy_missing_files(source_dir: &Path, target_dir: &Path, report: &mut MediaMigrationReport) {
    let Ok(entries) = fs::read_dir(source_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 只收文件：`.quarantine` 暂存区是子目录，会被这一条挡掉。
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let target = target_dir.join(file_name);
        if target.is_file() {
            report.skipped_files += 1;
            continue;
        }
        match fs::copy(&path, &target) {
            Ok(bytes) => {
                report.copied_files += 1;
                report.copied_bytes += bytes;
            }
            Err(error) => {
                report.failed_files += 1;
                warn!("迁移素材失败 {}: {error}", path.display());
            }
        }
    }
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

    #[test]
    fn parses_history_roots_and_drops_junk_lines() {
        let first = std::env::temp_dir().join("LenTalk");
        let second = std::env::temp_dir().join("LenTalk-second");
        // 空行 + 相对路径 + 重复项, 外加首尾空白 —— 都要被处理掉。
        let raw = format!(
            "{}\n\n  relative/path  \n{}\n{}\n",
            first.display(),
            second.display(),
            first.display()
        );

        assert_eq!(parse_output_roots(Some(&raw)), vec![first, second]);
        assert!(parse_output_roots(None).is_empty());
        assert!(parse_output_roots(Some("")).is_empty());
    }

    /// 迁移必须是**复制**：源文件留在原地（老工程的绝对路径还指着它），
    /// 同名文件跳过（文件名就是内容 md5），暂存区目录不动。
    #[test]
    fn migration_copies_missing_files_and_keeps_the_source() {
        let base = std::env::temp_dir().join(format!("lentalk-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let source = base.join("old").join("images");
        let target = base.join("new").join("images");
        fs::create_dir_all(&source).expect("mkdir source");
        fs::create_dir_all(&target).expect("mkdir target");

        fs::write(source.join("aaa.png"), b"AAA").expect("write aaa");
        fs::write(source.join("bbb.png"), b"BBB").expect("write bbb");
        fs::write(target.join("aaa.png"), b"AAA").expect("write existing");
        fs::create_dir_all(source.join(".quarantine")).expect("mkdir quarantine");

        let mut report = MediaMigrationReport::default();
        copy_missing_files(&source, &target, &mut report);

        assert_eq!(report.copied_files, 1);
        assert_eq!(report.copied_bytes, 3);
        assert_eq!(report.skipped_files, 1);
        assert_eq!(report.failed_files, 0);
        assert!(target.join("bbb.png").is_file());
        // 复制而非移动。
        assert!(source.join("bbb.png").is_file());
        // 暂存区是子目录, 不该被当成素材搬过去。
        assert!(!target.join(".quarantine").exists());

        let _ = fs::remove_dir_all(&base);
    }
}
