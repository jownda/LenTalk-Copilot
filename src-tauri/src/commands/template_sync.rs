use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::database;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSyncResult {
    pub template_count: usize,
    pub copied_file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateImportResult {
    pub imported_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateStorageRecord {
    id: String,
    name: String,
    payload_json: String,
    _created_at: i64,
        updated_at: i64,
}

fn normalize_share_path(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('/', "\\");
    if !normalized.starts_with(r"\\") {
        return Err("共享盘路径必须是 UNC 路径".to_string());
    }
    let trimmed = normalized.trim_end_matches('\\').to_string();
    if trimmed.len() < 5 || trimmed.split('\\').filter(|part| !part.is_empty()).count() < 2 {
        return Err("共享盘路径无效".to_string());
    }
    if trimmed.split('\\').any(|part| part == "." || part == "..") {
        return Err("共享盘路径不允许包含相对路径段".to_string());
    }
    Ok(trimmed)
}

fn normalized_for_compare(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

/// Every shared-drive write must pass this lexical containment check immediately before it.
fn validate_shared_write_path(root: &Path, target: &Path) -> Result<(), String> {
    if target.components().any(|component| component == Component::ParentDir) {
        return Err(format!("拒绝包含上级路径的共享盘写入: {target:?}"));
    }
    let root_text = normalized_for_compare(root);
    let target_text = normalized_for_compare(target);
    let prefix = format!("{root_text}\\");
    if target_text != root_text && !target_text.starts_with(&prefix) {
        return Err(format!("拒绝越界共享盘写入: {target:?}"));
    }
    Ok(())
}

fn validate_share_root(value: &str) -> Result<PathBuf, String> {
    let normalized = normalize_share_path(value)?;
    let root = PathBuf::from(&normalized);
    if !root.is_dir() {
        return Err(format!("共享盘目录不存在或不可访问: {normalized}"));
    }
    Ok(root)
}

fn safe_name(value: &str) -> String {
    let mut result = value.trim().chars().map(|character| {
        if matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || character.is_control() {
            '_'
        } else {
            character
        }
    }).collect::<String>();
    result.truncate(80);
    let result = result.trim_matches([' ', '.']).to_string();
    if result.is_empty() { "template".to_string() } else { result }
}

fn open_templates(app: &AppHandle) -> Result<(Connection, Vec<TemplateStorageRecord>), String> {
    let conn = database::open(app)?;
    let mut statement = conn
        .prepare("SELECT id, name, payload_json, created_at, updated_at FROM templates ORDER BY updated_at DESC")
        .map_err(|error| format!("读取模板失败: {error}"))?;
    let rows = statement.query_map([], |row| {
        Ok(TemplateStorageRecord {
            id: row.get(0)?, name: row.get(1)?, payload_json: row.get(2)?,
            _created_at: row.get(3)?, updated_at: row.get(4)?,
        })
    }).map_err(|error| format!("读取模板失败: {error}"))?;
    let records = rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析模板失败: {error}"))?;
    drop(statement);
    Ok((conn, records))
}

fn asset_sources(payload: &Value) -> Vec<String> {
    payload.get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| asset.get("sourcePath").and_then(Value::as_str))
        .filter(|source| (source.starts_with("http://") || source.starts_with("https://")) || Path::new(source).is_file())
        .map(ToString::to_string)
        .collect()
}

fn asset_file_name(source: &str) -> String {
    let candidate = source
        .split('?')
        .next()
        .and_then(|value| value.rsplit(['/', '\\']).next())
        .unwrap_or("");
    let name = safe_name(candidate);
    if name == "template" || !name.contains('.') {
        format!("video-{:x}.mp4", md5::compute(source.as_bytes()))
    } else {
        name
    }
}

fn copy_if_local_newer(source: &Path, target: &Path) -> Result<bool, String> {
    let source_modified = fs::metadata(source).and_then(|metadata| metadata.modified()).ok();
    let target_modified = fs::metadata(target).and_then(|metadata| metadata.modified()).ok();
    if target_modified.is_some() && source_modified.is_some() && source_modified <= target_modified {
        return Ok(false);
    }
    fs::copy(source, target)
        .map(|_| true)
        .map_err(|error| format!("复制模板视频失败: {error}"))
}

fn write_template_if_local_newer(
    root: &Path,
    target: &Path,
    payload: &str,
    local_updated_at: i64,
) -> Result<bool, String> {
    validate_shared_write_path(root, target)?;
    if let Ok(metadata) = fs::metadata(target) {
        if let Ok(modified) = metadata.modified() {
            let remote_ms = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_millis() as i64;
            if remote_ms >= local_updated_at {
                return Ok(false);
            }
        }
    }
    fs::write(target, payload)
        .map(|_| true)
        .map_err(|error| format!("写入模板 JSON 失败: {error}"))
}

async fn download_remote_if_missing(
    root: &Path,
    target: &Path,
    source: &str,
) -> Result<bool, String> {
    validate_shared_write_path(root, target)?;
    if target.exists() {
        return Ok(false);
    }
    let response = reqwest::get(source)
        .await
        .map_err(|error| format!("下载模板视频失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("下载模板视频失败: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取模板视频失败: {error}"))?;
    validate_shared_write_path(root, target)?;
    fs::write(target, bytes).map(|_| true).map_err(|error| format!("写入模板视频失败: {error}"))
}

#[tauri::command]
pub async fn template_sync_to_share(app: AppHandle, shared_root: String) -> Result<TemplateSyncResult, String> {
    let root = validate_share_root(&shared_root)?;
    let (_conn, records) = open_templates(&app)?;
    let templates_root = root.join("templates");
    validate_shared_write_path(&root, &templates_root)?;
    fs::create_dir_all(&templates_root).map_err(|error| format!("创建模板备份目录失败: {error}"))?;
    let mut copied_file_count = 0;

    for record in &records {
        let payload: Value = serde_json::from_str(&record.payload_json).map_err(|error| format!("模板 {} 数据无效: {error}", record.id))?;
        let package_dir = templates_root.join(format!("{}-{}", safe_name(&record.name), safe_name(&record.id)));
        let videos_dir = package_dir.join("videos");
        validate_shared_write_path(&root, &package_dir)?;
        validate_shared_write_path(&root, &videos_dir)?;
        fs::create_dir_all(&videos_dir).map_err(|error| format!("创建模板视频目录失败: {error}"))?;

        let template_json = package_dir.join("template.json");
        if write_template_if_local_newer(&root, &template_json, &record.payload_json, record.updated_at)? {
            copied_file_count += 1;
        }

        for source in asset_sources(&payload) {
            let source_path = PathBuf::from(&source);
            let target = videos_dir.join(asset_file_name(&source));
            validate_shared_write_path(&root, &target)?;
            let copied = if source.starts_with("http://") || source.starts_with("https://") {
                download_remote_if_missing(&root, &target, &source).await?
            } else {
                copy_if_local_newer(&source_path, &target)?
            };
            if copied {
                copied_file_count += 1;
            }
        }
    }

    Ok(TemplateSyncResult { template_count: records.len(), copied_file_count })
}

#[tauri::command]
pub fn template_sync_from_share(app: AppHandle, shared_root: String) -> Result<TemplateImportResult, String> {
    let root = validate_share_root(&shared_root)?;
    let templates_root = root.join("templates");
    validate_shared_write_path(&root, &templates_root)?;
    if !templates_root.is_dir() { return Ok(TemplateImportResult { imported_count: 0 }); }
    let conn = database::open(&app)?;
    let mut imported_count = 0;
    for entry in fs::read_dir(&templates_root).map_err(|error| format!("读取共享盘模板目录失败: {error}"))? {
        let package_dir = entry.map_err(|error| format!("读取共享盘模板目录失败: {error}"))?.path();
        let template_json = package_dir.join("template.json");
        validate_shared_write_path(&root, &template_json)?;
        if !template_json.is_file() { continue; }
        let payload_json = fs::read_to_string(&template_json).map_err(|error| format!("读取共享盘模板失败: {error}"))?;
        let payload: Value = serde_json::from_str(&payload_json).map_err(|error| format!("共享盘模板 JSON 无效: {error}"))?;
        let id = payload.get("id").and_then(Value::as_str).ok_or_else(|| "共享盘模板缺少 id".to_string())?;
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("导入模板");
        let created_at = payload.get("createdAt").and_then(Value::as_str).and_then(|value| chrono_like_timestamp(value)).unwrap_or(0);
        let updated_at = payload.get("updatedAt").and_then(Value::as_str).and_then(|value| chrono_like_timestamp(value)).unwrap_or(created_at);
        conn.execute("INSERT INTO templates (id, name, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload_json=excluded.payload_json, updated_at=excluded.updated_at", params![id, name, payload_json, created_at, updated_at]).map_err(|error| format!("导入模板失败: {error}"))?;
        imported_count += 1;
    }
    Ok(TemplateImportResult { imported_count })
}

fn chrono_like_timestamp(value: &str) -> Option<i64> {
    let parsed = value.parse::<i64>().ok();
    parsed.or_else(|| Some(0))
}

#[cfg(test)]
mod tests {
    use super::{normalize_share_path, validate_shared_write_path};
    use std::path::Path;

    #[test]
    fn shared_path_requires_unc_root() {
        assert!(normalize_share_path(r"C:\temp\templates").is_err());
        assert!(normalize_share_path(r"\\server\share\templates").is_ok());
    }

    #[test]
    fn shared_write_path_rejects_escape() {
        let root = Path::new(r"\\server\share\templates");
        assert!(validate_shared_write_path(root, Path::new(r"\\server\share\templates\a\template.json")).is_ok());
        assert!(validate_shared_write_path(root, Path::new(r"\\server\share\other\template.json")).is_err());
        assert!(validate_shared_write_path(root, Path::new(r"\\server\share\templates\..\other\template.json")).is_err());
    }
}
