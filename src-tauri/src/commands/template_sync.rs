use std::fs;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

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
        .filter(|source| is_remote_source(source) || source_to_local_path(source).is_some())
        .map(ToString::to_string)
        .collect()
}

fn is_remote_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn source_to_local_path(source: &str) -> Option<PathBuf> {
    if is_remote_source(source) || source.starts_with("data:") || source.starts_with("asset:") {
        return None;
    }
    let candidate = if let Some(file_url) = source.strip_prefix("file://") {
        let decoded = urlencoding::decode(file_url).ok()?.into_owned();
        decoded.strip_prefix('/').unwrap_or(&decoded).to_string()
    } else {
        source.to_string()
    };
    let path = PathBuf::from(candidate);
    path.is_file().then_some(path)
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

fn allocate_media_file_name(source: &str, used_names: &mut HashSet<String>) -> String {
    let preferred = asset_file_name(source);
    if used_names.insert(preferred.to_ascii_lowercase()) {
        return preferred;
    }
    let candidate = format!("{:x}-{}", md5::compute(source.as_bytes()), preferred);
    used_names.insert(candidate.to_ascii_lowercase());
    candidate
}

fn rewrite_media_paths(value: &mut Value, source_map: &HashMap<String, String>) {
    match value {
        Value::String(source) => {
            if let Some(shared_source) = source_map.get(source) {
                *source = shared_source.clone();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite_media_paths(item, source_map)),
        Value::Object(entries) => entries.values_mut().for_each(|item| rewrite_media_paths(item, source_map)),
        _ => {}
    }
}

fn basename(value: &str) -> Option<String> {
    let candidate = value.split('?').next()?.rsplit(['/', '\\']).next()?.trim();
    (!candidate.is_empty()).then(|| candidate.to_ascii_lowercase())
}

fn rewrite_import_media_paths(
    value: &mut Value,
    source_map: &HashMap<String, String>,
    media_by_name: &HashMap<String, String>,
) {
    match value {
        Value::String(source) => {
            if let Some(shared_source) = source_map.get(source) {
                *source = shared_source.clone();
            } else if let Some(file_name) = basename(source) {
                if let Some(shared_source) = media_by_name.get(&file_name) {
                    *source = shared_source.clone();
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite_import_media_paths(item, source_map, media_by_name)),
        Value::Object(entries) => entries.values_mut().for_each(|item| rewrite_import_media_paths(item, source_map, media_by_name)),
        _ => {}
    }
}

fn cache_imported_template_media(
    app: &AppHandle,
    template_id: &str,
    videos_dir: &Path,
) -> Result<HashMap<String, String>, String> {
    if !videos_dir.is_dir() {
        return Ok(HashMap::new());
    }
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位本机模板媒体目录: {error}"))?
        .join("template-shared-media")
        .join(safe_name(template_id));
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("无法创建本机模板媒体目录 {}: {error}", cache_dir.display()))?;

    let mut media_by_name = HashMap::<String, String>::new();
    for media in fs::read_dir(videos_dir).map_err(|error| format!("读取共享盘模板媒体失败: {error}"))? {
        let source = media.map_err(|error| format!("读取共享盘模板媒体失败: {error}"))?.path();
        if !source.is_file() {
            continue;
        }
        let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let target = cache_dir.join(safe_name(file_name));
        let copied = copy_if_local_newer(&source, &target)?;
        if copied || target.is_file() {
            media_by_name.insert(file_name.to_ascii_lowercase(), target.to_string_lossy().to_string());
        }
    }
    Ok(media_by_name)
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

fn write_template_payload(
    root: &Path,
    target: &Path,
    payload: &str,
) -> Result<bool, String> {
    validate_shared_write_path(root, target)?;
    if fs::read_to_string(target).ok().as_deref() == Some(payload) {
        return Ok(false);
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

        let mut payload_for_share = payload.clone();
        let mut source_map = HashMap::<String, String>::new();
        let mut manifest = HashMap::<String, String>::new();
        let mut used_names = HashSet::<String>::new();
        for source in asset_sources(&payload) {
            let file_name = allocate_media_file_name(&source, &mut used_names);
            let target = videos_dir.join(&file_name);
            validate_shared_write_path(&root, &target)?;
            let copied = if is_remote_source(&source) {
                download_remote_if_missing(&root, &target, &source).await?
            } else {
                let source_path = source_to_local_path(&source).ok_or_else(|| format!("模板媒体不可读取: {source}"))?;
                copy_if_local_newer(&source_path, &target)?
            };
            if copied {
                copied_file_count += 1;
            }
            let shared_source = target.to_string_lossy().to_string();
            source_map.insert(source.clone(), shared_source);
            manifest.insert(source, file_name);
        }

        rewrite_media_paths(&mut payload_for_share, &source_map);
        let shared_payload = serde_json::to_string(&payload_for_share).map_err(|error| format!("序列化共享模板失败: {error}"))?;
        let template_json = package_dir.join("template.json");
        if write_template_payload(&root, &template_json, &shared_payload)? {
            copied_file_count += 1;
        }
        let manifest_json = package_dir.join("media-map.json");
        let manifest_payload = serde_json::to_string(&manifest).map_err(|error| format!("序列化模板媒体映射失败: {error}"))?;
        if write_template_payload(&root, &manifest_json, &manifest_payload)? {
            copied_file_count += 1;
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
        let mut payload: Value = serde_json::from_str(&payload_json).map_err(|error| format!("共享盘模板 JSON 无效: {error}"))?;
        let videos_dir = package_dir.join("videos");
        validate_shared_write_path(&root, &videos_dir)?;
        let manifest_json = package_dir.join("media-map.json");
        validate_shared_write_path(&root, &manifest_json)?;
        let manifest: HashMap<String, String> = fs::read_to_string(&manifest_json)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
        let source_map = manifest.into_iter().map(|(source, file_name)| {
            (source, videos_dir.join(file_name).to_string_lossy().to_string())
        }).collect::<HashMap<_, _>>();
        let mut media_by_name = HashMap::<String, String>::new();
        if videos_dir.is_dir() {
            for media in fs::read_dir(&videos_dir).map_err(|error| format!("读取共享盘模板媒体失败: {error}"))? {
                let media_path = media.map_err(|error| format!("读取共享盘模板媒体失败: {error}"))?.path();
                if media_path.is_file() {
                    if let Some(file_name) = media_path.file_name().and_then(|name| name.to_str()) {
                        media_by_name.insert(file_name.to_ascii_lowercase(), media_path.to_string_lossy().to_string());
                    }
                }
            }
        }
        let id = payload.get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "共享盘模板缺少 id".to_string())?
            .to_string();
        let media_by_name = cache_imported_template_media(&app, &id, &videos_dir)?;
        let local_source_map = source_map
            .into_iter()
            .filter_map(|(source, shared_source)| {
                let file_name = basename(&shared_source)?;
                media_by_name.get(&file_name).cloned().map(|local_source| (source, local_source))
            })
            .collect::<HashMap<_, _>>();
        rewrite_import_media_paths(&mut payload, &local_source_map, &media_by_name);
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("导入模板").to_string();
        let created_at = payload.get("createdAt").and_then(Value::as_str).and_then(|value| chrono_like_timestamp(value)).unwrap_or(0);
        let updated_at = payload.get("updatedAt").and_then(Value::as_str).and_then(|value| chrono_like_timestamp(value)).unwrap_or(created_at);
        let imported_payload = serde_json::to_string(&payload).map_err(|error| format!("序列化导入模板失败: {error}"))?;
        conn.execute("INSERT INTO templates (id, name, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload_json=excluded.payload_json, updated_at=excluded.updated_at", params![id, name, imported_payload, created_at, updated_at]).map_err(|error| format!("导入模板失败: {error}"))?;
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
    use super::{normalize_share_path, rewrite_import_media_paths, rewrite_media_paths, validate_shared_write_path};
    use std::collections::HashMap;
    use std::path::Path;
    use serde_json::json;

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

    #[test]
    fn shared_template_payload_uses_packaged_media_paths() {
        let source = r"D:\source-machine\references\hero.png";
        let shared = r"\\server\share\templates\demo\videos\hero.png";
        let mut payload = json!({
            "assets": [{ "sourcePath": source }],
            "pipeline": { "referenceImages": [{ "sourcePath": source }] },
            "graph": { "nodes": [{ "data": { "imageUrl": source } }] },
        });
        let map = HashMap::from([(source.to_string(), shared.to_string())]);
        rewrite_media_paths(&mut payload, &map);
        assert_eq!(payload["assets"][0]["sourcePath"], shared);
        assert_eq!(payload["pipeline"]["referenceImages"][0]["sourcePath"], shared);
        assert_eq!(payload["graph"]["nodes"][0]["data"]["imageUrl"], shared);
    }

    #[test]
    fn legacy_template_import_recovers_media_by_file_name() {
        let mut payload = json!({
            "assets": [{ "sourcePath": r"D:\old-machine\media\clip.mp4" }],
            "artifacts": { "coverVideo": { "sourcePath": r"D:\old-machine\media\clip.mp4" } },
        });
        let media_by_name = HashMap::from([(
            "clip.mp4".to_string(),
            r"\\server\share\templates\demo\videos\clip.mp4".to_string(),
        )]);
        rewrite_import_media_paths(&mut payload, &HashMap::new(), &media_by_name);
        assert_eq!(payload["assets"][0]["sourcePath"], r"\\server\share\templates\demo\videos\clip.mp4");
        assert_eq!(payload["artifacts"]["coverVideo"]["sourcePath"], r"\\server\share\templates\demo\videos\clip.mp4");
    }

    #[test]
    fn imported_template_rewrites_shared_media_to_local_cache() {
        let shared_source = r"\\server\share\templates\demo\videos\clip.mp4";
        let local_source = r"C:\Users\tester\AppData\Roaming\LenTalk\template-shared-media\demo\clip.mp4";
        let mut payload = json!({
            "assets": [{ "sourcePath": shared_source }],
            "artifacts": { "coverVideo": { "sourcePath": shared_source } },
        });
        let source_map = HashMap::from([(shared_source.to_string(), local_source.to_string())]);
        rewrite_import_media_paths(&mut payload, &source_map, &HashMap::new());
        assert_eq!(payload["assets"][0]["sourcePath"], local_source);
        assert_eq!(payload["artifacts"]["coverVideo"]["sourcePath"], local_source);
    }
}
