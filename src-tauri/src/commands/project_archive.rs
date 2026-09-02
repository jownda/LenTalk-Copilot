use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::project_state::ProjectRecord;

const PROJECT_BUNDLE_FORMAT: &str = "lentalk-canvas-project-bundle";
const PROJECT_BUNDLE_VERSION: u32 = 1;
const BUNDLE_ASSET_PREFIX: &str = "__lentalk_bundle_asset__:";
const MAX_BUNDLE_ASSETS: usize = 2_000;

const RESOURCE_STRING_KEYS: &[&str] = &[
    "imageUrl",
    "previewImageUrl",
    "inputImageUrl",
    "previewInputImageUrl",
    "outputImageUrl",
    "outputPreviewImageUrl",
    "firstFrameImageUrl",
    "firstFramePreviewImageUrl",
    "lastFrameImageUrl",
    "lastFramePreviewImageUrl",
    "sourcePath",
];
const RESOURCE_ARRAY_KEYS: &[&str] = &["imagePool", "referenceImages", "referenceAudio"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBundleAsset {
    token: String,
    entry_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBundleManifest {
    format: String,
    version: u32,
    exported_at: String,
    project: ProjectRecord,
    assets: Vec<ProjectBundleAsset>,
}

struct BundleAssetSource {
    source: String,
    entry_name: String,
    token: String,
    bytes: Vec<u8>,
}

fn app_asset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("library-assets");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create asset directory: {error}"))?;
    Ok(dir)
}

fn is_remote_resource(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
}

fn local_path_from_resource(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if let Some(path) = trimmed.strip_prefix("file://") {
        let decoded = urlencoding::decode(path).ok()?;
        #[cfg(target_os = "windows")]
        let normalized = decoded
            .strip_prefix('/')
            .filter(|item| item.len() >= 3 && item.as_bytes()[1] == b':')
            .unwrap_or(decoded.as_ref());
        #[cfg(not(target_os = "windows"))]
        let normalized = decoded.as_ref();
        return Some(PathBuf::from(normalized));
    }

    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

fn safe_extension(value: &str) -> String {
    let path_like = value.split(['?', '#']).next().unwrap_or(value);
    let extension = Path::new(path_like)
        .extension()
        .and_then(|item| item.to_str())
        .unwrap_or("bin");
    let normalized: String = extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();

    match normalized.as_str() {
        "" => "bin".to_string(),
        "jpeg" => "jpg".to_string(),
        _ => normalized,
    }
}

fn visit_resource_values(value: &mut Value, visitor: &mut impl FnMut(&mut String)) {
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if RESOURCE_STRING_KEYS.contains(&key.as_str()) {
                    if let Value::String(resource) = child {
                        visitor(resource);
                    }
                    continue;
                }

                if RESOURCE_ARRAY_KEYS.contains(&key.as_str()) {
                    if let Some(resources) = child.as_array_mut() {
                        for resource in resources {
                            if let Value::String(resource) = resource {
                                visitor(resource);
                            }
                        }
                    }
                    continue;
                }

                visit_resource_values(child, visitor);
            }
        }
        Value::Array(items) => {
            for item in items {
                visit_resource_values(item, visitor);
            }
        }
        _ => {}
    }
}

fn collect_resources_from_json(raw: &str, resources: &mut HashSet<String>) -> Result<(), String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse project resource data: {error}"))?;
    visit_resource_values(&mut value, &mut |resource| {
        if !resource.trim().is_empty() {
            resources.insert(resource.clone());
        }
    });
    Ok(())
}

fn remap_resources_in_json(raw: &str, mappings: &HashMap<String, String>) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse project resource data: {error}"))?;
    visit_resource_values(&mut value, &mut |resource| {
        if let Some(replacement) = mappings.get(resource) {
            *resource = replacement.clone();
        }
    });
    serde_json::to_string(&value)
        .map_err(|error| format!("Failed to write project resource data: {error}"))
}

fn collect_project_resources(record: &ProjectRecord) -> Result<HashSet<String>, String> {
    let mut resources = HashSet::new();
    collect_resources_from_json(&record.nodes_json, &mut resources)?;
    collect_resources_from_json(&record.history_json, &mut resources)?;
    Ok(resources)
}

fn remap_project_resources(record: &mut ProjectRecord, mappings: &HashMap<String, String>) -> Result<(), String> {
    record.nodes_json = remap_resources_in_json(&record.nodes_json, mappings)?;
    record.history_json = remap_resources_in_json(&record.history_json, mappings)?;
    Ok(())
}

async fn read_resource_bytes(source: &str) -> Result<Vec<u8>, String> {
    if is_remote_resource(source) {
        let response = reqwest::get(source)
            .await
            .map_err(|error| format!("Failed to download project asset {source}: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Project asset download failed {source}: {error}"))?;
        return response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("Failed to read downloaded project asset {source}: {error}"));
    }

    let Some(path) = local_path_from_resource(source) else {
        return Err(format!("Project contains an unsupported non-portable asset reference: {source}"));
    };
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Failed to read project asset {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Project asset is not a file: {}", path.display()));
    }
    fs::read(&path).map_err(|error| format!("Failed to read project asset {}: {error}", path.display()))
}

async fn build_asset_sources(record: &ProjectRecord) -> Result<Vec<BundleAssetSource>, String> {
    let mut resources: Vec<String> = collect_project_resources(record)?.into_iter().collect();
    resources.sort();
    let mut candidates = Vec::new();
    for resource in resources {
        if resource.starts_with("data:") || resource.starts_with("__img_ref__:") {
            continue;
        }
        if is_remote_resource(&resource) || local_path_from_resource(&resource).is_some() {
            candidates.push(resource);
            continue;
        }
        return Err(format!("Project contains an unsupported non-portable asset reference: {resource}"));
    }

    if candidates.len() > MAX_BUNDLE_ASSETS {
        return Err(format!("Project contains too many assets to export ({})", candidates.len()));
    }

    let mut assets = Vec::with_capacity(candidates.len());
    for (index, source) in candidates.into_iter().enumerate() {
        let extension = safe_extension(&source);
        let entry_name = format!("assets/{:04}.{}", index + 1, extension);
        assets.push(BundleAssetSource {
            token: format!("{BUNDLE_ASSET_PREFIX}{entry_name}"),
            source: source.clone(),
            entry_name,
            bytes: read_resource_bytes(&source).await?,
        });
    }
    Ok(assets)
}

#[tauri::command]
pub async fn export_project_bundle(
    record: ProjectRecord,
    destination_path: String,
) -> Result<(), String> {
    let assets = build_asset_sources(&record).await?;
    let mappings: HashMap<String, String> = assets
        .iter()
        .map(|asset| (asset.source.clone(), asset.token.clone()))
        .collect();
    let mut portable_record = record;
    remap_project_resources(&mut portable_record, &mappings)?;

    let manifest = ProjectBundleManifest {
        format: PROJECT_BUNDLE_FORMAT.to_string(),
        version: PROJECT_BUNDLE_VERSION,
        exported_at: chrono_like_timestamp(),
        project: portable_record,
        assets: assets
            .iter()
            .map(|asset| ProjectBundleAsset {
                token: asset.token.clone(),
                entry_name: asset.entry_name.clone(),
            })
            .collect(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to encode project bundle manifest: {error}"))?;

    let destination = PathBuf::from(destination_path.trim());
    let file = File::create(&destination)
        .map_err(|error| format!("Failed to create project bundle {}: {error}", destination.display()))?;
    let mut archive = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file("project.json", options)
        .map_err(|error| format!("Failed to create project manifest entry: {error}"))?;
    archive
        .write_all(&manifest_bytes)
        .map_err(|error| format!("Failed to write project manifest: {error}"))?;

    for asset in assets {
        archive
            .start_file(&asset.entry_name, options)
            .map_err(|error| format!("Failed to create project asset entry: {error}"))?;
        archive
            .write_all(&asset.bytes)
            .map_err(|error| format!("Failed to write project asset: {error}"))?;
    }

    archive
        .finish()
        .map_err(|error| format!("Failed to finish project bundle: {error}"))?;
    Ok(())
}

fn chrono_like_timestamp() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

fn is_safe_bundle_entry(entry_name: &str) -> bool {
    entry_name.starts_with("assets/")
        && !entry_name.contains("..")
        && !entry_name.contains('\\')
        && Path::new(entry_name).components().count() == 2
}

fn restore_bundle_assets(
    app: &AppHandle,
    archive: &mut ZipArchive<File>,
    assets: &[ProjectBundleAsset],
) -> Result<HashMap<String, String>, String> {
    if assets.len() > MAX_BUNDLE_ASSETS {
        return Err(format!("Project bundle contains too many assets ({})", assets.len()));
    }

    let directory = app_asset_directory(app)?;
    let mut mappings = HashMap::with_capacity(assets.len());
    let mut written_paths = Vec::with_capacity(assets.len());

    let restore_result = (|| -> Result<(), String> {
        for asset in assets {
            if !asset.token.starts_with(BUNDLE_ASSET_PREFIX) || !is_safe_bundle_entry(&asset.entry_name) {
                return Err("Project bundle contains an invalid asset entry".to_string());
            }
            let extension = safe_extension(&asset.entry_name);
            let destination = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
            let mut entry = archive
                .by_name(&asset.entry_name)
                .map_err(|error| format!("Project bundle is missing asset {}: {error}", asset.entry_name))?;
            let mut output = File::create(&destination)
                .map_err(|error| format!("Failed to restore project asset: {error}"))?;
            io::copy(&mut entry, &mut output)
                .map_err(|error| format!("Failed to extract project asset: {error}"))?;
            written_paths.push(destination.clone());
            mappings.insert(asset.token.clone(), destination.to_string_lossy().to_string());
        }
        Ok(())
    })();

    if let Err(error) = restore_result {
        for path in written_paths {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }

    Ok(mappings)
}

#[tauri::command]
pub fn import_project_bundle(app: AppHandle, source_path: String) -> Result<ProjectRecord, String> {
    let source = File::open(source_path.trim())
        .map_err(|error| format!("Failed to open project bundle: {error}"))?;
    let mut archive = ZipArchive::new(source)
        .map_err(|error| format!("Failed to read project bundle: {error}"))?;
    let mut manifest_text = String::new();
    archive
        .by_name("project.json")
        .map_err(|error| format!("Project bundle is missing project.json: {error}"))?
        .read_to_string(&mut manifest_text)
        .map_err(|error| format!("Failed to read project bundle manifest: {error}"))?;
    let mut manifest: ProjectBundleManifest = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Failed to parse project bundle manifest: {error}"))?;

    if manifest.format != PROJECT_BUNDLE_FORMAT || manifest.version != PROJECT_BUNDLE_VERSION {
        return Err("Unsupported LenTalk project bundle".to_string());
    }

    let mappings = restore_bundle_assets(&app, &mut archive, &manifest.assets)?;
    if let Err(error) = remap_project_resources(&mut manifest.project, &mappings) {
        for path in mappings.values() {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }

    Ok(manifest.project)
}

#[cfg(test)]
mod tests {
    use super::{collect_project_resources, export_project_bundle, remap_project_resources, ProjectBundleManifest};
    use crate::commands::project_state::ProjectRecord;
    use std::collections::HashMap;
    use std::fs::{self, File};
    use uuid::Uuid;
    use zip::ZipArchive;

    fn project_record() -> ProjectRecord {
        ProjectRecord {
            id: "project-1".to_string(),
            name: "测试项目".to_string(),
            created_at: 1,
            updated_at: 1,
            node_count: 1,
            nodes_json: r#"[{"data":{"imageUrl":"__img_ref__:0","sourcePath":"/tmp/voice.mp3"}}]"#.to_string(),
            edges_json: "[]".to_string(),
            viewport_json: "{}".to_string(),
            history_json: r#"{"past":[],"future":[],"imagePool":["/tmp/frame.png"]}"#.to_string(),
        }
    }

    #[test]
    fn collects_and_remaps_image_pool_and_media_paths() {
        let mut project = project_record();
        let resources = collect_project_resources(&project).expect("resources should parse");
        assert!(resources.contains("/tmp/frame.png"));
        assert!(resources.contains("/tmp/voice.mp3"));

        let mappings = HashMap::from([
            ("/tmp/frame.png".to_string(), "__lentalk_bundle_asset__:assets/0001.png".to_string()),
            ("/tmp/voice.mp3".to_string(), "__lentalk_bundle_asset__:assets/0002.mp3".to_string()),
        ]);
        remap_project_resources(&mut project, &mappings).expect("paths should remap");

        assert!(project.history_json.contains("__lentalk_bundle_asset__:assets/0001.png"));
        assert!(project.nodes_json.contains("__lentalk_bundle_asset__:assets/0002.mp3"));
        assert!(project.nodes_json.contains("__img_ref__:0"));
    }

    #[tokio::test]
    async fn writes_project_data_and_assets_to_a_zip_bundle() {
        let directory = std::env::temp_dir().join(format!("lentalk-project-bundle-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("temporary directory should be created");
        let image_path = directory.join("frame.png");
        let audio_path = directory.join("voice.mp3");
        let bundle_path = directory.join("project.zip");
        fs::write(&image_path, b"image-bytes").expect("image should be written");
        fs::write(&audio_path, b"audio-bytes").expect("audio should be written");

        let project = ProjectRecord {
            nodes_json: serde_json::json!([
                { "data": { "imageUrl": "__img_ref__:0", "sourcePath": audio_path } }
            ])
            .to_string(),
            history_json: serde_json::json!({
                "past": [],
                "future": [],
                "imagePool": [image_path],
            })
            .to_string(),
            ..project_record()
        };

        export_project_bundle(project, bundle_path.to_string_lossy().to_string())
            .await
            .expect("project bundle should export");

        let mut archive = ZipArchive::new(File::open(&bundle_path).expect("bundle should exist"))
            .expect("bundle should be readable");
        let mut manifest_text = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("project.json").expect("manifest should exist"),
            &mut manifest_text,
        )
        .expect("manifest should be readable");
        let manifest: ProjectBundleManifest = serde_json::from_str(&manifest_text)
            .expect("manifest should parse");

        assert_eq!(manifest.assets.len(), 2);
        for asset in &manifest.assets {
            assert!(archive.by_name(&asset.entry_name).is_ok());
        }
        assert!(manifest.project.history_json.contains("__lentalk_bundle_asset__:assets/"));
        assert!(manifest.project.nodes_json.contains("__lentalk_bundle_asset__:assets/"));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }
}
