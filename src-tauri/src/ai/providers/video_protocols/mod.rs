// ---------------------------------------------------------------------------
// 专有视频协议的后端实现
//
// 背景: 这些协议原先跑在前端 WebView 的兼容 worker 里(内存 Map 存任务状态)。
// WebView 一刷新/切页, 任务状态就没了, 仍在平台生成(且已计费)的任务会被判成
// 「中断」, 用户只能重新提交 —— 二次扣费。迁到后端后, 提交即把平台 task_id 与
// 查询地址落进 ai_generation_jobs, 之后再凭它续查。
//
// 每个协议只暴露 submit / poll 两个函数, 共用 `assets` 的素材解析与上传:
//   submit: 构造请求体 -> 提交 -> 返回平台句柄(含绝对查询地址)
//   poll:   凭句柄查询 -> Succeeded(成片 URL 或已落盘的本地路径) / Running / Failed
//
// 元数据必须在提交时算全(尤其是绝对查询地址与协议名), 因为续查发生在任意进程/
// 会话里, 那时的 extra_params 已经不存在了。
// ---------------------------------------------------------------------------
pub mod assets;
pub mod binghuo;
pub mod extract;
pub mod kling;
pub mod runninghub;
pub mod sub2api;
pub mod wgspai;
pub mod zhenjian;
pub mod zzdh;

use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

use crate::ai::error::AIError;
use crate::ai::providers::openai_compat::OpenAICompatibleProvider;
use crate::ai::{
    GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

/// 已迁到后端任务执行器的专有视频协议。
///
/// **必须与前端 `tauriAiGateway.ts` 的 `needsCompatibilityVideoWorker` 保持一致**:
/// 不在此列却交给后端的协议会被 `submit_video_task` 直接拒掉(一个请求都不发);
/// 在此列却仍留在前端的协议则不会走后端。两边同时改。
pub const BACKEND_VIDEO_TRANSPORTS: [&str; 9] = [
    "openai-video",
    "zhiniao-video",
    "wgspai-video",
    "binghuo-video",
    "kling-control",
    "zhenjian-task-api",
    "zzdh-v8-video",
    "sub2api-video",
    "runninghub-model",
];

/// 提交时会把 `transport` 写进元数据的协议 —— 轮询阶段据此路由到协议层。
///
/// 其中帧间 / 字子动画 / Sub2API / Kling 有各自专属的解析(相对地址、二进制成片、
/// 顶层数组); WGSPAI 的解析也是通用的(`classify`), 只是额外补了一层业务错误包
/// 判定(族 2 用 `{"code": -1, "message": …}` 回错, 通用归类认不出顶层 `code`);
/// 炳火的查询响应形状与通用协议完全一致, 落到 `classify` 即可。**不含**
/// openai-video / zhiniao-video: 那两个的元数据里没有 transport 字段, 走
/// `poll_video_task` 里的通用分支。
///
/// RunningHub 必须在此列: 它的业务错误包用 `errorCode` 而非 `error`, 且
/// `status` 是**空串** —— 通用 `classify` 只会一直判"还在跑", 直到轮询窗口耗尽。
const PROTOCOL_TRANSPORTS: [&str; 7] = [
    "kling-control",
    "zhenjian-task-api",
    "zzdh-v8-video",
    "sub2api-video",
    "wgspai-video",
    "binghuo-video",
    "runninghub-model",
];

pub fn is_backend_transport(transport: &str) -> bool {
    transport.is_empty() || BACKEND_VIDEO_TRANSPORTS.contains(&transport)
}

/// 该协议是否有专属的轮询解析实现。
pub fn has_protocol_poll(transport: &str) -> bool {
    PROTOCOL_TRANSPORTS.contains(&transport)
}

// ---------------------------------------------------------------------------
// 媒体落盘端口
//
// 帧间 / Sub2API / 字子动画的成片地址是**带鉴权的二进制端点**(要带 Bearer 才能取到
// 字节, 前端 <video> 标签拿不到)。这类协议必须在后端把字节下载回来写进本地媒体目录,
// 再把本地绝对路径交给画布(前端 `resolveImageDisplayUrl` 会 convertFileSrc)。
//
// AI 层刻意**不依赖 tauri**(整个 `ai` 模块目前零 tauri 引用), 所以这里只声明签名,
// 由命令层在启动时注入实现 —— 见 `commands::image::make_media_persister` 与
// `lib.rs` 的 `install_media_persister`。
// ---------------------------------------------------------------------------
pub type MediaPersister = Box<dyn Fn(&[u8], &str) -> Result<String, String> + Send + Sync>;

static MEDIA_PERSISTER: OnceLock<MediaPersister> = OnceLock::new();

pub fn install_media_persister(persister: MediaPersister) {
    // 重复安装无害: 保留第一次注入的实现。
    let _ = MEDIA_PERSISTER.set(persister);
}

/// 把平台返回的成片字节写进本地媒体目录, 返回本地绝对路径。
pub fn persist_media_bytes(bytes: &[u8], extension: &str) -> Result<String, AIError> {
    if bytes.is_empty() {
        return Err(AIError::TaskFailed("平台返回的成片内容为空".into()));
    }
    let persister = MEDIA_PERSISTER.get().ok_or_else(|| {
        AIError::TaskFailed("媒体落盘通道未初始化, 无法保存平台返回的二进制成片".into())
    })?;
    persister(bytes, extension).map_err(AIError::TaskFailed)
}

/// 带鉴权的二进制下载。返回 (bytes, 用于推断扩展名的 url)。
pub async fn download_bytes(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, AIError> {
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 下载失败(网络): {}", label, describe_reqwest_error(&error))))?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(http_error(&format!("{} 下载失败", label), status, &raw, url));
    }
    // Content-Type 优先(比 URL 后缀可靠), 但只作为扩展名提示保留在调用方。
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AIError::Provider(format!("{} 下载失败(读取响应体): {}", label, describe_reqwest_error(&error))))?;
    if bytes.is_empty() {
        return Err(AIError::TaskFailed(format!("{} 下载失败: 内容为空 ({})", label, url)));
    }
    Ok(bytes.to_vec())
}

/// 从 MIME / URL 后缀推断落盘扩展名。
pub fn video_extension_hint(mime_type: &str, url: &str) -> String {
    let mime = mime_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match mime.as_str() {
        "video/mp4" | "application/mp4" => return "mp4".to_string(),
        "video/webm" => return "webm".to_string(),
        "video/quicktime" => return "mov".to_string(),
        "image/png" => return "png".to_string(),
        "image/jpeg" => return "jpg".to_string(),
        "image/webp" => return "webp".to_string(),
        _ => {}
    }
    let lower = url.to_ascii_lowercase();
    for (suffix, extension) in [
        (".webm", "webm"),
        (".mov", "mov"),
        (".mp4", "mp4"),
        (".png", "png"),
        (".jpg", "jpg"),
        (".jpeg", "jpg"),
        (".webp", "webp"),
    ] {
        if lower.contains(suffix) {
            return extension.to_string();
        }
    }
    "mp4".to_string()
}

/// 提交阶段的上下文。base_url 已去掉结尾斜杠与 `/v1` 后缀(站点根)。
pub struct SubmitContext {
    pub client: reqwest::Client,
    pub base_url: String,
    pub api_key: String,
    pub provider_id: String,
}

/// 轮询阶段的上下文。**不依赖任何内存状态**, 因此可以跨进程/跨会话使用。
pub struct PollContext {
    pub client: reqwest::Client,
    pub api_key: String,
}

impl SubmitContext {
    /// 把 extra_params 里的路径配置拼成绝对地址。支持 `{taskId}` 占位符。
    pub fn endpoint(&self, configured: Option<&str>, fallback: &str, task_id: Option<&str>) -> String {
        let path = configured
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback);
        let path = match task_id {
            Some(id) => path.replace("{taskId}", &urlencoding::encode(id)),
            None => path.to_string(),
        };
        if path.starts_with("http://") || path.starts_with("https://") {
            path
        } else if path.starts_with('/') {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}/{}", self.base_url, path)
        }
    }
}

/// 轮询间隔。各协议实测差异较大, 不统一成同一个值。
pub fn poll_interval(transport: &str) -> Duration {
    match transport {
        // 知鸟官方口径中位 4~40 分钟、p90 55~75 分钟, 3s 粒度足够。
        "zhiniao-video" => Duration::from_secs(3),
        "sub2api-video" => Duration::from_secs(4),
        "kling-control" | "zhenjian-task-api" => Duration::from_secs(4),
        // 炳火 / WGSPAI 提交后平台侧排队较久, 5s 一次可减少无效请求。
        _ => Duration::from_secs(5),
    }
}

/// 轮询窗口的**时长目标**(分钟)。给足长任务空间, 避免把仍在生成的付费任务误判成超时。
///
/// 用「时长」而不是「次数」来表达是刻意的: 各协议轮询间隔不同(3s/4s/5s), 直接写次数
/// 会让窗口长度随间隔漂移 —— 4s 间隔的协议只拿到 48 分钟, 比 5s 的少 12 分钟。
pub fn max_poll_minutes(transport: &str) -> u64 {
    match transport {
        // 知鸟官方口径: 中位 4~40 分钟、p90 55~75 分钟 ⇒ 给到 100 分钟。
        "zhiniao-video" => 100,
        // 其余远程协议(炳火 / WGSPAI / 帧间 / Kling / Sub2API / 字子动画)给到 60 分钟。
        _ => 60,
    }
}

/// 轮询窗口(次数 × 间隔)。由 `max_poll_minutes` 与 `poll_interval` 推导, 别再手写常量。
pub fn max_poll_attempts(transport: &str) -> u32 {
    let window_secs = max_poll_minutes(transport) * 60;
    let interval_secs = poll_interval(transport).as_secs().max(1);
    (window_secs / interval_secs).max(1) as u32
}

/// 提交成功但平台立即给了成片地址, 或返回了待轮询的句柄。
pub fn queued(
    task_id: String,
    provider_id: &str,
    transport: &str,
    query_url: String,
    extra_meta: Option<Value>,
) -> ProviderTaskSubmission {
    // 查询地址里的 `{taskId}` 占位符**必须在这里一次性换成真实任务号**。
    //
    // 原因: 轮询阶段是**原样**使用 metadata.query_url 的 —— 续查发生在任意进程/会话,
    // 那会儿 extra_params 早没了, 没有第二次替换的机会(见 poll_video_task / query_url_of)。
    // 漏掉这一步, 落库的就是 `.../generations/{taskId}` 这种带花括号的地址: reqwest
    // 连 URL 都解析不了, 每次轮询必失败, 而失败又被归成 "running"(见
    // get_generation_job_status 的 Err 分支) ⇒ **平台照跑照计费, 结果永远收不回**,
    // 界面上只表现为一直转圈、最后报「等待超时」。
    // 炳火 / WGSPAI 的 submit 就是直接把模板字符串传进来的。
    let query_url = if query_url.contains("{taskId}") {
        query_url.replace("{taskId}", &urlencoding::encode(&task_id))
    } else {
        query_url
    };
    let mut meta = serde_json::Map::new();
    meta.insert("provider_id".into(), Value::String(provider_id.to_string()));
    meta.insert("transport".into(), Value::String(transport.to_string()));
    meta.insert("query_url".into(), Value::String(query_url));
    meta.insert(
        "max_poll_attempts".into(),
        Value::Number(serde_json::Number::from(max_poll_attempts(transport))),
    );
    if let Some(Value::Object(extra)) = extra_meta {
        for (key, value) in extra {
            meta.insert(key, value);
        }
    }
    ProviderTaskSubmission::Queued(ProviderTaskHandle {
        task_id,
        metadata: Some(Value::Object(meta)),
    })
}

/// 统一的 HTTP 错误摘要, 让报错能直接定位到端点与平台原文。
/// HTTP 状态码是否属于「平台侧抖动」。
///
/// 5xx / 408 / 429 是平台侧抖动: 响应已到、请求未完成, 重试或下一轮轮询有意义。
/// 4xx 是**确定性**错误(地址写错、鉴权失效、参数不合法), 再轮询一万次也是同一个
/// 结果 —— 要判失败让用户立刻看到原因。
///
/// 判据与 [`fetch_json`] 完全一致: 同一个仓库里的两条 HTTP 通道必须给出同一个结论,
/// 否则一次 503 在提交的路径上被判死、在查询的路径上被判为可重试, 用户只能重提 ——
/// 等于我们自己制造了二次扣费(实机 2026-09-23 13:49 炳火提交返回 503 即此)。
pub fn is_transient_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// 响应体里带这些词就说明**平台已经给出定论**, 重试只会得到同一个结果。
///
/// 有的网关把上游的内容审核拒绝包成 HTTP 5xx(实机 2026-09-23 13:51 炳火:
/// HTTP 500 + `code=fail_to_fetch_task` + 内层「参考素材或提示词触发了上游内容审核」)。
/// 状态码落在"可重试"区间, 但语义上是终态 —— 用户要的是「换素材」这个可行动的结论,
/// 不是我们替他重试三次再报同样的错。
const TERMINAL_VERDICT_MARKERS: [&str; 8] = [
    "内容审核",
    "审核不通过",
    "审核未通过",
    "违规",
    "涉及敏感",
    "content_policy",
    "content policy",
    "moderation",
];

fn has_terminal_verdict(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    TERMINAL_VERDICT_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// 去掉已经被包进错误文案里的冗余前缀。
fn clean_reason(text: &str) -> String {
    let mut out = text.trim();
    for prefix in [
        "视频生成失败：",
        "视频生成失败:",
        "生成失败：",
        "生成失败:",
        "Generation failed:",
    ] {
        if let Some(rest) = out.strip_prefix(prefix) {
            out = rest.trim();
            break;
        }
    }
    assets::truncate(out, 500)
}

/// 从错误响应里挖出**人能读的那句话**。
///
/// 有的网关把上游错误当字符串又序列化了一层(实机 2026-09-23 13:51 炳火):
/// `{"code":"fail_to_fetch_task","message":"{\"ok\":false,\"error\":\"…审核…\"}"}`
/// 直接打印整个 raw, 真正的原因会被埋在一堆转义字符里, 用户看不出该做什么。
pub fn extract_error_reason(raw: &str) -> Option<String> {
    fn dig(value: &Value, depth: usize) -> Option<String> {
        if depth > 4 {
            return None;
        }
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return None;
                }
                // 内层可能是被再次序列化的 JSON, 继续往下钻到最里面那句人话。
                if let Ok(inner) = serde_json::from_str::<Value>(trimmed) {
                    if inner.is_object() || inner.is_array() {
                        if let Some(found) = dig(&inner, depth + 1) {
                            return Some(found);
                        }
                    }
                }
                Some(clean_reason(trimmed))
            }
            Value::Object(map) => {
                for key in [
                    "error",
                    "fail_reason",
                    "failure_reason",
                    "failReason",
                    "failureReason",
                    "message",
                    "msg",
                    "error_message",
                    "errorMessage",
                    "reason",
                    "detail",
                ] {
                    if let Some(found) = map.get(key).and_then(|item| dig(item, depth + 1)) {
                        return Some(found);
                    }
                }
                map.values()
                    .filter_map(|item| dig(item, depth + 1))
                    .next()
            }
            Value::Array(items) => items.iter().filter_map(|item| dig(item, depth + 1)).next(),
            _ => None,
        }
    }

    match serde_json::from_str::<Value>(raw) {
        Ok(value) => dig(&value, 0),
        Err(_) => {
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| assets::truncate(trimmed, 500))
        }
    }
}

// ---------------------------------------------------------------------------
// 网络层错误的可诊断文本
// ---------------------------------------------------------------------------

/// 把 `reqwest::Error` 展开成「外层描述 | 分类 | 成因链 | 代理提示」。
///
/// `reqwest::Error` 的 `Display` **只给最外层那一句**
/// `error sending request for url (…)` —— 究竟是 DNS 解析失败、TCP 被拒、TLS 握手
/// 失败, 还是连接被中途重置, 全在 `source()` 链里。线上直接 `{}` 打出来等于把
/// 可行动信息全丢光(报障只能看到「网络错误」, 无从下手)。这里:
///
/// - 用 reqwest 自己的分类打标签, 一眼区分「连不上」和「连上了但被掐断」;
/// - 把整条 `source()` 链拼上(OS 层原文, 含 `os error NNNN`);
/// - 带上进程环境里的代理变量 —— 同一个平台在「带代理的终端里启动」与「双击图标」
///   两种情况下走的链路完全不同, 这是最容易漏掉的一条线索。
pub fn describe_reqwest_error(error: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![error.to_string()];
    let kind = if error.is_timeout() {
        "超时"
    } else if error.is_connect() {
        "连接失败(DNS / 建连 / TLS)"
    } else if error.is_body() {
        "请求体或响应体中断"
    } else if error.is_redirect() {
        "重定向策略"
    } else if error.is_decode() {
        "响应解析"
    } else if error.is_builder() {
        "请求构造"
    } else {
        "其它"
    };
    parts.push(format!("分类: {}", kind));

    // 成因链: 从外往里走。层数设上限, 避免个别实现写出自引用链导致死循环。
    let mut cursor = std::error::Error::source(error);
    for _ in 0..8 {
        let Some(cause) = cursor else { break };
        let text = cause.to_string();
        if !text.trim().is_empty() && !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        cursor = cause.source();
    }

    if let Some(hint) = env_proxy_hint() {
        parts.push(hint);
    }
    parts.join(" | ")
}

/// 进程环境里是否有代理变量 —— 有的话 reqwest 默认会走它, 排查时必须知道。
fn env_proxy_hint() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        let Ok(value) = std::env::var(key) else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        return Some(format!(
            "进程环境有 {}={} (reqwest 默认会经它转发)",
            key,
            redact_proxy(value)
        ));
    }
    None
}

/// 打掉代理 URL 里的 `user:pass@`, 只留主机端口 —— 错误日志可能被用户贴到群/issue 里。
fn redact_proxy(value: &str) -> String {
    match value.rsplit_once('@') {
        Some((_, host)) => format!("***@{}", host),
        None => value.to_string(),
    }
}

/// 组装一条「可读 + 可分类」的 HTTP 错误。
///
/// 分类规则(与 [`fetch_json`] 同判据):
/// - 平台已给定论(内容审核/违规…) → `TaskFailed`, 不管状态码是多少;
/// - 5xx / 408 / 429 → `Provider`(可重试), 交给上层重试或下一轮轮询;
/// - 其它 4xx → `TaskFailed`, 让用户立刻看到可行动的原因。
pub fn http_error(label: &str, status: reqwest::StatusCode, raw: &str, url: &str) -> AIError {
    let reason = extract_error_reason(raw);
    let text = match reason.as_deref() {
        Some(reason) => format!("{}: HTTP {} {} ({})", label, status, reason, url),
        None => format!("{}: HTTP {} ({})", label, status, url),
    };
    let verdict = reason.as_deref().is_some_and(has_terminal_verdict);
    if is_transient_status(status) && !verdict {
        AIError::Provider(text)
    } else {
        AIError::TaskFailed(text)
    }
}

/// 提交阶段是否值得自动重试。
///
/// 只重试「平台**回过话**, 但回的是服务端抖动」这一类([`http_error`] 产出, 文案形如
/// `{label}: HTTP 503 …`): 响应已到 ⇒ 请求被处理但没完成, 重提不会凭空多出一单。
///
/// **不重试纯网络层错误** —— 请求可能已经送达并被计费, 自动重提就是二次扣费; 那种
/// 情况留给用户判断。
pub fn is_retryable_submit_failure(error: &AIError) -> bool {
    let AIError::Provider(message) = error else {
        return false;
    };
    // 状态码是从我们自己拼的文案里读回来的(`": HTTP 503 "` 这个形状由 `http_error` 保证),
    // 这样不必为了一个布尔值给 `AIError` 加变体、也不必改所有协议的调用点。
    message
        .split_once(": HTTP ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|code| code.parse::<u16>().ok())
        .and_then(|code| reqwest::StatusCode::from_u16(code).ok())
        .is_some_and(is_transient_status)
}

/// 终态判定。平台各家枚举不一致, 这里集中维护。
pub fn is_failed_status(status: &str) -> bool {
    matches!(
        status.to_ascii_uppercase().as_str(),
        "FAILED" | "FAIL" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED" | "EXPIRED" | "TIMEOUT" | "TIMED_OUT" | "ABORTED"
    )
}

/// "还在跑"的状态词。各家枚举不一致(炳火 `IN_PROGRESS` + 内层 `processing`,
/// 知鸟 `queued`, Kling `submitted`……), 一并收起。
///
/// 用途: 平台常在**仍在生成**时带一个空的失败占位字段, 也常把上游重试信息写进
/// `error`。状态已明确"进行中"时, 这些字段一律不采信 —— 一次误判就把已计费的长
/// 任务判死, 而平台还在跑, 成片永久收不回。
pub fn is_running_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_uppercase().replace([' ', '-'], "_").as_str(),
        "IN_PROGRESS"
            | "PROCESSING"
            | "PROCESS"
            | "RUNNING"
            | "QUEUED"
            | "QUEUE"
            | "PENDING"
            | "SUBMITTED"
            | "SUBMIT"
            | "GENERATING"
            | "GENERATE"
            | "IN_QUEUE"
            | "WAITING"
            | "CREATED"
            | "INIT"
            | "INITIALIZING"
            | "STARTED"
            | "NOT_START"
            | "NOT_STARTED"
            | "ACTIVE"
            | "DOING"
    )
}

/// 协议专属的轮询分派。`transport` 与 `query_url` 都来自提交时落库的元数据。
pub async fn poll(
    ctx: &PollContext,
    transport: &str,
    metadata: &serde_json::Map<String, Value>,
    handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    match transport {
        zhenjian::TRANSPORT => zhenjian::poll(ctx, metadata, handle).await,
        zzdh::TRANSPORT => zzdh::poll(ctx, metadata, handle).await,
        sub2api::TRANSPORT => sub2api::poll(ctx, metadata, handle).await,
        kling::TRANSPORT => kling::poll(ctx, metadata, handle).await,
        // WGSPAI 的族 2(Task)失败体是业务错误包 `{"code": -1, "message": "..."}`,
        // 通用归类认不出顶层 `code`, 会在 HTTP 200 的业务错误上一直判"还在跑"。
        wgspai::TRANSPORT => wgspai::poll(ctx, metadata, handle).await,
        // RunningHub 同属"HTTP 200 + 业务错误包", 但字段名是 `errorCode` 且 `status`
        // 为空串 —— 通用归类认不出, 必须走协议自己的查询。
        runninghub::TRANSPORT => runninghub::poll(ctx, metadata, handle).await,
        // 炳火查询响应形状与通用协议一致, 走统一归类即可。
        _ => {
            let payload = fetch_json(&ctx.client, &ctx.api_key, query_url_of(metadata)?, transport).await?;
            Ok(classify(&payload, handle))
        }
    }
}

fn query_url_of(metadata: &serde_json::Map<String, Value>) -> Result<&str, AIError> {
    metadata
        .get("query_url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AIError::InvalidRequest("视频任务缺少查询地址, 无法续查".into()))
}

/// 元数据里的字符串字段。
pub fn meta_string<'a>(metadata: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// GET 一个 JSON 端点, 返回解析后的 payload。
///
/// 失败语义分两档(与各协议自己的轮询实现保持一致), 别把两者混成一种:
/// - **4xx**(地址写错 / 鉴权失效, 确定性) → `AIError::TaskFailed` ⇒ 调用方把任务判失败,
///   用户立刻看到原因而不是干等;
/// - **5xx / 408 / 429 / 网络抖动**(平台侧临时) → `AIError::Provider` ⇒ 调用方保持 running
///   等下一轮重试, 否则一次 502 就会把仍在平台生成的长任务判成失败。
pub async fn fetch_json(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
    label: &str,
) -> Result<Value, AIError> {
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 查询失败(网络): {}", label, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // 判据集中在 `http_error`, 与各协议的 POST 通道共用同一条:
        // 5xx / 408 / 429 保持 running 交给下一轮(一次 502 就把仍在生成的长任务判死,
        // 用户只能重提 —— 等于我们自己制造了二次扣费); 4xx 与「平台已给定论」的否决
        // (如内容审核)直接判失败, 并带上解包后可读的原因。
        return Err(http_error(
            &format!("{} 查询失败", label),
            status,
            &raw,
            url,
        ));
    }
    match serde_json::from_str(&raw) {
        Ok(payload) => Ok(payload),
        Err(_) => {
            let lower = raw.to_ascii_lowercase();
            if lower.contains("failed")
                || lower.contains("failure")
                || lower.contains("error")
                || lower.contains("rejected")
                || lower.contains("cancelled")
                || lower.contains("canceled")
                || raw.contains("失败")
            {
                Err(AIError::TaskFailed(format!("{} 查询返回失败: {}", label, assets::truncate(&raw, 800))))
            } else {
                Err(AIError::Provider(format!("{} 查询返回了无效响应: {}", label, assets::truncate(&raw, 300))))
            }
        }
    }
}

/// 把平台响应归类成轮询结果。所有专有协议的响应形状最终都归到这里。
pub fn classify(payload: &Value, handle: &ProviderTaskHandle) -> ProviderTaskPollResult {
    if let Some(url) = OpenAICompatibleProvider::video_result_url(payload) {
        // 成功响应有时仍保留历史 task_id；只要不是明显的占位 URL，就直接回传成片。
        let lower = url.to_ascii_lowercase();
        let placeholder = lower.contains("placeholder")
            || lower.ends_with("/pending")
            || lower.ends_with("/processing");
        if OpenAICompatibleProvider::video_task_id(payload).is_none() || !placeholder {
            return ProviderTaskPollResult::Succeeded(url);
        }
    }
    let status = OpenAICompatibleProvider::video_task_status(payload);
    if is_failed_status(&status) {
        let reason = OpenAICompatibleProvider::video_failure_reason(payload).unwrap_or(status);
        return ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason));
    }
    // 平台明确说「还在跑」时, 响应里的失败字段一律不采信。
    // 炳火在 `IN_PROGRESS / progress: 30%` 时会带 `"fail_reason": ""`,
    // 只按"键存在"判定就会把正在生成的任务当场判死(实机 2026-09-23 11:17)。
    if is_running_status(&status) {
        return ProviderTaskPollResult::Running;
    }
    if OpenAICompatibleProvider::video_has_failure_signal(payload) {
        let reason = OpenAICompatibleProvider::video_failure_reason(payload)
            .unwrap_or_else(|| "平台返回失败标记".to_string());
        return ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason));
    }
    if let Some(reason) = OpenAICompatibleProvider::video_failure_reason(payload) {
        let lower = reason.to_ascii_lowercase();
        if lower.contains("fail") || lower.contains("error") || lower.contains("reject") || lower.contains("cancel") || lower.contains("timeout") || reason.contains("失败") {
            return ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason));
        }
    }
    let _ = handle;
    ProviderTaskPollResult::Running
}

/// 提交阶段共用的响应处理: 立即出片 → Succeeded; 有 task_id → 交给 queued()。
pub fn submission_from_payload(
    payload: &Value,
    provider_id: &str,
    transport: &str,
    query_url: String,
    extra_meta: Option<Value>,
) -> Result<ProviderTaskSubmission, AIError> {
    if let Some(url) = OpenAICompatibleProvider::video_result_url(payload) {
        if OpenAICompatibleProvider::video_task_id(payload).is_none() {
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }
    }
    let task_id = OpenAICompatibleProvider::video_task_id(payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "平台响应中未找到任务 ID 或视频地址: {}",
            assets::truncate(&payload.to_string(), 600)
        ))
    })?;
    Ok(queued(task_id, provider_id, transport, query_url, extra_meta))
}

/// 从 extra_params 里取字符串数组(如 `reference_videos`)。
pub fn string_array_param(request: &GenerateVideoRequest, key: &str, limit: usize) -> Vec<String> {
    request
        .extra_params
        .as_ref()
        .and_then(|params| params.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(limit)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn string_param(request: &GenerateVideoRequest, key: &str) -> String {
    request
        .extra_params
        .as_ref()
        .and_then(|params| params.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn transport_of(request: &GenerateVideoRequest) -> String {
    string_param(request, "video_transport")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata_of(submission: ProviderTaskSubmission) -> serde_json::Map<String, Value> {
        match submission {
            ProviderTaskSubmission::Queued(handle) => handle
                .metadata
                .and_then(|value| value.as_object().cloned())
                .expect("queued handle must carry metadata"),
            ProviderTaskSubmission::Succeeded(url) => panic!("expected Queued, got Succeeded({url})"),
        }
    }

    fn query_url_of(meta: &serde_json::Map<String, Value>) -> String {
        meta.get("query_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    /// 炳火 / WGSPAI 的 submit 传进来的是 `{submit_url}/{taskId}` **模板字符串**。
    /// 落库前必须换成真实任务号 —— 轮询阶段原样使用 query_url, 没有第二次替换机会。
    /// 漏了它就是「平台照跑照计费、结果永远收不回」(实机 2026-09-22 17:30 的炳火任务)。
    #[test]
    fn queued_expands_task_placeholder_from_template() {
        let meta = metadata_of(queued(
            "task_PU9iIFXKkcKuSEEg3WgDzKK".to_string(),
            "custom:炳火api",
            "binghuo-video",
            "https://api.7tai.cc/v1/video/generations/{taskId}".to_string(),
            None,
        ));
        let url = query_url_of(&meta);
        assert_eq!(
            url,
            "https://api.7tai.cc/v1/video/generations/task_PU9iIFXKkcKuSEEg3WgDzKK"
        );
        assert!(!url.contains("{taskId}"), "占位符必须被替换: {url}");
    }

    /// 已经算成绝对地址的协议(帧间 / 字子动画 / Sub2API / Kling)不能被改动。
    #[test]
    fn queued_leaves_concrete_query_url_untouched() {
        let concrete = "https://cuai.token6688.com/v1/tasks/task-1790069163126-53219";
        let meta = metadata_of(queued(
            "task-1790069163126-53219".to_string(),
            "custom:知鸟ai-23oa",
            "zhiniao-video",
            concrete.to_string(),
            None,
        ));
        assert_eq!(query_url_of(&meta), concrete);
    }

    /// 任务号里的保留字符要编码, 免得拼出非法 URL(实例里正好出现过带 `{`、`}` 的地址)。
    #[test]
    fn queued_encodes_task_id_in_placeholder() {
        let meta = metadata_of(queued(
            "a b/c?d".to_string(),
            "custom:字字动画",
            "zzdh-v8-video",
            "https://x/v8/videos/generations/{taskId}".to_string(),
            None,
        ));
        let url = query_url_of(&meta);
        assert!(url.starts_with("https://x/v8/videos/generations/"), "{url}");
        assert!(!url.contains(' '), "空格必须被编码: {url}");
        assert!(!url.contains('?'), "问号必须被编码: {url}");
        assert!(url.contains("a%20b"), "空格应编码为 %20: {url}");
    }

    /// 轮询窗口必须给足。炳火 / WGSPAI 平台侧排队久, 默认 30 分钟会把长任务误判成超时,
    /// 而这正是用户看到的「平台还在生成就报错」。
    #[test]
    fn poll_window_is_generous_enough_for_slow_platforms() {
        for transport in [
            "binghuo-video",
            "wgspai-video",
            "zhenjian-task-api",
            "kling-control",
            "sub2api-video",
            "zzdh-v8-video",
        ] {
            let minutes =
                (max_poll_attempts(transport) as u64 * poll_interval(transport).as_secs()) / 60;
            assert!(minutes >= 60, "{transport} 轮询窗口只有 {minutes} 分钟");
        }
        // 知鸟官方口径 p90 55~75 分钟, 窗口要给到 100 分钟量级。
        let zhiniao =
            (max_poll_attempts("zhiniao-video") as u64 * poll_interval("zhiniao-video").as_secs())
                / 60;
        assert!(zhiniao >= 90, "知鸟轮询窗口只有 {zhiniao} 分钟");
    }

    fn handle_of(task_id: &str) -> ProviderTaskHandle {
        ProviderTaskHandle {
            task_id: task_id.to_string(),
            metadata: None,
        }
    }

    /// 回归(2026-09-23 11:17 实机): 炳火在**仍在生成**时返回 `"fail_reason": ""`。
    /// 修前只看"键是否存在" ⇒ 第一轮就判 Failed(文案「平台返回失败标记」), 而平台当时
    /// `progress: 30%` 还在跑 ⇒ 用户看到"平台还在生成却报失败", 且成片永久收不回。
    #[test]
    fn in_progress_with_empty_fail_reason_stays_running() {
        let payload = serde_json::json!({
            "code": "success",
            "message": "",
            "data": {
                "id": 347607,
                "task_id": "task_YJrE1qDyOyFwgMVh1b3W4WPRiVJNN7AV",
                "action": "generate",
                "status": "IN_PROGRESS",
                "progress": "30%",
                "fail_reason": "",
                "finish_time": 0,
                "data": { "object": "video", "status": "processing" }
            }
        });
        assert!(matches!(
            classify(&payload, &handle_of("task_YJrE1qDyOyFwgMVh1b3W4WPRiVJNN7AV")),
            ProviderTaskPollResult::Running
        ));
    }

    /// 空占位不止一种写法: `error: ""` / `error: {}` / `error: false` 都不算失败信号。
    #[test]
    fn empty_failure_placeholders_are_not_failure_signals() {
        for payload in [
            serde_json::json!({ "status": "queued", "error": "" }),
            serde_json::json!({ "status": "queued", "error": {} }),
            serde_json::json!({ "status": "queued", "error": false }),
            serde_json::json!({ "status": "queued", "error": null }),
            serde_json::json!({ "status": "queued", "data": { "fail_reason": "  " } }),
        ] {
            assert!(
                !OpenAICompatibleProvider::video_has_failure_signal(&payload),
                "空占位被误判为失败信号: {payload}"
            );
        }
    }

    /// 反向护栏: 真的有内容时仍必须判失败(别把误判修成漏判)。
    #[test]
    fn genuine_failure_is_still_reported() {
        // 炳火真失败: 终态状态 + 非空 fail_reason
        let binghuo = serde_json::json!({
            "data": { "status": "FAILURE", "fail_reason": "上游超时" }
        });
        match classify(&binghuo, &handle_of("task-x")) {
            ProviderTaskPollResult::Failed(message) => {
                assert!(message.contains("上游超时"), "{message}")
            }
            other => panic!("应判失败, 实际 {other:?}"),
        }

        // 知鸟真失败(实机 2026-09-22 22:40 的原样报文): 终态 + 非空 error 文本
        let zhiniao = serde_json::json!({
            "created_at": "0001-01-01T00:00:00Z",
            "error": "生成失败，请稍后重试",
            "error_class": "video_task_failed",
            "id": "task-1790088056197-65125",
            "is_final": true,
            "status": "failed",
            "type": "video"
        });
        match classify(&zhiniao, &handle_of("task-y")) {
            ProviderTaskPollResult::Failed(message) => {
                assert!(message.contains("生成失败"), "{message}")
            }
            other => panic!("应判失败, 实际 {other:?}"),
        }

        // 嵌套的终态也要压过外层的"进行中"(video_task_status 先扫全部状态里的失败词)
        let nested = serde_json::json!({
            "status": "IN_PROGRESS",
            "data": { "status": "FAILED", "fail_reason": "上游拒绝" }
        });
        assert!(matches!(
            classify(&nested, &handle_of("task-z")),
            ProviderTaskPollResult::Failed(_)
        ));
    }

    /// 有意为之的取舍: 状态明确"进行中"时, 即使响应里带了非空 error 文本也**保持 Running**。
    /// 代价是多轮询几轮(窗口 100 分钟兜底); 收益是不会误杀已计费的长任务 ——
    /// 误杀的代价是钱和成片一起丢, 而干等只是晚一点看到结果。
    #[test]
    fn running_status_outranks_stray_error_text() {
        let payload = serde_json::json!({
            "status": "IN_PROGRESS",
            "progress": "30%",
            "error": "upstream retry scheduled"
        });
        assert!(matches!(
            classify(&payload, &handle_of("task-w")),
            ProviderTaskPollResult::Running
        ));
    }

    /// 状态词表要认得各家的"进行中"写法。
    #[test]
    fn running_status_words_are_recognized() {
        for status in ["IN_PROGRESS", "in_progress", "In Progress", "PROCESSING", "queued", "SUBMITTED"] {
            assert!(is_running_status(status), "{status} 应判为进行中");
        }
        for status in ["FAILED", "succeeded", "", "EXPIRED"] {
            assert!(!is_running_status(status), "{status} 不应判为进行中");
        }
    }

    // ---- 提交失败分类(实机 2026-09-23 炳火 13:49 / 13:51 原始报文) ----

    /// 上游内容审核拒绝 —— 被平台包成 HTTP 500 + `fail_to_fetch_task`。
    const BINGHUO_MODERATION_BODY: &str = r#"{"code":"fail_to_fetch_task","message":"{\"ok\":false,\"error\":\"视频生成失败：参考素材或提示词触发了上游内容审核，请更换素材 / 调整描述后重试。\"}","data":null}"#;

    /// 平台侧暂时不可用 —— HTTP 503, 报文里明确写着「请稍后重试」。
    const BINGHUO_BUSY_BODY: &str = r#"{"code":"fail_to_fetch_task","message":"{\"ok\":false,\"error\":\"视频生成失败：服务暂时不可用，请稍后重试 (request id: 202609230549581963163068268d9d6nUcRjHO3): code : public_model_request_failed\"}","data":null}"#;

    /// 内容审核是**终态**: 重试一万次也是同一个结果, 且文案必须能读 ——
    /// 用户要看到的是「换素材」这个可行动的结论, 不是一坨转义字符。
    #[test]
    fn moderation_verdict_is_terminal_even_on_5xx() {
        let error = http_error(
            "炳火 API 视频请求失败",
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            BINGHUO_MODERATION_BODY,
            "https://api.7tai.cc/v1/video/generations",
        );
        match &error {
            AIError::TaskFailed(message) => {
                assert!(
                    message.contains("参考素材或提示词触发了上游内容审核"),
                    "应带上解包后可读的原因: {message}"
                );
                assert!(
                    !message.contains("fail_to_fetch_task") && !message.contains(r#"\""#),
                    "不该把平台原始信封/转义字符丢给用户: {message}"
                );
            }
            other => panic!("内容审核应判终态, 实际 {other:?}"),
        }
        assert!(
            !is_retryable_submit_failure(&error),
            "已给定论的内容审核不该自动重试"
        );
    }

    /// HTTP 503 +「请稍后重试」是**平台侧抖动**: 一次抖动不该把任务判死, 应当自动重试。
    /// 修之前 `http_error` 对任何非 2xx 都返回 `TaskFailed`, 提交侧当场落 failed。
    #[test]
    fn transient_5xx_is_retryable() {
        let error = http_error(
            "炳火 API 视频请求失败",
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            BINGHUO_BUSY_BODY,
            "https://api.7tai.cc/v1/video/generations",
        );
        assert!(matches!(error, AIError::Provider(_)), "{error:?}");
        assert!(is_retryable_submit_failure(&error), "{error}");
        assert!(error.to_string().contains("服务暂时不可用"), "{error}");
    }

    /// 4xx 是确定性错误(鉴权/参数), 判终态且不重试。
    #[test]
    fn client_error_is_terminal_and_not_retried() {
        let error = http_error(
            "炳火 API 视频请求失败",
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"invalid api key"}}"#,
            "https://api.7tai.cc/v1/video/generations",
        );
        assert!(matches!(error, AIError::TaskFailed(_)), "{error:?}");
        assert!(!is_retryable_submit_failure(&error), "{error}");
        assert!(error.to_string().contains("invalid api key"), "{error}");
    }

    /// **纯网络层错误不自动重提**: 请求可能已经送达并被计费, 自动重提就是二次扣费。
    #[test]
    fn network_errors_are_not_auto_retried() {
        let error = AIError::Provider(
            "炳火 API 视频提交失败(网络): error sending request for url (https://api.7tai.cc/v1/video/generations)"
                .to_string(),
        );
        assert!(!is_retryable_submit_failure(&error));
    }

    #[test]
    fn error_reason_is_unwrapped_from_nested_json() {
        assert_eq!(
            extract_error_reason(BINGHUO_MODERATION_BODY).as_deref(),
            Some("参考素材或提示词触发了上游内容审核，请更换素材 / 调整描述后重试。")
        );
        assert_eq!(
            extract_error_reason("Bad Gateway").as_deref(),
            Some("Bad Gateway")
        );
        assert_eq!(extract_error_reason(""), None);
        assert_eq!(
            extract_error_reason(r#"[{"error":"boom"}]"#).as_deref(),
            Some("boom")
        );
    }

    /// 状态码分类必须与 `fetch_json` 同判据, 否则两条通道会给出相反结论。
    #[test]
    fn status_classification_matches_fetch_json() {
        for status in [500u16, 502, 503, 504, 408, 429] {
            assert!(
                is_transient_status(reqwest::StatusCode::from_u16(status).unwrap()),
                "{status} 应判为平台侧抖动"
            );
        }
        for status in [200u16, 400, 401, 402, 403, 404, 413, 422] {
            assert!(
                !is_transient_status(reqwest::StatusCode::from_u16(status).unwrap()),
                "{status} 不应判为平台侧抖动"
            );
        }
    }

    /// 素材上传失败(网络)的消息形状同样不能落进「可自动重提」的判据 —— 那会绕过
    /// 「不重提可能已计费请求」的保护(上传重试只允许发生在 [`assets`] 内部)。
    #[test]
    fn upload_network_failure_is_not_treated_as_retryable_submit() {
        let error = AIError::Provider(
            "炳火 API 参考素材上传失败(网络): 已重试 2 次仍未成功 — error sending request for url (https://api.7tai.cc/v1/assets/uploads) | 分类: 连接失败(DNS / 建连 / TLS)"
                .to_string(),
        );
        assert!(!is_retryable_submit_failure(&error));
    }

    /// `describe_reqwest_error` 必须把成因链带出来: 只有外层那句
    /// `error sending request for url (…)` 的话, 报障时根本分不清是 DNS、建连
    /// 还是 TLS 出问题(本次线上「炳火上传失败」就是栽在这里)。
    #[tokio::test]
    async fn network_error_description_keeps_root_cause() {
        // `.invalid` 是 RFC 2606 保留后缀, 永远解析不到 —— 必然得到 DNS 类错误,
        // 不依赖任何外部服务。no_proxy 是刻意的: 本机若带环境代理(沙箱/终端启动),
        // 否则这条断言测的就不是本机的解析行为了。
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("client")
            .post("http://upload.invalid/v1/assets/uploads")
            .send()
            .await
            .expect_err("upload.invalid 不应可解析");
        let described = describe_reqwest_error(&error);
        println!("{described}");
        assert!(described.contains("分类: "), "{described}");
        // 「外层 | 分类 | 成因」至少三段, 说明 source() 链确实被拼上了。
        assert!(described.split(" | ").count() >= 3, "{described}");
        assert!(described.len() > error.to_string().len(), "{described}");
    }

    /// 代理变量可能带账号密码, 而错误日志常被用户贴进群或 issue —— 必须打码。
    #[test]
    fn proxy_credentials_are_redacted() {
        assert_eq!(
            redact_proxy("http://user:secret@127.0.0.1:7890"),
            "***@127.0.0.1:7890"
        );
        assert_eq!(redact_proxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
    }
}
