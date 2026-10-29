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
use sha2::{Digest, Sha256};
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

/// 画布素材上传(`resource upload`)的单次超时: 4K 图和音频单个可能几十 MB,
/// 30 秒的通用命令超时在慢网下必然不够。
const CANVAS_UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);

/// 画布素材上传的最大尝试次数与退避。
///
/// 与生成提交的保守策略(见 `JIMENG_SUBMIT_MAX_ATTEMPTS` 上方注释)不是一回事: 上传素材
/// **不消耗积分**, 而且下面用内容哈希派生 `--resource-id` 幂等键, 重试不会在服务端留下
/// 重复对象。最坏情况也只是多一个孤儿素材, 代价远小于把 `human_intervention` 原样甩给用户。
const CANVAS_UPLOAD_MAX_ATTEMPTS: u32 = 3;
const CANVAS_UPLOAD_RETRY_BACKOFF_MS: [u64; 2] = [1_500, 4_000];


// 提交阶段的重试策略 —— 一切以即梦官方规则为准, 首要保证**不重复扣费**。
//
// 官方 CLI 说明(`dreamina -h`):
//   * "All generation operations consume credits." —— 扣费发生在**生成任务被创建**时;
//     `list_task` 返回的 commerce_info.credit_count 就是账单, 任务失败也会留下
//     CreditPreDeductNotEnough 这类预扣记录。
//   * "local files are uploaded automatically before submit" —— 本地素材在 submit
//     **之前**上传, 所以上传阶段失败时任务根本还没创建, 重试不产生任何新扣费。
//
// 因此重试的前提是**能证明服务端还没有这一次的任务**, 只有两条路:
//   ① 向服务端核对(首选): `list_task` 查得到这次的任务就绝不重试 —— 已扣费,
//      再提交就是重复下单; 查得到且任务还活着, 就直接接管它(既不重复扣费也不丢任务);
//   ② 报错本身证明卡在 submit 之前的上传阶段(见 PRESUBMIT_FAILURE_PATTERNS)。
// 两条都走不通(核对不了 + 报错阶段不明)时**一律不重试** —— 宁可让用户看到错误,
// 也不能冒重复扣费的风险。
const JIMENG_SUBMIT_MAX_ATTEMPTS: u32 = 3;
const JIMENG_SUBMIT_RETRY_BACKOFF_MS: [u64; 2] = [2_000, 5_000];

/// 轮询阶段(`query_result`)连续网络失败的最大重试次数(每次间隔 3 秒)。
///
/// 与提交阶段**完全不同的安全前提**: `query_result` 是只读、免费、幂等的, 而且走到这一步
/// 说明任务**已经在服务端创建并预缴了积分** —— 一次网络抖动就整段失败, 等于把已经扣过费的
/// 任务丢掉(用户实报的报文正是这样: 轮询 `get_history_by_ids` 时
/// `context deadline exceeded (Client.Timeout exceeded while awaiting headers)` 直接终止了
/// 整个 4K 生成)。所以这里可以放心地连续重试, 只有失败到上限才放弃。
const JIMENG_POLL_MAX_CONSECUTIVE_FAILURES: u32 = 10;
/// 上传参考图用的字节图床服务; 仅在提交失败后用于连通性诊断。
const JIMENG_UPLOAD_HOST: &str = "imagex.bytedanceapi.com";

/// 能证明「失败发生在服务端创建任务之前」的特征(大小写不敏感)。
///
/// 官方 CLI 会先把本地素材上传到字节图床再 submit —— 命中这些特征说明卡在上传阶段,
/// 此时服务端没有任务、没有预缴积分, 重试是安全的。两个真实命中的例子:
/// `ApplyImageUpload: do request ... context deadline exceeded`、
/// `upload resource "...image-1.png": upload image: apply phase`。
const PRESUBMIT_FAILURE_PATTERNS: &[&str] = &[
    "applyimageupload",
    "commit image upload",
    "upload resource",
    "upload image",
    "apply phase",
    "commit phase",
    // 真实报文: `upload resource "...image-1.png": upload image: upload phase,
    // no file upload, please check log for more details` —— 同样卡在 submit 之前。
    "upload phase",
    "no file upload",
];

/// 瞬时网络失败的特征(大小写不敏感)。命中只代表「值得再试一次」, 真正能不能重试还要由
/// `probe_server_task` 确认服务端没有这一次的任务(见 `decide_submit_retry`)。
///
/// 刻意**不**包含「即梦 CLI 命令超过 N 秒未返回」——那是我们自己的提交超时,
/// 重试一次就要再等 5 分钟, 不如让用户尽快看到错误。
const TRANSIENT_SUBMIT_FAILURE_PATTERNS: &[&str] = &[
    "context deadline exceeded",
    "deadline exceeded",
    "i/o timeout",
    "timed out",
    "connection reset",
    "connection refused",
    "connection aborted",
    "connection closed",
    "broken pipe",
    "unexpected eof",
    "network is unreachable",
    "no such host",
    "temporary failure in name resolution",
    "tls handshake",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
];

/// 即梦 CLI 官方二进制下载前缀（与官方安装脚本 `https://jimeng.jianying.com/cli` 同源，
/// Windows / macOS / Linux 各平台产物都在同一目录下）。
/// 仅在用户明确触发「自动安装」时使用；域名为白名单内固定地址，不做任何动态拼接。
const JIMENG_CLI_DOWNLOAD_BASE: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";
const JIMENG_CLI_VERSION_URL: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/version.json";
/// 下载后文件必须大于该阈值才认为有效，避免把错误页/极小残片当安装包。
/// 各平台官方产物都在 26MB 以上，1MB 只是兜底下限。
const JIMENG_CLI_MIN_BINARY_BYTES: u64 = 1024 * 1024;

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

    let submission = submit_jimeng_command(app, client_job_id, executable, &arguments, label)?;
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
    // 任务此刻已在服务端创建并预缴积分: 一次查询抖动就整段失败, 等于丢掉一个已经扣过费的
    // 任务。所以对瞬时网络失败做有限重试(只读 + 幂等, 重试不产生任何新费用)。
    let mut consecutive_poll_failures = 0u32;
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
        let query = match run_cli(
            executable,
            &[
                "query_result".to_string(),
                format!("--submit_id={submit_id}"),
                format!("--download_dir={}", download_dir.display()),
            ],
        ) {
            Ok(output) => {
                consecutive_poll_failures = 0;
                output
            }
            Err(message) => {
                if should_retry_poll_failure(&message, consecutive_poll_failures) {
                    consecutive_poll_failures += 1;
                    // 刻意不取 queue_count: 网络正不通时 `list_task` 会再卡满 30 秒超时,
                    // 把重试间隔拖成半分钟。
                    emit_cli_task_status(
                        app,
                        client_job_id,
                        &submit_id,
                        "retrying",
                        None,
                        Some(format!(
                            "查询结果网络失败, 正在自动重试(第 {}/{} 次; 任务已在服务端创建, 重试不会重复扣费)",
                            consecutive_poll_failures, JIMENG_POLL_MAX_CONSECUTIVE_FAILURES
                        )),
                    );
                    thread::sleep(Duration::from_secs(3));
                    continue;
                }
                let reason = describe_poll_failure(&submit_id, &message);
                emit_cli_task_status(
                    app,
                    client_job_id,
                    &submit_id,
                    "failed",
                    queue_count(executable),
                    Some(reason.clone()),
                );
                return Err(reason);
            }
        };

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

/// 任务记录探针结果 —— 决定「这次失败能否重试」的唯一依据。
///
/// 数据来源是 `dreamina list_task`。实测它读的是 **CLI 本地任务库**
/// (`~/.dreamina_cli/tasks.db`: 本地 37 行与 `list_task` 返回 37 条逐条一致,
/// 最老的一条 `querying` 从 09-15 起就没再更新), 不是实时服务端状态 ——
/// 但对计费判定已经够用, 因为**即梦自己的计费字段 `commerce_info` 就落在记录里**:
/// 27 条 success 全带 `credit_count`; 4 条 `generation failed`(生成阶段失败)的 fail
/// 也带 —— 说明扣费发生在**任务创建成功**时; 而「上传阶段失败」与
/// `CreditPreDeductNotEnough`(积分预扣不足)这 2 条为空 ⇒ **空就一定没扣钱**。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerTaskProbe {
    /// 本地任务库里已经有这一次的记录。
    /// `charged` 取自 `commerce_info`: true = 已产生计费, 再提交就是重复扣费。
    Exists {
        submit_id: String,
        failed: bool,
        charged: bool,
    },
    /// 确认没有这一次的任务: 重试不会重复扣费。
    Absent,
    /// 查不动(未登录 / CLI 不可用 / `list_task` 报错 / 冒出来的是别的节点的任务):
    /// 只能退回报错阶段来判断。
    Unknown,
}

/// `list_task` 里的一条任务。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskEntry {
    submit_id: String,
    failed: bool,
    /// 是否已经产生计费(`commerce_info` 非空)。空的失败记录 = 没扣过钱。
    charged: bool,
    prompt: String,
}

/// `list_task` 输出的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedTaskList {
    /// 解析成功; `None` 表示列表为空(服务端一个任务都没有)。
    Parsed(Option<TaskEntry>),
    /// 不是任务列表(CLI 报错 / 未登录 / 输出被日志污染)。
    Unparsable,
}

/// 服务端任务快照: 比对「提交前」与「提交后」有没有冒出新任务。
#[derive(Debug, Clone, PartialEq, Eq)]
enum TaskListSnapshot {
    Read(Option<TaskEntry>),
    Unavailable,
}

/// 失败是否可证明发生在服务端创建任务之前(即上传本地素材的阶段)。
fn is_presubmit_failure(reason: &str) -> bool {
    let lowered = reason.to_ascii_lowercase();
    PRESUBMIT_FAILURE_PATTERNS
        .iter()
        .any(|pattern| lowered.contains(*pattern))
}

fn is_transient_submit_failure(reason: &str) -> bool {
    let lowered = reason.to_ascii_lowercase();
    TRANSIENT_SUBMIT_FAILURE_PATTERNS
        .iter()
        .any(|pattern| lowered.contains(*pattern))
}

/// 轮询失败是否值得重试。
///
/// 复用提交阶段那份瞬时网络失败特征表 —— 那些特征描述的是网络层, 与阶段无关。
/// 与提交阶段的关键差异是**不需要**再核对计费: 提交阶段的顾虑是「重试会不会重复下单」,
/// 而 `query_result` 只读不写, 重试永远是安全的。
fn should_retry_poll_failure(reason: &str, consecutive_failures: u32) -> bool {
    consecutive_failures < JIMENG_POLL_MAX_CONSECUTIVE_FAILURES
        && is_transient_submit_failure(reason)
}

/// 纯函数: 依据「本地任务库里有没有这一次的记录、有没有产生计费」+ 报错性质,
/// 决定这次失败能否重试。
///
/// 四种不重试的情况, 优先级从高到低:
///   ① 记录里已有计费信息 —— 已经扣过钱, 再提交就是重复扣费;
///   ② 有失败记录但报错不指向 submit 之前 —— 无法证明任务没被创建;
///   ③ 情况不明且报错不指向 submit 之前 —— 同上, 宁可不重试;
///   ④ 报错不是网络抖动(参数错、审核拦截等), 重试没有意义。
///
/// 唯一允许「已经有失败记录仍然重试」的情形: 记录里**没有计费信息**
/// (上传阶段失败留下的空壳, 实测不会产生任何费用) **且** 报错能证明卡在
/// submit 之前的上传阶段 —— 两条同时成立, 重试就不会产生新费用。
/// 反例(必须继续拦住): `CreditPreDeductNotEnough` 虽然也没有计费信息,
/// 但它不满足「卡在上传阶段」, 重试只会再被拒一次。
fn decide_submit_retry(probe: &ServerTaskProbe, reason: &str) -> bool {
    match probe {
        ServerTaskProbe::Exists { charged: true, .. } => false,
        ServerTaskProbe::Exists { charged: false, .. } => is_presubmit_failure(reason),
        ServerTaskProbe::Absent => {
            is_transient_submit_failure(reason) || is_presubmit_failure(reason)
        }
        ServerTaskProbe::Unknown => is_presubmit_failure(reason),
    }
}

/// 取 CLI 输出里第一个 `[` 到最后一个 `]` 之间的片段 —— `list_task` 返回数组,
/// 而 CLI 常在 JSON 前后夹带日志行(`user_credit` 那套取的是 `{`, 用法不同)。
fn extract_json_array(output: &str) -> Option<&str> {
    let start = output.find('[')?;
    let end = output.rfind(']')?;
    (end > start).then(|| &output[start..=end])
}

/// 解析 `list_task` 的 JSON 数组, 取第一条(CLI 按最新在前返回)。
fn parse_task_list(output: &str) -> ParsedTaskList {
    let Some(raw) = extract_json_array(output) else {
        return ParsedTaskList::Unparsable;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return ParsedTaskList::Unparsable;
    };
    let Some(tasks) = value.as_array() else {
        return ParsedTaskList::Unparsable;
    };
    let Some(first) = tasks.first() else {
        return ParsedTaskList::Parsed(None);
    };
    let submit_id = first
        .get("submit_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if submit_id.is_empty() {
        return ParsedTaskList::Unparsable;
    }
    let status = first
        .get("gen_status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    // 计费字段: 成功任务形如 `{"credit_count":132,...}`; 上传阶段失败与积分预扣
    // 不足的记录里它是空串 / null —— 「空」就等于「没扣钱」, 是重试安全性的依据。
    let charged = first
        .get("commerce_info")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|info| !info.is_empty());
    ParsedTaskList::Parsed(Some(TaskEntry {
        submit_id,
        failed: matches!(status.to_ascii_lowercase().as_str(), "fail" | "failed"),
        charged,
        prompt: first
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }))
}

/// 读取服务端任务快照(最新一条)。`Unavailable` 表示查不动, 调用方必须按「不冒险」处理。
fn read_task_snapshot(executable: &str, extra_env: &[(String, String)]) -> TaskListSnapshot {
    let arguments = vec!["list_task".to_string(), "--limit=1".to_string()];
    match run_cli_with_timeout_env(executable, &arguments, CLI_COMMAND_TIMEOUT, extra_env) {
        Ok(output) => match parse_task_list(&output) {
            ParsedTaskList::Parsed(entry) => TaskListSnapshot::Read(entry),
            ParsedTaskList::Unparsable => TaskListSnapshot::Unavailable,
        },
        Err(_) => TaskListSnapshot::Unavailable,
    }
}

/// 提交参数里的提示词, 用于核对「新出现的任务是不是我们这次提交的」。
fn prompt_from_arguments(arguments: &[String]) -> String {
    arguments
        .iter()
        .find_map(|argument| argument.strip_prefix("--prompt="))
        .unwrap_or_default()
        .to_string()
}

fn normalize_prompt(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 新冒出来的任务是否属于本次提交。
///
/// 画布上可能有多个节点并发提交, 只看「最新任务变了」会把别人的任务错认成我们的,
/// 所以还要比对提示词前缀。
fn is_our_task(entry: &TaskEntry, prompt: &str) -> bool {
    const SAMPLE: usize = 120;
    let expected = normalize_prompt(prompt);
    let actual = normalize_prompt(&entry.prompt);
    if expected.len() < 40 || actual.len() < 40 {
        return false;
    }
    expected.chars().take(SAMPLE).eq(actual.chars().take(SAMPLE))
}

/// 纯函数: 比对提交前后的快照, 判断服务端有没有新产生「我们这次」的任务。
fn diff_task_snapshots(
    before: &TaskListSnapshot,
    after: &TaskListSnapshot,
    prompt: &str,
) -> ServerTaskProbe {
    let (TaskListSnapshot::Read(before), TaskListSnapshot::Read(after)) = (before, after) else {
        return ServerTaskProbe::Unknown;
    };
    let entry = match (before, after) {
        // 列表反而空了: 情况不明, 不冒险。
        (_, None) => return ServerTaskProbe::Unknown,
        // 最新任务没变 ⇒ 没有新任务。
        (Some(previous), Some(latest)) if previous.submit_id == latest.submit_id => {
            return ServerTaskProbe::Absent;
        }
        (_, Some(latest)) => latest,
    };
    if is_our_task(entry, prompt) {
        ServerTaskProbe::Exists {
            submit_id: entry.submit_id.clone(),
            failed: entry.failed,
            charged: entry.charged,
        }
    } else {
        // 冒出来的是别的节点/别的会话的任务: 无法证明我们的任务没被创建。
        ServerTaskProbe::Unknown
    }
}

/// 用 CLI 自己打印的 submit_id 去本地任务库里精确核对。
///
/// 关键事实一: 即梦 CLI **失败时也会打印** `submit_id="<uuid>"`, 但那可能只是本地 id ——
/// 实测拿它去查 `list_task --submit_id=<该值>` 会返回 `[]`。所以「输出里有 submit_id」
/// 并不等于「任务已创建」。
///
/// 关键事实二: 这里查到的记录**不是实时服务端状态**, 而是 CLI 本地任务库。
/// 真正决定能否重试的是记录里的 `commerce_info`(计费字段) —— 见 `ServerTaskProbe`。
fn probe_reported_submit_id(
    executable: &str,
    submit_id: &str,
    extra_env: &[(String, String)],
) -> ServerTaskProbe {
    let arguments = vec!["list_task".to_string(), format!("--submit_id={submit_id}")];
    match run_cli_with_timeout_env(executable, &arguments, CLI_COMMAND_TIMEOUT, extra_env) {
        Ok(output) => match parse_task_list(&output) {
            ParsedTaskList::Parsed(Some(entry)) => ServerTaskProbe::Exists {
                submit_id: entry.submit_id,
                failed: entry.failed,
                charged: entry.charged,
            },
            // 该 id 查不到 ⇒ 它只是本地 id, 服务端没有对应任务。
            ParsedTaskList::Parsed(None) => ServerTaskProbe::Absent,
            ParsedTaskList::Unparsable => ServerTaskProbe::Unknown,
        },
        Err(_) => ServerTaskProbe::Unknown,
    }
}

/// 提交失败后的计费安全核对: 服务端到底有没有这一次的任务?
fn probe_server_task(
    executable: &str,
    reported_submit_id: Option<&str>,
    baseline: &TaskListSnapshot,
    prompt: &str,
    extra_env: &[(String, String)],
) -> ServerTaskProbe {
    if let Some(submit_id) = reported_submit_id {
        let probed = probe_reported_submit_id(executable, submit_id, extra_env);
        // 精确命中说明这个 id 确实是服务端任务, 直接采信。
        if matches!(probed, ServerTaskProbe::Exists { .. }) {
            return probed;
        }
    }
    diff_task_snapshots(baseline, &read_task_snapshot(executable, extra_env), prompt)
}

/// 把即梦 CLI 的原始英文报错翻成用户能照着做的中文说明; 未命中已知模式返回 None。
fn humanize_jimeng_failure(reason: &str) -> Option<&'static str> {
    let lowered = reason.to_ascii_lowercase();
    // DNS 解析失败最容易被误判成「素材 / 提示词有问题」, 而且它的处理办法与
    // 单纯的超时完全不同, 所以要抢在下面那条上传分支之前单独识别。
    if lowered.contains("no such host") || lowered.contains("server misbehaving") {
        return Some(
            "说明: 上传参考图时域名解析失败(DNS 查不到字节的上传服务器), 与提示词、素材内容都无关,\
             也不代表账户或登录有问题。\n\
             建议: ① 先直接重试一次(这类多半是当时的偶发失败); \
             ② 把系统 DNS 换成 223.5.5.5 / 119.29.29.29, 或先执行 `ipconfig /flushdns` \
             清掉失败的解析缓存; ③ 换个网络(如手机热点)做对照。",
        );
    }
    if lowered.contains("applyimageupload")
        || lowered.contains("upload resource")
        || lowered.contains("upload image")
        || lowered.contains("apply phase")
        || lowered.contains("upload phase")
    {
        return Some(
            "说明: 卡在「参考图上传到字节图床」这一步, 还没进入生成阶段, 与提示词、素材内容无关;\
             这一步失败**不会产生任何费用**。\n\
             建议: ① 先直接重试(上传阶段失败是免费可重试的); ② 换个网络(如手机热点)做对照; \
             ③ 参考图先减到 1~2 张再试; ④ 若长期失败, 到「设置 - 密钥 - 即梦 CLI」重新登录一次。",
        );
    }
    if lowered.contains("fail_to_fetch_task")
        && (reason.contains("审核")
            || lowered.contains("moderation")
            || lowered.contains("sensitive")
            || lowered.contains("review"))
    {
        return Some(
            "说明: 本次请求被上游内容审核拦截。\n\
             建议: 调整参考素材或提示词描述(如虚化商标与文字、减少真人面部特写描述)后重试。",
        );
    }
    if lowered.contains("creditpredeductnotenough") || reason.contains("积分不足") {
        return Some(
            "说明: 即梦账户积分不足, 任务在「预扣积分」这一步就被拒了 —— 任务没有创建成功, 也没有扣费。\n             建议: 在终端运行 `dreamina user_credit` 查看余额, 到即梦账户补充积分或开通会员后重试。",
        );
    }
    if lowered.contains("aigccomplianceconfirmationrequired") {
        return Some(
            "需要先在即梦 Web 端用这个模型完成一次首次生成（即梦官方的 AIGC 合规确认，ret=4010）。\n\
             影响: 请求在提交接口就被拒，任务从未创建 —— 所以即梦后台查不到记录、也没有扣积分，不是丢了任务。\n\
             做法: 到「设置 - 密钥 - 即梦 CLI」点「打开即梦网页」，用**当前 CLI 登录的同一个账号**\
             选「全能参考 / Seedance 2.5」生成一次并同意页面上的合规提示，再回来重试即可。\
             合规确认按「账号 + 模型」记，换了账号要重新做一次。",
        );
    }
    if lowered.contains("not login")
        || lowered.contains("unauthorized")
        || lowered.contains("invalid token")
        || reason.contains("未登录")
    {
        return Some(
            "说明: 即梦 CLI 的登录态已失效。\n建议: 到「设置 - 密钥 - 即梦 CLI」重新登录后再试。",
        );
    }
    // 放在最后: 超时是最泛化的一条, 必须让上面那些更具体的原因(上传阶段 / 审核 / 未登录)
    // 先命中 —— `ApplyImageUpload: ... context deadline exceeded` 就同时含「上传」与「超时」。
    if lowered.contains("context deadline exceeded")
        || lowered.contains("client.timeout exceeded")
        || lowered.contains("deadline exceeded")
        || lowered.contains("i/o timeout")
    {
        return Some(
            "说明: 请求即梦服务器时网络超时(时限内没拿到响应), 与提示词、素材内容无关;\
             即梦是国内服务, 若系统或应用带了代理, 走代理反而容易超时。\n\
             建议: ① 先直接重试一次(这类多半是当时的偶发失败); \
             ② 关掉系统代理 / VPN 再试一次做对照; ③ 换个网络(如手机热点)做对照。",
        );
    }
    None
}

/// 把报错里的临时目录折叠掉: `C:\...\Temp\lentalk-jimeng-cli-<uuid>\image-1.png`
/// 这种路径会淹没真正的原因, 换成「参考图 image-1.png」即可。
fn condense_upload_paths(reason: &str) -> String {
    const MARKER: &str = "lentalk-jimeng-cli-";
    let mut out = String::with_capacity(reason.len());
    let mut rest = reason;
    while let Some(index) = rest.find(MARKER) {
        // 左边界: 向前吃掉路径与盘符, 停在引号/空白/括号处(路径里的 `:` 不算边界,
        // 否则会停在 `C:` 上把剩下的盘符路径留在消息里)。
        let head_cut = rest[..index]
            .char_indices()
            .rev()
            .find(|&(_, character)| matches!(character, '"' | '\'' | ' ' | '(' | '[' | '=' | '\n'))
            .map(|(position, character)| position + character.len_utf8())
            .unwrap_or(0);
        out.push_str(&rest[..head_cut]);
        let tail = &rest[index..];
        let end = tail
            .char_indices()
            .find(|&(_, character)| matches!(character, '"' | '\'' | ' ' | '\n' | '\r'))
            .map(|(position, _)| position)
            .unwrap_or(tail.len());
        // 报错里的路径是 JSON 转义过的, 结尾的 `\"` 会在文件名后留下一个反斜杠,
        // 直接按分隔符切会切出空文件名 —— 先去掉尾部分隔符再取最后一段。
        let segment = tail[..end].trim_end_matches(|character| character == '/' || character == '\\');
        let file_name = segment
            .rsplit(|character| character == '/' || character == '\\')
            .next()
            .unwrap_or(segment);
        out.push_str(&format!("参考图 {file_name}"));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// DNS + TCP 探测上传服务的 80 / 443 端口, 区分三种情况:
/// 完全不通(本机网络/代理)、只有 443 通(明文 http 被漏掉)、都通(上游偶发抖动)。
fn probe_upload_host(timeout: Duration) -> String {
    let http_reachable = tcp_reachable(JIMENG_UPLOAD_HOST, 80, timeout);
    let https_reachable = tcp_reachable(JIMENG_UPLOAD_HOST, 443, timeout);
    match (http_reachable, https_reachable) {
        (false, false) => format!(
            "诊断: 本机到 {JIMENG_UPLOAD_HOST} 的 80 与 443 都不通, 问题出在本机网络或代理, 请按下面的建议处理。"
        ),
        (false, true) => format!(
            "诊断: {JIMENG_UPLOAD_HOST} 的 443 可通、80 不通 —— 即梦 CLI 的申请上传位接口走的正是明文 http, 这多半就是失败原因。请放行 80 端口(或让该域名直连)后重试。"
        ),
        (true, false) => format!(
            "诊断: {JIMENG_UPLOAD_HOST} 的 80 可通、443 不通, 本机网络策略可能限制了 https, 建议换网络重试。"
        ),
        (true, true) => format!(
            "诊断: 本机到 {JIMENG_UPLOAD_HOST} 的 80 / 443 都可达 —— 本机网络本身是通的, {JIMENG_UPLOAD_HOST} 这一个域名不是失败点。分片上传另有对象存储域名(见 CLI 日志里的 `Fail to upload`)。"
        ),
    }
}

/// DNS 解析 + TCP 连接。`to_socket_addrs` / `connect_timeout` 都是阻塞调用,
/// 只在这条失败诊断路径上使用(在 spawn_blocking 线程里, 不会卡住异步运行时)。
fn tcp_reachable(host: &str, port: u16, timeout: Duration) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .filter_map(|address| TcpStream::connect_timeout(&address, timeout).ok())
        .next()
        .is_some()
}

/// 失败时的诊断文本: 说明这次走的是哪条网络 + 失败到底卡在哪个域名。
///
/// 诊断来源有优先级: **CLI 自己的日志**永远比我们猜一个域名去探测准 ——
/// 真实失败域名是分片上传随机分配的(`tos-d-lf` / `tos-d-lq` …), 猜不到。
/// 只有日志读不到时才退化为探测 `JIMENG_UPLOAD_HOST`。
fn describe_submit_failure_context(
    proxy_env: &[(String, String)],
    log_failure: Option<&CliLogFailure>,
) -> Vec<String> {
    let mut lines = Vec::new();
    match proxy_env.iter().find(|(key, _)| key == "HTTP_PROXY") {
        Some((_, value)) => lines.push(format!(
            "诊断: 检测到系统代理 {value}, 已注入给即梦 CLI(它默认不读 Windows 系统代理); 图床上传由 CLI 自行处理, 未必经过该代理。"
        )),
        None => lines.push("诊断: 未检测到可用的系统代理, 本次按直连进行。".to_string()),
    }
    match log_failure {
        Some(failure) => lines.extend(describe_cli_log_failure(failure)),
        None => lines.push(probe_upload_host(Duration::from_millis(2_500))),
    }
    lines
}

/// 是否需要人工先去网页端完成一次「模型首次生成」的合规确认。
///
/// 这类失败是**硬前置**: 重试多少次都没用, 所以提示必须放在报错的最前面,
/// 不能混在一堆技术细节后面。
fn is_compliance_blocker(reason: &str) -> bool {
    reason
        .to_ascii_lowercase()
        .contains("aigccomplianceconfirmationrequired")
}

/// 轮询阶段失败的完整说明。
///
/// 必须讲清的第一件事是「这不是生成失败」: 任务已经在服务端创建并预缴了积分, 结果通常仍会
/// 产出, 只是本地没能查回来。所以一定把 `submit_id` 交给用户, 让他能用官方 CLI 手动取回 ——
/// 否则用户会以为白花了积分, 再去重新生成一次(那才是真的重复扣费)。
fn describe_poll_failure(submit_id: &str, message: &str) -> String {
    let mut out = format!(
        "即梦 CLI 查询结果失败(注意: 这不等于生成失败 —— 任务已在服务端创建并预缴积分): {}\n\
         说明: 卡在「查询任务结果」这一步, 与提示词、素材内容无关; 服务端通常会继续把任务跑完, \
         结果一般不会丢。\n\
         建议: ① 等一两分钟后用官方 CLI 直接取回这一次的结果(不必重新生成, 也就不用再扣一次费):\
         `dreamina query_result --submit_id={submit_id} --download_dir=.`;\
         ② 换个网络(如手机热点)做对照; ③ 若开了系统代理 / VPN, 先关掉再试。",
        condense_upload_paths(message),
    );
    if let Some(hint) = humanize_jimeng_failure(message) {
        out.push('\n');
        out.push_str(hint);
    }
    out.push('\n');
    out.push_str(&describe_cli_proxy_state());
    out.push('\n');
    out.push_str(&cli_log_hint());
    out
}

/// 取证: 即梦 CLI 会不会把请求走进代理。
///
/// CLI 是 Go 程序, 它的 http 客户端**自动读取** `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
/// (与 Windows 系统代理无关), 而 GUI 进程的子进程会原样继承这些变量。即梦是国内服务,
/// 一旦被代理接管, 典型症状就是 `Client.Timeout exceeded while awaiting headers`。
/// 这里只做取证、不改行为 —— 用真实数据帮用户判断该不该关代理。
fn describe_cli_proxy_state() -> String {
    let mut values: Vec<String> = Vec::new();
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(raw) = std::env::var(key) {
            let value = raw.trim().to_string();
            // Windows 的环境变量名大小写不敏感, 同一个变量会被查出来两次 —— 按值去重。
            if !value.is_empty() && !values.contains(&value) {
                values.push(value);
            }
        }
    }
    if values.is_empty() {
        "诊断: 未检测到代理环境变量, 即梦 CLI 按直连访问即梦服务器。".to_string()
    } else {
        format!(
            "诊断: 检测到代理环境变量(HTTP_PROXY / HTTPS_PROXY / ALL_PROXY, 值: {}), \
             即梦 CLI 会自动继承 —— 即梦是国内服务, 被代理接管时容易在查询接口上超时, \
             建议关掉代理 / 清掉这些变量后重试一次做对照。",
            values.join(", ")
        )
    }
}

/// CLI 日志里读到的一次上传失败要点。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CliLogFailure {
    /// 失败的那台主机(分片上传每次随机分配, 所以只能在日志里读到)。
    host: String,
    kind: CliLogFailureKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliLogFailureKind {
    /// `dial tcp: lookup <host>: no such host` —— DNS 解析失败。
    Dns,
    /// `context deadline exceeded` / `i/o timeout` —— 连接超时。
    Timeout,
    /// 只知道域名, 弄不清类型。
    Other,
}

/// 即梦 CLI 的运行日志目录(官方排障指引指定的位置)。
fn cli_log_directory() -> Option<PathBuf> {
    current_user_home().map(|home| home.join(".dreamina_cli").join("logs"))
}

/// 读最新一份 CLI 日志的尾部若干行。
///
/// CLI 的失败细节(失败域名、每次重试的原始错误)只写在它自己的日志里,
/// 透传给我们的 `fail_reason` 往往只剩一句 `no file upload, please check log` ——
/// 这正是用户说的「哪里错误都不知道」的根源。
fn read_cli_log_tail(max_lines: usize) -> Option<Vec<String>> {
    let directory = cli_log_directory()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&directory).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.starts_with("dreamina.log") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if newest
            .as_ref()
            .is_none_or(|(previous, _)| modified > *previous)
        {
            newest = Some((modified, path));
        }
    }
    let (_, path) = newest?;
    let content = std::fs::read_to_string(path).ok()?;
    Some(
        content
            .lines()
            .rev()
            .take(max_lines)
            .map(str::to_string)
            .collect(),
    )
}

/// 纯函数: 从日志尾部找出上传失败的主机与类型。
///
/// 真实日志形如:
///   Error ... Fail to upload image, file_0 upload by HOST, isDirectUpload:false,
///   err:doamin tos-d-lq.bytedancevod.com, contentType , All attempts fail:
///   #1: http do, Post "https://tos-d-lq.bytedancevod.com/upload/v1/...":
///       dial tcp: lookup tos-d-lq.bytedancevod.com: no such host
/// 注意 `doamin` 是 CLI 自己的拼写, 这里按原文匹配。
fn extract_cli_log_failure(tail: &[String]) -> Option<CliLogFailure> {
    for line in tail {
        let Some(position) = line.find("lookup ") else {
            continue;
        };
        let rest = &line[position + "lookup ".len()..];
        let end = rest
            .find(|character: char| matches!(character, ':' | ' ' | '"'))
            .unwrap_or(rest.len());
        let host = rest[..end].trim();
        if !host.contains('.') {
            continue;
        }
        let lowered = rest.to_ascii_lowercase();
        let kind = if lowered.contains("no such host") {
            CliLogFailureKind::Dns
        } else if lowered.contains("timeout") || lowered.contains("i/o") {
            CliLogFailureKind::Timeout
        } else {
            CliLogFailureKind::Other
        };
        return Some(CliLogFailure {
            host: host.to_string(),
            kind,
        });
    }
    // 兜底: 只拿得到域名(CLI 的 `err:doamin <host>`)时, 按「类型未知」返回。
    for line in tail {
        let (position, marker_len) = if let Some(position) = line.find("err:doamin ") {
            (position, "err:doamin ".len())
        } else if let Some(position) = line.find("err:domain ") {
            (position, "err:domain ".len())
        } else {
            continue;
        };
        let rest = &line[position + marker_len..];
        let end = rest
            .find(|character: char| matches!(character, ',' | ' '))
            .unwrap_or(rest.len());
        let host = rest[..end].trim();
        if host.contains('.') {
            return Some(CliLogFailure {
                host: host.to_string(),
                kind: CliLogFailureKind::Other,
            });
        }
    }
    None
}

/// 失败时取证: 从 CLI 日志里读出真正的失败域名与类型。
fn read_cli_log_failure() -> Option<CliLogFailure> {
    let tail = read_cli_log_tail(200)?;
    extract_cli_log_failure(&tail)
}

/// 把日志取证结果写成用户能照做的诊断: 失败域名 + 类型 + **此刻是否已恢复**。
fn describe_cli_log_failure(failure: &CliLogFailure) -> Vec<String> {
    let what = match failure.kind {
        CliLogFailureKind::Dns => {
            "解析失败(DNS 查不到该主机)。这属于本机 DNS 层面的问题, 与提示词、素材内容无关。"
        }
        CliLogFailureKind::Timeout => "连接超时(请求发出后没等到响应)。",
        CliLogFailureKind::Other => "连接失败。",
    };
    let mut lines = vec![format!(
        "诊断: 即梦 CLI 日志显示, 失败发生在把参考图上传到字节对象存储时 —— 域名 {} {what}",
        failure.host
    )];
    // 用**此刻**的连通性做对照, 把「当时偶发」与「一直不通」区分开 ——
    // 这直接决定用户该「直接重试」还是该「先去修网络」。
    if tcp_reachable(&failure.host, 443, Duration::from_millis(2_500)) {
        lines.push(format!(
            "诊断: 本机此刻已能连通 {} ⇒ 说明是当时那一刻的偶发失败, 直接重试通常即可恢复。",
            failure.host
        ));
    } else {
        lines.push(format!(
            "诊断: 本机此刻仍连不上 {} ⇒ 请先按下面的建议处理本机网络 / DNS, 再重试。",
            failure.host
        ));
    }
    lines
}

/// 官方排障指引: 报错的完整描述在 CLI 日志里, 且很多问题升级 CLI 后即可解决。
///
/// 附在每条失败信息末尾, 用户就不会「哪里错了都不知道」——尤其当报错来自 CLI
/// 内部(比如上传阶段)而不是我们自己的链路时。
fn cli_log_hint() -> String {
    let logs = cli_log_directory()
        .map(|directory| directory.display().to_string())
        .unwrap_or_else(|| "~/.dreamina_cli/logs/".to_string());
    format!(
        "参考: 即梦 CLI 的完整运行日志在 {logs}; 按官方指引, 先保留出错的命令, 再对照该日志, \
         并优先把 CLI 升级到最新版后重试(很多问题在新版本已修复)。"
    )
}

/// 提交即梦 CLI 任务。
///
/// 失败时**先向服务端核对这次的任务有没有被创建**(即梦的生成任务一创建就预缴积分),
/// 只有确认没有才可能重试; 若发现任务其实已经建好(例如提交请求超时但服务端收到了),
/// 就直接接管它继续查询 —— 既不重复下单, 也不丢掉这个已经扣过费的任务。
fn submit_jimeng_command(
    app: &AppHandle,
    client_job_id: Option<&str>,
    executable: &str,
    arguments: &[String],
    label: &str,
) -> Result<String, String> {
    let mut attempt = 0u32;
    let mut proxy_env: Vec<(String, String)> = Vec::new();
    let mut diagnosis: Option<Vec<String>> = None;
    let mut log_failure: Option<CliLogFailure> = None;
    let prompt = prompt_from_arguments(arguments);
    // 提交前的服务端基线: 失败后用它判断有没有新任务冒出来(有 ⇒ 已扣费, 不能重试)。
    let mut baseline = read_task_snapshot(executable, &proxy_env);

    loop {
        attempt += 1;
        let outcome = run_cli_with_timeout_env(
            executable,
            arguments,
            CLI_SUBMIT_COMMAND_TIMEOUT,
            &proxy_env,
        );

        let failure_reason = match &outcome {
            Ok(output) if !is_failed(output) => return Ok(output.clone()),
            Ok(output) => output_summary(output),
            Err(message) => message.clone(),
        };
        let reported_submit_id = match &outcome {
            Ok(output) => extract_field(output, &["submit_id", "submitId"]),
            Err(_) => None,
        };

        // 第一次失败时: 解析系统代理 + 从 CLI 日志取证真实失败原因。
        // 之后的核对与重试复用同一条网络, 诊断也只生成一次。
        if diagnosis.is_none() {
            proxy_env = resolve_cli_proxy_env();
            log_failure = read_cli_log_failure();
            diagnosis = Some(describe_submit_failure_context(
                &proxy_env,
                log_failure.as_ref(),
            ));
        }
        let probe =
            probe_server_task(executable, reported_submit_id.as_deref(), &baseline, &prompt, &proxy_env);

        // 任务已建好、只是提交请求没拿到回执: 直接接管它, 不重复下单也不丢任务。
        if let ServerTaskProbe::Exists { submit_id, failed: false, .. } = &probe {
            return Ok(format!("submit_id={submit_id}"));
        }

        if !decide_submit_retry(&probe, &failure_reason) {
            let condensed = condense_upload_paths(&failure_reason);
            let mut message = match &probe {
                // 本地任务库里已经有这一次的失败记录 —— 把「到底扣没扣钱」说清楚,
                // 用户才知道能不能自己手动重试, 而不是对着一句英文发呆。
                ServerTaskProbe::Exists { submit_id, charged, .. } => {
                    let billing = if *charged {
                        "记录已产生计费, 已跳过自动重试以免重复扣费"
                    } else {
                        "记录未产生计费; 因本次报错无法确认卡在上传阶段, 已跳过自动重试 —— 你可手动重试, 不会重复扣费"
                    };
                    format!(
                        "即梦 CLI {label}失败(submit_id={submit_id} 已在本地任务库中, {billing}): {condensed}"
                    )
                }
                _ if failure_reason.starts_with("即梦 CLI") => condensed,
                _ => format!("即梦 CLI {label}生成失败: {condensed}"),
            };
            // 这一类失败(参数错、审核拦截、无法核实的超时等)原来只回一句原始错误,
            // 补上中文说明、日志取证与官方日志位置, 用户才知道下一步该做什么。
            if let Some(hint) = humanize_jimeng_failure(&failure_reason) {
                if is_compliance_blocker(&failure_reason) {
                    // 必须人工去网页做一次, 顶到第一行。
                    message = format!("{hint}\n{message}");
                } else {
                    message.push('\n');
                    message.push_str(hint);
                }
            }
            if let Some(note) = &diagnosis {
                message.push('\n');
                message.push_str(&note.join("\n"));
            }
            message.push('\n');
            message.push_str(&cli_log_hint());
            return Err(message);
        }
        if attempt >= JIMENG_SUBMIT_MAX_ATTEMPTS {
            let mut message = format!(
                "即梦 CLI {label}生成失败(提交阶段失败, 已自动重试 {} 次): {}",
                JIMENG_SUBMIT_MAX_ATTEMPTS - 1,
                condense_upload_paths(&failure_reason),
            );
            if let Some(note) = &diagnosis {
                message.push('\n');
                message.push_str(&note.join("\n"));
            }
            if let Some(hint) = humanize_jimeng_failure(&failure_reason) {
                if is_compliance_blocker(&failure_reason) {
                    message = format!("{hint}\n{message}");
                } else {
                    message.push('\n');
                    message.push_str(hint);
                }
            }
            message.push('\n');
            message.push_str(&cli_log_hint());
            return Err(message);
        }

        emit_cli_task_status(
            app,
            client_job_id,
            "",
            "retrying",
            None,
            Some(format!(
                "参考图上传失败, 正在自动重试(第 {}/{} 次)",
                attempt + 1,
                JIMENG_SUBMIT_MAX_ATTEMPTS
            )),
        );
        let index = ((attempt - 1) as usize).min(JIMENG_SUBMIT_RETRY_BACKOFF_MS.len() - 1);
        thread::sleep(Duration::from_millis(JIMENG_SUBMIT_RETRY_BACKOFF_MS[index]));
        // 刷新基线: 下一轮失败时以「这一轮之前」的服务端状态做比对。
        baseline = read_task_snapshot(executable, &proxy_env);
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
    run_cli_with_timeout_env(executable, arguments, timeout, &[])
}

/// 与 `run_cli_with_timeout` 相同, 但可追加环境变量 —— 重试时用它把系统代理显式传给
/// 即梦 CLI(它不读 Windows 系统代理, 只认 `HTTP_PROXY` / `HTTPS_PROXY`)。
/// 执行 CLI 并**保留退出码**: 返回 `(成功, 合并输出)`。
///
/// 设备码轮询(`auth wait`)这类命令会把「本轮没等到」编码成**非零退出码 + JSON 错误体**。
/// 用 `run_cli` 会把它直接变成 Err, 于是永远读不到 `error.code`, 只能看到一个干巴巴的
/// 「命令执行失败」。需要读错误体内部的调用方要用这个版本。
fn spawn_cli_capture(
    executable: &str,
    arguments: &[String],
    timeout: Duration,
    extra_env: &[(String, String)],
) -> Result<(bool, String), String> {
    let lock = JIMENG_CLI_PROCESS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "即梦 CLI 调用锁异常，请重启应用后重试".to_string())?;
    let resolved = resolve_executable(executable)?;
    let mut command = build_cli_command(&resolved, extra_env);
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
    Ok((output.status.success(), combined))
}

/// 常规调用: 非零退出码一律视为失败。
fn run_cli_with_timeout_env(
    executable: &str,
    arguments: &[String],
    timeout: Duration,
    extra_env: &[(String, String)],
) -> Result<String, String> {
    let (success, combined) = spawn_cli_capture(executable, arguments, timeout, extra_env)?;
    if success {
        Ok(combined)
    } else {
        Err(format!(
            "即梦 CLI 命令执行失败: {}",
            output_summary(&combined)
        ))
    }
}

/// GUI applications inherit a minimal environment. Keep the CLI's user
/// profile and executable search paths explicit so its credential backend and
/// helper commands behave the same as when launched from a terminal.
fn build_cli_command(resolved: &str, extra_env: &[(String, String)]) -> Command {
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
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command
}

/// 把 Windows 系统代理(WinINET 设置)翻译成即梦 CLI 认的环境变量。
///
/// 即梦 CLI 只认 `HTTP_PROXY` / `HTTPS_PROXY`, **不读** Windows 系统代理; 而它上传
/// 参考图用的是明文 `http://` 地址, 很多代理规则只覆盖 https 就漏掉了这一步。这里把
/// 系统代理显式传给子进程, 让 CLI 和浏览器走同一条网络。
///
/// 只在「上一次提交因网络问题失败」后调用, 不进入正常路径。
#[cfg(target_os = "windows")]
fn resolve_cli_proxy_env() -> Vec<(String, String)> {
    // 应用本身就是带着代理变量启动的: 子进程默认继承环境, 不要覆盖用户的选择。
    if std::env::var_os("HTTP_PROXY").is_some() || std::env::var_os("http_proxy").is_some() {
        return Vec::new();
    }
    let Some((http, https)) = read_windows_system_proxy() else {
        return Vec::new();
    };
    vec![
        ("HTTP_PROXY".to_string(), proxy_url(&http)),
        ("HTTPS_PROXY".to_string(), proxy_url(&https)),
        ("NO_PROXY".to_string(), "localhost,127.0.0.1,::1".to_string()),
    ]
}

#[cfg(not(target_os = "windows"))]
fn resolve_cli_proxy_env() -> Vec<(String, String)> {
    // macOS / Linux 的系统代理同样不被即梦 CLI 识别, 但读取方式不同, 本次未覆盖。
    Vec::new()
}

/// 统一成 `http://host:port`: HTTPS 目标也是走 HTTP CONNECT, 这是各代理客户端通用的写法。
#[cfg(target_os = "windows")]
fn proxy_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

/// 解析注册表里的 `ProxyServer`: 既可能是裸的 `host:port`, 也可能是
/// `http=host:port;https=host:port`。同一个代理同时覆盖两种协议时, 缺失的一侧回落到另一侧。
#[cfg(target_os = "windows")]
fn parse_system_proxy_server(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if !raw.contains('=') {
        return Some((raw.to_string(), raw.to_string()));
    }
    let mut http = None;
    let mut https = None;
    for entry in raw.split(';') {
        let mut parts = entry.splitn(2, '=');
        let Some(scheme) = parts.next() else {
            continue;
        };
        let value = parts.next().unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = Some(value.to_string()),
            "https" => https = Some(value.to_string()),
            _ => {}
        }
    }
    match (http, https) {
        (Some(http), Some(https)) => Some((http, https)),
        (Some(http), None) => Some((http.clone(), http)),
        (None, Some(https)) => Some((https.clone(), https)),
        (None, None) => None,
    }
}

#[cfg(target_os = "windows")]
fn read_windows_system_proxy() -> Option<(String, String)> {
    const INTERNET_SETTINGS: &str =
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let mut command = Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.args(["query", INTERNET_SETTINGS]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let _kind = parts.next();
        let Some(value) = parts.next() else {
            continue;
        };
        if name.eq_ignore_ascii_case("ProxyEnable") {
            let value = value.trim();
            enabled = value != "0x0" && value != "0";
        } else if name.eq_ignore_ascii_case("ProxyServer") {
            server = Some(value.trim().to_string());
        }
    }
    if !enabled {
        return None;
    }
    parse_system_proxy_server(server.as_deref()?)
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
/// - `force=true` → 走 `dreamina relogin --headless`: 先清本地 OAuth 记录再**强制**发新材料,
///   用于「切换账号」。普通 `login` 会复用仍有效的旧登录态, 这正是切号后仍进老账号的原因。
#[tauri::command]
pub async fn jimeng_cli_login_start(
    executable: String,
    force: Option<bool>,
) -> Result<JimengCliLoginStartResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦 CLI」中填写 CLI 可执行命令".to_string());
    }
    let force = force.unwrap_or(false);
    let value = executable.clone();
    let output = tokio::task::spawn_blocking(move || {
        let subcommand = if force { "relogin" } else { "login" };
        run_cli(&value, &[subcommand.to_string(), "--headless".to_string()])
    })
    .await
    .map_err(|error| format!("即梦 CLI 登录任务中断: {error}"))??;

    // relogin 已经清掉了本地记录, 输出里不可能有「复用」; 这里只在普通模式
    // 下认「已登录」, 否则强制换号会被误判成登录成功而直接返回。
    let lower = output.to_ascii_lowercase();
    let already_logged_in = !force
        && (lower.contains("复用")
            || lower.contains("已登录")
            || lower.contains("already logged")
            || lower.contains("reuse")
            || lower.contains("logged in"));
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

/// 用无痕窗口打开授权页的结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliOpenAuthResult {
    /// 后端是否已用无痕窗口打开; false 时由前端回退到系统默认浏览器。
    pub opened: bool,
    pub private_mode: bool,
    /// 实际使用的浏览器名, 便于前端提示用户用的是哪一个。
    pub browser: Option<String>,
}

/// 常见 Chromium 内核浏览器 + 各自的无痕开关。
///
/// 即梦的设备码授权认的是**浏览器里当前登录的即梦账号**, 所以「切换账号」必须
/// 用一个没有旧 cookie 的会话, 否则授权页会直接把旧账号授出去 —— 这正是
/// 「退出登录后重新授权, 还是老账号」的根因。
fn browser_candidates() -> Vec<(&'static str, PathBuf, &'static str)> {
    #[allow(unused_mut)]
    let mut candidates: Vec<(&'static str, PathBuf, &'static str)> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            let Some(base) = std::env::var_os(key).map(PathBuf::from) else {
                continue;
            };
            candidates.push((
                "Edge",
                base.join("Microsoft").join("Edge").join("Application").join("msedge.exe"),
                "--inprivate",
            ));
            candidates.push((
                "Chrome",
                base.join("Google").join("Chrome").join("Application").join("chrome.exe"),
                "--incognito",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push((
            "Chrome",
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "--incognito",
        ));
        candidates.push((
            "Edge",
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            "--inprivate",
        ));
    }
    candidates
}

/// 授权链接只允许 http(s) —— 这个值会被直接交给浏览器进程, 不做 scheme 白名单
/// 就等于把 `file://` / 自定义协议也放行了。
fn is_allowed_login_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// 内置登录窗口的 label —— 同一个窗口反复复用, 避免点几次堆出几个登录窗。
const JIMENG_LOGIN_WINDOW_LABEL: &str = "jimeng-login";

/// 第三方登录弹窗(抖音等)的 label 序号。
static JIMENG_LOGIN_POPUP_SEQ: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliLoginWindowResult {
    pub opened: bool,
    pub label: Option<String>,
    pub message: String,
}

/// 清掉登录窗口专属会话里的账号态。
///
/// 只删 cookie 与本地存储 —— **不删整个 profile 目录**。整份目录 60MB / 800+ 文件,
/// 删完 WebView2 还要重新初始化一份全新的用户数据目录(实测量级 1~3 秒), 而用户真正
/// 要清掉的只是「这个窗口当前登录的是哪个账号」。
fn clear_login_profile_session(profile_dir: &Path) {
    let webview = profile_dir.join("EBWebView");
    let default_dir = webview.join("Default");
    let network = default_dir.join("Network");
    // ⚠️ `EBWebView/Local State` 是环境级配置, 删了会让 WebView2 重新初始化, 不能动。
    let targets = [
        default_dir.join("Cookies"),
        default_dir.join("Cookies-journal"),
        default_dir.join("Local Storage"),
        default_dir.join("Session Storage"),
        network.join("Cookies"),
        network.join("Cookies-journal"),
    ];
    for target in targets {
        if !target.exists() {
            continue;
        }
        let outcome = if target.is_dir() {
            fs::remove_dir_all(&target)
        } else {
            fs::remove_file(&target)
        };
        if let Err(error) = outcome {
            // 删不掉不致命: 窗口会继续用旧会话, 但至少还能打开授权页。
            eprintln!("清理即梦登录会话失败（{}）：{error}", target.display());
        }
    }
}

/// 在应用内用独立 WebView 窗口打开即梦授权页。
///
/// 相比拉起系统浏览器, 这条路有三个好处:
/// 1. **会话可控**: Windows 上给窗口单独指定 WebView2 数据目录, 换号时直接删目录,
///    既不受系统浏览器里旧账号的影响, 也不会把用户的浏览器搞乱;
/// 2. **不切应用**: 授权页就在应用里, 不用找标签页, 关掉就是关掉;
/// 3. **零安装**: WebView2 是 Win10/11 自带的运行时, 不额外打包浏览器内核。
///
/// `reset_session=true` 用于「切换账号」: 连同窗口专属的会话目录一起删掉。
#[tauri::command]
pub async fn jimeng_cli_open_login_window(
    app: AppHandle,
    url: String,
    reset_session: Option<bool>,
    title: Option<String>,
) -> Result<JimengCliLoginWindowResult, String> {
    let url = url.trim().to_string();
    if !is_allowed_login_url(&url) {
        return Err("授权地址无效：只接受 http(s) 链接".to_string());
    }
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| format!("授权地址无法解析: {error}"))?;
    let reset_session = reset_session.unwrap_or(false);
    // 同一个窗口既用于「设备码授权」也用于「打开即梦网页做合规确认」, 标题跟着变。
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "即梦账号登录".to_string());

    if let Some(existing) = app.get_webview_window(JIMENG_LOGIN_WINDOW_LABEL) {
        let _ = existing.close();
        // 等窗口真正销毁, 否则紧接着删会话目录会因文件占用失败。
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    #[cfg(target_os = "windows")]
    let profile_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("jimeng-login-profile");

    #[cfg(target_os = "windows")]
    if reset_session && profile_dir.exists() {
        clear_login_profile_session(&profile_dir);
    }

    // 抖音/微信等第三方登录都是 `window.open` 弹窗。WebView 默认把这类新窗口请求
    // 直接丢掉且**不报错**, 表现就是「点了按钮没反应」。
    //
    // 光 `Allow` 不够: 那样 WebView2 会把链接甩给系统默认浏览器, 登录态落在浏览器里,
    // 授权页这一侧仍然看不到。必须用 `window_features(features)` 继承 opener 的
    // WebView2 environment, 再用 `Create` 在应用内开窗 —— 这样弹窗和授权页共用同一份
    // 会话数据, 抖音登录完的 cookie 授权页立刻就能用上。
    let popup_app = app.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        JIMENG_LOGIN_WINDOW_LABEL,
        tauri::WebviewUrl::External(parsed),
    )
    .title(&title)
    .inner_size(460.0, 800.0)
    .min_inner_size(360.0, 560.0)
    .center()
    .on_new_window(move |url, features| {
        let label = format!(
            "{JIMENG_LOGIN_WINDOW_LABEL}-popup-{}",
            JIMENG_LOGIN_POPUP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let has_requested_size = features.size().is_some();
        let mut builder = tauri::WebviewWindowBuilder::new(
            &popup_app,
            &label,
            tauri::WebviewUrl::External(url),
        )
        .window_features(features)
        .title("登录");
        if !has_requested_size {
            builder = builder.inner_size(520.0, 720.0);
        }
        // 🔴 这里**不要**按「导航回 jimeng 域名」自动关窗。
        // 抖音登录弹窗自己一打开就会先跳一次 jimeng(OAuth 中转), 之前靠导航判断
        // 会在登录画面还没出来时就把窗口关掉。关窗改由前端在轮询到登录成功后
        // 调 `jimeng_cli_close_login_window` —— 那时主窗口一关, 弹窗自然一起消失。
        match builder.build() {
            Ok(window) => tauri::webview::NewWindowResponse::Create { window },
            // 兜底: 建不出来就交给 WebView2 默认处理, 至少不会「点了没反应」。
            Err(error) => {
                eprintln!("即梦第三方登录弹窗创建失败: {error}");
                tauri::webview::NewWindowResponse::Allow
            }
        }
    });

    #[cfg(target_os = "windows")]
    {
        let _ = fs::create_dir_all(&profile_dir);
        builder = builder.data_directory(profile_dir);
    }

    let window = builder
        .build()
        .map_err(|error| format!("无法打开内置登录窗口: {error}"))?;
    let _ = window.set_focus();

    Ok(JimengCliLoginWindowResult {
        opened: true,
        label: Some(JIMENG_LOGIN_WINDOW_LABEL.to_string()),
        message: "已在内置窗口中打开授权页".to_string(),
    })
}

/// 登录完成 / 用户取消后关掉所有登录相关窗口。
///
/// 注意要按**前缀**匹配: 第三方登录弹窗的 label 是 `jimeng-login-popup-N`,
/// 只关主窗口会把抖音/微信登录窗留在屏幕上。
#[tauri::command]
pub async fn jimeng_cli_close_login_window(app: AppHandle) -> Result<(), String> {
    let mut first_error: Option<String> = None;
    for (label, window) in app.webview_windows() {
        if !label.starts_with(JIMENG_LOGIN_WINDOW_LABEL) {
            continue;
        }
        if let Err(error) = window.close() {
            if first_error.is_none() {
                first_error = Some(format!("关闭登录窗口失败: {error}"));
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 打开即梦授权页。
/// - `private_mode=true`: 优先用系统的 Edge/Chrome 无痕窗口打开, 用来切换账号;
///   都不可用时返回 `opened=false`, 由前端回退到系统默认浏览器。
/// - `private_mode=false`: 直接返回 `opened=false`(前端用系统默认浏览器, 复用现有登录态最快)。
#[tauri::command]
pub async fn jimeng_cli_open_login_url(
    url: String,
    private_mode: Option<bool>,
) -> Result<JimengCliOpenAuthResult, String> {
    let url = url.trim().to_string();
    if !is_allowed_login_url(&url) {
        return Err("授权地址无效：只接受 http(s) 链接".to_string());
    }
    if !private_mode.unwrap_or(false) {
        return Ok(JimengCliOpenAuthResult {
            opened: false,
            private_mode: false,
            browser: None,
        });
    }
    for (name, path, flag) in browser_candidates() {
        if !path.is_file() {
            continue;
        }
        // 参数直接交给 CreateProcess / execve, 不经过 shell, URL 不会被当命令解析。
        let spawned = Command::new(&path)
            .arg(flag)
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(_) => {
                // 不 wait: 浏览器是常驻 GUI 进程, 等它会把这个命令挂死。
                return Ok(JimengCliOpenAuthResult {
                    opened: true,
                    private_mode: true,
                    browser: Some(name.to_string()),
                });
            }
            Err(error) => {
                eprintln!("即梦授权页无痕打开失败（{name} @ {}）：{error}", path.display());
            }
        }
    }
    Ok(JimengCliOpenAuthResult {
        opened: false,
        private_mode: false,
        browser: None,
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
    fn login_url_scheme_whitelist_rejects_non_http() {
        assert!(is_allowed_login_url("https://jimeng.jianying.com/ai-tool/cli-auth?x=1"));
        assert!(is_allowed_login_url("http://127.0.0.1:1420/cb"));
        // 大小写/前后空白不该被当成非法链接
        assert!(is_allowed_login_url("  HTTPS://example.com/x  "));
        assert!(!is_allowed_login_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_allowed_login_url("javascript:alert(1)"));
        assert!(!is_allowed_login_url("ms-settings:privacy"));
        assert!(!is_allowed_login_url(""));
    }

    #[test]
    fn browser_candidates_carry_private_flags() {
        let candidates = browser_candidates();
        #[cfg(target_os = "windows")]
        {
            assert!(candidates
                .iter()
                .any(|(name, _, flag)| *name == "Edge" && *flag == "--inprivate"));
            assert!(candidates
                .iter()
                .any(|(name, _, flag)| *name == "Chrome" && *flag == "--incognito"));
        }
        // 每条候选都必须带无痕开关, 否则切号会复用浏览器里已有的旧账号。
        assert!(candidates.iter().all(|(_, _, flag)| !flag.is_empty()));
    }

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

    // --- 平台自动识别（Windows / macOS / Linux 与官方安装脚本同源） ---

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lentalk-jimeng-test-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn platform_download_files_match_official_script() {
        // 必须与官方脚本 detect_platform() 中的 DOWNLOAD_FILE 逐字一致
        assert_eq!(
            JimengCliPlatform::WindowsAmd64.download_file(),
            "dreamina_cli_windows_amd64.exe"
        );
        assert_eq!(
            JimengCliPlatform::DarwinAmd64.download_file(),
            "dreamina_cli_darwin_amd64"
        );
        assert_eq!(
            JimengCliPlatform::DarwinArm64.download_file(),
            "dreamina_cli_darwin_arm64"
        );
        assert_eq!(
            JimengCliPlatform::LinuxAmd64.download_file(),
            "dreamina_cli_linux_amd64"
        );
        assert_eq!(
            JimengCliPlatform::LinuxArm64.download_file(),
            "dreamina_cli_linux_arm64"
        );
    }

    #[test]
    fn only_windows_binary_carries_exe_suffix() {
        assert!(JimengCliPlatform::WindowsAmd64.is_windows());
        assert_eq!(JimengCliPlatform::WindowsAmd64.binary_name(), "dreamina.exe");
        assert_eq!(JimengCliPlatform::WindowsAmd64.binary_suffix(), ".exe");
        for platform in [
            JimengCliPlatform::DarwinAmd64,
            JimengCliPlatform::DarwinArm64,
            JimengCliPlatform::LinuxAmd64,
            JimengCliPlatform::LinuxArm64,
        ] {
            assert!(!platform.is_windows(), "{} 不该带 .exe", platform.label());
            assert_eq!(platform.binary_name(), "dreamina");
            assert_eq!(platform.binary_suffix(), "");
        }
    }

    #[test]
    fn install_bin_dir_matches_official_layout() {
        let home = Path::new("/home/tester");
        assert_eq!(
            install_bin_dir(home, JimengCliPlatform::WindowsAmd64),
            home.join("bin")
        );
        for platform in [
            JimengCliPlatform::DarwinAmd64,
            JimengCliPlatform::DarwinArm64,
            JimengCliPlatform::LinuxAmd64,
            JimengCliPlatform::LinuxArm64,
        ] {
            assert_eq!(
                install_bin_dir(home, platform),
                home.join(".local").join("bin")
            );
        }
    }

    #[test]
    fn detected_platform_matches_the_host_os() {
        let platform = JimengCliPlatform::detect().expect("本机应为受支持的平台");
        let expected_prefix = if cfg!(target_os = "windows") {
            "dreamina_cli_windows_"
        } else if cfg!(target_os = "macos") {
            "dreamina_cli_darwin_"
        } else {
            "dreamina_cli_linux_"
        };
        assert!(
            platform.download_file().starts_with(expected_prefix),
            "{} 应下载 {expected_prefix}* 产物，实际为 {}",
            platform.label(),
            platform.download_file()
        );
        assert_eq!(platform.is_windows(), cfg!(target_os = "windows"));
    }

    #[test]
    fn install_bin_dir_is_discoverable_after_install() {
        // 装完必须能被 detect_executable 的候选目录扫到，否则复检必然失败。
        // common_locations 本身是平台相关的（只在 Windows 收 ~/bin），故只校验本机平台。
        let home = current_user_home().unwrap_or_else(|| PathBuf::from("/home/tester"));
        let candidates = common_locations("dreamina")
            .into_iter()
            .map(|path| path.replace('\\', "/"))
            .collect::<Vec<_>>();
        let platform = JimengCliPlatform::detect().expect("本机应为受支持的平台");
        let dir = install_bin_dir(&home, platform)
            .to_string_lossy()
            .replace('\\', "/");
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.starts_with(&dir)),
            "{} 的安装目录 {dir} 不在探测候选里",
            platform.label()
        );
    }

    // --- Unix PATH 写入（启动文件选择 + 幂等追加） ---

    #[test]
    fn zsh_rc_honours_zdotdir() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            pick_unix_rc_file(Some("/bin/zsh"), home, None),
            home.join(".zshrc")
        );
        assert_eq!(
            pick_unix_rc_file(Some("/usr/local/bin/zsh"), home, None),
            home.join(".zshrc")
        );
        assert_eq!(
            pick_unix_rc_file(Some("/bin/zsh"), home, Some("/Users/tester/.config/zsh")),
            Path::new("/Users/tester/.config/zsh").join(".zshrc")
        );
        // 空串 ZDOTDIR 视为未设置
        assert_eq!(
            pick_unix_rc_file(Some("/bin/zsh"), home, Some("")),
            home.join(".zshrc")
        );
    }

    #[test]
    fn bash_rc_pick_matches_official_rule() {
        let home = unique_temp_dir("bash-home");
        // 没有 .bash_profile → .bashrc
        assert_eq!(
            pick_unix_rc_file(Some("/bin/bash"), &home, None),
            home.join(".bashrc")
        );
        fs::write(home.join(".bash_profile"), "").expect("seed bash_profile");
        assert_eq!(
            pick_unix_rc_file(Some("/bin/bash"), &home, None),
            home.join(".bash_profile")
        );
        fs::write(home.join(".bashrc"), "").expect("seed bashrc");
        assert_eq!(
            pick_unix_rc_file(Some("/bin/bash"), &home, None),
            home.join(".bashrc")
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_shell_prefers_existing_zshrc_over_profile() {
        let home = unique_temp_dir("unknown-shell-home");
        // 没有 ~/.zshrc 时退到 ~/.profile
        assert_eq!(pick_unix_rc_file(None, &home, None), home.join(".profile"));
        assert_eq!(
            pick_unix_rc_file(Some("/bin/fish"), &home, None),
            home.join(".profile")
        );
        // macOS 默认 zsh：~/.zshrc 存在时必须落它，否则 zsh 不读 .profile
        fs::write(home.join(".zshrc"), "").expect("seed zshrc");
        assert_eq!(pick_unix_rc_file(None, &home, None), home.join(".zshrc"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn appends_path_line_only_once() {
        let dir = unique_temp_dir("rc-append");
        let rc = dir.join(".zshrc");
        let line = "export PATH=\"/Users/tester/.local/bin:$PATH\"";

        assert!(append_line_if_missing(&rc, line).expect("first append"));
        assert!(!append_line_if_missing(&rc, line).expect("second append is a no-op"));
        let contents = fs::read_to_string(&rc).expect("read rc");
        assert_eq!(contents.matches(line).count(), 1);
        assert_eq!(contents, format!("{line}\n"));

        // 已有内容且末尾没有换行时也不能把两行粘连
        let other = dir.join(".bashrc");
        fs::write(&other, "# keep me").expect("seed file");
        assert!(append_line_if_missing(&other, line).expect("append to existing"));
        assert_eq!(
            fs::read_to_string(&other).expect("read bashrc"),
            format!("# keep me\n{line}\n")
        );

        let _ = fs::remove_dir_all(&dir);
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

    #[test]
    fn upload_deadline_exceeded_retries_only_without_a_server_task() {
        // 真实报文: 上传参考图的 apply 阶段超时。
        let reason = r#"gen_status="fail", fail_reason="upload resource \"C:\\Users\\A\\AppData\\Local\\Temp\\lentalk-jimeng-cli-6ce178c8-5000-4729-a0dc-ddb99119e4b2\\image-1.png\": upload image: apply phase, ApplyImageUpload: do request, Get \"http://imagex.bytedanceapi.com/?Action=ApplyImageUpload&NeedFallback=true&UploadNum=1\": context deadline exceeded""#;

        assert!(is_presubmit_failure(reason));
        assert!(is_transient_submit_failure(reason));
        // 服务端确认没有这次的任务 ⇒ 可以重试。
        assert!(decide_submit_retry(&ServerTaskProbe::Absent, reason));
        // 情况不明, 但报错证明卡在 submit 之前的上传阶段 ⇒ 仍然安全。
        assert!(decide_submit_retry(&ServerTaskProbe::Unknown, reason));
        // 记录里已产生计费 ⇒ 已扣过钱, 绝不重试。
        assert!(!decide_submit_retry(
            &ServerTaskProbe::Exists { submit_id: "t".into(), failed: false, charged: true },
            reason
        ));
        // 记录里没有计费信息(上传阶段失败留下的空壳) + 报错证明卡在上传阶段
        // ⇒ 免费可重试。
        assert!(decide_submit_retry(
            &ServerTaskProbe::Exists { submit_id: "t".into(), failed: true, charged: false },
            reason
        ));
    }

    #[test]
    fn content_moderation_is_not_retryable() {
        let reason = "gen_status=\"fail\", fail_reason=\"炳火 API 请求失败: HTTP 500 fail_to_fetch_task 参考素材或提示词触发了上游内容审核\"";

        assert!(!is_transient_submit_failure(reason));
        assert!(!is_presubmit_failure(reason));
        assert!(!decide_submit_retry(&ServerTaskProbe::Absent, reason));
        assert!(!decide_submit_retry(&ServerTaskProbe::Unknown, reason));
        assert!(humanize_jimeng_failure(reason).is_some_and(|hint| hint.contains("内容审核")));
    }

    #[test]
    fn unknown_phase_failure_without_network_signal_never_retries() {
        // 提交超时(我们自己的 5 分钟)既不能证明任务没建好, 也不是网络抖动特征 ——
        // 重试还要再等 5 分钟, 且可能是重复下单, 所以一律不重试。
        let reason = "即梦 CLI 命令超过 300 秒未返回, 已终止";

        assert!(!is_presubmit_failure(reason));
        assert!(!is_transient_submit_failure(reason));
        assert!(!decide_submit_retry(&ServerTaskProbe::Unknown, reason));
        assert!(!decide_submit_retry(&ServerTaskProbe::Absent, reason));
    }

    #[test]
    fn parse_task_list_reads_newest_entry() {
        // 真实 `list_task --limit=1` 输出(节选, 字段保持原样)。
        let output = r#"[
  {
    "submit_id": "5b99bb21-70dc-4bb9-becc-0e314a4c33d2",
    "prompt": "SCENE CONTEXT 藏医诊所，8秒真人实景质感短片。",
    "gen_task_type": "multimodal2video",
    "gen_status": "fail",
    "fail_reason": "api error: ret=1006, message=CreditPreDeductNotEnough, logid=20260923163929192168003026079BF8C"
  }
]"#;

        let ParsedTaskList::Parsed(Some(entry)) = parse_task_list(output) else {
            panic!("应能解析出任务");
        };
        assert_eq!(entry.submit_id, "5b99bb21-70dc-4bb9-becc-0e314a4c33d2");
        assert!(entry.failed);
        assert!(entry.prompt.starts_with("SCENE CONTEXT"));
        // 该记录没有 commerce_info ⇒ 没扣钱(实测 CreditPreDeductNotEnough 正是这种)。
        assert!(!entry.charged);
    }

    #[test]
    fn parse_task_list_reads_billing_from_commerce_info() {
        // 真实 `list_task` 输出: 生成阶段的失败**已经扣了费**, 记录里带 credit_count。
        let charged = r#"[{"submit_id":"s1","gen_status":"fail","prompt":"p",
          "commerce_info":{"credit_count":132,"triplets":[{"resource_type":"aigc"}]}}]"#;
        let ParsedTaskList::Parsed(Some(entry)) = parse_task_list(charged) else {
            panic!("应能解析出任务");
        };
        assert!(entry.charged, "有 credit_count 就必须判定为已计费");

        // 上传阶段失败与积分预扣不足: 计费字段缺失 / 为空 ⇒ 没扣钱。
        let empty_object = r#"[{"submit_id":"s2","gen_status":"fail","commerce_info":{}}]"#;
        let ParsedTaskList::Parsed(Some(entry)) = parse_task_list(empty_object) else {
            panic!("应能解析出任务");
        };
        assert!(!entry.charged);

        let null_billing = r#"[{"submit_id":"s3","gen_status":"fail","commerce_info":null}]"#;
        let ParsedTaskList::Parsed(Some(entry)) = parse_task_list(null_billing) else {
            panic!("应能解析出任务");
        };
        assert!(!entry.charged);
    }

    #[test]
    fn unattributable_failure_record_never_retries() {
        // 关键安全线: 「有失败记录但没计费信息」**不等于**可以重试 ——
        // 还必须让这次的报错本身也能证明卡在 submit 之前, 否则一律不重试。
        // CreditPreDeductNotEnough(积分预扣不足)正是这种: 无计费信息, 但重试只会再被拒。
        let credit = "api error: ret=1006, message=CreditPreDeductNotEnough, logid=2026";
        assert!(!is_presubmit_failure(credit));
        assert!(!decide_submit_retry(
            &ServerTaskProbe::Exists { submit_id: "t".into(), failed: true, charged: false },
            credit
        ));
        // 生成阶段失败(已扣费)就更不必说。
        assert!(!decide_submit_retry(
            &ServerTaskProbe::Exists { submit_id: "t".into(), failed: true, charged: true },
            "generation failed: final generation failed"
        ));
    }

    #[test]
    fn parse_task_list_treats_empty_list_as_no_task() {
        // 关键实证: 用户报错里那个 submit_id 拿去精确查询返回 `[]` —— 它不是服务端任务。
        assert_eq!(
            parse_task_list("[]"),
            ParsedTaskList::Parsed(None)
        );
        // CLI 报错文案(而非 JSON)必须被识别为「查不动」, 不能当成「没有任务」。
        assert_eq!(
            parse_task_list("尚未登录, 请先执行 dreamina login"),
            ParsedTaskList::Unparsable
        );
    }

    #[test]
    fn diff_detects_new_task_of_the_same_submission() {
        let prompt = "SCENE CONTEXT 苗医馆内，一名苗族男子坐在桌后，对镜头口播，全程中景，十秒真人实景。";
        let before = TaskListSnapshot::Read(Some(TaskEntry {
            submit_id: "old-task".into(),
            failed: false,
            charged: true,
            prompt: "上一单的提示词".into(),
        }));
        let after = TaskListSnapshot::Read(Some(TaskEntry {
            submit_id: "new-task".into(),
            failed: false,
            charged: true,
            prompt: prompt.into(),
        }));

        assert_eq!(
            diff_task_snapshots(&before, &after, prompt),
            ServerTaskProbe::Exists { submit_id: "new-task".into(), failed: false, charged: true }
        );
        // 最新任务没变 ⇒ 没有新任务。
        assert_eq!(
            diff_task_snapshots(&before, &before, prompt),
            ServerTaskProbe::Absent
        );
        // 快照读不到 ⇒ 不冒险。
        assert_eq!(
            diff_task_snapshots(&TaskListSnapshot::Unavailable, &after, prompt),
            ServerTaskProbe::Unknown
        );
    }

    #[test]
    fn foreign_task_is_not_treated_as_ours() {
        // 画布上别的节点并发提交时, 最新任务会变, 但提示词对不上 —— 不能认领。
        let prompt = "SCENE CONTEXT 苗医馆内，一名苗族男子坐在桌后，对镜头口播，全程中景，十秒真人实景。";
        let before = TaskListSnapshot::Read(Some(TaskEntry {
            submit_id: "old-task".into(),
            failed: false,
            charged: true,
            prompt: "上一单的提示词".into(),
        }));
        let after = TaskListSnapshot::Read(Some(TaskEntry {
            submit_id: "other-node-task".into(),
            failed: false,
            charged: true,
            prompt: "另一个节点的完全不同的提示词内容，用于验证不会被误认领成我们这一单。".into(),
        }));

        assert_eq!(
            diff_task_snapshots(&before, &after, prompt),
            ServerTaskProbe::Unknown
        );
    }

    #[test]
    fn humanize_covers_credit_and_compliance_failures() {
        // 真实报文: 积分不足导致预扣失败。
        assert!(humanize_jimeng_failure(
            "gen_status=\"fail\", fail_reason=\"api error: ret=1006, message=CreditPreDeductNotEnough, logid=2026\""
        )
        .is_some_and(|hint| hint.contains("积分不足")));
        assert!(humanize_jimeng_failure("api error: AigcComplianceConfirmationRequired")
            .is_some_and(|hint| hint.contains("合规确认")));
    }

    #[test]
    fn compliance_blocker_is_detected_case_insensitively() {
        assert!(is_compliance_blocker(
            "api error: ret=4010, message=AigcComplianceConfirmationRequired"
        ));
        assert!(is_compliance_blocker("aigccomplianceconfirmationrequired"));
        // 别的失败不能被当成「必须去网页确认」, 否则提示会误导。
        assert!(!is_compliance_blocker("context deadline exceeded"));
        assert!(!is_compliance_blocker("CreditPreDeductNotEnough"));
    }

    #[test]
    fn prompt_is_read_from_submit_arguments() {
        let arguments = vec![
            "multimodal2video".to_string(),
            "--prompt=一段测试用的提示词".to_string(),
            "--duration=5".to_string(),
        ];
        assert_eq!(prompt_from_arguments(&arguments), "一段测试用的提示词");
        assert_eq!(prompt_from_arguments(&["text2image".to_string()]), "");
    }

    #[test]
    fn log_hint_points_to_cli_log_directory() {
        // 官方排障指引要求让用户能对照 CLI 自己的日志, 所以失败信息里必须带出该目录。
        let hint = cli_log_hint();
        assert!(hint.contains(".dreamina_cli"), "实际: {hint}");
        assert!(hint.contains("logs"), "实际: {hint}");
    }

    #[test]
    fn condenses_upload_temp_path() {
        // 真实报文里路径是 JSON 转义过的: 文件名后面紧跟着 `\"`, 那个反斜杠不是路径分隔符。
        let reason = r#"fail_reason="upload resource \"C:\\Users\\A\\AppData\\Local\\Temp\\lentalk-jimeng-cli-6ce\\image-1.png\": upload image""#;

        let condensed = condense_upload_paths(reason);

        assert!(condensed.contains("参考图 image-1.png"));
        assert!(!condensed.contains("lentalk-jimeng-cli-"));
        assert!(!condensed.contains("AppData"));
        // 未转义(路径直接写在引号里)的写法同样要折叠对。
        assert_eq!(
            condense_upload_paths(
                r#"upload resource "C:\Users\A\Temp\lentalk-jimeng-cli-9\image-3.png": upload image"#
            ),
            r#"upload resource "参考图 image-3.png": upload image"#
        );
    }

    #[test]
    fn humanize_covers_upload_and_login_failures() {
        assert!(humanize_jimeng_failure("ApplyImageUpload: do request: context deadline exceeded")
            .is_some_and(|hint| hint.contains("参考图上传")));
        assert!(humanize_jimeng_failure("status_code=401, unauthorized, not login")
            .is_some_and(|hint| hint.contains("重新登录")));
        // 已知的参数校验错误不该套上「网络有问题」的说明。
        assert!(humanize_jimeng_failure("image_resource_id_list length is 10, should be <= 9").is_none());
        assert!(!is_transient_submit_failure("image_resource_id_list length is 10, should be <= 9"));
    }

    #[test]
    fn humanize_explains_dns_failure_without_blaming_the_proxy() {
        // 真实报文(2026-09-23 18:13, 上传分片阶段 DNS 查不到主机)。
        let reason = "upload resource \"参考图 image-1.png\": upload image: upload phase, no file upload";
        assert!(is_presubmit_failure(reason));
        assert!(
            humanize_jimeng_failure("dial tcp: lookup tos-d-lq.bytedancevod.com: no such host")
                .is_some_and(|hint| hint.contains("域名解析失败"))
        );
        // 那条曾经写错方向的建议(「把代理切到全局 / TUN 模式」)不该再出现在说明里;
        // 上传阶段失败要明确告诉用户「不产生费用、可以直接重试」。
        let upload_hint =
            humanize_jimeng_failure("apply phase, ApplyImageUpload failed").expect("上传类失败应有人话说明");
        assert!(!upload_hint.contains("TUN"), "实际: {upload_hint}");
        assert!(upload_hint.contains("参考图上传"));
        assert!(upload_hint.contains("不会产生任何费用"));
    }

    /// 用户实报(2026-10-14, app 1.2.29): 4K 图片生成在**查询结果**这一步被一次网络抖动
    /// 直接终止 —— 任务已经扣过费, 结果却没能取回来。
    const REPORTED_POLL_TIMEOUT: &str = r#"即梦 CLI 命令执行失败: do request: Post "https://jimeng.jianying.com/mweb/v1/get_history_by_ids?agent_detect=human&aid=513695&cli_version=673dd28-dirty&from=dreamina_cli": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"#;

    #[test]
    fn retries_transient_poll_failures_until_the_budget_runs_out() {
        assert!(should_retry_poll_failure(REPORTED_POLL_TIMEOUT, 0));
        assert!(should_retry_poll_failure(
            REPORTED_POLL_TIMEOUT,
            JIMENG_POLL_MAX_CONSECUTIVE_FAILURES - 1
        ));
        // 连续失败到上限就放弃, 不能无限等下去。
        assert!(!should_retry_poll_failure(
            REPORTED_POLL_TIMEOUT,
            JIMENG_POLL_MAX_CONSECUTIVE_FAILURES
        ));
        // 非网络类失败(登录失效 / 参数错)重试没有意义。
        assert!(!should_retry_poll_failure("status_code=401, unauthorized, not login", 0));
        assert!(!should_retry_poll_failure(
            "image_resource_id_list length is 10, should be <= 9",
            0
        ));
    }

    #[test]
    fn poll_failure_keeps_submit_id_so_the_result_can_be_recovered() {
        let message = describe_poll_failure("submit-abc-123", REPORTED_POLL_TIMEOUT);
        // 必须说清「这不是生成失败」, 否则用户会以为积分白花而重新生成(那才是重复扣费)。
        assert!(message.contains("不等于生成失败"), "实际: {message}");
        assert!(message.contains("submit-abc-123"));
        assert!(message.contains("dreamina query_result --submit_id=submit-abc-123"));
        // 原始报文里的临时目录 / 长 URL 不该原样糊在用户面前。
        assert!(message.contains("超时") || message.contains("网络"));
    }

    #[test]
    fn humanize_covers_poll_timeout_without_shadowing_upload_hint() {
        let hint = humanize_jimeng_failure(REPORTED_POLL_TIMEOUT).expect("轮询超时应有人话说明");
        assert!(hint.contains("网络超时"), "实际: {hint}");
        // 上传阶段的超时仍要命中更具体的上传分支(它带「不产生费用、可直接重试」的说明)。
        let upload =
            humanize_jimeng_failure("ApplyImageUpload: do request: context deadline exceeded").expect("上传超时");
        assert!(upload.contains("参考图上传"), "实际: {upload}");
        // 明确的参数错误不该被套上网络说明。
        assert!(humanize_jimeng_failure("unknown flag: --foo").is_none());
    }

    #[test]
    fn proxy_state_diagnostic_never_panics_and_reads_real_env() {
        let line = describe_cli_proxy_state();
        assert!(line.starts_with("诊断:"), "实际: {line}");
        assert!(
            line.contains("未检测到代理环境变量") || line.contains("检测到代理环境变量"),
            "实际: {line}"
        );
    }

    #[test]
    fn extracts_upload_failure_from_real_cli_log() {
        // 真实 `dreamina.log` 片段(2026-09-23 18:13): 失败域名只在这里出现 ——
        //   第 2 张图成功走 tos-d-lf, 第 1 张图挂在 tos-d-lq 的 DNS 上。
        let tail: Vec<String> = [
            "Info 2026-09-23 18:12:57 upload completed resource_type=image path=...image-2.png uri=tos-cn-i-tb4s082cfz/9b6aea47",
            "Error 2026-09-23 18:13:15 Fail to upload image, file_0 upload by HOST, isDirectUpload:false, err:doamin tos-d-lq.bytedancevod.com, contentType , All attempts fail:",
            "#1: http do, Post \"https://tos-d-lq.bytedancevod.com/upload/v1/tos-cn-i-tb4s082cfz/3046a174\": dial tcp: lookup tos-d-lq.bytedancevod.com: no such host",
            "#2: http do, Post \"https://tos-d-lq.bytedancevod.com/upload/v1/...\": dial tcp: lookup tos-d-lq.bytedancevod.com: no such host",
        ]
        .iter()
        .map(|line| (*line).to_string())
        .collect();

        let failure = extract_cli_log_failure(&tail).expect("应能从日志里读出失败主机");
        assert_eq!(failure.host, "tos-d-lq.bytedancevod.com");
        assert_eq!(failure.kind, CliLogFailureKind::Dns);
    }

    #[test]
    fn log_forensics_falls_back_to_bare_host_and_stays_silent_on_clean_logs() {
        // 只有 `err:doamin <host>` 时也要能拿到域名(类型未知)。
        let tail: Vec<String> = vec![
            "Error 2026-09-23 18:13:15 Fail to upload image ... err:doamin tos-d-lq.bytedancevod.com, contentType".to_string(),
        ];
        let failure = extract_cli_log_failure(&tail).expect("应能读出域名");
        assert_eq!(failure.host, "tos-d-lq.bytedancevod.com");
        assert_eq!(failure.kind, CliLogFailureKind::Other);

        // 日志干净(没有失败记录)时不该硬编一个域名出来。
        let clean: Vec<String> = vec![
            "Info 2026-09-23 18:12:57 Direct Upload success, domain tos-d-lf.bytedancevod.com".to_string(),
        ];
        assert_eq!(extract_cli_log_failure(&clean), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_system_proxy_server_formats() {
        assert_eq!(
            parse_system_proxy_server("127.0.0.1:7890"),
            Some(("127.0.0.1:7890".to_string(), "127.0.0.1:7890".to_string()))
        );
        assert_eq!(
            parse_system_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891"),
            Some(("127.0.0.1:7890".to_string(), "127.0.0.1:7891".to_string()))
        );
        assert_eq!(parse_system_proxy_server(""), None);
        assert_eq!(proxy_url("127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(proxy_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
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

// ==================== 即梦画布 CLI（dreamina-canvas） ====================
//
// 和 `dreamina` 是两个独立工具: 可执行名 `dreamina-canvas`, 输出是规整 JSON
// (`{"schemaVersion":"1","ok":true,"data":{…}}`), 登录同样是 OAuth Device Flow。
// 使用文档: https://bytedance.larkoffice.com/wiki/QO66wGahSiakEHkJbxIcNBtDnAc

fn canvas_cli_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|value| (*value).to_string()).collect()
}

/// 解析 `dreamina-canvas` 的统一 JSON 信封, 返回 `data` 段。
fn parse_canvas_payload(output: &str) -> Result<serde_json::Value, String> {
    let raw = extract_json_object(output).ok_or_else(|| {
        let preview: String = output.trim().chars().take(300).collect();
        format!("即梦画布 CLI 未返回 JSON: {preview}")
    })?;
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "即梦画布 CLI 返回的 JSON 无法解析".to_string())?;
    // 失败时 `ok=false`：正文在 error.message，但**真正能救人的信息在 error.reason /
    // validation.detail** 里（例如 `oauth_scope_insufficient` 会告诉我们「重新登录」）。
    // 只带 message 的话用户看到的永远是 "Access was denied"，完全不知道下一步做什么。
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err(describe_canvas_failure(&value));
    }
    Ok(value
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// 把画布 CLI 的失败信封翻成一句**能照着做**的中文。
///
/// CLI 的错误结构比 `message` 丰富得多：
/// ```json
/// {"error":{"code":"service.10000","message":"Access was denied for this operation.",
///           "reason":"oauth_scope_insufficient","requiredAction":"login",
///           "validation":{"detail":"... Run auth login --force ..."}}}
/// ```
/// `service.10000` + `Access was denied` 本身没有信息量 —— 真正的原因是
/// **本地登录凭证的授权范围不够**（CLI 升级后要求的 scope 变多了，旧 token 没到期但不含新权限）。
/// 这种情况光看报错会以为是模型/参数/配额问题，实测排查花了很久，所以在这里直接给出解法。
fn describe_canvas_failure(value: &serde_json::Value) -> String {
    let message = value
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("即梦画布 CLI 返回失败");
    let code = value
        .pointer("/error/code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let reason = value
        .pointer("/error/reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let base = if code.is_empty() {
        message.to_string()
    } else {
        format!("{message}（{code}）")
    };
    match reason {
        "oauth_scope_insufficient" => format!(
            "{base}：即梦画布 CLI 的登录凭证权限不足（不是模型、参数或积分问题）。请到「设置 → 即梦画布 CLI」点【切换账号】重新授权；或在终端执行 `dreamina-canvas auth login --force`。若重新授权后仍报同一错误，说明 CLI 版本太旧，用官方脚本更新后再授权"
        ),
        // 其它已知原因点名，避免它们也被埋在 "Access was denied" 后面。
        "credit_insufficient" => format!("{base}：即梦积分不足"),
        "" => base,
        other => format!("{base}（reason: {other}）"),
    }
}

/// 从素材内容派生**确定性**的 `--resource-id` 幂等键。
///
/// CLI 的契约(`dreamina-canvas resource upload --help`)写得很清楚:
/// 「--resource-id 资源 UUID 幂等键; 省略时自动生成, **跨进程重试须复用同一值**」。
/// 省略它的后果正是用户实报的那个报错: 上传阶段一旦「请求已发出但没拿到确认」, CLI
/// 既无法证明远端有没有建对象, 也没法安全重传, 只能抛 `cli.upload_state_unknown` +
/// `retryable:false`, 要求人工介入 —— 而调用方手里连那个自动生成的键都没有, 除了全量
/// 重传别无选择。
///
/// 这里改用内容哈希派生: 同一份素材(同项目 / 同类型 / 同字节)在任何一次重试、乃至另一个
/// 节点上都会落到同一个资源, 所以「重试」天然幂等, 也不需要把键持久化到前端。
fn canvas_resource_key(project_id: &str, media_type: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    // 加一个域前缀, 避免和别处的 sha256 用途撞车。
    hasher.update(b"lentalk-canvas-resource-v1\0");
    hasher.update(project_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(media_type.as_bytes());
    hasher.update(b"\0");
    hasher.update(bytes);
    let digest = hasher.finalize();

    let mut raw = [0u8; 16];
    raw.copy_from_slice(&digest[..16]);
    // 折成 RFC 4122 v4 形状(version=4, variant=10xx): CLI 只要求它是个 UUID。
    raw[6] = (raw[6] & 0x0f) | 0x40;
    raw[8] = (raw[8] & 0x3f) | 0x80;
    Uuid::from_bytes(raw).to_string()
}

/// 画布 CLI 调用。与 `run_cli` 的唯一区别在**失败怎么表达**。
///
/// 画布 CLI 的失败体是 `{"ok":false,"error":{"class":..,"code":..,"message":..}}`,
/// `run_cli` 会把它压成 `error={...}` 一大坨 JSON 直接糊到用户脸上(用户实报的报错正是如此)。
/// 这里改走 `parse_canvas_payload`, 只保留 `message（code）`。
fn run_canvas_cli(executable: &str, arguments: &[String]) -> Result<String, String> {
    run_canvas_cli_with_timeout(executable, arguments, CLI_COMMAND_TIMEOUT)
}

fn run_canvas_cli_with_timeout(
    executable: &str,
    arguments: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let (success, output) = spawn_cli_capture(executable, arguments, timeout, &[])?;
    if success {
        Ok(output)
    } else {
        Err(canvas_cli_failure_reason(&output))
    }
}

/// 从失败输出里取最有用的一句话: 优先 `error.message（error.code）`, 没有信封时才退回原始摘要。
fn canvas_cli_failure_reason(output: &str) -> String {
    match parse_canvas_payload(output) {
        Err(message) => message,
        // 退出码非 0 但信封是 ok=true —— 结构和判定不一致, 这时原始摘要信息更多。
        Ok(_) => output_summary(output),
    }
}

/// 产物下载的重试策略。
///
/// 为什么必须重试: 走到这一步**积分已经扣了、视频已经在服务端生成好了**, 下载只是一次
/// 普通的 HTTP 传输。CDN 偶发不可达(用户实际遇到过 `cli.download_transport_failed`)
/// 就把整次生成判为失败、还要用户手打命令取回 —— 代价完全不对等。
/// CLI 自身没有重试开关(`resource download --help` 只有 `-o` / `--project-id`), 只能在这里补。
///
/// 单次上限 10 分钟、三次合计 30 分钟: **总量与原来一次 30 分钟相同**, 但瞬时错误(连接被拒、
/// DNS 抖动、代理掉线)会立刻重试而不是直接判死。
const CLI_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CLI_DOWNLOAD_ATTEMPTS: usize = 3;
/// 第 1、2 次失败后的等待秒数(长度 = ATTEMPTS - 1)。
const CLI_DOWNLOAD_RETRY_DELAYS: [u64; CLI_DOWNLOAD_ATTEMPTS - 1] = [2, 6];

/// 下载产物资源到本地, 失败自动重试。
fn download_canvas_resource(
    executable: &str,
    project_id: &str,
    resource_id: &str,
    target: &Path,
) -> Result<(), String> {
    let arguments = [
        "resource".to_string(),
        "download".to_string(),
        resource_id.to_string(),
        format!("--project-id={project_id}"),
        "-o".to_string(),
        target.to_string_lossy().to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];

    let mut last_error = String::new();
    // 首次尝试前也清一次: 目标路径若残留同名文件(上次运行留下的), 会让「退出码 0 + 文件存在」
    // 的判定把一个旧文件当成这次刚下载成功的产物。
    let _ = fs::remove_file(target);
    for attempt in 0..CLI_DOWNLOAD_ATTEMPTS {
        if attempt > 0 {
            // 半截文件留着会让下一次写入进入未知状态, 先删干净。
            let _ = fs::remove_file(target);
            std::thread::sleep(Duration::from_secs(CLI_DOWNLOAD_RETRY_DELAYS[attempt - 1]));
        }
        match run_canvas_cli_with_timeout(executable, &arguments, CLI_DOWNLOAD_TIMEOUT) {
            // CLI 说成功还要确认真的落盘了 —— 退出码 0 但文件不存在这种情况必须当失败处理,
            // 否则调用方拿到一个指向空文件的路径。
            Ok(_) if target.is_file() => {
                if attempt > 0 {
                    eprintln!("即梦产物下载第 {} 次尝试成功（{resource_id}）", attempt + 1);
                }
                return Ok(());
            }
            Ok(_) => {
                last_error = format!("CLI 报告成功但本地没有落盘文件（期望 {}）", target.display())
            }
            Err(error) => last_error = error,
        }
        eprintln!(
            "即梦产物下载第 {}/{} 次失败（{resource_id}）: {last_error}",
            attempt + 1,
            CLI_DOWNLOAD_ATTEMPTS
        );
    }
    Err(format!("重试 {CLI_DOWNLOAD_ATTEMPTS} 次仍失败: {last_error}"))
}

/// 查一个素材在服务端的稳定状态(`resource get`), 并把 `running` 等到落定。
///
/// 查不到(资源不存在 / 接口本身拒绝)返回 `None` —— 调用方据此判断「远端确实没建成」,
/// 可以放心用同一个幂等键重传。
fn canvas_resource_status(
    executable: &str,
    project_id: &str,
    resource_id: &str,
    waits: u32,
) -> Option<String> {
    let arguments = [
        "resource".to_string(),
        "get".to_string(),
        resource_id.to_string(),
        format!("--project-id={project_id}"),
        "--format".to_string(),
        "json".to_string(),
    ];

    let mut state = None;
    for round in 0..=waits {
        let (success, output) =
            spawn_cli_capture(executable, &arguments, CLI_COMMAND_TIMEOUT, &[]).ok()?;
        if !success {
            return None;
        }
        let data = parse_canvas_payload(&output).ok()?;
        state = find_json_string_field(&data, "status").map(|value| value.to_lowercase());
        if state.as_deref() != Some("running") || round == waits {
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }
    state
}

/// 这个失败是不是「远端可能已经有对象了」。命中时值得先查状态再决定, 而不是直接当失败。
fn canvas_failure_means_resource_exists(reason: &str) -> bool {
    let lowered = reason.to_ascii_lowercase();
    lowered.contains("upload_state_unknown")
        || lowered.contains("already submitted")
        || lowered.contains("service.5")
}

/// 把一份本地素材登记成项目资源, 返回可直接塞进 `--ref` 的 `res:<id>`。
///
/// 🔴 幂等键由 `canvas_resource_key` 生成并**贯穿所有重试**, 这是把
/// `cli.upload_state_unknown`(要求人工介入)变成自动恢复的关键: 失败后先 `resource get`
/// 问一句远端建成了没有 —— 建好了就直接复用, 没建好就用同一个键重传。
fn upload_canvas_resource(
    executable: &str,
    project_id: &str,
    path: &Path,
    media_type: &str,
    label: &str,
) -> Result<String, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("读取{label}失败({}): {error}", path.display()))?;
    let resource_id = canvas_resource_key(project_id, media_type, &bytes);
    let arguments = [
        "resource".to_string(),
        "upload".to_string(),
        format!("--file={}", path.display()),
        format!("--type={media_type}"),
        format!("--project-id={project_id}"),
        format!("--resource-id={resource_id}"),
        "--format".to_string(),
        "json".to_string(),
    ];

    let mut last_reason = String::new();
    for attempt in 0..CANVAS_UPLOAD_MAX_ATTEMPTS {
        if attempt > 0 {
            // 上一轮已经把请求发出去了。先问服务端「这个键到底建成了没有」——
            // 这正是 CLI 甩给我们 human_intervention 的那一步, 而幂等键在我们手里, 我们能自己回答。
            if canvas_resource_status(executable, project_id, &resource_id, 3).as_deref()
                == Some("success")
            {
                return Ok(format!("res:{resource_id}"));
            }
        }

        let (success, output) =
            spawn_cli_capture(executable, &arguments, CANVAS_UPLOAD_TIMEOUT, &[])?;
        let parsed = parse_canvas_payload(&output);
        if success {
            if let Ok(data) = &parsed {
                if let Some(id) = find_json_string_field(data, "resourceId") {
                    return Ok(format!("res:{id}"));
                }
            }
        }
        last_reason = match &parsed {
            Err(message) => message.clone(),
            Ok(_) => output_summary(&output),
        };

        // `service.5 already submitted` = 同一个幂等键提交过了, 对象就在服务端。
        // 再查一次就能确认, 不该把它当失败。
        if canvas_failure_means_resource_exists(&last_reason)
            && canvas_resource_status(executable, project_id, &resource_id, 3).as_deref()
                == Some("success")
        {
            return Ok(format!("res:{resource_id}"));
        }

        if attempt + 1 < CANVAS_UPLOAD_MAX_ATTEMPTS {
            let backoff = CANVAS_UPLOAD_RETRY_BACKOFF_MS
                [(attempt as usize).min(CANVAS_UPLOAD_RETRY_BACKOFF_MS.len() - 1)];
            thread::sleep(Duration::from_millis(backoff));
        }
    }

    Err(describe_canvas_upload_failure(
        label,
        &resource_id,
        project_id,
        &last_reason,
    ))
}

/// 上传最终失败时的用户可读说明。
///
/// `cli.upload_state_unknown` 的原始文案是给机器和工程师看的(「Do not automatically retry;
/// inspect the operation or contact support」), 直接抛给用户只会让人以为素材或账号坏了。
fn describe_canvas_upload_failure(
    label: &str,
    resource_id: &str,
    project_id: &str,
    reason: &str,
) -> String {
    let lowered = reason.to_ascii_lowercase();
    let mut text = format!("上传{label}到即梦画布失败（幂等键 {resource_id}）: {reason}");

    if canvas_failure_means_resource_exists(reason) {
        text.push_str(&format!(
            "\n说明: 上传请求已经发出, 但没拿到服务端的确认, 所以 CLI 判断不了远端到底建没建成 —— \
             它要求人工介入, **不代表参考素材或提示词有问题**, 上传阶段也不消耗积分。\
             本次已用同一个幂等键自动核对并重传 {} 次, 仍未确认成功。\
             \n建议: ① 直接再点一次生成: 同一个素材会复用同一个幂等键, 不会重复上传; \
             ② 换个网络(如手机热点)做对照; \
             ③ 想手动确认远端有没有: dreamina-canvas resource get {resource_id} --project-id={project_id}",
            CANVAS_UPLOAD_MAX_ATTEMPTS
        ));
    } else if lowered.contains("not login")
        || lowered.contains("unauthorized")
        || lowered.contains("credential")
        || reason.contains("未登录")
    {
        text.push_str(
            "\n说明: 即梦画布 CLI 的登录态已失效或凭据读取失败。\
             \n建议: 到「设置 - 密钥 - 即梦画布 CLI」重新登录后再试。",
        );
    } else if lowered.contains("deadline exceeded")
        || lowered.contains("timeout")
        || lowered.contains("i/o timeout")
        || reason.contains("超时")
    {
        text.push_str(
            "\n说明: 上传时网络超时, 与素材内容无关; 即梦是国内服务, 走代理反而容易超时。\
             \n建议: ① 先直接重试; ② 关掉系统代理 / VPN 再试一次做对照; ③ 换个网络(如手机热点)做对照。",
        );
    }

    text
}

/// 从 `auth account` 的返回里挑一个能展示的账号名。
/// 字段名在不同版本里可能不一样, 按常见顺序试, 再尝试剥一层嵌套对象。
fn canvas_account_label(data: &serde_json::Value) -> Option<String> {
    const KEYS: [&str; 6] = ["name", "nickname", "userName", "displayName", "email", "uid"];
    for key in KEYS {
        if let Some(text) = data.get(key).and_then(serde_json::Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    for wrapper in ["account", "user", "profile"] {
        if let Some(inner) = data.get(wrapper) {
            if inner.is_object() {
                if let Some(label) = canvas_account_label(inner) {
                    return Some(label);
                }
            }
        }
    }
    None
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCanvasCliStatus {
    /// 可执行文件能否跑起来(`dreamina-canvas version` 成功)。
    pub found: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    /// 当前登录账号(`auth account`); 未登录或取不到时为 None。
    pub account: Option<String>,
    pub message: String,
}

/// 检测即梦画布 CLI: 版本 + 登录态 + 当前账号。
#[tauri::command]
pub async fn jimeng_canvas_cli_status(executable: String) -> Result<JimengCanvasCliStatus, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦画布 CLI 的可执行命令".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<JimengCanvasCliStatus, String> {
        let version_output =
            match run_cli(&executable, &canvas_cli_args(&["version", "--format", "json"])) {
                Ok(output) => output,
                // 跑不起来 = 没装 / 路径不对。这不是异常, 是要展示给用户的状态。
                Err(error) => {
                    return Ok(JimengCanvasCliStatus {
                        found: false,
                        version: None,
                        logged_in: false,
                        account: None,
                        message: error,
                    })
                }
            };
        let version = parse_canvas_payload(&version_output)
            .ok()
            .and_then(|data| {
                data.get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            });

        let logged_in = run_cli(
            &executable,
            &canvas_cli_args(&["auth", "status", "--format", "json"]),
        )
        .ok()
        .and_then(|output| parse_canvas_payload(&output).ok())
        .and_then(|data| data.get("loggedIn").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);

        let account = if logged_in {
            run_cli(
                &executable,
                &canvas_cli_args(&["auth", "account", "--format", "json"]),
            )
            .ok()
            .and_then(|output| parse_canvas_payload(&output).ok())
            .and_then(|data| canvas_account_label(&data))
        } else {
            None
        };

        Ok(JimengCanvasCliStatus {
            found: true,
            version,
            logged_in,
            account,
            message: if logged_in {
                "已登录".to_string()
            } else {
                "未登录".to_string()
            },
        })
    })
    .await
    .map_err(|error| format!("即梦画布 CLI 检测中断: {error}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCanvasCliLoginStart {
    pub need_auth: bool,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub device_code: Option<String>,
    pub expires_at: Option<String>,
    pub message: String,
}

/// 申请即梦画布 CLI 的授权材料(OAuth Device Flow)。
/// `force=true` 会带 `--force`: 清掉当前 profile 的登录态再重新授权(切换账号)。
#[tauri::command]
pub async fn jimeng_canvas_cli_login_start(
    executable: String,
    force: Option<bool>,
) -> Result<JimengCanvasCliLoginStart, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦画布 CLI 的可执行命令".to_string());
    }
    let force = force.unwrap_or(false);
    let output = tokio::task::spawn_blocking(move || {
        let mut args = canvas_cli_args(&["auth", "login", "--non-interactive", "--format", "json"]);
        if force {
            args.push("--force".to_string());
        }
        run_canvas_cli(&executable, &args)
    })
    .await
    .map_err(|error| format!("即梦画布 CLI 登录任务中断: {error}"))??;

    let data = parse_canvas_payload(&output)?;
    // 已经登录时不会返回 challenge —— 说明这次点的是「登录」而不是「切换账号」。
    let Some(challenge) = data.get("challenge") else {
        return Ok(JimengCanvasCliLoginStart {
            need_auth: false,
            verification_uri: None,
            user_code: None,
            device_code: None,
            expires_at: None,
            message: "当前已登录即梦画布账号".to_string(),
        });
    };
    let field = |key: &str| {
        challenge
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    Ok(JimengCanvasCliLoginStart {
        need_auth: true,
        // 优先用 Complete 版: 授权码已拼进链接, 少一步手输。
        verification_uri: field("verificationUriComplete").or_else(|| field("verificationUri")),
        user_code: field("userCode"),
        device_code: field("deviceCode"),
        expires_at: field("expiresAt"),
        message: "请在内置窗口中完成授权".to_string(),
    })
}

/// 等待并完成即梦画布 CLI 的登录(`auth wait --device-code`)。
///
/// 🔴 必须用 `auth wait` 而不是 `auth status`: status 只读本地登录态, **不会拿 device code
/// 去后端换 token** —— 只用 status 轮询会一直 loggedIn=false, 直到授权码过期(表现为「等待授权超时」)。
/// `wait` 是阻塞的, 这里给一个短超时(4s); 未完成时 CLI 回
/// `error.code = cli.login_wait_timeout` + `retryable: true`, 前端据此继续下一轮。
#[tauri::command]
pub async fn jimeng_canvas_cli_login_check(
    executable: String,
    device_code: String,
) -> Result<JimengCliLoginCheckResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦画布 CLI 的可执行命令".to_string());
    }
    let device_code = device_code.trim().to_string();
    if device_code.is_empty() {
        return Err("缺少设备授权码，请重新发起登录".to_string());
    }
    let (_exit_ok, output) = tokio::task::spawn_blocking(move || {
        spawn_cli_capture(
            &executable,
            &[
                "auth".to_string(),
                "wait".to_string(),
                format!("--device-code={device_code}"),
                "--timeout=4s".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ],
            CLI_COMMAND_TIMEOUT,
            &[],
        )
    })
    .await
    .map_err(|error| format!("即梦画布 CLI 登录检查中断: {error}"))??;

    let raw = extract_json_object(&output).ok_or_else(|| {
        let preview: String = output.trim().chars().take(200).collect();
        format!("即梦画布 CLI 未返回 JSON: {preview}")
    })?;
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "即梦画布 CLI 返回的 JSON 无法解析".to_string())?;

    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(JimengCliLoginCheckResult {
            success: true,
            message: "登录成功".to_string(),
        });
    }
    let code = value
        .pointer("/error/code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    // 本轮没等到授权: 这是预期分支(CLI 以非零退出码表达), 不是失败。
    if code == "cli.login_wait_timeout" {
        return Ok(JimengCliLoginCheckResult {
            success: false,
            message: "等待授权完成…".to_string(),
        });
    }
    let message = value
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("即梦画布授权失败");
    Err(if code.is_empty() {
        message.to_string()
    } else {
        format!("{message}（{code}）")
    })
}

/// 退出即梦画布 CLI 的登录态(`auth logout`)。
#[tauri::command]
pub async fn jimeng_canvas_cli_logout(
    executable: String,
) -> Result<JimengCliLoginCheckResult, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦画布 CLI 的可执行命令".to_string());
    }
    let output =
        tokio::task::spawn_blocking(move || run_canvas_cli(&executable, &canvas_cli_args(&["auth", "logout"])))
            .await
            .map_err(|error| format!("即梦画布 CLI 退出登录中断: {error}"))??;
    Ok(JimengCliLoginCheckResult {
        success: true,
        message: output.trim().to_string(),
    })
}

/// 在 JSON 里递归找第一个指定键的字符串值。
///
/// 即梦画布 CLI 的返回把 nodeId / resourceId 埋在 `data.node.nodeId`、
/// `data.nodes[0].node.resources[0].resourceId` 这类深浅不一的位置, 而且不同小版本还会挪。
/// 与其挨个写路径(错一个就白等一次生成), 不如按字段名找。
/// 把即梦画布节点的数字错误码翻译成人能读的一句话。
///
/// ⚠️ 即梦**没有公开的错误码表**，下面的对照只来自实测定点，别当成全量字典：
///   - `20110` —— 2026-10-28 一次 4 张参考图（其中两张是真人肖像）的视频生成失败，
///     同一节点在平台网页端显示「审核失败，参考图使用了公众人物形象」，`node show`
///     只返回 `{status:"failed", errorCode:20110}`。据此推断为**内容审核未通过**。
///
/// 未知码原样输出：编一个假原因比不给解释更糟。
fn describe_canvas_error_code(code: i64) -> String {
    match code {
        20110 => "错误码 20110：内容审核未通过。参考图含真人肖像 / 公众人物 / 品牌标识时最常见 —— 换成非写实素材（手绘、素描）或去掉清晰人脸后再试".to_string(),
        _ => format!("错误码 {code}（CLI 未提供文字原因，可在即梦画布网页端查看该节点详情）"),
    }
}

fn find_json_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(found) = map.get(key).and_then(serde_json::Value::as_str) {
                if !found.trim().is_empty() {
                    return Some(found.trim().to_string());
                }
            }
            map.values()
                .find_map(|child| find_json_string_field(child, key))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|child| find_json_string_field(child, key)),
        _ => None,
    }
}

/// 保证有一个可用的画布项目: 只复用**名为 LenTalk 的专用画布**, 没有就新建。
///
/// 刻意不「取最近更新的一个」—— 用户自己的画布里全是他的作品节点, 往里塞自动生成的节点
/// 会把他的画布搞乱。宁可新建一张专供 LenTalk 用的。
fn ensure_canvas_project(executable: &str) -> Result<String, String> {
    if let Ok(output) = run_cli(
        executable,
        &canvas_cli_args(&["canvas", "ls", "--format", "json"]),
    ) {
        if let Ok(data) = parse_canvas_payload(&output) {
            if let Some(items) = data.get("items").and_then(|value| value.as_array()) {
                for item in items {
                    let named = item
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(|name| name.trim() == "LenTalk")
                        .unwrap_or(false);
                    if !named {
                        continue;
                    }
                    if let Some(project_id) = item
                        .get("projectId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return Ok(project_id.to_string());
                    }
                }
            }
        }
    }
    let output = run_canvas_cli(
        executable,
        &canvas_cli_args(&["canvas", "create", "LenTalk", "--format", "json"]),
    )?;
    let data = parse_canvas_payload(&output)?;
    find_json_string_field(&data, "projectId")
        .ok_or_else(|| "即梦画布 CLI 新建画布后未返回 projectId".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateJimengCanvasVideoRequest {
    pub executable: String,
    pub prompt: String,
    /// 服务端模型标识, 如 `seedance_2.5`、`seedance_2.0_vip`
    pub model: String,
    /// `t2v` / `first_last_frame` / `m2v`
    pub mode: String,
    pub duration: u32,
    pub aspect_ratio: String,
    /// `480p` / `720P` / `1080P` / `4K`(大小写按 model list 原样)
    pub resolution: String,
    pub reference_images: Option<Vec<String>>,
    /// 参考音频(`m2v` 模式支持, 最多 10 个)。漏传会表现为「音频素材没进生成」。
    pub reference_audio: Option<Vec<String>>,
    pub project_id: Option<String>,
}

/// 即梦画布 CLI 生成视频: 上传参考素材 → 建节点并运行 → 等终态 → 下载到本地。
#[tauri::command]
pub async fn generate_jimeng_canvas_video(
    app: AppHandle,
    request: GenerateJimengCanvasVideoRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate_canvas_video_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦画布 CLI 任务执行中断: {error}"))?
}

fn generate_canvas_video_blocking(
    app: &AppHandle,
    request: GenerateJimengCanvasVideoRequest,
) -> Result<String, String> {
    let executable = request.executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦画布 CLI」中填写可执行命令".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("即梦画布 CLI 视频生成需要提示词".to_string());
    }
    let project_id = match request
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => ensure_canvas_project(&executable)?,
    };

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-canvas-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦画布 CLI 临时目录: {error}"))?;

    let result = (|| {
        let images = materialize_data_urls(
            request.reference_images.as_deref().unwrap_or_default(),
            &input_dir,
            "image",
        )?;

        // 参考图必须先登记成项目资源, `--ref` 才能用 `res:<id>` 引用。
        let mut references: Vec<String> = Vec::new();
        for path in &images {
            references.push(upload_canvas_resource(
                &executable,
                &project_id,
                path,
                "image",
                "参考图",
            )?);
        }

        // 参考音频也要登记成项目资源, `--ref` 只认 `res:<id>`;
        // 不登记就等于音频没传进去(模型只看到图片)。
        let audio_files =
            materialize_audio_files(request.reference_audio.as_deref().unwrap_or_default())?;
        for path in &audio_files {
            references.push(upload_canvas_resource(
                &executable,
                &project_id,
                path,
                "audio",
                "参考音频",
            )?);
        }

        // 走「建节点 → 报价 → 按报价批准 → 运行 → 等终态」,
        // 而不是 `--run`: 只有这样才拿得到服务端报的真实积分, ceiling 也不用猜。
        let mut content_args = vec![
            format!("--model={}", request.model),
            format!("--mode={}", request.mode),
            format!("--prompt={}", request.prompt),
            format!("--ratio={}", request.aspect_ratio),
            format!("--resolution={}", request.resolution),
            format!("--duration={}", request.duration),
        ];
        for reference in &references {
            content_args.push(format!("--ref={reference}"));
        }
        let (node_id, quoted) =
            create_quote_confirm_run(&executable, &project_id, "video", &content_args)?;
        if let Some(credits) = quoted {
            eprintln!("即梦画布 CLI 报价: {credits} 积分");
        }

        // 产物在节点视图的 resources 里; node.run 的返回不一定带, 统一再读一次。
        let show_output = run_canvas_cli(
            &executable,
            &[
                "node".to_string(),
                "show".to_string(),
                format!("--project-id={project_id}"),
                format!("--node-id={node_id}"),
                "--format".to_string(),
                "json".to_string(),
            ],
        )?;
        let show_data = parse_canvas_payload(&show_output)?;
        let resource_id = find_json_string_field(&show_data, "resourceId").ok_or_else(|| {
            format!("即梦画布 CLI 节点 {node_id} 运行完成但没有产物资源, 请到即梦画布网页端确认")
        })?;

        let download_dir = resolve_download_dir(app, &run_id)?;
        let target = download_dir.join(format!("canvas-{run_id}.mp4"));
        download_canvas_resource(&executable, &project_id, &resource_id, &target).map_err(
            |error| {
                format!(
                    "视频已生成但下载失败（resourceId={resource_id}）: {error}。\
                     可手动取回: dreamina-canvas resource download {resource_id} --project-id={project_id} -o <路径>"
                )
            },
        )?;
        if !target.is_file() {
            return Err(format!(
                "视频已生成但本地没有落盘文件（resourceId={resource_id}, 期望 {})",
                target.display()
            ));
        }
        Ok(target.to_string_lossy().to_string())
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateJimengCanvasImageRequest {
    pub executable: String,
    pub prompt: String,
    pub model: String,
    /// `t2i`（无参考图）/ `i2i`（有参考图）
    pub mode: String,
    pub aspect_ratio: String,
    /// `1K` / `1.5K` / `2K` / `4K`（大小写按 model list 原样）
    pub resolution: String,
    pub reference_images: Option<Vec<String>>,
    pub project_id: Option<String>,
}

/// 即梦画布 CLI 生成图片。
#[tauri::command]
pub async fn generate_jimeng_canvas_image(
    app: AppHandle,
    request: GenerateJimengCanvasImageRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate_canvas_image_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦画布 CLI 任务执行中断: {error}"))?
}

fn generate_canvas_image_blocking(
    app: &AppHandle,
    request: GenerateJimengCanvasImageRequest,
) -> Result<String, String> {
    let executable = request.executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦画布 CLI」中填写可执行命令".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("即梦画布 CLI 图片生成需要提示词".to_string());
    }
    let project_id = match request
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => ensure_canvas_project(&executable)?,
    };

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-canvas-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦画布 CLI 临时目录: {error}"))?;

    let result = (|| {
        let images = materialize_data_urls(
            request.reference_images.as_deref().unwrap_or_default(),
            &input_dir,
            "image",
        )?;
        let mut references: Vec<String> = Vec::new();
        for path in &images {
            references.push(upload_canvas_resource(
                &executable,
                &project_id,
                path,
                "image",
                "参考图",
            )?);
        }

        let mut content_args = vec![
            format!("--model={}", request.model),
            format!("--mode={}", request.mode),
            format!("--prompt={}", request.prompt),
            format!("--ratio={}", request.aspect_ratio),
            format!("--resolution={}", request.resolution),
        ];
        for reference in &references {
            content_args.push(format!("--ref={reference}"));
        }
        let (node_id, _quoted) =
            create_quote_confirm_run(&executable, &project_id, "image", &content_args)?;

        let show_output = run_canvas_cli(
            &executable,
            &[
                "node".to_string(),
                "show".to_string(),
                format!("--project-id={project_id}"),
                format!("--node-id={node_id}"),
                "--format".to_string(),
                "json".to_string(),
            ],
        )?;
        let show_data = parse_canvas_payload(&show_output)?;
        let resource_id = find_json_string_field(&show_data, "resourceId").ok_or_else(|| {
            format!("即梦画布 CLI 节点 {node_id} 运行完成但没有产物资源, 请到即梦画布网页端确认")
        })?;

        let download_dir = resolve_download_dir(app, &run_id)?;
        let target = download_dir.join(format!("canvas-{run_id}.png"));
        download_canvas_resource(&executable, &project_id, &resource_id, &target).map_err(
            |error| {
                format!(
                    "图片已生成但下载失败（resourceId={resource_id}）: {error}。\
                     可手动取回: dreamina-canvas resource download {resource_id} --project-id={project_id} -o <路径>"
                )
            },
        )?;
        if !target.is_file() {
            return Err(format!(
                "图片已生成但本地没有落盘文件（resourceId={resource_id}, 期望 {}）",
                target.display()
            ));
        }
        Ok(target.to_string_lossy().to_string())
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateJimengCanvasAudioRequest {
    pub executable: String,
    pub prompt: String,
    pub model: String,
    /// `tts`（文本转语音）/ `music`（音乐生成）
    pub mode: String,
    /// music 模式的时长（秒），tts 忽略
    pub duration: Option<u32>,
    /// 全能配音的参考音频（本地文件或 data URL）
    pub reference_audio: Option<Vec<String>>,
    pub project_id: Option<String>,
}

/// 即梦画布 CLI 生成音频(`node create audio --run --wait`)。
#[tauri::command]
pub async fn generate_jimeng_canvas_audio(
    app: AppHandle,
    request: GenerateJimengCanvasAudioRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || generate_canvas_audio_blocking(&app, request))
        .await
        .map_err(|error| format!("即梦画布 CLI 任务执行中断: {error}"))?
}

fn generate_canvas_audio_blocking(
    app: &AppHandle,
    request: GenerateJimengCanvasAudioRequest,
) -> Result<String, String> {
    let executable = request.executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先在「设置 - 密钥 - 即梦画布 CLI」中填写可执行命令".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("即梦画布 CLI 音频生成需要提示词或台词".to_string());
    }
    let project_id = match request
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => ensure_canvas_project(&executable)?,
    };

    let run_id = Uuid::new_v4().to_string();
    let input_dir = std::env::temp_dir().join(format!("lentalk-jimeng-canvas-{run_id}"));
    fs::create_dir_all(&input_dir)
        .map_err(|error| format!("无法创建即梦画布 CLI 临时目录: {error}"))?;

    let result = (|| {
        // 参考音频同样要先登记成项目资源, `--ref` 只认 `res:<id>`。
        let audio_files = materialize_audio_files(
            request.reference_audio.as_deref().unwrap_or_default(),
        )?;
        let mut references: Vec<String> = Vec::new();
        for path in &audio_files {
            references.push(upload_canvas_resource(
                &executable,
                &project_id,
                path,
                "audio",
                "参考音频",
            )?);
        }

        let mut content_args = vec![
            format!("--mode={}", request.mode),
            format!("--model={}", request.model),
            format!("--prompt={}", request.prompt),
        ];
        if request.mode == "music" {
            if let Some(duration) = request.duration.filter(|value| *value >= 30) {
                content_args.push(format!("--duration={duration}"));
            }
        }
        for reference in &references {
            content_args.push(format!("--ref={reference}"));
        }
        let (node_id, _quoted) =
            create_quote_confirm_run(&executable, &project_id, "audio", &content_args)?;

        let show_output = run_canvas_cli(
            &executable,
            &[
                "node".to_string(),
                "show".to_string(),
                format!("--project-id={project_id}"),
                format!("--node-id={node_id}"),
                "--format".to_string(),
                "json".to_string(),
            ],
        )?;
        let show_data = parse_canvas_payload(&show_output)?;
        let resource_id = find_json_string_field(&show_data, "resourceId").ok_or_else(|| {
            format!("即梦画布 CLI 节点 {node_id} 运行完成但没有产物资源, 请到即梦画布网页端确认")
        })?;

        // 音频服务端可能回 mp3 也可能回 wav, 先落成临时名再按实际扩展名修正。
        let download_dir = resolve_download_dir(app, &run_id)?;
        let target = download_dir.join(format!("canvas-{run_id}.mp3"));
        download_canvas_resource(&executable, &project_id, &resource_id, &target).map_err(
            |error| {
                format!(
                    "音频已生成但下载失败（resourceId={resource_id}）: {error}。\
                     可手动取回: dreamina-canvas resource download {resource_id} --project-id={project_id} -o <路径>"
                )
            },
        )?;
        if !target.is_file() {
            return Err(format!(
                "音频已生成但本地没有落盘文件（resourceId={resource_id}, 期望 {}）",
                target.display()
            ));
        }
        Ok(target.to_string_lossy().to_string())
    })();

    let _ = fs::remove_dir_all(&input_dir);
    result
}

/// 在 JSON 里递归找第一个数值字段（按候选 key 名依次试）。
///
/// 报价(`node quote`)返回的积分字段名在不同小版本里叫 `credits` / `totalCredits` /
/// `total` 都有可能, 与其猜一个写死, 不如按候选名找。
fn find_json_number_field(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    match value {
        serde_json::Value::Object(map) => {
            for key in keys {
                if let Some(number) = map.get(*key).and_then(serde_json::Value::as_f64) {
                    return Some(number);
                }
            }
            map.values()
                .find_map(|child| find_json_number_field(child, keys))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|child| find_json_number_field(child, keys)),
        _ => None,
    }
}

const CANVAS_QUOTE_KEYS: [&str; 9] = [
    // 实测 `node quote` 回的是 `{"items":[{"nodeId":…,"maxCredits":45}],"totalMaxCredits":45}`
    "totalMaxCredits",
    "maxCredits",
    "credits",
    "credit",
    "totalCredits",
    "total_credit",
    "creditsAmount",
    "amount",
    "total",
];

/// 建节点 → 报价 → 按报价批准 → 运行 → 等终态。
///
/// 不用 `node create --run`: 那条命令虽然会在内部「报价 → 批准 → 运行」, 但**用户看不到
/// 要花多少积分**, 而且 ceiling 只能猜一个写死的值。拆开之后:
/// ① 积分是服务端报的真实数字; ② 批准额度按报价给, 不会因为猜小了被拒、猜大了失控。
/// 返回 `(node_id, 报价积分)`。
fn create_quote_confirm_run(
    executable: &str,
    project_id: &str,
    node_kind: &str,
    content_args: &[String],
) -> Result<(String, Option<f64>), String> {
    // 1) 建节点(不触发生成)
    let mut create_args = vec![
        "node".to_string(),
        "create".to_string(),
        node_kind.to_string(),
        format!("--project-id={project_id}"),
        "--format".to_string(),
        "json".to_string(),
    ];
    create_args.extend(content_args.iter().cloned());
    let created = run_canvas_cli(executable, &create_args)?;
    let created_data = parse_canvas_payload(&created)?;
    let node_id = find_json_string_field(&created_data, "nodeId")
        .ok_or_else(|| "即梦画布 CLI 建节点后未返回 nodeId".to_string())?;

    // 2) 报价 —— 失败不致命: 拿不到就退回让服务端在运行前自行判断。
    let quoted = run_canvas_cli(
        executable,
        &canvas_cli_args(&[
            "node",
            "quote",
            &format!("--node-id={node_id}"),
            &format!("--project-id={project_id}"),
            "--format",
            "json",
        ]),
    )
    .ok()
    .and_then(|output| parse_canvas_payload(&output).ok())
    .and_then(|data| find_json_number_field(&data, &CANVAS_QUOTE_KEYS));

    // 3) 按报价批准(留 10% 余量, 服务端报价可能因分辨率微调), 拿短期凭证
    let ceiling = quoted.map(|value| (value * 1.1).ceil() as i64).unwrap_or(2000);
    let confirmed = run_canvas_cli(
        executable,
        &canvas_cli_args(&[
            "node",
            "confirm",
            &format!("--node-id={node_id}"),
            &format!("--project-id={project_id}"),
            &format!("--credit-ceiling={ceiling}"),
            "--non-interactive",
            "--yes",
            "--format",
            "json",
        ]),
    )?;
    let confirmed_data = parse_canvas_payload(&confirmed)?;
    let credit_token = find_json_string_field(&confirmed_data, "creditConfirmationToken")
        .or_else(|| find_json_string_field(&confirmed_data, "token"));

    // 4) 提交运行
    let mut run_args = vec![
        "node".to_string(),
        "run".to_string(),
        format!("--node-id={node_id}"),
        format!("--project-id={project_id}"),
        "--non-interactive".to_string(),
        "--yes".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(token) = &credit_token {
        run_args.push(format!("--credit-token={token}"));
    }
    let _ = run_canvas_cli(executable, &run_args)?;

    // 5) 等终态: 直接轮询 `node show` 读 status。
    // 不走 `operation wait <submitId>` —— 那需要先拿到 submitId, 而 run 的返回结构没实测过;
    // 而 show 是后面取产物必经的一步, status 字段已经确认存在(`success` / `empty` / `failed`)。
    let deadline = std::time::Instant::now() + CLI_TASK_TIMEOUT;
    loop {
        let show = run_canvas_cli(
            executable,
            &canvas_cli_args(&[
                "node",
                "show",
                &format!("--project-id={project_id}"),
                &format!("--node-id={node_id}"),
                "--format",
                "json",
            ]),
        )?;
        let data = parse_canvas_payload(&show)?;
        let status = find_json_string_field(&data, "status")
            .unwrap_or_default()
            .to_lowercase();
        match status.as_str() {
            "success" => break,
            "failed" | "canceled" | "cancelled" => {
                // 失败原因通常在节点的 error 字段里, 原样带回比只说「失败」有用。
                //
                // 但**内容审核失败是个例外**: CLI 的 `node show` 只给 `errorCode`,
                // 一个字的文本都不给（2026-10-28 实测:
                // `resources[0] = {status:"failed", errorCode:20110}`，全 JSON 里没有
                // message / errorMessage / reason / audit 任何一项）。这种情况下再说
                // 「未返回失败原因」等于什么都没说 —— 把码带出来, 用户至少能去平台网页对号。
                let detail = find_json_string_field(&data, "errorMessage")
                    .or_else(|| find_json_string_field(&data, "error"))
                    .or_else(|| find_json_string_field(&data, "message"))
                    .unwrap_or_else(|| match find_json_number_field(&data, &["errorCode"]) {
                        Some(code) => describe_canvas_error_code(code as i64),
                        None => "未返回失败原因".to_string(),
                    });
                return Err(format!(
                    "即梦画布 CLI 节点 {node_id} 生成失败: {detail}\
                     （可在即梦画布网页端查看该节点, 或 dreamina-canvas node show --node-id={node_id}）"
                ));
            }
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "即梦画布 CLI 节点 {node_id} 等待超时（当前状态 {status}）。\
                 任务可能仍在服务端运行, 稍后用 dreamina-canvas node show --node-id={node_id} 查看"
            ));
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }

    Ok((node_id, quoted))
}

/// 即梦 CLI 的账户积分(`dreamina user_credit`)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengCliCredit {
    /// 剩余积分总数。
    pub total_credit: f64,
    /// 会员等级(如 maestro), 未登录或字段缺失时为 None。
    pub vip_level: Option<String>,
    /// 当前登录用户的 ID(v1.4.21+ 才返回)。
    /// 切号后靠它才能确认「现在到底是哪个账号」—— CLI 拿不到昵称, ID 是唯一可靠标识。
    pub user_id: Option<String>,
    pub user_name: Option<String>,
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
    // `user_id` 在 JSON 里是数字(可能超出 i64, 一律按字符串取), 昵称常常是空串。
    let user_id = payload.get("user_id").and_then(|value| match value {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    });
    let user_name = payload
        .get("user_name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(JimengCliCredit {
        total_credit,
        vip_level,
        user_id,
        user_name,
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

/// 官方安装脚本（https://jimeng.jianying.com/cli）支持的平台。
/// 每个变体对应脚本 `detect_platform()` 里的一组 `PLATFORM` / `DOWNLOAD_FILE`，
/// 从而保证「识别系统」这件事与官方脚本口径完全一致。
///
/// 这张表是全平台描述性的：任一编译目标只会构造其中一个变体，
/// 其余变体仍要保留给 match / 单测，所以整体允许 dead_code。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JimengCliPlatform {
    WindowsAmd64,
    DarwinAmd64,
    DarwinArm64,
    LinuxAmd64,
    LinuxArm64,
}

impl JimengCliPlatform {
    /// 识别当前运行平台；不支持的平台返回 None，由调用方给出可读提示。
    fn detect() -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
            return Some(Self::WindowsAmd64);
        }
        #[cfg(target_os = "macos")]
        {
            return Some(if macos_is_apple_silicon() {
                Self::DarwinArm64
            } else {
                Self::DarwinAmd64
            });
        }
        #[cfg(target_os = "linux")]
        {
            return Some(if cfg!(target_arch = "aarch64") {
                Self::LinuxArm64
            } else {
                Self::LinuxAmd64
            });
        }
        #[allow(unreachable_code)]
        None
    }

    /// 官方二进制文件名（与脚本 `DOWNLOAD_FILE` 逐字一致）。
    fn download_file(self) -> &'static str {
        match self {
            Self::WindowsAmd64 => "dreamina_cli_windows_amd64.exe",
            Self::DarwinAmd64 => "dreamina_cli_darwin_amd64",
            Self::DarwinArm64 => "dreamina_cli_darwin_arm64",
            Self::LinuxAmd64 => "dreamina_cli_linux_amd64",
            Self::LinuxArm64 => "dreamina_cli_linux_arm64",
        }
    }

    /// 落地后的文件名：只有 Windows 需要 `.exe` 后缀才能被直接执行。
    fn binary_name(self) -> &'static str {
        if self.is_windows() {
            "dreamina.exe"
        } else {
            "dreamina"
        }
    }

    /// 临时文件后缀，与落地文件名保持同一约定。
    fn binary_suffix(self) -> &'static str {
        if self.is_windows() {
            ".exe"
        } else {
            ""
        }
    }

    fn is_windows(self) -> bool {
        matches!(self, Self::WindowsAmd64)
    }

    /// 人类可读的平台名，用于安装结果与失败提示。
    fn label(self) -> &'static str {
        match self {
            Self::WindowsAmd64 => "Windows (x64)",
            Self::DarwinArm64 => "macOS (Apple 芯片)",
            Self::DarwinAmd64 => "macOS (Intel)",
            Self::LinuxAmd64 => "Linux (x64)",
            Self::LinuxArm64 => "Linux (arm64)",
        }
    }
}

/// 判定是否为 Apple 芯片。
/// Rosetta 下 `uname -m` 会谎报 `x86_64`，而 `sysctl -n hw.optional.arm64`
/// 在 Apple Silicon 上始终返回 1，所以优先用它；探测失败时退回编译目标架构。
#[cfg(target_os = "macos")]
fn macos_is_apple_silicon() -> bool {
    match Command::new("sysctl")
        .args(["-n", "hw.optional.arm64"])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim() == "1"
        }
        _ => cfg!(target_arch = "aarch64"),
    }
}

/// 安装目录：Windows 沿用官方安装器的 `%USERPROFILE%\bin`，
/// macOS/Linux 与官方脚本一致用 `~/.local/bin`。
/// 两者都已经在 `common_locations` 的首批候选里，所以装完立刻能被探测到。
fn install_bin_dir(home: &Path, platform: JimengCliPlatform) -> PathBuf {
    if platform.is_windows() {
        home.join("bin")
    } else {
        home.join(".local").join("bin")
    }
}

/// 自动安装即梦 CLI（自动识别 Windows / macOS / Linux，与官方安装脚本同源）：
/// 1. 已安装 → 直接返回 installed=false（不重复安装）；
/// 2. 按当前平台下载官方二进制（Windows → `%USERPROFILE%\bin\dreamina.exe`；
///    macOS/Linux → `~/.local/bin/dreamina`），Unix 下补可执行位并清 quarantine；
/// 3. 尽力补齐 `~/.dreamina_cli` 下的 SKILL.md / version.json（失败不阻塞）；
/// 4. 把安装目录写进用户 PATH（Windows 用户级环境变量 / Unix shell 启动文件，失败不阻塞）；
/// 5. 复检；所有失败路径均返回可读 message，不向上抛致命错误。
#[tauri::command]
pub async fn jimeng_cli_install() -> Result<JimengCliInstallResult, String> {
    tokio::task::spawn_blocking(jimeng_cli_install_blocking)
        .await
        .map_err(|error| format!("即梦 CLI 自动安装任务中断: {error}"))?
}

fn jimeng_cli_install_blocking() -> Result<JimengCliInstallResult, String> {
    let Some(platform) = JimengCliPlatform::detect() else {
        return Ok(JimengCliInstallResult {
            success: false,
            installed: false,
            resolved_path: None,
            message: format!(
                "当前系统（{}）暂不支持自动安装即梦 CLI，请参考 docs/jimeng-cli-guide.md 手动安装",
                std::env::consts::OS
            ),
        });
    };

    let detection = detect_executable("dreamina");
    if detection.found {
        return Ok(JimengCliInstallResult {
            success: true,
            installed: false,
            resolved_path: detection.resolved_path,
            message: "已检测到即梦 CLI，无需重复安装".to_string(),
        });
    }

    let home = current_user_home().ok_or_else(|| {
        format!(
            "无法定位用户主目录，请手动安装即梦 CLI（{}）",
            platform.label()
        )
    })?;
    let bin_dir = install_bin_dir(&home, platform);
    let binary_path = bin_dir.join(platform.binary_name());
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("无法创建安装目录 {}: {error}", bin_dir.display()))?;

    let curl = find_curl().ok_or_else(|| {
        format!(
            "未找到 curl，无法下载即梦 CLI（{}），请手动安装",
            platform.label()
        )
    })?;

    let binary_url = format!("{JIMENG_CLI_DOWNLOAD_BASE}/{}", platform.download_file());
    let tmp_path = std::env::temp_dir().join(format!(
        "lentalk-jimeng-install-{}{}",
        Uuid::new_v4(),
        platform.binary_suffix()
    ));
    download_with_curl(&curl, &binary_url, &tmp_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        error
    })?;
    let size = fs::metadata(&tmp_path).map(|meta| meta.len()).unwrap_or(0);
    if size < JIMENG_CLI_MIN_BINARY_BYTES {
        let _ = fs::remove_file(&tmp_path);
        return Ok(JimengCliInstallResult {
            success: false,
            installed: false,
            resolved_path: None,
            message: format!(
                "下载的即梦 CLI 文件异常（{}，仅 {size} 字节），安装中止，请手动安装",
                platform.label()
            ),
        });
    }
    if binary_path.exists() {
        // 只覆盖本次自动安装写入的目标文件；绝不触碰用户手动配置的其它路径。
        let _ = fs::remove_file(&binary_path);
    }
    fs::rename(&tmp_path, &binary_path)
        .or_else(|_| fs::copy(&tmp_path, &binary_path).map(|_| ()))
        .map_err(|error| {
            let _ = fs::remove_file(&tmp_path);
            format!("无法写入安装目录 {}: {error}", binary_path.display())
        })?;
    let _ = fs::remove_file(&tmp_path);

    // Unix 下 curl 落盘的二进制没有可执行位，且 macOS 可能带上隔离属性，
    // 缺失会让后续 `Command::new(dreamina)` 报 "Permission denied"/"已损坏"。
    #[cfg(unix)]
    {
        if let Err(error) = make_unix_executable(&binary_path) {
            return Ok(JimengCliInstallResult {
                success: false,
                installed: false,
                resolved_path: None,
                message: format!(
                    "已下载即梦 CLI 但无法设置可执行权限（{error}），请手动执行 chmod +x {}",
                    binary_path.display()
                ),
            });
        }
        clear_macos_quarantine(&binary_path);
    }

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
    if let Err(error) = ensure_user_path(&bin_dir) {
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
            message: format!(
                "安装后仍未检测到即梦 CLI（{}），请参考 docs/jimeng-cli-guide.md 手动安装{suffix}",
                platform.label()
            ),
        }),
    }
}

/// 定位 curl：优先系统自带的固定路径，其次当前进程 PATH。
/// Windows 用 `C:\Windows\System32\curl.exe`，macOS/Linux 用 `/usr/bin/curl`
/// —— GUI 应用从 Finder/桌面启动时拿不到登录 shell 的 PATH，直查固定路径最稳。
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
    let system_curl = PathBuf::from("/usr/bin/curl");
    if system_curl.is_file() {
        return Some(system_curl);
    }
    find_in_path("curl").map(PathBuf::from)
}

/// 用 curl 下载文件到目标路径；失败返回可读错误。
fn download_with_curl(curl: &Path, url: &str, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建下载目录 {}: {error}", parent.display()))?;
    }
    let output = Command::new(curl)
        .args(["-fsSL", url, "-o"])
        .arg(target)
        .output()
        .map_err(|error| format!("无法启动 curl: {error}"))?;
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

/// Unix 下补可执行位（curl 落盘默认是 0644）。
#[cfg(unix)]
fn make_unix_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("无法设置可执行权限: {error}"))
}

/// macOS 会记录「从网络下载」的隔离属性，带该属性的二进制首次执行会被 Gatekeeper 拦截。
/// 官方安装脚本同样会在安装后清一次。
#[cfg(target_os = "macos")]
fn clear_macos_quarantine(target: &Path) {
    let _ = Command::new("xattr")
        .args(["-d", "com.apple.quarantine"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn clear_macos_quarantine(_target: &Path) {}

/// 把安装目录写入用户 PATH。
/// - Windows：改当前用户 PATH 环境变量（PowerShell，User 级，不触碰系统 PATH）；
/// - macOS/Linux：把 `export PATH="…:$PATH"` 追加到当前 shell 的启动文件。
/// 失败不致命：返回 Err 由调用方转成提示，不影响已完成的安装。
fn ensure_user_path(bin_dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
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
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(if trimmed.is_empty() {
            "PowerShell 执行失败".to_string()
        } else {
            trimmed.to_string()
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        ensure_unix_path(bin_dir)
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_unix_path(bin_dir: &Path) -> Result<(), String> {
    if let Some(path) = std::env::var_os("PATH") {
        if std::env::split_paths(&path).any(|entry| entry.as_path() == bin_dir) {
            return Ok(());
        }
    }
    let home = current_user_home().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let shell = std::env::var("SHELL").ok();
    let zdotdir = std::env::var("ZDOTDIR").ok();
    let rc_file = pick_unix_rc_file(shell.as_deref(), &home, zdotdir.as_deref());
    let line = format!(
        "export PATH=\"{}:$PATH\"",
        bin_dir.to_string_lossy().replace('"', "\\\"")
    );
    append_line_if_missing(&rc_file, &line).map(|_| ())
}

/// 按官方安装脚本 `pick_unix_rc_file` 的规则挑选启动文件：
/// zsh → `${ZDOTDIR:-$HOME}/.zshrc`；bash → 优先 `.bashrc`（存在，或没有 `.bash_profile` 时）；
/// 其它 shell → `~/.profile`。
///
/// 与官方脚本的唯一差别：`$SHELL` 缺失时不盲写 `~/.profile` —— zsh 不读它，
/// 会出现「脚本说装好了但 `dreamina: command not found`」。macOS 默认 zsh，
/// 所以优先落到已存在的 `~/.zshrc`，否则再退 `~/.profile`。
///
/// 保持平台无关（只用 PathBuf / fs），这样在任意开发机上都有单测覆盖。
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn pick_unix_rc_file(shell: Option<&str>, home: &Path, zdotdir: Option<&str>) -> PathBuf {
    let shell_name = shell
        .map(|value| {
            value
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    match shell_name.as_str() {
        "zsh" => zdotdir
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| home.to_path_buf())
            .join(".zshrc"),
        "bash" => {
            let bashrc = home.join(".bashrc");
            if bashrc.is_file() || !home.join(".bash_profile").is_file() {
                bashrc
            } else {
                home.join(".bash_profile")
            }
        }
        _ => {
            let zshrc = home.join(".zshrc");
            if zshrc.is_file() {
                zshrc
            } else {
                home.join(".profile")
            }
        }
    }
}

/// 向文件追加一行（文件不存在则创建）；已存在完全相同的行时不再重复追加。
/// 返回是否发生了写入。同样保持平台无关，便于在任意开发机上覆盖。
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn append_line_if_missing(file: &Path, line: &str) -> Result<bool, String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    let existing = fs::read_to_string(file).unwrap_or_default();
    if existing.lines().any(|current| current.trim() == line) {
        return Ok(false);
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(line);
    next.push('\n');
    fs::write(file, next).map_err(|error| format!("无法写入 {}: {error}", file.display()))?;
    Ok(true)
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

    // ---- 画布素材上传的幂等键与恢复 ----

    /// 幂等键必须**确定性**: 同一份素材在重试时必须落回同一个资源, 否则
    /// `--resource-id` 就退化成 CLI 自己生成的随机键, `cli.upload_state_unknown` 也就恢复不了。
    #[test]
    fn canvas_resource_key_is_deterministic_per_content() {
        let first = canvas_resource_key("project-a", "image", b"same-bytes");
        let second = canvas_resource_key("project-a", "image", b"same-bytes");
        assert_eq!(first, second, "同一份素材必须得到同一个幂等键");
    }

    #[test]
    fn canvas_resource_key_separates_content_project_and_media_type() {
        let base = canvas_resource_key("project-a", "image", b"bytes");
        assert_ne!(base, canvas_resource_key("project-b", "image", b"bytes"));
        assert_ne!(base, canvas_resource_key("project-a", "audio", b"bytes"));
        assert_ne!(base, canvas_resource_key("project-a", "image", b"other-bytes"));
    }

    /// CLI 只校验「是个 UUID」, 但形状不对(非 v4)可能被服务端拒, 所以固定断言版本位与变体位。
    #[test]
    fn canvas_resource_key_is_uuid_v4_shaped() {
        let key = canvas_resource_key("project-a", "image", b"bytes");
        let parts: Vec<&str> = key.split('-').collect();
        assert_eq!(parts.len(), 5, "应为 UUID 形状: {key}");
        assert_eq!(
            [parts[0].len(), parts[1].len(), parts[2].len(), parts[3].len(), parts[4].len()],
            [8, 4, 4, 4, 12],
            "分段长度不对: {key}"
        );
        assert!(parts[2].starts_with('4'), "version 位应为 4: {key}");
        assert!(
            matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')),
            "variant 位应为 8/9/a/b: {key}"
        );
    }

    /// 用户实报的报错原文: 整坨 JSON 被 `output_summary` 糊出来后, 用户只看到
    /// `error={"class":"human_intervention",...}`, 完全不知道该做什么。
    #[test]
    fn canvas_failure_reason_keeps_message_and_code_only() {
        let output = serde_json::json!({
            "schemaVersion": "1",
            "ok": false,
            "error": {
                "class": "human_intervention",
                "code": "cli.upload_state_unknown",
                "message": "The upload may already have created a remote object. Do not automatically retry; inspect the operation or contact support.",
                "retryable": false
            }
        })
        .to_string();

        let reason = canvas_cli_failure_reason(&output);
        assert!(reason.contains("cli.upload_state_unknown"), "应带错误码: {reason}");
        assert!(
            reason.contains("Do not automatically retry"),
            "应保留可读原因: {reason}"
        );
        assert!(
            !reason.contains("\"class\"") && !reason.contains("human_intervention"),
            "不应再把整坨信封 JSON 抛给用户: {reason}"
        );
    }

    #[test]
    fn canvas_failure_marks_unknown_upload_state_as_maybe_existing() {
        assert!(canvas_failure_means_resource_exists(
            "The upload may already have created a remote object.（cli.upload_state_unknown）"
        ));
        assert!(canvas_failure_means_resource_exists(
            "This request was already submitted. Reuse the existing submission identity.（service.5）"
        ));
        assert!(!canvas_failure_means_resource_exists(
            "即梦画布 CLI 的登录态已失效（cli.credential_missing）"
        ));
    }

    /// 人话说明必须点明「不是素材/提示词的问题 + 不花钱 + 怎么手动核对」,
    /// 否则用户只会以为是参考图坏了, 反复换图重试。
    #[test]
    fn canvas_upload_failure_explains_unknown_state() {
        let text = describe_canvas_upload_failure(
            "参考图",
            "f8eafd66-b4a8-4e68-bae4-99f12044a6f0",
            "3fa5626f-f323-4663-858c-7b8a8fa7266f",
            "The upload may already have created a remote object.（cli.upload_state_unknown）",
        );

        assert!(text.contains("参考图"), "应指明是哪类素材: {text}");
        assert!(text.contains("f8eafd66-b4a8-4e68-bae4-99f12044a6f0"), "应带幂等键: {text}");
        assert!(text.contains("不代表参考素材或提示词有问题"), "应排除素材嫌疑: {text}");
        assert!(text.contains("不消耗积分"), "应说明没有花钱: {text}");
        assert!(
            text.contains("dreamina-canvas resource get f8eafd66-b4a8-4e68-bae4-99f12044a6f0"),
            "应给手动核对命令: {text}"
        );
        assert!(text.contains("--project-id=3fa5626f"), "核对命令应带项目: {text}");
    }

    #[test]
    fn canvas_upload_failure_handles_login_and_timeout() {
        let login = describe_canvas_upload_failure("参考音频", "rid", "pid", "not login, unauthorized");
        assert!(login.contains("重新登录"), "未登录应引导重新登录: {login}");

        let timeout = describe_canvas_upload_failure(
            "参考图",
            "rid",
            "pid",
            "context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
        );
        assert!(timeout.contains("代理"), "超时应提示代理问题: {timeout}");
    }
    /// 真机抓到的原始错误（即梦画布 CLI 1.1.1，`service.10000`）。
    const OAUTH_SCOPE_ERROR: &str = r#"{"schemaVersion":"1","ok":false,"error":{"code":"service.10000","serviceCode":10000,"class":"auth_required","message":"Access was denied for this operation.","reason":"oauth_scope_insufficient","retryable":false,"requiredAction":"login","requestId":"202610291410359A6EE970D5FD614C611E","validation":{"reasonCode":"oauth_scope_insufficient","fieldPath":"authorization","detail":"Insufficient permissions."}}}"#;

    #[test]
    fn oauth_scope_failure_explains_how_to_fix_it() {
        let value: serde_json::Value = serde_json::from_str(OAUTH_SCOPE_ERROR).expect("valid json");
        let message = describe_canvas_failure(&value);
        // 原始 code 要保留，方便用户搜索/反馈。
        assert!(message.contains("service.10000"), "{message}");
        // 必须点名真实原因，而不是只说 "Access was denied"。
        assert!(message.contains("权限不足"), "{message}");
        // 必须给出可执行的两条路（界面按钮 / 终端命令）。
        assert!(message.contains("切换账号"), "{message}");
        assert!(message.contains("auth login --force"), "{message}");
    }

    #[test]
    fn unknown_reason_is_still_surfaced() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"ok":false,"error":{"code":"service.5","message":"already submitted","reason":"idempotent_reuse"}}"#,
        )
        .expect("valid json");
        let message = describe_canvas_failure(&value);
        assert!(message.contains("already submitted"), "{message}");
        assert!(message.contains("idempotent_reuse"), "未知原因也要带出来: {message}");
    }

    #[test]
    fn failure_without_reason_falls_back_to_message_and_code() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"ok":false,"error":{"code":"cli.invalid_flag","message":"Invalid flag"}}"#,
        )
        .expect("valid json");
        assert_eq!(describe_canvas_failure(&value), "Invalid flag（cli.invalid_flag）");
    }

}
