//! 扒剧本引擎桥接：把短剧视频扒成拉片剧本。
//!
//! 引擎是随包的 Python 脚本（`resources/pajuben/`），这里只做三件事：
//! 探测运行环境（Python 解释器 / 引擎目录 / ffmpeg 目录 / 人脸依赖）、
//! 拉起子进程、把 stdout 上的 `##PROGRESS` / `##EP` 机器协议流式转发给前端。
//!
//! Python 解释器**优先用随包运行时**（`pajuben/runtime/`），找不到才回退系统
//! Python —— 这样"完全内置"和"先跑起来"两种形态共用同一套代码路径。
//!
//! ffmpeg 优先复用随包或系统版本；Windows 缺失时首次使用按需下载到应用数据目录。
//! 引擎按裸名调用 `ffmpeg`/`ffprobe`，所以要把其目录前置进子进程的 PATH。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use flate2::read::GzDecoder;
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::io::Read;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const LOG_EVENT: &str = "pajuben://log";
pub const PROGRESS_EVENT: &str = "pajuben://progress";
pub const FINISH_EVENT: &str = "pajuben://finish";

const ENGINE_DIR_NAME: &str = "pajuben";
const ENGINE_ENTRY: &str = "pajuben.py";
/// 失败诊断用：保留最后多少行引擎输出。
const LOG_TAIL_LIMIT: usize = 60;
#[cfg(windows)]
const WINDOWS_FFMPEG_ARCHIVE_URL: &str =
    "https://github.com/jownda/LenTalk-Copilot/releases/download/bundled-tools/ffmpeg.tar.gz";
#[cfg(windows)]
/// 解压后的 ffmpeg.exe SHA256。与 scripts/setup-ffmpeg.mjs 保持一致；
/// 不能拿这个值直接校验 tar.gz 压缩包本身。
const WINDOWS_FFMPEG_BINARY_SHA256: &str =
    "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00";
#[cfg(windows)]
const MAX_FFMPEG_ARCHIVE_BYTES: u64 = 200 * 1024 * 1024;

/// 从引擎输出尾部提取「给用户看」的失败原因。
///
/// 引擎失败时打印的是以 `❌` 开头的多行诊断（HTTP 状态码、真实请求地址、
/// 响应开头），例如：
///
/// ```text
/// ❌ 处理失败：HTTP 307 重定向：'/zh-CN/chat/completions'
///     请求地址：https://cuai.token6688.com/chat/completions
///     说明请求路径不对（base 地址可能缺版本段，如 /v1）
/// ```
///
/// 从 `❌` 那行起整块取出（缩进行原样保留），交给前端多行展示；找不到 `❌`
/// 就退化成最后一条非空输出，都没有则返回空串由调用方兜底。
fn failure_detail(lines: &[String]) -> String {
    let start = lines.iter().position(|line| line.contains('❌'));
    match start {
        Some(index) => lines[index..]
            .iter()
            .enumerate()
            .map(|(offset, line)| {
                if offset == 0 {
                    line.trim_start_matches(|c: char| c == '❌' || c.is_whitespace())
                        .to_string()
                } else {
                    line.trim_end().to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        None => lines
            .iter()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
            .unwrap_or_default(),
    }
}

/// 正在运行的子进程句柄。`Mutex` 让「读取等待」与「取消」串行化：
/// 读线程 `wait()` 和取消线程 `kill()` 都需要 &mut。
#[derive(Default)]
pub struct PajubenState {
    child: Arc<Mutex<Option<Child>>>,
}

impl PajubenState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Child>>, String> {
        self.child.lock().map_err(|_| "扒剧本进程状态异常".to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PajubenEnvironment {
    /// Python 解释器路径；None = 没找到可用解释器。
    pub python_path: Option<String>,
    pub python_version: Option<String>,
    /// 是否来自随包运行时（false = 系统 Python 兜底）。
    pub python_bundled: bool,
    pub engine_dir: Option<String>,
    /// 引擎入口脚本存在且能 import。
    pub engine_ready: bool,
    pub ffmpeg_dir: Option<String>,
    /// 人脸识别依赖（Pillow + NumPy + 带 YuNet/SFace 的 OpenCV）是否齐备。
    pub face_ready: bool,
    /// 面向用户的说明（缺什么、怎么补）。
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PajubenRunRequest {
    /// 视频文件路径（单集）或文件夹路径（批量）。
    pub target: String,
    pub batch: bool,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// pajuben 内置渠道名；用自定义 base_url 时传空串走 `--base`。
    pub provider: String,
    pub proxy: String,
    pub episode: Option<u32>,
    pub fps: Option<f64>,
    /// low / medium / high
    pub resolution: Option<String>,
    pub max_frames: Option<u32>,
    pub workers: Option<u32>,
    /// 单次模型请求的最长等待时间；None 时沿用引擎完整模式默认值。
    pub request_timeout_secs: Option<u32>,
    /// 单次模型请求的尝试次数；快速模式只尝试一次，避免长时间无响应。
    pub request_attempts: Option<u32>,
    /// 是否把音频一并送给模型（能听声的模型才需要）。
    pub audio: bool,
    pub anime_mode: bool,
    /// 人物识别开关（预留）：依赖 `face_ready`，不满足时前端应禁用。
    pub face_enabled: bool,
    /// 输出目录；留空 = 引擎默认的「视频同目录/剧本」。
    pub output_dir: Option<String>,
    pub role_sheet: Option<String>,
    pub dual_audio_model: Option<String>,
    pub dual_vision_model: Option<String>,
    pub from_episode: Option<u32>,
    pub to_episode: Option<u32>,
    pub limit: Option<u32>,
    pub overwrite: bool,
    pub skip_alias_verify: bool,
    /// 画布快速模式不应在失败后切入可能长达数十分钟的双模型降级流程。
    #[serde(default)]
    pub disable_dual_fallback: bool,
    /// 选中的模型不支持音频输入时，直接走音频模型 + 视觉模型的双模型流程。
    #[serde(default)]
    pub force_dual_fallback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPayload {
    run_id: String,
    line: String,
    is_error: bool,
}

/// 进度事件：`kind` 取 overall（整批集数）/ episode（单集内阶段）/ episodeDone / episodeFailed。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    run_id: String,
    kind: String,
    episode: Option<u32>,
    done: Option<u32>,
    total: Option<u32>,
    percent: Option<f64>,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishPayload {
    run_id: String,
    success: bool,
    cancelled: bool,
    code: Option<i32>,
    message: String,
}

fn executable_suffixes() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &[".exe", ".cmd", ".bat"]
    }
    #[cfg(not(windows))]
    {
        &[""]
    }
}

/// 引擎目录：打包后在资源目录，开发时回退到 src-tauri/resources。
fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join(ENGINE_DIR_NAME);
        if candidate.join(ENGINE_ENTRY).is_file() {
            return Some(candidate);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(ENGINE_DIR_NAME);
    if dev.join(ENGINE_ENTRY).is_file() {
        return Some(dev);
    }
    None
}

/// ffmpeg 所在目录：优先使用 LenTalk 随包的二进制，开发/旧版 macOS 安装则复用系统版本。
fn ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::commands::video_cfr::resolve_ffmpeg_path(app)
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| downloaded_ffmpeg_path(app).and_then(|path| path.parent().map(Path::to_path_buf)))
        .or_else(|| system_ffmpeg_path().and_then(|path| path.parent().map(Path::to_path_buf)))
}

#[cfg(windows)]
fn downloaded_ffmpeg_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_data_dir().ok()?.join("tools").join("ffmpeg").join("ffmpeg.exe");
    path.is_file().then_some(path)
}

#[cfg(not(windows))]
fn downloaded_ffmpeg_path(_app: &AppHandle) -> Option<PathBuf> {
    None
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let suffixes = executable_suffixes();
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in names {
            for suffix in suffixes {
                let candidate = dir.join(format!("{name}{suffix}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn system_ffmpeg_path() -> Option<PathBuf> {
    if let Some(path) = find_on_path(&["ffmpeg"]) {
        return Some(path);
    }

    // 从 Finder / Dock 启动的 macOS App 常常拿不到 shell PATH；补查 Homebrew 的两个默认目录。
    #[cfg(target_os = "macos")]
    for candidate in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn homebrew_path() -> Option<PathBuf> {
    find_on_path(&["brew"]).or_else(|| {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    })
}

#[cfg(windows)]
fn unpack_windows_ffmpeg_archive(archive: &[u8]) -> Result<Vec<u8>, String> {
    let mut tar = Vec::new();
    GzDecoder::new(archive)
        .read_to_end(&mut tar)
        .map_err(|error| format!("解压 FFmpeg 下载包失败：{error}"))?;

    let mut offset = 0usize;
    while offset.saturating_add(512) <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let name = String::from_utf8_lossy(&header[..100])
            .trim_end_matches('\0')
            .to_string();
        let size_text = String::from_utf8_lossy(&header[124..136])
            .trim_end_matches('\0')
            .trim()
            .to_string();
        let size = usize::from_str_radix(&size_text, 8)
            .map_err(|error| format!("FFmpeg 下载包格式无效：{error}"))?;
        let data_start = offset + 512;
        let data_end = data_start
            .checked_add(size)
            .filter(|end| *end <= tar.len())
            .ok_or_else(|| "FFmpeg 下载包内容不完整".to_string())?;
        let type_flag = header[156];
        if (type_flag == 0 || type_flag == b'0') && name.ends_with("ffmpeg.exe") {
            let binary = tar[data_start..data_end].to_vec();
            if binary.len() < 2 || &binary[..2] != b"MZ" {
                return Err("下载的 FFmpeg 文件无效".to_string());
            }
            return Ok(binary);
        }
        offset = data_start + size.div_ceil(512) * 512;
    }

    Err("FFmpeg 下载包内未找到 ffmpeg.exe".to_string())
}

#[cfg(windows)]
fn download_windows_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let tools_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("tools")
        .join("ffmpeg");
    let target = tools_dir.join("ffmpeg.exe");
    if target.is_file() {
        return Ok(target);
    }

    let response = reqwest::blocking::get(WINDOWS_FFMPEG_ARCHIVE_URL)
        .map_err(|error| format!("下载 FFmpeg 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载 FFmpeg 失败：{error}"))?;
    if response.content_length().is_some_and(|size| size > MAX_FFMPEG_ARCHIVE_BYTES) {
        return Err("FFmpeg 下载包过大，已取消安装".to_string());
    }
    let archive = response
        .bytes()
        .map_err(|error| format!("读取 FFmpeg 下载包失败：{error}"))?;
    if archive.len() as u64 > MAX_FFMPEG_ARCHIVE_BYTES {
        return Err("FFmpeg 下载包过大，已取消安装".to_string());
    }
    let binary = unpack_windows_ffmpeg_archive(&archive)?;
    let digest = format!("{:x}", Sha256::digest(&binary));
    if digest != WINDOWS_FFMPEG_BINARY_SHA256 {
        return Err("下载的 FFmpeg 文件校验失败，请稍后重试".to_string());
    }

    std::fs::create_dir_all(&tools_dir)
        .map_err(|error| format!("无法创建 FFmpeg 目录：{error}"))?;
    let temporary = tools_dir.join(format!("ffmpeg-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, binary).map_err(|error| format!("写入 FFmpeg 失败：{error}"))?;
    std::fs::rename(&temporary, &target).map_err(|error| format!("安装 FFmpeg 失败：{error}"))?;
    Ok(target)
}

/// 首次点击「开始扒剧本」时确保 ffmpeg 已就绪。
///
/// Windows 正常由安装包附带二进制；macOS 的历史安装包未随包时，自动通过 Homebrew
/// 补装，避免 Python 引擎启动后才要求用户手动执行 `brew install ffmpeg`。
fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = ffmpeg_dir(app) {
        return Ok(dir);
    }

    #[cfg(target_os = "macos")]
    {
        let brew = homebrew_path().ok_or_else(|| {
            "未找到 Homebrew，无法自动安装 FFmpeg。请先安装 Homebrew 后重试。".to_string()
        })?;
        let output = Command::new(&brew)
            .args(["install", "ffmpeg"])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("无法启动 Homebrew 安装 FFmpeg：{error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr)
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("Homebrew 未返回错误详情")
                .trim()
                .to_string();
            return Err(format!("自动安装 FFmpeg 失败：{detail}"));
        }
        return ffmpeg_dir(app).ok_or_else(|| {
            "Homebrew 已完成安装，但未找到 ffmpeg 可执行文件；请重启 LenTalk 后重试。".to_string()
        });
    }

    #[cfg(windows)]
    {
        let installed = download_windows_ffmpeg(app)?;
        return installed.parent().map(Path::to_path_buf).ok_or_else(|| {
            "FFmpeg 安装完成，但安装目录无效".to_string()
        });
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let _ = app;
        Err("未找到 FFmpeg。请安装 FFmpeg 后重试。".to_string())
    }
}

/// 随包运行时优先，其次系统 Python。
fn resolve_python(app: &AppHandle) -> (Option<PathBuf>, bool) {
    if let Some(engine) = engine_dir(app) {
        let runtime = engine.join("runtime");
        let candidates = if cfg!(windows) {
            vec![runtime.join("python.exe")]
        } else {
            vec![runtime.join("bin").join("python3"), runtime.join("python3")]
        };
        for candidate in candidates {
            if candidate.is_file() {
                return (Some(candidate), true);
            }
        }
    }
    let system = if cfg!(windows) {
        find_on_path(&["python", "python3"])
    } else {
        find_on_path(&["python3", "python"])
    };
    (system, false)
}

fn run_python_capture(python: &Path, script: &str) -> Result<String, String> {
    let mut command = Command::new(python);
    command
        .arg("-X")
        .arg("utf8")
        .arg("-c")
        .arg(script)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|error| format!("无法启动 Python：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().last().unwrap_or("").trim().to_string();
        return Err(if detail.is_empty() { stdout } else { detail });
    }
    Ok(stdout)
}

const VERSION_PROBE: &str = "import sys; print('%d.%d.%d' % sys.version_info[:3])";
const FACE_PROBE: &str = "import cv2, numpy, PIL\n\
assert hasattr(cv2, 'FaceDetectorYN') and hasattr(cv2, 'FaceRecognizerSF'), 'OpenCV 版本过低'\n\
print('ok')";

fn probe_environment(app: &AppHandle) -> PajubenEnvironment {
    let (python, bundled) = resolve_python(app);
    let engine = engine_dir(app);
    let ffmpeg = ffmpeg_dir(app);

    let mut message = String::new();
    let mut python_version = None;
    let mut face_ready = false;

    if let Some(python_path) = python.as_ref() {
        match run_python_capture(python_path, VERSION_PROBE) {
            Ok(version) => python_version = Some(version),
            Err(error) => {
                message = format!("Python 不可用：{error}");
            }
        }
        if python_version.is_some() {
            face_ready = run_python_capture(python_path, FACE_PROBE).is_ok();
        }
    } else {
        message = "未找到 Python 解释器".to_string();
    }

    let engine_ready = python_version.is_some() && engine.is_some();
    if engine_ready && message.is_empty() && !face_ready {
        message = "人物识别组件未安装，其余功能不受影响".to_string();
    }
    if !engine_ready && message.is_empty() {
        message = "扒剧本引擎文件缺失".to_string();
    }

    PajubenEnvironment {
        python_path: python.map(|path| path.to_string_lossy().to_string()),
        python_version,
        python_bundled: bundled,
        engine_dir: engine.map(|path| path.to_string_lossy().to_string()),
        engine_ready,
        ffmpeg_dir: ffmpeg.map(|path| path.to_string_lossy().to_string()),
        face_ready,
        message,
    }
}

#[tauri::command]
pub async fn pajuben_probe(app: AppHandle) -> Result<PajubenEnvironment, String> {
    tauri::async_runtime::spawn_blocking(move || probe_environment(&app))
        .await
        .map_err(|error| format!("环境探测失败：{error}"))
}

fn build_arguments(engine: &Path, request: &PajubenRunRequest) -> Vec<String> {
    let mut args = vec![
        engine.join(ENGINE_ENTRY).to_string_lossy().to_string(),
        request.target.clone(),
    ];

    // 渠道：pajuben 自带的 provider 表只用于给 base_url 兜底；LenTalk 侧选定
    // 的渠道已经把 base_url 传过来了，所以优先走 --base，避免模型与渠道错配。
    let base = request.base_url.trim();
    if !base.is_empty() {
        args.push("--base".to_string());
        args.push(base.to_string());
    } else if !request.provider.trim().is_empty() {
        args.push("--provider".to_string());
        args.push(request.provider.trim().to_string());
    }
    if !request.model.trim().is_empty() {
        args.push("--model".to_string());
        args.push(request.model.trim().to_string());
    }
    if !request.proxy.trim().is_empty() {
        args.push("--proxy".to_string());
        args.push(request.proxy.trim().to_string());
    }
    if request.batch {
        args.push("--batch".to_string());
    }
    if let Some(episode) = request.episode {
        args.push("--ep".to_string());
        args.push(episode.to_string());
    }
    if let Some(fps) = request.fps {
        args.push("--fps".to_string());
        args.push(fps.to_string());
    }
    if let Some(resolution) = request.resolution.as_deref().filter(|v| !v.is_empty()) {
        args.push("--res".to_string());
        args.push(resolution.to_string());
    }
    if let Some(max_frames) = request.max_frames {
        args.push("--max-frames".to_string());
        args.push(max_frames.to_string());
    }
    if let Some(workers) = request.workers {
        args.push("--workers".to_string());
        args.push(workers.to_string());
    }
    if let Some(timeout) = request.request_timeout_secs.filter(|value| *value > 0) {
        args.push("--request-timeout".to_string());
        args.push(timeout.to_string());
    }
    if let Some(attempts) = request.request_attempts.filter(|value| *value > 0) {
        args.push("--request-attempts".to_string());
        args.push(attempts.to_string());
    }
    if request.audio {
        args.push("--audio".to_string());
    } else {
        args.push("--no-audio".to_string());
    }
    if request.anime_mode {
        args.push("--anime-mode".to_string());
    }
    if let Some(output) = request.output_dir.as_deref().filter(|v| !v.trim().is_empty()) {
        args.push("--output-dir".to_string());
        args.push(output.trim().to_string());
    }
    if let Some(roles) = request.role_sheet.as_deref().filter(|v| !v.trim().is_empty()) {
        args.push("--roles".to_string());
        args.push(roles.to_string());
    }
    if let Some(model) = request.dual_audio_model.as_deref().filter(|v| !v.trim().is_empty()) {
        args.push("--dual-audio-model".to_string());
        args.push(model.trim().to_string());
    }
    if let Some(model) = request.dual_vision_model.as_deref().filter(|v| !v.trim().is_empty()) {
        args.push("--dual-vision-model".to_string());
        args.push(model.trim().to_string());
    }
    if let Some(from) = request.from_episode {
        args.push("--from".to_string());
        args.push(from.to_string());
    }
    if let Some(to) = request.to_episode {
        args.push("--to".to_string());
        args.push(to.to_string());
    }
    if let Some(limit) = request.limit {
        args.push("--limit".to_string());
        args.push(limit.to_string());
    }
    if request.overwrite {
        args.push("--overwrite".to_string());
    }
    if request.skip_alias_verify {
        args.push("--no-verify".to_string());
    }
    if request.disable_dual_fallback {
        args.push("--no-dual-fallback".to_string());
    }
    if request.force_dual_fallback {
        args.push("--dual-only".to_string());
    }
    // 人物识别（预留开关）：关掉时用空的人物库，等价于纯模型判断。
    if !request.face_enabled {
        args.push("--no-face".to_string());
    }
    args
}

/// 把一行 stdout 解析成进度事件；不是协议行则返回 None（当普通日志处理）。
fn parse_progress_line(line: &str) -> Option<ProgressPayload> {
    let rest = line.strip_prefix("##")?;
    let (tag, body) = rest.split_once(' ')?;
    let mut fields = body.splitn(3, ' ');
    match tag {
        "PROGRESS" => {
            let (done, total) = body.split_once('/')?;
            Some(ProgressPayload {
                run_id: String::new(),
                kind: "overall".to_string(),
                episode: None,
                done: done.trim().parse().ok(),
                total: total.trim().parse().ok(),
                percent: None,
                text: String::new(),
            })
        }
        "EP" => {
            let episode = fields.next()?.trim().parse().ok()?;
            let percent = fields.next()?.trim().parse::<f64>().ok()?;
            let text = fields.next().unwrap_or("").trim().to_string();
            Some(ProgressPayload {
                run_id: String::new(),
                kind: "episode".to_string(),
                episode: Some(episode),
                done: None,
                total: None,
                percent: Some(percent),
                text,
            })
        }
        "EPDONE" => Some(ProgressPayload {
            run_id: String::new(),
            kind: "episodeDone".to_string(),
            episode: body.trim().parse().ok(),
            done: None,
            total: None,
            percent: Some(100.0),
            text: String::new(),
        }),
        "EPFAIL" => {
            let (episode, reason) = body.split_once(' ').unwrap_or((body, ""));
            Some(ProgressPayload {
                run_id: String::new(),
                kind: "episodeFailed".to_string(),
                episode: episode.trim().parse().ok(),
                done: None,
                total: None,
                percent: None,
                text: reason.trim().to_string(),
            })
        }
        _ => None,
    }
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    // 子进程组（ffmpeg / curl / 人脸引擎）需要一并回收。
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[tauri::command]
pub fn pajuben_run(
    app: AppHandle,
    state: State<'_, PajubenState>,
    request: PajubenRunRequest,
) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("请先选择渠道并填写 API 密钥".to_string());
    }
    if request.target.trim().is_empty() {
        return Err("请选择视频文件或文件夹".to_string());
    }
    if !Path::new(request.target.trim()).exists() {
        return Err(format!("路径不存在：{}", request.target.trim()));
    }

    {
        let guard = state.lock()?;
        if guard.is_some() {
            return Err("已有扒剧本任务正在运行".to_string());
        }
    }

    let (python, _) = resolve_python(&app);
    let python = python.ok_or_else(|| "未找到可用的 Python 解释器".to_string())?;
    let engine = engine_dir(&app).ok_or_else(|| "扒剧本引擎文件缺失".to_string())?;
    // 第一次启动时若缺少 ffmpeg，先自动安装/恢复；成功后继续本次任务，
    // 不再让 Python 引擎把缺失问题抛回给用户。
    let ffmpeg = ensure_ffmpeg(&app)?;

    // 完成时要把落盘位置告诉用户（否则只提示「完成」等于让人自己去找），
    // 所以在这里先把最终输出目录定下来，随 finish 事件一起回给前端。
    let output_path = output_dir_for(&request.target, request.output_dir.as_deref())
        .map(|path| path.to_string_lossy().to_string());

    let run_id = format!("pajuben-{}", uuid::Uuid::new_v4());
    let arguments = build_arguments(&engine, &request);

    let mut command = Command::new(&python);
    command.arg("-X").arg("utf8");
    command.args(&arguments);
    command
        .current_dir(&engine)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        // 不要往随包目录里写 __pycache__：安装目录可能只读，且缓存会污染打包产物。
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 密钥走环境变量：命令行参数会出现在进程列表里，同机其他进程可读。
    command.env("PAJUBEN_API_KEY", request.api_key.trim());
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![ffmpeg];
    paths.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PATH", joined);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    {
        // 独立进程组：取消时能把 ffmpeg / curl / 人脸引擎一并回收。
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "启动扒剧本引擎失败：{error}（解释器 {}）",
            python.to_string_lossy()
        )
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.lock()? = Some(child);

    // stdout / stderr 是两个不同的具体类型，统一成 trait object 后才能放进同一批读取线程。
    let readers: Vec<(Box<dyn std::io::Read + Send>, bool)> = vec![
        stdout.map(|pipe| (Box::new(pipe) as Box<dyn std::io::Read + Send>, false)),
        stderr.map(|pipe| (Box::new(pipe) as Box<dyn std::io::Read + Send>, true)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut handles = Vec::new();
    // 输出环形缓冲：失败时用它把引擎的真实报错带进 finish 消息。
    // 只回「退出码 1，详情见日志」等于让用户自己去翻控制台。
    let log_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    for (pipe, is_error) in readers {
        let app_handle = app.clone();
        let run = run_id.clone();
        let log_tail = log_tail.clone();
        handles.push(std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        let raw = String::from_utf8_lossy(&buffer);
                        let line = raw.trim_end_matches(['\r', '\n']);
                        if line.trim().is_empty() {
                            continue;
                        }
                        if let Some(mut payload) = parse_progress_line(line) {
                            payload.run_id = run.clone();
                            let _ = app_handle.emit(PROGRESS_EVENT, payload);
                        } else {
                            if let Ok(mut tail) = log_tail.lock() {
                                if tail.len() >= LOG_TAIL_LIMIT {
                                    tail.remove(0);
                                }
                                tail.push(line.to_string());
                            }
                            let _ = app_handle.emit(
                                LOG_EVENT,
                                LogPayload {
                                    run_id: run.clone(),
                                    line: line.to_string(),
                                    is_error,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        let _ = app_handle.emit(
                            LOG_EVENT,
                            LogPayload {
                                run_id: run.clone(),
                                line: format!("读取引擎输出失败：{error}"),
                                is_error: true,
                            },
                        );
                        break;
                    }
                }
            }
        }));
    }

    let app_handle = app.clone();
    let run = run_id.clone();
    let child_slot = state.child.clone();
    let log_tail = log_tail.clone();
    std::thread::spawn(move || {
        for handle in handles {
            let _ = handle.join();
        }
        let status = {
            let mut guard = match child_slot.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    let _ = app_handle.emit(
                        FINISH_EVENT,
                        FinishPayload {
                            run_id: run,
                            success: false,
                            cancelled: false,
                            code: None,
                            message: "进程状态异常".to_string(),
                        },
                    );
                    return;
                }
            };
            match guard.as_mut() {
                Some(child) => child.wait().ok(),
                None => None,
            }
        };
        if let Ok(mut guard) = child_slot.lock() {
            *guard = None;
        }
        let code = status.as_ref().and_then(|value| value.code());
        let success = status.as_ref().map(|value| value.success()).unwrap_or(false);
        let cancelled = matches!(code, Some(1) | Some(137) | None) && !success;
        let _ = app_handle.emit(
            FINISH_EVENT,
            FinishPayload {
                run_id: run,
                success,
                cancelled,
                code,
                message: if success {
                    match output_path.as_deref() {
                        Some(path) => format!("扒取完成，剧本已保存到：{path}"),
                        None => "扒取完成".to_string(),
                    }
                } else if cancelled {
                    "已取消".to_string()
                } else {
                    let detail = log_tail
                        .lock()
                        .map(|tail| failure_detail(&tail))
                        .unwrap_or_default();
                    if detail.is_empty() {
                        match code {
                            Some(value) => format!("扒取失败（退出码 {value}），详情见日志"),
                            None => "扒取失败：进程被终止，详情见日志".to_string(),
                        }
                    } else {
                        format!("扒取失败：{detail}")
                    }
                },
            },
        );
    });

    Ok(run_id)
}

/// 取消正在运行的任务，连同它派生的 ffmpeg / curl 子进程一起回收。
#[tauri::command]
pub fn pajuben_cancel(state: State<'_, PajubenState>) -> Result<(), String> {
    let pid = {
        let mut guard = state.lock()?;
        match guard.as_mut() {
            Some(child) => {
                let pid = child.id();
                let _ = child.kill();
                pid
            }
            None => return Ok(()),
        }
    };
    kill_process_tree(pid);
    Ok(())
}

/// 引擎输出目录：显式指定优先；留空则是视频同目录下的「剧本」文件夹，
/// 保证扒出来的剧本始终跟视频放在一起，而不是散落到应用数据目录里。
fn output_dir_for(target: &str, output_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = output_dir.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let path = Path::new(target.trim());
    if path.is_dir() {
        return Some(path.join("剧本"));
    }
    path.parent().map(|parent| parent.join("剧本"))
}

#[tauri::command]
pub fn pajuben_resolve_output_dir(target: String) -> Result<String, String> {
    if !Path::new(target.trim()).exists() {
        return Err(format!("路径不存在：{}", target.trim()));
    }
    output_dir_for(&target, None)
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位视频所在目录".to_string())
}

/// 单集剧本的落盘文件名。
///
/// 必须和引擎 `pajuben.py` 的命名严格一致（`第{ep}集.txt`），否则「扒完立刻读回」
/// 会因为文件名差一个字而报「没有找到剧本文件」。集号 <= 0 时兜底成第 1 集 ——
/// 引擎不会写「第0集.txt」，拼出来就是一个永远读不到的路径。
fn script_file_name(episode: i64) -> String {
    format!("第{}集.txt", episode.max(1))
}

/// 读回某一集已经扒好的剧本正文。
///
/// 画布上的「扒视频」跑完要把剧本直接落到文本节点；整篇剧本可能有几万字，
/// 塞进 finish 事件会把事件负载撑得很大，所以单独开一条按「视频路径 + 集号」
/// 定位产物的通道。定位规则与 `output_dir_for` 完全一致：显式 output_dir 优先，
/// 留空 = 视频同目录下的「剧本」文件夹。
#[tauri::command]
pub fn pajuben_read_script(
    target: String,
    output_dir: Option<String>,
    episode: Option<i64>,
) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("视频路径为空".to_string());
    }
    let dir = output_dir_for(target, output_dir.as_deref())
        .ok_or_else(|| "无法定位剧本输出目录".to_string())?;
    let path = dir.join(script_file_name(episode.unwrap_or(1)));
    if !path.is_file() {
        return Err(format!("没有找到剧本文件：{}", path.to_string_lossy()));
    }
    std::fs::read_to_string(&path).map_err(|error| format!("读取剧本失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_overall_progress() {
        let payload = parse_progress_line("##PROGRESS 3/12").expect("应解析为进度");
        assert_eq!(payload.kind, "overall");
        assert_eq!(payload.done, Some(3));
        assert_eq!(payload.total, Some(12));
    }

    #[test]
    fn parses_episode_stage_with_chinese_text() {
        let payload = parse_progress_line("##EP 7 45 调用模型…").expect("应解析为进度");
        assert_eq!(payload.kind, "episode");
        assert_eq!(payload.episode, Some(7));
        assert_eq!(payload.percent, Some(45.0));
        assert_eq!(payload.text, "调用模型…");
    }

    #[test]
    fn parses_episode_done_and_failure() {
        let done = parse_progress_line("##EPDONE 4").expect("应解析");
        assert_eq!(done.kind, "episodeDone");
        assert_eq!(done.episode, Some(4));

        let failed = parse_progress_line("##EPFAIL 5 视频没有可用音轨").expect("应解析");
        assert_eq!(failed.kind, "episodeFailed");
        assert_eq!(failed.episode, Some(5));
        assert_eq!(failed.text, "视频没有可用音轨");
    }

    #[test]
    fn ordinary_lines_are_not_progress() {
        assert!(parse_progress_line("  第1集 时长 92s，分 2 段扒取").is_none());
        assert!(parse_progress_line("## 第1集").is_none());
        assert!(parse_progress_line("").is_none());
    }

    fn base_request() -> PajubenRunRequest {
        PajubenRunRequest {
            target: "D:/video/01.mp4".to_string(),
            batch: false,
            base_url: "https://example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: "doubao-seed-1-6".to_string(),
            provider: String::new(),
            proxy: String::new(),
            episode: None,
            fps: None,
            resolution: None,
            max_frames: None,
            workers: None,
            request_timeout_secs: None,
            request_attempts: None,
            audio: true,
            anime_mode: false,
            face_enabled: true,
            output_dir: None,
            role_sheet: None,
            dual_audio_model: None,
            dual_vision_model: None,
            from_episode: None,
            to_episode: None,
            limit: None,
            overwrite: false,
            skip_alias_verify: false,
            disable_dual_fallback: false,
            force_dual_fallback: false,
        }
    }

    #[test]
    fn builds_base_and_model_arguments() {
        let request = base_request();
        let args = build_arguments(Path::new("X:/engine"), &request);
        assert!(args[0].ends_with(ENGINE_ENTRY));
        assert!(args.contains(&"--base".to_string()));
        assert!(args.contains(&"https://example.com/v1".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"doubao-seed-1-6".to_string()));
    }

    #[test]
    fn custom_base_url_wins_over_builtin_provider() {
        let mut request = base_request();
        request.provider = "volcano".to_string();
        let args = build_arguments(Path::new("X:/engine"), &request);
        assert!(args.contains(&"--base".to_string()));
        assert!(!args.contains(&"--provider".to_string()));
    }

    #[test]
    fn disabling_face_recognition_passes_no_face() {
        let mut request = base_request();
        request.face_enabled = false;
        let args = build_arguments(Path::new("X:/engine"), &request);
        assert!(args.contains(&"--no-face".to_string()));
    }

    #[test]
    fn batch_flags_are_forwarded() {
        let mut request = base_request();
        request.batch = true;
        request.limit = Some(3);
        request.overwrite = true;
        request.skip_alias_verify = true;
        request.anime_mode = true;
        let args = build_arguments(Path::new("X:/engine"), &request);
        for flag in ["--batch", "--overwrite", "--no-verify", "--anime-mode"] {
            assert!(args.contains(&flag.to_string()), "缺少 {flag}");
        }
        assert!(args.contains(&"--limit".to_string()));
        assert!(args.contains(&"3".to_string()));
    }

    #[test]
    fn audio_flag_is_explicit() {
        let mut request = base_request();
        request.audio = false;
        let args = build_arguments(Path::new("X:/engine"), &request);
        assert!(args.contains(&"--no-audio".to_string()));
        assert!(!args.contains(&"--audio".to_string()));
    }

    #[test]
    fn output_dir_defaults_next_to_the_video() {
        // 视频文件 → 同目录下的「剧本」
        let resolved = output_dir_for("D:/剧集/第01集.mp4", None);
        assert_eq!(
            resolved.as_deref(),
            Some(Path::new("D:/剧集/剧本")),
            "默认应落在视频同目录"
        );
    }

    #[test]
    fn output_dir_defaults_next_to_the_batch_folder() {
        // 批量：target 本身是文件夹 → 文件夹内的「剧本」。
        // 必须用真实存在的目录：output_dir_for 靠 is_dir() 区分「视频文件」与
        // 「剧集文件夹」，假路径会被判成文件而退到父目录。
        let root = std::env::temp_dir().join(format!("pajuben-batch-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("应能创建临时目录");
        let resolved = output_dir_for(&root.to_string_lossy(), None);
        let expected = root.join("剧本");
        let _ = std::fs::remove_dir(&root);
        assert_eq!(
            resolved.as_deref(),
            Some(expected.as_path()),
            "批量应落在剧集文件夹内的「剧本」"
        );
    }

    #[test]
    fn explicit_output_dir_wins() {
        let resolved = output_dir_for("D:/剧集/第01集.mp4", Some("  E:/成品  "));
        assert_eq!(resolved.as_deref(), Some(Path::new("E:/成品")));
        // 纯空白视同没填，回落到默认值
        let fallback = output_dir_for("D:/剧集/第01集.mp4", Some("   "));
        assert_eq!(fallback.as_deref(), Some(Path::new("D:/剧集/剧本")));
    }

    #[test]
    fn script_file_name_matches_engine_output() {
        // 引擎落盘固定是「第N集.txt」（pajuben.py 的 f"第{ep}集.txt"）
        assert_eq!(script_file_name(3), "第3集.txt");
        assert_eq!(script_file_name(16), "第16集.txt");
        // 集号缺失/异常时兜底到第 1 集：拼出「第0集.txt」等于永远读不到
        assert_eq!(script_file_name(0), "第1集.txt");
        assert_eq!(script_file_name(-7), "第1集.txt");
    }

    #[test]
    fn failure_detail_keeps_the_whole_multiline_diagnosis() {
        // 引擎的报错是多行诊断，必须整块带出来，否则用户只看到第一行
        // 「HTTP 307 重定向」却看不到真正该改的请求地址。
        let lines = vec![
            "抽帧 12 张".to_string(),
            "❌ 处理失败：HTTP 307 重定向：'/zh-CN/chat/completions'".to_string(),
            "    请求地址：https://cuai.token6688.com/chat/completions".to_string(),
            "    说明请求路径不对（base 地址可能缺版本段，如 /v1）".to_string(),
        ];
        let expected = [
            "处理失败：HTTP 307 重定向：'/zh-CN/chat/completions'",
            "    请求地址：https://cuai.token6688.com/chat/completions",
            "    说明请求路径不对（base 地址可能缺版本段，如 /v1）",
        ]
        .join("\n");
        assert_eq!(failure_detail(&lines), expected);
    }

    #[test]
    fn failure_detail_falls_back_to_last_output_line() {
        // 没有 ❌ 前缀（例如解释器自身崩了）时，用最后一条非空输出兜底。
        let lines = vec!["开始".to_string(), "   ".to_string(), "ImportError: cv2".to_string()];
        assert_eq!(failure_detail(&lines), "ImportError: cv2");
        assert_eq!(failure_detail(&[]), "");
    }
}
