use md5;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
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

#[tauri::command]
pub fn load_asset_library_state(app: AppHandle) -> Result<AssetLibraryStateRecord, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(default_state());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read asset library: {error}"))?;
    let state = serde_json::from_str::<AssetLibraryStateRecord>(&text)
        .map_err(|error| format!("Failed to parse asset library: {error}"))?;
    Ok(normalize_state(state))
}

#[tauri::command]
pub fn save_asset_library_state(
    app: AppHandle,
    state: AssetLibraryStateRecord,
) -> Result<AssetLibraryStateRecord, String> {
    let normalized = normalize_state(state);
    let path = state_path(&app)?;
    let temporary_path = path.with_extension("json.tmp");
    let text = serde_json::to_vec_pretty(&normalized)
        .map_err(|error| format!("Failed to encode asset library: {error}"))?;
    std::fs::write(&temporary_path, text)
        .map_err(|error| format!("Failed to write asset library: {error}"))?;
    std::fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Failed to finalize asset library: {error}"))?;
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

/**
 * 用系统 QuickLook(qlmanage) 为视频生成首帧缩略图 PNG, 存到视频同目录。
 * WKWebView 禁止无手势 autoplay, 前端 <video> 无法自动出首帧, 只能用系统级工具抽帧。
 * 成功返回缩略图绝对路径, 失败返回 None(调用方回退)。
 */
#[tauri::command]
pub fn extract_video_thumbnail(
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
    let output = parent.join(format!("{file_name}.png"));

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

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&parent, &output);
        Ok(None)
    }
}
