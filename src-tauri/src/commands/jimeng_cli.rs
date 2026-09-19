use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// The Dreamina CLI refreshes and persists the OAuth record during normal
// commands. Running two CLI processes at once can make its keyring backend
// return "store unavailable" (especially on Windows Credential Manager).
static JIMENG_CLI_PROCESS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const CLI_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
// 提交带多张参考图的任务时, CLI 需要读取并上传本地文件, 速度受磁盘、网络和
// 即梦服务端排队影响。提交命令本身不是生成任务, 但 30 秒对 7-9 张图过于激进。
const CLI_SUBMIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CLI_TASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const JIMENG_CLI_MAX_REFERENCE_IMAGES: usize = 9;

/// 即梦 CLI 官方 Windows 安装包下载前缀（与官方安装脚本 `https://jimeng.jianying.com/cli` 同源）。
/// 仅在用户明确触发「自动安装」时使用；域名为白名单内固定地址，不做任何动态拼接。
const JIMENG_CLI_DOWNLOAD_BASE: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";
const JIMENG_CLI_VERSION_URL: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/version.json";
/// 下载后文件必须大于该阈值才认为有效，避免把错误页/极小残片当安装包。
const JIMENG_CLI_MIN_EXE_BYTES: u64 = 1024 * 1024;

/// Windows: 阻止控制台子进程弹出终端窗口。
/// 即梦 CLI 一次任务会反复调用（提交 + 每 3 秒 query_result + queue_count），
/// 不设置该标志时每个子进程都会闪出一个黑窗口，关闭窗口等于杀掉子进程导致命令失败。
/// macOS 无此机制，保持原有行为。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Deserialize)]
pub struct GenerateJimengCliVideoRequest {
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

#[tauri::command]
pub async fn generate_jimeng_cli_video(
    app: AppHandle,
    request: GenerateJimengCliVideoRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate_video_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦 CLI 任务执行中断: {error}"))?
}

fn generate_video_blocking(
    app: &AppHandle,
    request: GenerateJimengCliVideoRequest,
) -> Result<String, String> {
    let executable = request.executable.trim();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("即梦 CLI 视频生成需要提示词".to_string());
    }
    let video_resolution = resolve_video_resolution(&request);
    validate_model_and_duration(&request.model_version, request.duration, &video_resolution)?;

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-cli-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦 CLI 临时目录: {error}"))?;

    let result = (|| {
        let reference_images = materialize_data_urls(
            request.reference_images.as_deref().unwrap_or_default(),
            &input_dir,
            "image",
        )?;
        if reference_images.len() > JIMENG_CLI_MAX_REFERENCE_IMAGES {
            return Err(format!(
                "即梦 CLI 最多支持 {} 张参考图片，当前有 {} 张，请删除多余参考图后重试",
                JIMENG_CLI_MAX_REFERENCE_IMAGES,
                reference_images.len()
            ));
        }
        let reference_audio = materialize_audio_files(
            request.reference_audio.as_deref().unwrap_or_default(),
        )?;
        let command = resolve_video_command(
            request.image_mode.as_deref(),
            &reference_images,
            &reference_audio,
        )?;
        if command == "multimodal2video"
            && reference_images.is_empty()
            && request.model_version != "seedance2.5"
        {
            return Err("即梦 CLI 的纯音频参考需要选择 Seedance 2.5".to_string());
        }
        let download_dir = resolve_download_dir(app, &run_id)?;
        run_jimeng_video_task(
            app,
            executable,
            &command,
            &request,
            &video_resolution,
            &reference_images,
            &reference_audio,
            &download_dir,
        )
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

fn resolve_video_resolution(request: &GenerateJimengCliVideoRequest) -> String {
    request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("720p")
        .to_ascii_lowercase()
}

fn validate_model_and_duration(
    model_version: &str,
    duration: u32,
    video_resolution: &str,
) -> Result<(), String> {
    const SUPPORTED: [&str; 6] = [
        "seedance2.0",
        "seedance2.0fast",
        "seedance2.0_vip",
        "seedance2.0fast_vip",
        "seedance2.0mini",
        "seedance2.5",
    ];
    if !SUPPORTED.contains(&model_version) {
        return Err(format!("即梦 CLI 不支持视频模型: {model_version}"));
    }
    let maximum = if model_version == "seedance2.5" { 30 } else { 15 };
    if !(4..=maximum).contains(&duration) {
        return Err(format!(
            "{model_version} 支持 4–{maximum} 秒视频，请在节点中调整时长"
        ));
    }
    let supported_resolutions: &[&str] = match model_version {
        "seedance2.5" => &["480p", "720p", "1080p"],
        "seedance2.0_vip" => &["720p", "1080p", "4k"],
        _ => &["720p"],
    };
    if !supported_resolutions.contains(&video_resolution) {
        return Err(format!(
            "{model_version} 不支持 {video_resolution}，可选：{}",
            supported_resolutions.join("、")
        ));
    }
    Ok(())
}

fn materialize_data_urls(
    sources: &[String],
    directory: &Path,
    prefix: &str,
) -> Result<Vec<PathBuf>, String> {
    sources
        .iter()
        .filter(|source| !source.trim().is_empty())
        .enumerate()
        .map(|(index, source)| {
            let (mime, encoded) = source
                .split_once(',')
                .ok_or_else(|| "即梦 CLI 参考图片格式无效".to_string())?;
            if !mime.starts_with("data:image/") {
                return Err("即梦 CLI 参考图片必须是图片文件".to_string());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| format!("无法读取即梦 CLI 参考图片: {error}"))?;
            let extension = mime
                .split(';')
                .next()
                .and_then(|value| value.rsplit('/').next())
                .filter(|value| matches!(*value, "png" | "jpeg" | "jpg" | "webp"))
                .unwrap_or("png");
            let path = directory.join(format!("{prefix}-{}.{}", index + 1, extension));
            fs::write(&path, bytes)
                .map_err(|error| format!("无法写入即梦 CLI 参考图片: {error}"))?;
            Ok(path)
        })
        .collect()
}

fn materialize_audio_files(sources: &[String]) -> Result<Vec<PathBuf>, String> {
    sources
        .iter()
        .filter(|source| !source.trim().is_empty())
        .map(|source| {
            let path = source_path(source);
            if path.is_file() {
                Ok(path)
            } else {
                Err("即梦 CLI 的音频参考必须来自已连接的本地音频节点".to_string())
            }
        })
        .collect()
}

fn source_path(source: &str) -> PathBuf {
    let trimmed = source.trim();
    if let Some(path) = trimmed.strip_prefix("file://") {
        let decoded = urlencoding::decode(path).unwrap_or_else(|_| path.into());
        let decoded_str: &str = decoded.as_ref();
        // Windows 下 file:// 路径形如 /C:/xxx, 去掉前导斜杠
        #[cfg(target_os = "windows")]
        let decoded_str = decoded_str.strip_prefix('/').unwrap_or(decoded_str);
        return PathBuf::from(decoded_str);
    }
    PathBuf::from(trimmed)
}

fn resolve_video_command(
    image_mode: Option<&str>,
    images: &[PathBuf],
    audio: &[PathBuf],
) -> Result<&'static str, String> {
    if image_mode == Some("first-last") {
        if images.len() != 2 {
            return Err("即梦 CLI 首尾帧模式需要两张图片".to_string());
        }
        if !audio.is_empty() {
            return Err("即梦 CLI 首尾帧模式暂不支持同时引用音频".to_string());
        }
        return Ok("frames2video");
    }

    if images.is_empty() && audio.is_empty() {
        return Ok("text2video");
    }

    // LenTalk 的「参考模式」必须保持为参考生视频。即梦的 image2video
    // 语义是图生视频，会把唯一一张图片当作首帧，并按图片原比例推断画幅，
    // 从而让节点里选择的 9:16 被 4:3 等图片比例覆盖。只有显式传入
    // 非参考模式的旧调用才保留 image2video 兼容行为。
    if image_mode != Some("reference") && images.len() == 1 && audio.is_empty() {
        return Ok("image2video");
    }
    Ok("multimodal2video")
}

fn resolve_download_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let output_dir = app_data_dir.join("jimeng-cli/videos").join(run_id);
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("无法创建即梦 CLI 下载目录: {error}"))?;
    Ok(output_dir)
}

fn run_jimeng_video_task(
    app: &AppHandle,
    executable: &str,
    command: &str,
    request: &GenerateJimengCliVideoRequest,
    video_resolution: &str,
    images: &[PathBuf],
    audio: &[PathBuf],
    download_dir: &Path,
) -> Result<String, String> {
    let mut arguments = vec![command.to_string()];
    append_generation_args(
        &mut arguments,
        command,
        request,
        video_resolution,
        images,
        audio,
    );
    // 先提交并立即返回 submit_id，后续由本函数自行查询并向前端上报状态。
    arguments.push("--poll=0".to_string());

    submit_and_poll_jimeng_task(
        app,
        executable,
        arguments,
        request.client_job_id.as_deref(),
        download_dir,
        JimengArtifactKind::Video,
    )
}

/// 产物类型: 视频与图片走同一条提交-轮询链路, 只有落盘文件的扩展名与文案不同。
#[derive(Clone, Copy, PartialEq, Eq)]
enum JimengArtifactKind {
    Video,
    Image,
}

/// 提交即梦 CLI 任务并轮询到终态。
///
/// 两者共用同一链路: `--poll=0` 先拿到 submit_id, 再用 `query_result`
/// 每 3 秒查询一次, 产物被 `--download_dir` 落到本地文件。
fn submit_and_poll_jimeng_task(
    app: &AppHandle,
    executable: &str,
    arguments: Vec<String>,
    client_job_id: Option<&str>,
    download_dir: &Path,
    artifact: JimengArtifactKind,
) -> Result<String, String> {
    let label = match artifact {
        JimengArtifactKind::Video => "视频",
        JimengArtifactKind::Image => "图片",
    };

    let submission = run_cli_with_timeout(executable, &arguments, CLI_SUBMIT_COMMAND_TIMEOUT)?;
    if is_failed(&submission) {
        return Err(format!("即梦 CLI {label}生成失败: {}", output_summary(&submission)));
    }
    // --poll=0 通常只提交任务；保留即时结果分支，兼容 CLI 后端直接返回成品的情况。
    if is_succeeded(&submission) {
        if let Some(result) = find_downloaded_artifact(download_dir, artifact) {
            return Ok(result);
        }
        if let Some(url) = extract_http_url(&submission) {
            return Ok(url);
        }
    }
    let submit_id = extract_field(&submission, &["submit_id", "submitId"])
        .ok_or_else(|| format!("即梦 CLI 未返回 submit_id: {}", output_summary(&submission)))?;

    emit_cli_task_status(app, client_job_id, &submit_id, "queued", queue_count(executable), None);

    let task_deadline = Instant::now() + CLI_TASK_TIMEOUT;
    loop {
        if Instant::now() >= task_deadline {
            emit_cli_task_status(
                app,
                client_job_id,
                &submit_id,
                "failed",
                queue_count(executable),
                Some("即梦 CLI 任务超过 30 分钟仍未完成，已停止轮询".to_string()),
            );
            return Err("即梦 CLI 任务超时（超过 30 分钟）".to_string());
        }
        let query = run_cli(
            executable,
            &[
                "query_result".to_string(),
                format!("--submit_id={submit_id}"),
                format!("--download_dir={}", download_dir.display()),
            ],
        )?;

        if is_failed(&query) {
            emit_cli_task_status(app, client_job_id, &submit_id, "failed", queue_count(executable), Some(output_summary(&query)));
            return Err(format!("即梦 CLI {label}生成失败: {}", output_summary(&query)));
        }
        if is_succeeded(&query) {
            if let Some(result) = find_downloaded_artifact(download_dir, artifact) {
                emit_cli_task_status(app, client_job_id, &submit_id, "succeeded", Some(0), None);
                return Ok(result);
            }
            if let Some(url) = extract_http_url(&query) {
                emit_cli_task_status(app, client_job_id, &submit_id, "succeeded", Some(0), None);
                return Ok(url);
            }
            emit_cli_task_status(app, client_job_id, &submit_id, "failed", Some(0), Some(format!("任务已完成但未找到{label}文件")));
            return Err(format!("即梦 CLI 已完成任务，但未找到下载的{label}文件"));
        }

        let status = extract_field(&query, &["gen_status"]).unwrap_or_else(|| "querying".to_string());
        let normalized_status = match status.to_ascii_lowercase().as_str() {
            "querying" | "queued" | "pending" => "queued",
            "success" | "succeeded" | "fail" | "failed" => status.as_str(),
            _ => "running",
        };
        emit_cli_task_status(app, client_job_id, &submit_id, normalized_status, queue_count(executable), None);

        thread::sleep(Duration::from_secs(3));
    }
}

#[derive(Clone, serde::Serialize)]
struct JimengCliTaskStatusEvent {
    client_job_id: Option<String>,
    submit_id: String,
    status: String,
    queue_count: Option<usize>,
    message: Option<String>,
}

/// 视频与图片共用同一个事件名, 前端只需监听 `jimeng-cli-status` 一处。
fn emit_cli_task_status(
    app: &AppHandle,
    client_job_id: Option<&str>,
    submit_id: &str,
    status: &str,
    queue_count: Option<usize>,
    message: Option<String>,
) {
    let _ = app.emit(
        "jimeng-cli-status",
        JimengCliTaskStatusEvent {
            client_job_id: client_job_id.map(str::to_string),
            submit_id: submit_id.to_string(),
            status: status.to_string(),
            queue_count,
            message,
        },
    );
}

fn queue_count(executable: &str) -> Option<usize> {
    let output = run_cli(executable, &["list_task".to_string(), "--limit=100".to_string()]).ok()?;
    let value: serde_json::Value = serde_json::from_str(&output).ok()?;
    let tasks = value.as_array()?;
    Some(tasks.iter().filter(|task| {
        task.get("gen_status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| matches!(status.to_ascii_lowercase().as_str(), "querying" | "queued" | "pending"))
    }).count())
}

fn append_generation_args(
    arguments: &mut Vec<String>,
    command: &str,
    request: &GenerateJimengCliVideoRequest,
    video_resolution: &str,
    images: &[PathBuf],
    audio: &[PathBuf],
) {
    arguments.push(format!("--prompt={}", request.prompt.trim()));
    arguments.push(format!("--model_version={}", request.model_version));
    arguments.push(format!("--duration={}", request.duration));
    arguments.push(format!("--video_resolution={video_resolution}"));

    // 首尾帧模式的画幅由首帧图片决定，传 --ratio 会触发 CLI 的严格校验，
    // 且可能与首帧实际比例不一致。参考模式走 multimodal2video，必须显式
    // 传节点选中的 ratio，避免 CLI 按参考图比例生成。
    if command != "image2video" && command != "frames2video" {
        arguments.push(format!("--ratio={}", request.aspect_ratio));
    }

    match command {
        "image2video" => {
            arguments.push(format!("--image={}", images[0].display()));
        }
        "frames2video" => {
            arguments.push(format!("--first={}", images[0].display()));
            arguments.push(format!("--last={}", images[1].display()));
        }
        "multimodal2video" => {
            for image in images {
                arguments.push(format!("--image={}", image.display()));
            }
            for audio_path in audio {
                arguments.push(format!("--audio={}", audio_path.display()));
            }
        }
        _ => {}
    }
}

fn run_cli(executable: &str, arguments: &[String]) -> Result<String, String> {
    run_cli_with_timeout(executable, arguments, CLI_COMMAND_TIMEOUT)
}

fn run_cli_with_timeout(
    executable: &str,
    arguments: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let lock = JIMENG_CLI_PROCESS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "即梦 CLI 调用锁异常，请重启应用后重试".to_string())?;
    let resolved = resolve_executable(executable)?;
    let mut command = build_cli_command(&resolved);
    #[cfg(target_os = "windows")]
    if is_windows_script(&resolved) {
        // cmd.exe /S /C requires an extra pair of quotes around the complete
        // command when the executable path itself is quoted. Without it,
        // paths with spaces can be split before the .cmd/.bat file runs.
        let command_line = std::iter::once(quote_windows_arg(&resolved))
            .chain(arguments.iter().map(|argument| quote_windows_arg(argument)))
            .collect::<Vec<_>>()
            .join(" ");
        command.args(["/D", "/V:OFF", "/S", "/C"]).arg(format!("\"{command_line}\""));
    } else {
        command.args(arguments);
    }
    #[cfg(not(target_os = "windows"))]
    command.args(arguments);
    #[cfg(target_os = "windows")]
    {
        // 子进程不再弹出终端窗口；同时确保 stdio 全部被管道接管，
        // 避免 CLI 因无控制台而尝试分配新的控制台窗口。
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "无法启动即梦 CLI（{resolved}）: {error}。请确认已安装 CLI，并在设置中填写正确命令或完整路径"
            )
        })?;
    let started_at = Instant::now();
    let output = loop {
        match child.try_wait() {
            Ok(Some(_status)) => break child
                .wait_with_output()
                .map_err(|error| format!("读取即梦 CLI 输出失败: {error}"))?,
            Ok(None) if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("即梦 CLI 命令超过 {} 秒未返回", timeout.as_secs()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法检查即梦 CLI 进程状态: {error}"));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    drop(lock);
    if output.status.success() {
        Ok(combined)
    } else {
        Err(format!("即梦 CLI 命令执行失败: {}", output_summary(&combined)))
    }
}

/// GUI applications inherit a minimal environment. Keep the CLI's user
/// profile and executable search paths explicit so its credential backend and
/// helper commands behave the same as when launched from a terminal.
fn build_cli_command(resolved: &str) -> Command {
    #[cfg(target_os = "windows")]
    let mut command = if is_windows_script(resolved) {
        let command = Command::new("cmd.exe");
        // Arguments are assembled in run_cli and passed as one /C command
        // string so paths under `Program Files` and flags remain intact.
        command
    } else {
        Command::new(resolved)
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(resolved);
    if let Some(home) = current_user_home() {
        command.env("HOME", &home);
        #[cfg(target_os = "windows")]
        {
            command.env("USERPROFILE", &home);
            command.env("APPDATA", PathBuf::from(&home).join("AppData/Roaming"));
            command.env("LOCALAPPDATA", PathBuf::from(&home).join("AppData/Local"));
        }
        if let Some(parent) = Path::new(resolved).parent() {
            let mut paths = vec![parent.to_path_buf()];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
        // Avoid an invalid working directory inherited from a desktop shell.
        command.current_dir(home);
    }
    command
}

#[cfg(target_os = "windows")]
fn quote_windows_arg(argument: &str) -> String {
    if argument.is_empty()
        || argument.chars().any(char::is_whitespace)
        || argument.contains('"')
        || argument.chars().any(|character| matches!(character, '&' | '|' | '<' | '>' | '^' | '(' | ')'))
    {
        format!("\"{}\"", argument.replace('"', "\\\""))
    } else {
        argument.to_string()
    }
}

#[cfg(target_os = "windows")]
fn is_windows_script(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("cmd" | "bat")
    )
}

fn current_user_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|path| path.is_dir());
    }

    #[cfg(not(target_os = "windows"))]
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

/// 解析即梦 CLI 可执行文件:
/// - 绝对路径/含斜杠 → 直接校验文件存在;
/// - 命令名 → 先查当前进程 PATH, 再查常见安装目录。
/// macOS GUI 应用(从 Finder 启动)不继承 shell 的 PATH(~/.local/bin 不在其中),
/// 因此必须主动探测常见安装位置, 否则会报 "No such file or directory"。
fn resolve_executable(requested: &str) -> Result<String, String> {
    let trimmed = requested.trim().trim_matches(['"', '\'']);
    if trimmed.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let expanded = expand_windows_path(trimmed);
    if Path::new(&expanded).is_absolute() || expanded.contains('/') || expanded.contains('\\') {
        if Path::new(&expanded).is_file() {
            return Ok(expanded);
        }
        return Err(format!(
            "即梦 CLI 路径不存在: {trimmed}，请检查设置中填写的完整路径"
        ));
    }
    if let Some(found) = find_in_path(&expanded) {
        return Ok(found);
    }
    for candidate in common_locations(&expanded) {
        if Path::new(&candidate).is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "未找到即梦 CLI（{trimmed}）。请先在终端运行 `dreamina -h` 验证安装，或在设置中填写完整路径（Windows 示例：%USERPROFILE%\\bin\\dreamina.exe）"
    ))
}

fn expand_windows_path(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        let mut expanded = path.to_string();
        if expanded == "~" || expanded.starts_with("~\\") || expanded.starts_with("~/") {
            if let Some(home) = current_user_home() {
                expanded = format!("{}{}", home.display(), &expanded[1..]);
            }
        }
        let mut output = String::with_capacity(expanded.len());
        let mut remainder = expanded.as_str();
        while let Some(start) = remainder.find('%') {
            output.push_str(&remainder[..start]);
            let after_start = &remainder[start + 1..];
            let Some(end) = after_start.find('%') else {
                output.push('%');
                output.push_str(after_start);
                remainder = "";
                break;
            };
            let variable = &after_start[..end];
            if let Some(value) = std::env::var_os(variable) {
                output.push_str(&value.to_string_lossy());
            } else {
                output.push('%');
                output.push_str(variable);
                output.push('%');
            }
            remainder = &after_start[end + 1..];
        }
        output.push_str(remainder);
        return output;
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

fn find_in_path(command: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        #[cfg(target_os = "windows")]
        {
            for suffix in windows_command_suffixes(command) {
                let candidate = dir.join(format!("{command}{suffix}"));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let candidate = dir.join(command);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_command_suffixes(command: &str) -> Vec<&'static str> {
    if Path::new(command).extension().is_some() {
        return vec![""];
    }
    // The installer may produce an .exe, while npm/npm.cmd and shell shims
    // commonly expose .cmd or .bat. PATHEXT is preferred when available.
    let mut suffixes = Vec::new();
    if let Some(path_ext) = std::env::var_os("PATHEXT") {
        for extension in path_ext.to_string_lossy().split(';') {
            match extension.to_ascii_lowercase().as_str() {
                ".com" => suffixes.push(".com"),
                ".exe" => suffixes.push(".exe"),
                ".bat" => suffixes.push(".bat"),
                ".cmd" => suffixes.push(".cmd"),
                _ => {}
            }
        }
    }
    for suffix in [".exe", ".cmd", ".bat", ""] {
        if !suffixes.contains(&suffix) {
            suffixes.push(suffix);
        }
    }
    suffixes
}

/// 常见安装目录(覆盖 GUI 启动无 shell PATH 的场景)
fn common_locations(command: &str) -> Vec<String> {
    let home = current_user_home().unwrap_or_default();
    #[allow(unused_mut)]
    let mut directories = vec![
        home.join(".local/bin"),
        home.join(".dreamina_cli/bin"),
        home.join(".dreamina_cli"),
        home.join(".cargo/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    #[cfg(target_os = "windows")]
    {
        // The official Windows installer defaults to %USERPROFILE%\\bin.
        directories.push(home.join("bin"));
        if let Some(app_data) = std::env::var_os("APPDATA") {
            directories.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            directories.push(PathBuf::from(local_app_data.clone()).join("Programs"));
            directories.push(PathBuf::from(local_app_data).join("dreamina"));
        }
        directories.push(home.join("AppData/Roaming/npm"));
        directories.push(home.join("AppData/Local/Programs"));
    }
    directories
    .into_iter()
    .flat_map(|dir| {
        let path = dir.join(command);
        #[cfg(target_os = "windows")]
        {
            windows_command_suffixes(command)
                .into_iter()
                .map(|suffix| format!("{}{}", path.display(), suffix))
                .collect::<Vec<_>>()
        }
        #[cfg(not(target_os = "windows"))]
        {
            vec![path.to_string_lossy().into_owned()]
        }
    })
    .collect()
}

fn extract_field(output: &str, names: &[&str]) -> Option<String> {
    for name in names {
        for (index, _) in output.match_indices(name) {
            let remainder = output[index + name.len()..]
                .trim_start_matches(|character: char| character == ' ' || character == ':' || character == '=' || character == '"');
            let value = remainder
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
                .collect::<String>();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn is_succeeded(output: &str) -> bool {
    extract_field(output, &["gen_status"]).is_some_and(|status| {
        status.eq_ignore_ascii_case("success") || status.eq_ignore_ascii_case("succeeded")
    })
}

fn is_failed(output: &str) -> bool {
    extract_field(output, &["gen_status"])
        .is_some_and(|status| status.eq_ignore_ascii_case("fail") || status.eq_ignore_ascii_case("failed"))
}

fn find_downloaded_video(directory: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(directory).ok()?;
    entries.flatten().find_map(|entry| {
        let path = entry.path();
        if path.is_dir() {
            return find_downloaded_video(&path);
        }
        let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
        matches!(extension.as_str(), "mp4" | "mov" | "webm" | "mkv").then_some(path)
    })
}

fn find_downloaded_images(directory: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return paths;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            paths.extend(find_downloaded_images(&path));
            continue;
        }
        let Some(extension) = path.extension() else {
            continue;
        };
        let extension = extension.to_string_lossy().to_ascii_lowercase();
        if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            paths.push(path);
        }
    }
    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    paths
}

fn find_downloaded_artifact(directory: &Path, artifact: JimengArtifactKind) -> Option<String> {
    match artifact {
        JimengArtifactKind::Video => find_downloaded_video(directory)
            .map(|path| path.to_string_lossy().into_owned()),
        JimengArtifactKind::Image => {
            let paths = find_downloaded_images(directory);
            if paths.is_empty() {
                return None;
            }
            if paths.len() == 1 {
                return Some(paths[0].to_string_lossy().into_owned());
            }
            serde_json::to_string(
                &paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            )
            .ok()
        }
    }
}

fn extract_http_url(output: &str) -> Option<String> {
    for prefix in ["https://", "http://"] {
        if let Some(index) = output.find(prefix) {
            let value = output[index..]
                .chars()
                .take_while(|character| !character.is_whitespace() && !matches!(character, '"' | '\'' | ')' | ']'))
                .collect::<String>();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn output_summary(output: &str) -> String {
    let compact = output.split_whitespace().collect::<Vec<_>>().join(" ");

    // Query responses include the prompt before the actual failure reason.
    // Prefer status/error fields so a long prompt cannot hide the actionable
    // message in the generated error report.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&compact) {
        if let Some(object) = value.as_object() {
            let fields = [
                "gen_status",
                "fail_reason",
                "error",
                "error_message",
                "message",
                "submit_id",
            ];
            let summary = fields
                .iter()
                .filter_map(|field| object.get(*field).map(|value| format!("{field}={value}")))
                .collect::<Vec<_>>()
                .join(", ");
            if !summary.is_empty() {
                return summary;
            }
        }
    }

    if compact.len() > 500 {
        // `str::len` is measured in bytes, while Rust string slices must end
        // on a UTF-8 character boundary. Find the last valid boundary within
        // the byte limit instead of slicing directly at byte 500.
        let end = compact
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= 500)
            .last()
            .unwrap_or(0);
        format!("{}…", &compact[..end])
    } else {
        compact
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliLoginStartResult {
    /// true = 需要用户在浏览器完成授权; false = 已复用本地登录态
    pub need_auth: bool,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub device_code: Option<String>,
    pub message: String,
}

#[derive(Debug, serde::Serialize)]
pub struct JimengCliLoginCheckResult {
    pub success: bool,
    pub message: String,
}

/// 开始即梦 CLI 登录: 运行 `dreamina login --headless` 获取设备码登录材料。
/// - 已登录 → need_auth=false
/// - 未登录 → 解析出 verification_uri / user_code / device_code, 由前端打开浏览器并轮询 checklogin
#[tauri::command]
pub async fn jimeng_cli_login_start(executable: String) -> Result<JimengCliLoginStartResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let value = executable.clone();
    let output = tokio::task::spawn_blocking(move || {
        run_cli(&value, &["login".to_string(), "--headless".to_string()])
    })
    .await
    .map_err(|error| format!("即梦 CLI 登录任务中断: {error}"))??;

    let lower = output.to_ascii_lowercase();
    let already_logged_in = lower.contains("复用") || lower.contains("已登录")
        || lower.contains("already logged") || lower.contains("reuse") || lower.contains("logged in");
    if already_logged_in {
        return Ok(JimengCliLoginStartResult {
            need_auth: false,
            verification_uri: None,
            user_code: None,
            device_code: None,
            message: output.trim().to_string(),
        });
    }

    let verification_uri = extract_url_field(&output);
    let user_code = extract_field(&output, &["user_code", "userCode"]);
    let device_code = extract_field(&output, &["device_code", "deviceCode"]);

    let Some(verification_uri) = verification_uri else {
        return Err(format!(
            "无法从即梦 CLI 输出中找到验证地址，请手动在终端执行 `{} login` 完成登录。原始输出: {}",
            executable,
            output_summary(&output)
        ));
    };
    if user_code.is_none() || device_code.is_none() {
        return Err(format!(
            "无法从即梦 CLI 输出中解析用户码/设备码，请手动在终端执行 `{} login` 完成登录。原始输出: {}",
            executable,
            output_summary(&output)
        ));
    }

    Ok(JimengCliLoginStartResult {
        need_auth: true,
        verification_uri: Some(verification_uri),
        user_code,
        device_code,
        message: output.trim().to_string(),
    })
}

/// 查询即梦 CLI 设备码登录是否完成: `dreamina login checklogin --device_code=xxx`。
/// 前端每 2~3 秒轮询一次, 直到 success=true 或出现失败/过期。
#[tauri::command]
pub async fn jimeng_cli_login_check(
    executable: String,
    device_code: String,
) -> Result<JimengCliLoginCheckResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let device_code = device_code.trim().to_string();
    let output = tokio::task::spawn_blocking(move || {
        run_cli(&executable, &[
            "login".to_string(),
            "checklogin".to_string(),
            format!("--device_code={device_code}"),
            "--poll=0".to_string(),
        ])
    })
    .await
    .map_err(|error| format!("即梦 CLI 登录检查中断: {error}"))??;

    let lower = output.to_ascii_lowercase();
    let success = lower.contains("成功") || lower.contains("已登录")
        || lower.contains("success") || lower.contains("logged in");
    Ok(JimengCliLoginCheckResult {
        success,
        message: output.trim().to_string(),
    })
}

/// 从 CLI 输出中提取 http(s) 验证地址(优先取 verification_uri/verification_url 字段, 兜底找任意 http 链接)。
fn extract_url_field(output: &str) -> Option<String> {
    for name in [
        "verification_uri",
        "verification_url",
        "verificationUrl",
        "verificationUri",
        "auth_url",
        "authUrl",
        "login_url",
        "loginUrl",
    ] {
        if let Some(index) = output.find(name) {
            let remainder = output[index + name.len()..].trim_start_matches(
                |character: char| character == ' ' || character == ':' || character == '=' || character == '"' || character == '\'',
            );
            let value = remainder
                .chars()
                .take_while(|character| !character.is_whitespace() && !matches!(character, '"' | '\'' | ',' | ')'))
                .collect::<String>();
            if value.starts_with("http") {
                return Some(value);
            }
        }
    }
    // 兜底: 输出里任意 https?:// 开头直到空白
    for prefix in ["https://", "http://"] {
        if let Some(index) = output.find(prefix) {
            let value = output[index..]
                .chars()
                .take_while(|character| !character.is_whitespace() && !matches!(character, '"' | '\'' | ')' | ']' | ','))
                .collect::<String>();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_start_result_serializes_camel_case() {
        let result = JimengCliLoginStartResult {
            need_auth: true,
            verification_uri: Some("https://example.com/auth".to_string()),
            user_code: Some("ABC-123".to_string()),
            device_code: Some("def456".to_string()),
            message: "ok".to_string(),
        };
        let value = serde_json::to_value(&result).expect("result serializes");
        let object = value.as_object().expect("result is an object");
        assert!(object.contains_key("needAuth"));
        assert!(object.contains_key("verificationUri"));
        assert!(object.contains_key("userCode"));
        assert!(object.contains_key("deviceCode"));
        assert!(object.contains_key("message"));
        assert!(!object.contains_key("need_auth"));
    }

    #[test]
    fn parses_current_headless_login_output() {
        let output = "✓ 请使用浏览器完成 OAuth Device Flow 登录。 verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?verification_uri=https%3A%2F%2Fjimeng.jianying.com%2Fpassport%2Fopen%2Fscan_user_code%2F%3Fuser_code%3De1c08104fb4102e12ffb67d73c8efa0e user_code: e1c08104fb4102e12ffb67d73c8efa0e device_code: fa27cecdb576a27dc37cad8c812928a0 poll_interval: 1s expires_at: 2026-08-24T09:38:56+08:00";
        assert_eq!(
            extract_url_field(output).as_deref(),
            Some("https://jimeng.jianying.com/ai-tool/cli-auth?verification_uri=https%3A%2F%2Fjimeng.jianying.com%2Fpassport%2Fopen%2Fscan_user_code%2F%3Fuser_code%3De1c08104fb4102e12ffb67d73c8efa0e")
        );
        assert_eq!(extract_field(output, &["user_code"]).as_deref(), Some("e1c08104fb4102e12ffb67d73c8efa0e"));
        assert_eq!(extract_field(output, &["device_code"]).as_deref(), Some("fa27cecdb576a27dc37cad8c812928a0"));
    }

    #[test]
    fn extracts_verification_url_and_codes() {
        let output = r#"
verification_uri: https://jimeng.jianying.com/oauth/device/activate
user_code: ABCD-EFGH
device_code: 8f3a2b9c1d4e5f6a7b8c9d0e
"#;
        assert_eq!(
            extract_url_field(output).as_deref(),
            Some("https://jimeng.jianying.com/oauth/device/activate")
        );
        assert_eq!(extract_field(output, &["user_code"]).as_deref(), Some("ABCD-EFGH"));
        assert_eq!(
            extract_field(output, &["device_code"]).as_deref(),
            Some("8f3a2b9c1d4e5f6a7b8c9d0e")
        );
    }

    #[test]
    fn extracts_url_from_json_output() {
        let output = r#"{"verification_uri":"https://jimeng.jianying.com/activate","user_code":"1234-5678","device_code":"abc123"}"#;
        assert_eq!(
            extract_url_field(output).as_deref(),
            Some("https://jimeng.jianying.com/activate")
        );
        assert_eq!(extract_field(output, &["user_code"]).as_deref(), Some("1234-5678"));
        assert_eq!(extract_field(output, &["device_code"]).as_deref(), Some("abc123"));
    }

    #[test]
    fn falls_back_to_any_http_url() {
        let output = "请打开 https://jimeng.jianying.com/oauth/device 完成授权";
        assert_eq!(
            extract_url_field(output).as_deref(),
            Some("https://jimeng.jianying.com/oauth/device")
        );
    }

    #[test]
    fn returns_none_without_url() {
        assert_eq!(extract_url_field("已复用当前本地 OAuth 登录态。"), None);
    }

    #[test]
    fn resolves_absolute_path_when_file_exists() {
        let current = std::env::current_exe().expect("current exe");
        let path = current.to_string_lossy().into_owned();
        assert_eq!(resolve_executable(&path).expect("absolute path"), path);
    }

    #[test]
    fn rejects_missing_absolute_path() {
        let error = resolve_executable("/nonexistent/dreamina").expect_err("should fail");
        assert!(error.contains("路径不存在"), "unexpected error: {error}");
    }

    #[test]
    fn resolves_command_via_common_locations() {
        // 本机已装 ~/.local/bin/dreamina 时应能解析成功(不依赖 GUI 的 PATH)
        if let Ok(resolved) = resolve_executable("dreamina") {
            assert!(std::path::Path::new(&resolved).is_file(), "resolved file exists");
        }
    }

    #[test]
    fn common_locations_include_home_dirs() {
        let locations = common_locations("dreamina").into_iter().map(|p| p.replace('\\', "/")).collect::<Vec<_>>();
        assert!(locations.iter().any(|p| p.ends_with(".local/bin/dreamina") || p.ends_with(".local/bin/dreamina.exe")));
        assert!(locations.iter().any(|p| p.ends_with(".cargo/bin/dreamina") || p.ends_with(".cargo/bin/dreamina.exe")));
    }

    #[test]
    fn official_download_base_matches_install_script() {
        assert!(JIMENG_CLI_DOWNLOAD_BASE.ends_with("/dreamina_cli_beta"));
        assert!(JIMENG_CLI_VERSION_URL.ends_with("/version.json"));
        assert!(!JIMENG_CLI_VERSION_URL.contains("dreamina_cli_beta"));
    }

    #[test]
    fn output_summary_truncates_chinese_without_panicking() {
        let output = format!("{}车后续输出", "a".repeat(498));
        let summary = output_summary(&output);

        assert_eq!(summary, format!("{}…", "a".repeat(498)));
    }

    #[test]
    fn output_summary_prioritizes_cli_failure_reason_over_prompt() {
        let output = serde_json::json!({
            "submit_id": "example-task",
            "prompt": "a very long prompt",
            "gen_status": "fail",
            "fail_reason": "image_resource_id_list length is 10, should be <= 9"
        })
        .to_string();

        let summary = output_summary(&output);

        assert!(summary.contains("gen_status=\"fail\""));
        assert!(summary.contains("image_resource_id_list length is 10"));
        assert!(!summary.contains("very long prompt"));
    }

    #[test]
    fn extract_json_object_skips_surrounding_log_lines() {
        // `dreamina user_credit` 的输出是纯 JSON, 但这层容错让 CLI 加日志后也不会坏掉。
        let output = "refreshing token...\n{\n  \"total_credit\": 12608\n}\ndone";
        assert_eq!(
            extract_json_object(output),
            Some("{\n  \"total_credit\": 12608\n}")
        );
    }

    #[test]
    fn extract_json_object_returns_none_without_json() {
        assert_eq!(extract_json_object("尚未登录, 请先执行 dreamina login"), None);
        assert_eq!(extract_json_object(""), None);
    }
}

/// Clear the local Dreamina CLI OAuth login state.
#[tauri::command]
pub async fn jimeng_cli_logout(executable: String) -> Result<JimengCliLoginCheckResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let value = executable.clone();
    let output = tokio::task::spawn_blocking(move || {
        run_cli(&value, &["logout".to_string()])
    })
    .await
    .map_err(|error| format!("即梦 CLI 退出登录失败: {error}"))??;
    Ok(JimengCliLoginCheckResult {
        success: true,
        message: output.trim().to_string(),
    })
}

/// 即梦 CLI 的账户积分(`dreamina user_credit`)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliCredit {
    /// 剩余积分总数。
    pub total_credit: f64,
    /// 会员等级(如 maestro), 未登录或字段缺失时为 None。
    pub vip_level: Option<String>,
}

/// CLI 输出里除 JSON 外还常夹带日志行, 取第一个 `{` 到最后一个 `}` 之间的部分。
fn extract_json_object(output: &str) -> Option<&str> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    (end > start).then(|| &output[start..=end])
}

/// 查询即梦 CLI 剩余积分(设置页「即梦 CLI」面板展示)。
#[tauri::command]
pub async fn jimeng_cli_credit(executable: String) -> Result<JimengCliCredit, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let output = tokio::task::spawn_blocking(move || {
        run_cli(&executable, &["user_credit".to_string()])
    })
    .await
    .map_err(|error| format!("即梦 CLI 积分查询中断: {error}"))??;

    let payload: serde_json::Value =
        serde_json::from_str(extract_json_object(&output).ok_or_else(|| {
            // 未登录时 CLI 会直接打印错误文案, 原样带回去比"解析失败"更有用。
            format!("即梦 CLI 未返回积分信息: {}", output.trim())
        })?)
        .map_err(|_| "即梦 CLI 返回的积分信息无法解析".to_string())?;

    let total_credit = payload
        .get("total_credit")
        .and_then(|value| match value {
            serde_json::Value::Number(number) => number.as_f64(),
            serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        })
        .ok_or_else(|| "即梦 CLI 未返回积分字段".to_string())?;
    let vip_level = payload
        .get("vip_level")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(JimengCliCredit {
        total_credit,
        vip_level,
    })
}

// ---------------------------------------------------------------------------
// 自动检测与自动安装（仅 Windows；失败不致命，只写用户目录）
// ---------------------------------------------------------------------------

/// 检测结果（内部结构，来源字段供日志/调试使用）。
struct ExecutableDetection {
    found: bool,
    resolved_path: Option<String>,
    source: String,
    candidate_paths: Vec<String>,
}

/// 与 `resolve_executable` 相同的解析顺序（绝对路径 → PATH → 常见安装目录），
/// 但返回结构化结果而不抛错，供启动自动检测与自动安装后的复检使用。
/// 保持 `resolve_executable` 现有行为与错误文案不变。
fn detect_executable(requested: &str) -> ExecutableDetection {
    let trimmed = requested.trim().trim_matches(['"', '\'']);
    if trimmed.is_empty() {
        return ExecutableDetection {
            found: false,
            resolved_path: None,
            source: "none".to_string(),
            candidate_paths: Vec::new(),
        };
    }
    let expanded = expand_windows_path(trimmed);
    if Path::new(&expanded).is_absolute() || expanded.contains('/') || expanded.contains('\\') {
        if Path::new(&expanded).is_file() {
            return ExecutableDetection {
                found: true,
                resolved_path: Some(expanded),
                source: "settings-absolute".to_string(),
                candidate_paths: Vec::new(),
            };
        }
        return ExecutableDetection {
            found: false,
            resolved_path: None,
            source: "none".to_string(),
            candidate_paths: Vec::new(),
        };
    }
    if let Some(found) = find_in_path(&expanded) {
        return ExecutableDetection {
            found: true,
            resolved_path: Some(found),
            source: "settings-command-path".to_string(),
            candidate_paths: Vec::new(),
        };
    }
    let candidates = common_locations(&expanded);
    for candidate in &candidates {
        if Path::new(candidate).is_file() {
            return ExecutableDetection {
                found: true,
                resolved_path: Some(candidate.clone()),
                source: "settings-command-common".to_string(),
                candidate_paths: candidates,
            };
        }
    }
    ExecutableDetection {
        found: false,
        resolved_path: None,
        source: "none".to_string(),
        candidate_paths: candidates,
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliDetectResult {
    pub found: bool,
    pub resolved_path: Option<String>,
    pub source: String,
    pub candidate_paths: Vec<String>,
}

/// 检测本机是否安装即梦 CLI。
/// - executable 为空时按默认命令 `dreamina` 检测；
/// - 只读探测，不修改任何文件、不写注册表、不启动安装。
#[tauri::command]
pub async fn jimeng_cli_detect(executable: Option<String>) -> Result<JimengCliDetectResult, String> {
    let requested = executable
        .unwrap_or_default()
        .trim()
        .to_string();
    let requested = if requested.is_empty() {
        "dreamina".to_string()
    } else {
        requested
    };
    let detection = detect_executable(&requested);
    Ok(JimengCliDetectResult {
        found: detection.found,
        resolved_path: detection.resolved_path,
        source: detection.source,
        candidate_paths: detection.candidate_paths,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliInstallResult {
    pub success: bool,
    pub installed: bool,
    pub resolved_path: Option<String>,
    pub message: String,
}

/// 自动安装即梦 CLI（仅 Windows）：
/// 1. 已安装 → 直接返回 installed=false（不重复安装）；
/// 2. 下载官方 Windows 安装包到 %USERPROFILE%\bin\dreamina.exe；
/// 3. 尽力补齐 %USERPROFILE%\.dreamina_cli 下的 SKILL.md / version.json（失败不阻塞）；
/// 4. 将 %USERPROFILE%\bin 追加到当前用户 PATH（User 级，失败不阻塞）；
/// 5. 复检；所有失败路径均返回可读 message，不向上抛致命错误。
#[tauri::command]
pub async fn jimeng_cli_install() -> Result<JimengCliInstallResult, String> {
    tokio::task::spawn_blocking(jimeng_cli_install_blocking)
        .await
        .map_err(|error| format!("即梦 CLI 自动安装任务中断: {error}"))?
}

fn jimeng_cli_install_blocking() -> Result<JimengCliInstallResult, String> {
    let detection = detect_executable("dreamina");
    if detection.found {
        return Ok(JimengCliInstallResult {
            success: true,
            installed: false,
            resolved_path: detection.resolved_path,
            message: "已检测到即梦 CLI，无需重复安装".to_string(),
        });
    }

    let home = current_user_home()
        .ok_or_else(|| "无法定位用户主目录（%USERPROFILE%），请手动安装即梦 CLI".to_string())?;
    let bin_dir = home.join("bin");
    let exe_path = bin_dir.join("dreamina.exe");
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("无法创建安装目录 {}: {error}", bin_dir.display()))?;

    let curl = find_curl().ok_or_else(|| "未找到 curl.exe，请手动安装即梦 CLI".to_string())?;

    let exe_url = format!("{JIMENG_CLI_DOWNLOAD_BASE}/dreamina_cli_windows_amd64.exe");
    let tmp_path = std::env::temp_dir().join(format!("lentalk-jimeng-install-{}.exe", Uuid::new_v4()));
    download_with_curl(&curl, &exe_url, &tmp_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        error
    })?;
    let size = fs::metadata(&tmp_path).map(|meta| meta.len()).unwrap_or(0);
    if size < JIMENG_CLI_MIN_EXE_BYTES {
        let _ = fs::remove_file(&tmp_path);
        return Ok(JimengCliInstallResult {
            success: false,
            installed: false,
            resolved_path: None,
            message: format!("下载的即梦 CLI 文件异常（仅 {size} 字节），安装中止，请手动安装"),
        });
    }
    if exe_path.exists() {
        // 只覆盖本次自动安装写入的目标文件；绝不触碰用户手动配置的其它路径。
        let _ = fs::remove_file(&exe_path);
    }
    fs::rename(&tmp_path, &exe_path)
        .or_else(|_| fs::copy(&tmp_path, &exe_path).map(|_| ()))
        .map_err(|error| {
            let _ = fs::remove_file(&tmp_path);
            format!("无法写入安装目录 {}: {error}", exe_path.display())
        })?;
    let _ = fs::remove_file(&tmp_path);

    let mut warnings: Vec<String> = Vec::new();
    let dot_dir = home.join(".dreamina_cli");
    let skill_dir = dot_dir.join("dreamina");
    let _ = fs::create_dir_all(&skill_dir);
    if let Err(error) = download_with_curl(
        &curl,
        &format!("{JIMENG_CLI_DOWNLOAD_BASE}/SKILL.md"),
        &skill_dir.join("SKILL.md"),
    ) {
        warnings.push(format!("SKILL.md 下载失败: {error}"));
    }
    if let Err(error) = download_with_curl(
        &curl,
        JIMENG_CLI_VERSION_URL,
        &dot_dir.join("version.json"),
    ) {
        warnings.push(format!("version.json 下载失败: {error}"));
    }
    if let Err(error) = ensure_windows_user_path(&bin_dir) {
        warnings.push(format!("写入用户 PATH 失败（不影响本软件直接使用）: {error}"));
    }

    let detection = detect_executable("dreamina");
    let suffix = if warnings.is_empty() {
        String::new()
    } else {
        format!("（{}）", warnings.join("；"))
    };
    match detection.resolved_path {
        Some(path) => {
            let message = format!("即梦 CLI 安装完成：{path}{suffix}");
            Ok(JimengCliInstallResult {
                success: true,
                installed: true,
                resolved_path: Some(path),
                message,
            })
        }
        None => Ok(JimengCliInstallResult {
            success: false,
            installed: false,
            resolved_path: None,
            message: format!("安装后仍未检测到即梦 CLI，请手动安装{suffix}"),
        }),
    }
}

/// 定位 curl.exe：优先 Windows 系统自带，其次当前进程 PATH。
#[cfg(target_os = "windows")]
fn find_curl() -> Option<PathBuf> {
    let system_curl = PathBuf::from(r"C:\Windows\System32\curl.exe");
    if system_curl.is_file() {
        return Some(system_curl);
    }
    find_in_path("curl").map(PathBuf::from)
}

#[cfg(not(target_os = "windows"))]
fn find_curl() -> Option<PathBuf> {
    find_in_path("curl").map(PathBuf::from)
}

/// 用 curl.exe 下载文件到目标路径；失败返回可读错误。
fn download_with_curl(curl: &Path, url: &str, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建下载目录 {}: {error}", parent.display()))?;
    }
    let output = Command::new(curl)
        .args(["-fsSL", url, "-o"])
        .arg(target)
        .output()
        .map_err(|error| format!("无法启动 curl.exe: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(if trimmed.is_empty() {
            "下载失败（HTTP 错误），请稍后重试或手动安装".to_string()
        } else {
            format!("下载失败: {trimmed}")
        });
    }
    if !target.is_file() {
        return Err("下载失败：未生成目标文件".to_string());
    }
    Ok(())
}

/// 将 bin_dir 追加到当前用户 PATH（User 级环境变量，不触碰系统 PATH）。
/// 失败不致命：返回 Err 由调用方转成提示，不影响已完成的安装。
#[cfg(target_os = "windows")]
fn ensure_windows_user_path(bin_dir: &Path) -> Result<(), String> {
    let dir = bin_dir.to_string_lossy().to_string();
    let escaped = dir.replace('\'', "''");
    let script = format!(
        "$p=[Environment]::GetEnvironmentVariable('Path','User'); \
         if ($p -and ($p -split ';' -contains '{escaped}')) {{ exit 0 }}; \
         $new=if ($p) {{ $p.TrimEnd(';') + ';' + '{escaped}' }} else {{ '{escaped}' }}; \
         [Environment]::SetEnvironmentVariable('Path',$new,'User')"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法启动 powershell.exe: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        Err(if trimmed.is_empty() {
            "PowerShell 执行失败".to_string()
        } else {
            trimmed.to_string()
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_windows_user_path(_bin_dir: &Path) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// 图片: text2image / image2image(生成与编辑) 与 image_upscale(超清)
// ---------------------------------------------------------------------------

/// 即梦图片支持的画幅枚举(取自 CLI `--help`)。
/// 注意它不含自定义平台用的 5:4 / 4:5, 传了会被 CLI 以严格校验拒绝。
const JIMENG_CLI_IMAGE_ASPECT_RATIOS: [&str; 8] =
    ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];

/// `text2image` 支持的模型版本。
const JIMENG_CLI_TEXT2IMAGE_VERSIONS: [&str; 9] =
    ["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"];

/// `image2image` 不支持 3.0 / 3.1(CLI 只列 4.0 及以上)。
const JIMENG_CLI_IMAGE2IMAGE_VERSIONS: [&str; 7] =
    ["4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"];

/// `image_upscale` 的档位枚举。
const JIMENG_CLI_UPSCALE_RESOLUTIONS: [&str; 3] = ["2k", "4k", "8k"];

/// 与视频一致: 即梦一次最多接受 10 张参考图。
const JIMENG_CLI_MAX_EDIT_IMAGES: usize = 10;

#[derive(Debug, Deserialize)]
pub struct GenerateJimengCliImageRequest {
    pub client_job_id: Option<String>,
    pub executable: String,
    pub prompt: String,
    pub model_version: String,
    pub resolution_type: String,
    pub aspect_ratio: Option<String>,
    pub generate_num: Option<u32>,
    pub reference_images: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateJimengCliImageUpscaleRequest {
    pub client_job_id: Option<String>,
    pub executable: String,
    pub image: String,
    pub resolution_type: String,
}

/// 文生图 / 图生图: 没有参考图走 `text2image`, 有参考图走 `image2image`。
#[tauri::command]
pub async fn generate_jimeng_cli_image(
    app: AppHandle,
    request: GenerateJimengCliImageRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate_image_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦 CLI 图片任务执行中断: {error}"))?
}

/// 图片超清: 对一张已有图片做 2k / 4k / 8k 超分, 产出新文件而不是覆盖原图。
#[tauri::command]
pub async fn generate_jimeng_cli_image_upscale(
    app: AppHandle,
    request: GenerateJimengCliImageUpscaleRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || upscale_image_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦 CLI 图片超清任务执行中断: {error}"))?
}

/// LenTalk 侧的分辨率档位是大写(1K / 2K / 4K, 5.0Pro 还有 1.5K),
/// 即梦 CLI 只认小写(`2k` / `1.5k`), 这里统一归一化。
fn normalize_image_resolution(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn validate_image_request(
    model_version: &str,
    resolution_type: &str,
    aspect_ratio: Option<&str>,
    reference_count: usize,
) -> Result<(), String> {
    let versions: &[&str] = if reference_count > 0 {
        &JIMENG_CLI_IMAGE2IMAGE_VERSIONS
    } else {
        &JIMENG_CLI_TEXT2IMAGE_VERSIONS
    };
    let mode_label = if reference_count > 0 { "图生图" } else { "文生图" };
    if !versions.contains(&model_version) {
        return Err(format!("即梦 CLI {mode_label}不支持模型版本 {model_version}"));
    }

    // 每个版本支持的档位不同: 3.x 只有 1k/2k, 4.x~5.0 是 2k/4k, 5.0Pro 多出 1.5k。
    let supported: &[&str] = match model_version {
        "3.0" | "3.1" => &["1k", "2k"],
        "5.0Pro" => &["1.5k", "2k", "4k"],
        _ => &["2k", "4k"],
    };
    if !supported.contains(&resolution_type) {
        return Err(format!(
            "{model_version} 不支持 {resolution_type} 分辨率，可选：{}",
            supported.join("、")
        ));
    }

    if let Some(ratio) = aspect_ratio {
        if !JIMENG_CLI_IMAGE_ASPECT_RATIOS.contains(&ratio) {
            return Err(format!(
                "即梦 CLI 不支持画幅 {ratio}，可选：{}",
                JIMENG_CLI_IMAGE_ASPECT_RATIOS.join("、")
            ));
        }
    }
    Ok(())
}

/// 图片输入来源: data URL、file:// 或本地绝对路径。
///
/// 视频只接受 data URL, 但图片节点常直接持有本地文件(素材库导入、已落盘的结果),
/// 因此图片链路额外接受本地路径。
fn materialize_images(
    sources: &[String],
    directory: &Path,
    prefix: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for (index, source) in sources
        .iter()
        .map(|source| source.trim())
        .filter(|source| !source.is_empty())
        .enumerate()
    {
        if source.starts_with("data:") {
            // materialize_data_urls 会用 prefix-1 命名, 逐张传入时必须带上序号,
            // 否则第二张会覆盖第一张。
            let mut materialized = materialize_data_urls(
                std::slice::from_ref(&source.to_string()),
                directory,
                &format!("{prefix}-{}", index + 1),
            )?;
            paths.append(&mut materialized);
            continue;
        }
        let path = source_path(source);
        if path.is_file() {
            paths.push(path);
        } else {
            return Err(format!("即梦 CLI 无法读取参考图片: {source}"));
        }
    }
    Ok(paths)
}

fn append_image_generation_args(
    arguments: &mut Vec<String>,
    command: &str,
    request: &GenerateJimengCliImageRequest,
    resolution_type: &str,
    aspect_ratio: Option<&str>,
    images: &[PathBuf],
) {
    arguments.push(format!("--prompt={}", request.prompt.trim()));
    arguments.push(format!("--model_version={}", request.model_version));
    if let Some(ratio) = aspect_ratio {
        arguments.push(format!("--ratio={ratio}"));
    }
    arguments.push(format!("--resolution_type={resolution_type}"));
    arguments.push(format!(
        "--generate_num={}",
        request.generate_num.unwrap_or(1).clamp(1, 10)
    ));

    if command == "image2image" {
        for image in images {
            arguments.push(format!("--images={}", image.display()));
        }
    }
}

fn resolve_image_download_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let output_dir = app_data_dir.join("jimeng-cli/images").join(run_id);
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("无法创建即梦 CLI 图片下载目录: {error}"))?;
    Ok(output_dir)
}

fn generate_image_blocking(
    app: &AppHandle,
    request: GenerateJimengCliImageRequest,
) -> Result<String, String> {
    let executable = request.executable.trim();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("即梦 CLI 图片生成需要提示词".to_string());
    }
    let resolution_type = normalize_image_resolution(&request.resolution_type);
    if resolution_type.is_empty() {
        return Err("即梦 CLI 图片生成需要指定分辨率档位".to_string());
    }

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-cli-image-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦 CLI 临时目录: {error}"))?;

    let result = (|| {
        let images = materialize_images(
            request.reference_images.as_deref().unwrap_or_default(),
            &input_dir,
            "ref",
        )?;
        if images.len() > JIMENG_CLI_MAX_EDIT_IMAGES {
            return Err(format!(
                "即梦 CLI 最多支持 {JIMENG_CLI_MAX_EDIT_IMAGES} 张参考图片，当前有 {} 张，请删除多余参考图后重试",
                images.len()
            ));
        }
        let aspect_ratio = request
            .aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        validate_image_request(
            &request.model_version,
            &resolution_type,
            aspect_ratio,
            images.len(),
        )?;

        let command = if images.is_empty() { "text2image" } else { "image2image" };
        let download_dir = resolve_image_download_dir(app, &run_id)?;
        let mut arguments = vec![command.to_string()];
        append_image_generation_args(
            &mut arguments,
            command,
            &request,
            &resolution_type,
            aspect_ratio,
            &images,
        );
        arguments.push("--poll=0".to_string());

        submit_and_poll_jimeng_task(
            app,
            executable,
            arguments,
            request.client_job_id.as_deref(),
            &download_dir,
            JimengArtifactKind::Image,
        )
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

fn upscale_image_blocking(
    app: &AppHandle,
    request: GenerateJimengCliImageUpscaleRequest,
) -> Result<String, String> {
    let executable = request.executable.trim();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let resolution_type = normalize_image_resolution(&request.resolution_type);
    if !JIMENG_CLI_UPSCALE_RESOLUTIONS.contains(&resolution_type.as_str()) {
        return Err(format!(
            "即梦 CLI 图片超清仅支持 {}，当前是 {resolution_type}",
            JIMENG_CLI_UPSCALE_RESOLUTIONS.join("、")
        ));
    }

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-upscale-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦 CLI 临时目录: {error}"))?;

    let result = (|| {
        let images = materialize_images(
            std::slice::from_ref(&request.image),
            &input_dir,
            "upscale-source",
        )?;
        let source = images
            .first()
            .ok_or_else(|| "即梦 CLI 图片超清需要一张图片".to_string())?;
        let download_dir = resolve_image_download_dir(app, &run_id)?;
        let arguments = vec![
            "image_upscale".to_string(),
            format!("--image={}", source.display()),
            format!("--resolution_type={resolution_type}"),
            "--poll=0".to_string(),
        ];

        submit_and_poll_jimeng_task(
            app,
            executable,
            arguments,
            request.client_job_id.as_deref(),
            &download_dir,
            JimengArtifactKind::Image,
        )
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

#[cfg(test)]
mod image_tests {
    use super::*;

    fn video_request(image_mode: Option<&str>) -> GenerateJimengCliVideoRequest {
        GenerateJimengCliVideoRequest {
            client_job_id: None,
            executable: "dreamina".to_string(),
            prompt: "让画面中的主体向前移动".to_string(),
            model_version: "seedance2.5".to_string(),
            duration: 5,
            aspect_ratio: "9:16".to_string(),
            video_resolution: Some("720p".to_string()),
            image_mode: image_mode.map(str::to_string),
            reference_images: None,
            reference_audio: None,
        }
    }

    #[test]
    fn reference_mode_single_image_is_not_treated_as_first_frame() {
        let images = vec![PathBuf::from("reference.png")];
        assert_eq!(
            resolve_video_command(Some("reference"), &images, &[]).unwrap(),
            "multimodal2video"
        );
    }

    #[test]
    fn reference_mode_passes_selected_ratio_to_multimodal_cli() {
        let request = video_request(Some("reference"));
        let images = vec![PathBuf::from("reference.png")];
        let mut arguments = Vec::new();
        append_generation_args(
            &mut arguments,
            "multimodal2video",
            &request,
            "720p",
            &images,
            &[],
        );

        assert!(arguments.iter().any(|argument| argument == "--ratio=9:16"));
        assert!(arguments.iter().any(|argument| argument == "--image=reference.png"));
        assert!(!arguments.iter().any(|argument| argument.starts_with("--first=")));
    }

    #[test]
    fn first_last_mode_keeps_frame_semantics_and_does_not_pass_ratio() {
        let request = video_request(Some("first-last"));
        let images = vec![PathBuf::from("first.png"), PathBuf::from("last.png")];
        let mut arguments = Vec::new();
        append_generation_args(
            &mut arguments,
            "frames2video",
            &request,
            "720p",
            &images,
            &[],
        );

        assert!(!arguments.iter().any(|argument| argument.starts_with("--ratio=")));
        assert!(arguments.iter().any(|argument| argument == "--first=first.png"));
        assert!(arguments.iter().any(|argument| argument == "--last=last.png"));
    }

    #[test]
    fn text2image_rejects_4k_for_legacy_versions() {
        let error = validate_image_request("3.0", "4k", None, 0).unwrap_err();
        assert!(error.contains("不支持 4k"), "实际报错: {error}");
    }

    #[test]
    fn text2image_accepts_1k_for_legacy_versions() {
        assert!(validate_image_request("3.1", "1k", None, 0).is_ok());
    }

    #[test]
    fn image2image_rejects_versions_without_edit_support() {
        let error = validate_image_request("3.0", "2k", None, 1).unwrap_err();
        assert!(error.contains("图生图"), "实际报错: {error}");
    }

    #[test]
    fn pro_version_accepts_1_5k_resolution() {
        assert!(validate_image_request("5.0Pro", "1.5k", None, 0).is_ok());
        assert!(validate_image_request("5.0", "1.5k", None, 0).is_err());
    }

    #[test]
    fn unsupported_aspect_ratio_is_rejected() {
        let error = validate_image_request("5.0", "2k", Some("5:4"), 0).unwrap_err();
        assert!(error.contains("画幅"), "实际报错: {error}");
    }

    #[test]
    fn supported_aspect_ratio_passes() {
        assert!(validate_image_request("5.0", "2k", Some("21:9"), 0).is_ok());
    }

    #[test]
    fn normalize_image_resolution_lowercases_tier() {
        assert_eq!(normalize_image_resolution(" 2K "), "2k");
        assert_eq!(normalize_image_resolution("1.5K"), "1.5k");
    }
}
