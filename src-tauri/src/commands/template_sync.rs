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

/// 把任意字符串净化成安全的文件/目录名, 并按 UTF-8 字节预算截断。
///
/// **绝不能用 `String::truncate`**: 它按字节切, 切点多字节字符(中文/emoji)中间时会
/// `assert!(self.is_char_boundary(new_len))` 直接 panic。模板名常直接取用提示词
/// (动辄数千字节的中文), 第 80 字节很容易落在汉字中间 —— 命令 panic 后 Tauri
/// 不会回包, 前端 `invoke` 永不 settle, 界面就永久停在「同步中」, 共享盘上连目录
/// 都建不出来。改成按字符累加、以字节预算为上限, 保证落点始终在字符边界上。
const SAFE_NAME_MAX_BYTES: usize = 80;

fn safe_name(value: &str) -> String {
    let sanitized = value.trim().chars().map(|character| {
        if matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || character.is_control() {
            '_'
        } else {
            character
        }
    });
    let mut truncated = String::new();
    for character in sanitized {
        if truncated.len() + character.len_utf8() > SAFE_NAME_MAX_BYTES {
            break;
        }
        truncated.push(character);
    }
    let result = truncated.trim_matches([' ', '.']).to_string();
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

/// 递归收集 payload 里所有「可搬运的媒体来源」。
///
/// 不能只看 `assets` 数组: 节点数据里的 `previewImageUrl`(缩略图)、
/// `studioReferenceImages` / `studioReferenceAudio` 等字段并不保证出现在
/// `assets` 里(见 `createTemplate.ts`), 而 `rewrite_media_paths` 会重写整份
/// payload。漏掉的字段会以「导出机本地绝对路径」原样写进共享盘 template.json,
/// 换电脑后这些路径不存在 → 图片/缩略图全坏。
///
/// 只收「远端 URL」和「本机真实存在的文件」: `data:` 是自包含的内联数据,
/// `asset:` 需要运行时解析, 两者都搬不动也无需搬运。
fn asset_sources(payload: &Value) -> Vec<String> {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    collect_media_sources(payload, &mut sources, &mut seen);
    sources
}

fn collect_media_sources(value: &Value, sources: &mut Vec<String>, seen: &mut HashSet<String>) {
    match value {
        Value::String(source) => {
            let transportable = is_remote_source(source) || source_to_local_path(source).is_some();
            if transportable && seen.insert(source.clone()) {
                sources.push(source.clone());
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_media_sources(item, sources, seen)),
        Value::Object(entries) => entries.values().for_each(|item| collect_media_sources(item, sources, seen)),
        _ => {}
    }
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
    use super::{normalize_share_path, rewrite_import_media_paths, rewrite_media_paths, safe_name, validate_shared_write_path};
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
    fn collects_media_sources_outside_the_assets_array() {
        // 复现线上问题: 节点数据里的 previewImageUrl 不在 assets 里,
        // 旧实现只扫 assets → 缩略图不会被拷到共享盘, 换电脑后全坏。
        let dir = std::env::temp_dir().join("lentalk-template-sync-test");
        std::fs::create_dir_all(&dir).unwrap();
        let preview = dir.join("preview.png");
        std::fs::write(&preview, b"stub").unwrap();
        let preview_text = preview.to_string_lossy().to_string();
        let payload = json!({
            "assets": [{ "sourcePath": "https://example.com/cover.mp4" }],
            "graph": { "nodes": [{ "data": { "previewImageUrl": preview_text } }] },
        });

        let sources = super::asset_sources(&payload);

        assert!(sources.contains(&"https://example.com/cover.mp4".to_string()));
        assert!(sources.contains(&preview_text), "节点数据里的本机文件也必须被收集: {sources:?}");
    }

    #[test]
    fn media_sources_are_deduplicated_and_skip_untransportable_schemes() {
        let payload = json!({
            "assets": [
                { "sourcePath": "https://example.com/a.png" },
                { "sourcePath": "https://example.com/a.png" },
            ],
            "graph": { "nodes": [{ "data": {
                "previewImageUrl": "data:image/png;base64,iVBORw0KGgo=",
                "imageUrl": "asset:library/abc.png",
            } }] },
        });

        let sources = super::asset_sources(&payload);

        assert_eq!(sources, vec!["https://example.com/a.png".to_string()]);
    }

    #[test]
    fn safe_name_never_cuts_a_multibyte_character() {
        // 复现线上「一直卡在同步中」: 模板名直接取用提示词(长中文), 旧实现用
        // String::truncate(80) 按字节切, 第 80 字节落在汉字中间 → panic →
        // 命令不回包 → 前端 invoke 永不 settle。
        let name = "SCENE CONTEXT \n13.5秒竖屏9:16真人实景药品广告短片。约50岁男士与藏医视频通话，全流程展示藏九公腰椎贴的使用与承诺。";
        let result = safe_name(name);
        assert!(result.len() <= super::SAFE_NAME_MAX_BYTES, "截断后字节数超预算: {}", result.len());
        assert!(result.is_char_boundary(result.len()), "截断点必须落在字符边界上");

        // 第 80 字节恰好落在字符边界时也必须正常(不能因为贪心提前少截太多)
        let aligned = "SCENE CONTEXT\n传统藏式药房工坊内部，草药香气与热气弥漫。中景横贯一条长木案，两侧立着满墙药材斗柜。";
        assert!(!safe_name(aligned).is_empty());
    }

    #[test]
    fn safe_name_falls_back_for_blank_and_strips_illegal_characters() {
        assert_eq!(safe_name("   "), "template");
        assert_eq!(safe_name(r#"a<b>c:d"e/f\g|h?i*j"#), "a_b_c_d_e_f_g_h_i_j");
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
