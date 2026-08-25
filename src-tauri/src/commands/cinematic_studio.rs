use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: &str = "0.2.0";

fn ensure_sqlite(base: &PathBuf) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(base.join("database.sqlite")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS prompt_versions (
            id TEXT PRIMARY KEY,
            template TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn project_save(
    dir: String,
    project_json: String,
    assets: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let base = PathBuf::from(&dir);
    fs::create_dir_all(base.join("assets")).map_err(|e| e.to_string())?;
    fs::create_dir_all(base.join("prompts")).map_err(|e| e.to_string())?;

    let manifest = serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "app": "cinematic-prompt-studio",
        "project": serde_json::from_str::<serde_json::Value>(&project_json).map_err(|e| e.to_string())?,
    });
    fs::write(
        base.join("project.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    for (asset_id, data_urls) in &assets {
        let asset_dir = base.join("assets").join(asset_id);
        fs::create_dir_all(&asset_dir).map_err(|e| e.to_string())?;
        for (index, data_url) in data_urls.iter().enumerate() {
            let (mime, bytes) = decode_data_url(data_url)?;
            let ext = ext_for_mime(mime.as_str());
            let name = format!("reference-{:02}{}", index + 1, ext);
            fs::write(asset_dir.join(name), bytes).map_err(|e| e.to_string())?;
        }
    }

    ensure_sqlite(&base)?;
    Ok(())
}

#[tauri::command]
pub fn project_load(dir: String) -> Result<serde_json::Value, String> {
    let base = PathBuf::from(&dir);
    if !base.join("project.json").exists() {
        return Err("not a .cineprompt project: project.json missing".to_string());
    }
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(base.join("project.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let mut project = manifest
        .get("project")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    if let Some(assets) = project
        .get_mut("assets")
        .and_then(|a| a.as_array_mut())
    {
        for asset in assets {
            let id = asset.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let asset_dir = base.join("assets").join(id);
            let mut files: Vec<(String, String)> = Vec::new();
            if let Ok(entries) = fs::read_dir(&asset_dir) {
                for entry in entries.flatten() {
                    if let Ok(bytes) = fs::read(entry.path()) {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let mime = mime_for_ext(
                            entry
                                .path()
                                .extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or(""),
                        );
                        files.push((name, format!("data:{};base64,{}", mime, base64_encode(&bytes))));
                    }
                }
            }
            files.sort_by(|a, b| a.0.cmp(&b.0));
            if let Some(refs) = asset
                .get_mut("referencePaths")
                .and_then(|r| r.as_array_mut())
            {
                *refs = files
                    .into_iter()
                    .map(|(_, data)| serde_json::Value::String(data))
                    .collect();
            }
        }
    }
    Ok(project)
}

#[tauri::command]
pub fn prompt_save(dir: String, version_id: String, text: String) -> Result<(), String> {
    let base = PathBuf::from(&dir);
    fs::create_dir_all(base.join("prompts")).map_err(|e| e.to_string())?;
    fs::write(
        base.join("prompts").join(format!("{}.md", version_id)),
        text,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn prompt_load(dir: String, version_id: String) -> Result<String, String> {
    let base = PathBuf::from(&dir);
    fs::read_to_string(base.join("prompts").join(format!("{}.md", version_id)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn version_record(
    dir: String,
    version_id: String,
    template: String,
    summary_json: String,
) -> Result<(), String> {
    let base = PathBuf::from(&dir);
    let conn = ensure_sqlite(&base)?;
    conn.execute(
        "INSERT INTO prompt_versions (id, template, summary_json, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
        rusqlite::params![version_id, template, summary_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn version_list(dir: String) -> Result<Vec<serde_json::Value>, String> {
    let base = PathBuf::from(&dir);
    let conn = ensure_sqlite(&base)?;
    let mut stmt = conn
        .prepare("SELECT id, template, summary_json, created_at FROM prompt_versions ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "template": row.get::<_, String>(1)?,
                "summary": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(2)?).unwrap_or(serde_json::Value::Null),
                "createdAt": row.get::<_, String>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn keychain_set(app: AppHandle, service: String, account: String, value: String) -> Result<(), String> {
    let dir = resolve_keychain_dir(&app)?;
    let key = format!("{service}\u{241F}{account}");
    let name = format!("{}.key", md5_hex(key.as_bytes()));
    fs::write(dir.join(name), value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_get(app: AppHandle, service: String, account: String) -> Result<String, String> {
    let dir = resolve_keychain_dir(&app)?;
    let key = format!("{service}\u{241F}{account}");
    let name = format!("{}.key", md5_hex(key.as_bytes()));
    fs::read_to_string(dir.join(name)).map_err(|e| e.to_string())
}

fn resolve_keychain_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let dir = app_data_dir.join("cinematic-studio-secrets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn md5_hex(bytes: &[u8]) -> String {
    let digest = md5::compute(bytes);
    format!("{digest:x}")
}

fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url.strip_prefix("data:").ok_or("not a data URL")?;
    let (header, payload) = rest.split_once(',').ok_or("malformed data URL")?;
    let mime = header.split(';').next().unwrap_or("image/jpeg").to_string();
    let bytes = base64_decode(payload).map_err(|e| e.to_string())?;
    Ok((mime, bytes))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(input)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        _ => ".jpg",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}