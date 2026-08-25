use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// The Dreamina CLI refreshes and persists the OAuth record during normal
// commands. Running two CLI processes at once can make its keyring backend
// return "store unavailable" (especially on Windows Credential Manager).
static JIMENG_CLI_PROCESS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const CLI_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const CLI_TASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

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
    if images.len() == 1 && audio.is_empty() {
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

    let submission = run_cli(executable, &arguments)?;
    if is_failed(&submission) {
        return Err(format!("即梦 CLI 视频生成失败: {}", output_summary(&submission)));
    }
    // --poll=0 通常只提交任务；保留即时结果分支，兼容 CLI 后端直接返回成品的情况。
    if is_succeeded(&submission) {
        if let Some(path) = find_downloaded_video(download_dir) {
            return Ok(path.to_string_lossy().into_owned());
        }
        if let Some(url) = extract_http_url(&submission) {
            return Ok(url);
        }
    }
    let submit_id = extract_field(&submission, &["submit_id", "submitId"])
        .ok_or_else(|| format!("即梦 CLI 未返回 submit_id: {}", output_summary(&submission)))?;

    emit_task_status(app, request, &submit_id, "queued", queue_count(executable), None);

    let task_deadline = Instant::now() + CLI_TASK_TIMEOUT;
    loop {
        if Instant::now() >= task_deadline {
            emit_task_status(
                app,
                request,
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
            emit_task_status(app, request, &submit_id, "failed", queue_count(executable), Some(output_summary(&query)));
            return Err(format!("即梦 CLI 视频生成失败: {}", output_summary(&query)));
        }
        if is_succeeded(&query) {
            if let Some(path) = find_downloaded_video(download_dir) {
                emit_task_status(app, request, &submit_id, "succeeded", Some(0), None);
                return Ok(path.to_string_lossy().into_owned());
            }
            if let Some(url) = extract_http_url(&query) {
                emit_task_status(app, request, &submit_id, "succeeded", Some(0), None);
                return Ok(url);
            }
            emit_task_status(app, request, &submit_id, "failed", Some(0), Some("任务已完成但未找到视频文件".to_string()));
            return Err("即梦 CLI 已完成任务，但未找到下载的视频文件".to_string());
        }

        let status = extract_field(&query, &["gen_status"]).unwrap_or_else(|| "querying".to_string());
        let normalized_status = match status.to_ascii_lowercase().as_str() {
            "querying" | "queued" | "pending" => "queued",
            "success" | "succeeded" | "fail" | "failed" => status.as_str(),
            _ => "running",
        };
        emit_task_status(app, request, &submit_id, normalized_status, queue_count(executable), None);

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

fn emit_task_status(
    app: &AppHandle,
    request: &GenerateJimengCliVideoRequest,
    submit_id: &str,
    status: &str,
    queue_count: Option<usize>,
    message: Option<String>,
) {
    let _ = app.emit(
        "jimeng-cli-status",
        JimengCliTaskStatusEvent {
            client_job_id: request.client_job_id.clone(),
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

    // 即梦 CLI 对 image2video / frames2video 都从输入首图推断画幅；首尾帧传
    // --ratio 会触发 CLI 的严格校验，且可能与首帧实际比例不一致。
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
            Ok(None) if started_at.elapsed() >= CLI_COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("即梦 CLI 命令超过 {} 秒未返回", CLI_COMMAND_TIMEOUT.as_secs()));
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
    if compact.len() > 500 {
        format!("{}…", &compact[..500])
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