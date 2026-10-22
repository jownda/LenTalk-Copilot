use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use super::runtime::{args, error_message, run};

static SUBMIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize, Serialize)]
pub struct GenerateWanCliVideoRequest {
    pub client_job_id: Option<String>,
    pub executable: String,
    pub prompt: String,
    pub model_version: String,
    pub duration: u32,
    pub aspect_ratio: String,
    pub video_resolution: Option<String>,
    pub image_mode: Option<String>,
    pub reference_images: Option<Vec<String>>,
    pub reference_audio: Option<Vec<String>>,
}

pub(super) fn generation_args(request: &GenerateWanCliVideoRequest, images: &[String]) -> Result<Vec<String>, String> {
    if request.prompt.trim().is_empty() || request.prompt.chars().count() > 20000 {
        return Err("万相视频提示词不能为空，且不能超过 20000 字符".into());
    }
    if request.model_version != "wan3.0" || !(2..=30).contains(&request.duration) {
        return Err("当前万相视频节点支持 Wan 3.0，时长为 2–30 秒".into());
    }
    if request.reference_audio.as_ref().is_some_and(|items| items.iter().any(|value| !value.trim().is_empty())) {
        return Err("Wan 3.0 的文生视频和首尾帧不接受上传音频；请移除参考音频。参考配音和 Omni 尚未接入此节点".into());
    }
    let resolution = request.video_resolution.as_deref().unwrap_or("720p").to_ascii_uppercase();
    if !["480P", "720P", "1080P"].contains(&resolution.as_str()) {
        return Err("Wan 3.0 支持 480P、720P、1080P 分辨率".into());
    }
    let first_last = request.image_mode.as_deref() == Some("first-last");
    if !["16:9", "9:16", "1:1", "4:3", "3:4"].contains(&request.aspect_ratio.as_str()) {
        return Err("万相视频支持 16:9、9:16、1:1、4:3、3:4 比例".into());
    }
    if first_last && images.len() != 2 { return Err("万相首尾帧需要恰好两张图片".into()); }
    if images.len() > 5 { return Err("万相参考生视频最多支持 5 张图片".into()); }
    let command = if first_last { "frame2video" } else if images.is_empty() { "text2video" } else { "reference2video" };
    let mut result = args(&[command, "--model", "wan3.0", "--prompt", &request.prompt,
        "--duration", &request.duration.to_string(), "--resolution", &resolution]);
    if first_last {
        // Wan 3.0 frame-to-video derives its ratio from the frame images.
        result.extend(args(&["--first-frame", &images[0], "--last-frame", &images[1]]));
    } else {
        result.extend(args(&["--ratio", &request.aspect_ratio]));
        if !images.is_empty() {
            if images.iter().any(|image| image.contains(',')) { return Err("万相参考图片路径不能包含逗号，请重命名后重试".into()); }
            result.extend(args(&["--assets", &images.join(",")]));
        }
    }
    Ok(result)
}

pub(super) fn materialize_images(sources: &[String], directory: &Path) -> Result<Vec<String>, String> {
    sources.iter().enumerate().map(|(index, source)| {
        let source = source.trim();
        if source.starts_with("https://") || source.starts_with("http://") || Path::new(source).is_file() {
            return Ok(source.to_string());
        }
        let (header, data) = source.split_once(',').ok_or("万相参考图片格式无效")?;
        let extension = match header {
            "data:image/png;base64" => "png",
            "data:image/jpeg;base64" | "data:image/jpg;base64" => "jpg",
            "data:image/webp;base64" => "webp",
            _ => return Err("万相参考图片仅支持 PNG、JPEG、WebP".into()),
        };
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "万相参考图片编码无效")?;
        let path = directory.join(format!("reference-{index}.{extension}"));
        std::fs::write(&path, bytes).map_err(|error| format!("无法写入万相参考图：{error}"))?;
        Ok(path.to_string_lossy().into_owned())
    }).collect()
}

fn write_record(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, value.to_string()).map_err(|error| format!("无法保存万相任务：{error}"))?;
    std::fs::rename(temporary, path).map_err(|error| format!("无法保存万相任务：{error}"))
}

pub(super) fn saved_video(value: &Value, directory: &Path) -> Result<String, String> {
    let root = directory.canonicalize().map_err(|error| error.to_string())?;
    for file in value.get("savedFiles").and_then(Value::as_array).into_iter().flatten() {
        if let Some(path) = file.get("path").and_then(Value::as_str) {
            if let Ok(path) = Path::new(path).canonicalize() {
                if path.starts_with(&root) && path.is_file()
                    && path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("mov")) {
                    return Ok(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    Err("万相任务已完成，但未找到下载的视频；重试将继续下载已有任务".into())
}

pub async fn generate_wan_cli_video(app: AppHandle, request: GenerateWanCliVideoRequest) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    generate(&request, &data.join("wan-cli/videos"), |task_id, status| {
        let _ = app.emit("wan-cli-status", json!({ "clientJobId": request.client_job_id, "taskId": task_id, "status": status }));
    }).await
}

pub(super) async fn generate(
    request: &GenerateWanCliVideoRequest,
    root: &Path,
    progress: impl Fn(&str, &str),
) -> Result<String, String> {
    // A persisted client job ID is unique per Generate click and survives app
    // restart. Include input in the digest so edited requests cannot reuse it.
    let fingerprint = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    let run_id = if request.client_job_id.as_ref().is_some_and(|id| !id.is_empty()) {
        format!("{:x}", md5::compute(fingerprint))
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let directory = root.join(run_id);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let record_path = directory.join("task.json");
    let task_id;
    {
        let _guard = SUBMIT_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        if record_path.exists() {
            let record: Value = serde_json::from_slice(&std::fs::read(&record_path).map_err(|error| error.to_string())?)
                .map_err(|_| "万相任务记录损坏；请先使用 wan task list 检查已有任务，避免重复提交")?;
            if let Some(path) = record.get("videoPath").and_then(Value::as_str).filter(|path| Path::new(path).is_file()) {
                return Ok(path.to_string());
            }
            task_id = record.get("taskId").and_then(Value::as_str)
                .ok_or("上次万相提交结果未确认；请先运行 wan task list --output json 查询，勿重复生成")?.to_string();
        } else {
            // Validate before uploading media or creating a paid task.
            let placeholders = vec!["reference.png".to_string(); request.reference_images.as_ref().map_or(0, Vec::len)];
            generation_args(request, &placeholders)?;
            run(&request.executable, &args(&["auth", "status"]), 30).await?;
            let inputs = directory.join("inputs");
            std::fs::create_dir_all(&inputs).map_err(|error| error.to_string())?;
            let images = materialize_images(request.reference_images.as_deref().unwrap_or_default(), &inputs)?;
            let arguments = generation_args(request, &images)?;
            write_record(&record_path, &json!({"status": "submitting"}))?;
            let submitted = run(&request.executable, &arguments, 300).await;
            let _ = std::fs::remove_dir_all(inputs);
            let submitted = submitted.map_err(|error| format!("{error}。请先运行 wan task list --output json 核对提交结果，避免重复扣费"))?;
            task_id = submitted.get("taskId").and_then(|id| id.as_str().map(str::to_string)
                .or_else(|| id.as_u64().map(|number| number.to_string())))
                .filter(|id| !id.is_empty()).ok_or("万相未返回任务 ID；请先查询任务列表，不要重复提交")?;
            write_record(&record_path, &json!({"taskId": task_id}))?;
        }
    }
    let started = Instant::now();
    let mut transient_errors = 0;
    loop {
        if started.elapsed() > Duration::from_secs(30 * 60) {
            return Err(format!("万相任务 {task_id} 等待超时，重试该结果节点将继续查询已有任务"));
        }
        let value = match run(&request.executable, &args(&["result", "get", &task_id]), 60).await {
            Ok(value) => { transient_errors = 0; value },
            Err(error) => {
                transient_errors += 1;
                if error.contains("4018") || transient_errors >= 3 {
                    return Err(format!("万相任务 {task_id}：{error}"));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let status = value.get("statusLabel").and_then(Value::as_str).unwrap_or("unknown");
        progress(&task_id, status);
        match status {
            "succeeded" => {
                let files = run(&request.executable, &args(&["result", "get", &task_id, "--save", "--save-dir", &directory.to_string_lossy()]), 300).await?;
                let path = saved_video(&files, &directory)?;
                write_record(&record_path, &json!({"taskId": task_id, "videoPath": path}))?;
                return Ok(path);
            }
            "failed" => return Err(format!("万相任务 {task_id} 失败：{}", error_message(&value))),
            "queued" | "queued_relax" | "processing" | "thinking" => {},
            _ => return Err(format!("万相任务 {task_id} 返回未知状态 {status}；已保留任务记录")),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
