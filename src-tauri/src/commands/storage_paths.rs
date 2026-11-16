//! 默认存储位置：**优先 D 盘，没有可用 D 盘再退回 C 盘**。
//!
//! 素材库原文件 + 生成缓存（图/视频/音频）+ 缩略图，一台机器上动辄十几 GB，全塞进
//! 系统盘很快就会把 C 盘吃满。所以全新安装默认落到 `D:\LenTalk\`：
//!
//! ```text
//! D:\LenTalk\
//!   ├─ 素材库\            素材原文件
//!   └─ 缓存\              生成的图/视频/音频
//!       └─ thumbnails\    缩略图缓存（可再生）
//! ```
//!
//! 🔴 **老机器保持原位**：判据是「历史默认目录里已经有东西」。升级一次就把新素材写到
//! D 盘、旧素材留在 C 盘，等于把同一套素材拆成两处 —— 用户看到的是一半图裂、一半正常，
//! 比不迁更糟。所以默认只在**空白的全新安装**上生效。
//!
//! 探测 D 盘用「建目录 + 写探针」而不是只看盘符存在：只读挂载、光驱、未挂载的盘符
//! 都可能有 `D:`，真写的时候才失败，那时素材已经导完了。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::database::app_data_dir;

/// 新装默认根目录。
#[cfg(target_os = "windows")]
const PREFERRED_ROOT: &str = r"D:\LenTalk";

/// 有可用（可写）的 D 盘时返回 `D:\LenTalk`，否则 `None`。
///
/// 🔴 只在 Windows 上成立。macOS / Linux 没有盘符，`PathBuf::from(r"D:\LenTalk")` 在那里
/// 是一个**相对路径**（`D:` 只是个目录名），`create_dir_all` 会在进程当前目录下真的建出
/// `D:\LenTalk` 并且写探针成功 —— 于是素材库与生成缓存被塞进启动目录：从 Finder 启动时
/// 是 `/`（不可写，探测失败，碰巧无害），从终端或脚本启动时却会成功落进去。
pub fn preferred_root() -> Option<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    {
        None
    }

    #[cfg(target_os = "windows")]
    {
        let root = PathBuf::from(PREFERRED_ROOT);
        std::fs::create_dir_all(&root).ok()?;
        let probe = root.join(".write-probe");
        std::fs::write(&probe, b"ok").ok()?;
        let _ = std::fs::remove_file(&probe);
        Some(root)
    }
}

/// 目录里是否已经有文件（用来判断「这是不是一台已有数据的机器」）。
fn has_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// 素材库默认位置：已有素材 → 原位；全新安装 → `D:\LenTalk\素材库`（无 D 盘则 AppData）。
pub fn default_library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let legacy = app_data_dir(app)?.join("library-assets");
    if has_entries(&legacy) {
        return Ok(legacy);
    }
    if let Some(root) = preferred_root() {
        return Ok(root.join("素材库"));
    }
    Ok(legacy)
}

/// 生成落盘默认位置：已有产物 → 原位（下载目录/LenTalk）；全新安装 → `D:\LenTalk\缓存`。
pub fn default_media_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(downloads) = app.path().download_dir() {
        let legacy = downloads.join("LenTalk");
        if has_entries(&legacy) {
            return Ok(legacy);
        }
        if let Some(root) = preferred_root() {
            return Ok(root.join("缓存"));
        }
        return Ok(legacy);
    }
    if let Some(root) = preferred_root() {
        return Ok(root.join("缓存"));
    }
    Ok(app_data_dir(app)?.join("LenTalk"))
}

/// 缩略图缓存默认位置：已有缓存 → 原位；全新安装 → `缓存\thumbnails`。
///
/// 缩略图是可再生的派生数据，跟着缓存目录走即可 —— 但同样遵守「已有就不搬」，
/// 免得升级后第一次打开画布要重新解码几百张原图。
pub fn default_thumbnail_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let legacy = app_data_dir(app)?.join("thumbnails");
    if has_entries(&legacy) {
        return Ok(legacy);
    }
    if let Some(root) = preferred_root() {
        return Ok(root.join("缓存").join("thumbnails"));
    }
    Ok(legacy)
}
