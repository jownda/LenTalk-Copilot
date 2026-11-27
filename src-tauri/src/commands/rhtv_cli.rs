//! RunningHub 画布 CLI（`rhtvcli`）桥接。
//!
//! 与官方标准模型 API 的 CLI（`rh`，见 `runninghub_cli.rs`）不同，`rhtvcli` 连的是
//! **画布**（rhTV / canvas-api）。画布目录比标准模型 API 更全（例如 `Minimax-H3-RH-Enhanced`
//! 这类 RH 自研增强模型只在画布里有），所以这里把它当模型来源。
//!
//! 三条硬约束（都来自官方 0.7.1 的 USAGE.md，实测验证过）：
//! 1. 模型目录与参数 schema **由服务端实时返回**（`model search` / `model CODE`），
//!    所以前端不能硬编码模型清单，也不能猜参数名 —— 猜错服务端只回 `INVALID_ARGUMENT`。
//! 2. 生成是**节点语义**：先在某个画布里建节点，再运行、再取产物。没有"一次 POST 出图"，
//!    因此本模块自己维护一个 LenTalk 专用画布（首次自动创建，ID 落盘复用）。
//! 3. 登录态由 CLI 自己维护（浏览器授权 + 系统钥匙串），这里只做只读探测，不碰凭据。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 安装后的共享入口名（`~/.runninghub-canvas/bin/rhtvcli`）。
const DEFAULT_EXECUTABLE: &str = "rhtvcli";

/// LenTalk 专用画布的名字。用户能在网站上看到它，所以要能一眼认出来。
const CANVAS_NAME: &str = "LenTalk";

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(20);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(40);
const WRITE_TIMEOUT: Duration = Duration::from_secs(90);
const RUN_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvCliStatus {
    pub found: bool,
    pub executable: String,
    pub resolved_path: Option<String>,
    /// `0.7.1` 这类纯版本号；探测失败为 None。
    pub version: Option<String>,
    pub logged_in: bool,
    pub user_id: Option<String>,
    pub canvas_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvGenerateRequest {
    pub executable: Option<String>,
    /// 画布模型编码（`text-video-rhart-video-minimax-h3-rh-enhanced-t2va-app` 这类），
    /// 由目录接口返回，**不是**标准模型 API 的 endpoint。
    pub model: String,
    pub prompt: Option<String>,
    /// `KEY=VALUE` 形式的模型参数（来自前端按 schema 渲染的控件）。
    pub params: Option<Vec<String>>,
    /// 参考图的本地绝对路径（画布只认上传后的媒体节点，不认外链）。
    pub images: Option<Vec<String>>,
    /// image / video / audio。
    pub kind: String,
    pub timeout_seconds: Option<u64>,
}

// ---------------------------------------------------------------- 进程调用

#[cfg(windows)]
fn apply_executable(command: &mut Command, exe: &Path) {
    // 官方在 Windows 上装出来是 `rhtvcli.cmd`，直接 spawn 会报「不是有效的 Win32 应用」。
    let is_cmd = exe
        .extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_ascii_lowercase();
            ext == "cmd" || ext == "bat"
        })
        .unwrap_or(false);
    if is_cmd {
        command.env("RHTVCLI_TARGET", exe);
        command.arg("/C").arg(exe);
    }
}

#[cfg(not(windows))]
fn apply_executable(command: &mut Command, exe: &Path) {
    command.arg(exe);
}

fn command_file_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat") {
            return vec![name.to_string()];
        }
        return vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            format!("{name}.bat"),
            name.to_string(),
        ];
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

/// PATH 之外唯一需要显式探测的位置：官方 bootstrap 的固定安装目录。
fn install_locations() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(&home).join(".runninghub-canvas").join("bin"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        roots.push(PathBuf::from(&profile).join(".runninghub-canvas").join("bin"));
    }
    roots
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for file_name in command_file_names(name) {
            let candidate = directory.join(&file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 设置项（可为绝对路径）→ PATH → 官方安装目录。返回第一个真实存在的文件。
fn resolve_executable(requested: Option<&str>) -> Option<PathBuf> {
    let requested = requested.unwrap_or(DEFAULT_EXECUTABLE).trim().trim_matches(['"', '\'']);
    let name = if requested.is_empty() { DEFAULT_EXECUTABLE } else { requested };

    if name.contains('/') || name.contains('\\') {
        let path = PathBuf::from(name);
        return path.is_file().then_some(path);
    }
    if let Some(found) = find_in_path(name) {
        return Some(found);
    }
    install_locations()
        .into_iter()
        .flat_map(|root| command_file_names(name).into_iter().map(move |file| root.join(file)))
        .find(|candidate| candidate.is_file())
}

struct CliOutput {
    /// stdout 里所有能解析成 JSON 的行。业务命令默认直接输出对象，写命令是 NDJSON 多行。
    values: Vec<Value>,
    stdout: String,
    stderr: String,
}

impl CliOutput {
    fn first_error(&self) -> Option<String> {
        self.values.iter().find_map(|value| {
            let error = value.get("error")?;
            let code = error.get("code").and_then(Value::as_str).unwrap_or("UNKNOWN");
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            Some(if message.is_empty() {
                code.to_string()
            } else {
                format!("{code}: {message}")
            })
        })
    }
}

fn run_cli_once(exe: &Path, args: &[String], timeout: Duration) -> Result<CliOutput, String> {
    let mut command = Command::new(exe);
    apply_executable(&mut command, exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 rhtvcli（{}）: {error}", exe.display()))?;
    let mut stdout = child.stdout.take().ok_or("rhtvcli stdout 不可用")?;
    let mut stderr = child.stderr.take().ok_or("rhtvcli stderr 不可用")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stdout.read_to_string(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stderr.read_to_string(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => return Err(format!("等待 rhtvcli 失败: {error}")),
        }
    }

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if timed_out {
        return Err(format!(
            "rhtvcli 超时（{}s）。{}",
            timeout.as_secs(),
            tail(&stderr)
        ));
    }

    let values: Vec<Value> = stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with('{') && !line.starts_with('[') {
                return None;
            }
            serde_json::from_str::<Value>(line).ok()
        })
        .collect();

    Ok(CliOutput { values, stdout, stderr })
}

/// 全局串行锁。
///
/// `rhtvcli` 自己有一把**本机单实例锁**：第二个进程会立刻拿到
/// `{"error":{"code":"LOCAL_BUSY","retryAfterSeconds":3}}`，而不是排队。
/// 所以同一时刻只允许一个调用出去 —— 否则"后台同步模型参数"和"用户点生成"
/// 会互相打断，表现为随机失败，很难归因。
static CLI_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn acquire_cli_lock(timeout: Duration) -> Option<std::sync::MutexGuard<'static, ()>> {
    let deadline = Instant::now() + timeout;
    loop {
        match CLI_LOCK.try_lock() {
            Ok(guard) => return Some(guard),
            // 持锁线程 panic 不该让画布功能永久瘫痪，取回内部值继续用。
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        }
    }
}

/// 从 `LOCAL_BUSY` 响应里取建议等待秒数。
fn local_busy_wait(output: &CliOutput) -> Option<u64> {
    output.values.iter().find_map(|value| {
        let error = value.get("error")?;
        if error.get("code").and_then(Value::as_str) != Some("LOCAL_BUSY") {
            return None;
        }
        Some(
            error
                .get("retryAfterSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .clamp(1, 15),
        )
    })
}

/// 从运行结果里挖出失败原因。
///
/// 画布把"余额不足 / 内容不合规 / 上游报错"这类真因放在 `errorMessage`（有时还藏进
/// `plans[].outputs[].errorMessage`），顶层没有 `error` 对象。只看 `first_error()`
/// 会把它们丢掉，最后只报一句"节点没有产出媒体 URL"，用户完全不知道要充值。
fn failure_reason(value: &Value) -> Option<String> {
    if let Some(message) = pick_str(value, &["errorMessage", "error_message", "failReason"]) {
        return Some(message);
    }
    if value.get("status").and_then(Value::as_str) == Some("FAILED") {
        if let Some(message) = pick_str(value, &["message", "reason"]) {
            return Some(message);
        }
    }
    for key in ["plans", "outputs", "items"] {
        let Some(Value::Array(items)) = value.get(key) else {
            continue;
        };
        for item in items {
            if let Some(message) = failure_reason(item) {
                return Some(message);
            }
        }
    }
    None
}

fn first_failure(output: &CliOutput) -> Option<String> {
    output.values.iter().find_map(failure_reason)
}

/// 带排队与重试的调用入口。
fn run_cli(exe: &Path, args: &[String], timeout: Duration) -> Result<CliOutput, String> {
    // 等锁不超过调用本身的上限，否则探测类命令会在长任务后面挂几分钟。
    let lock_wait = timeout.min(Duration::from_secs(45));
    let mut attempt = 0;
    loop {
        let guard = acquire_cli_lock(lock_wait)
            .ok_or_else(|| "画布客户端正忙（另一个任务尚未结束），请稍后重试".to_string())?;
        let output = run_cli_once(exe, args, timeout)?;
        if let Some(wait) = local_busy_wait(&output) {
            // 我们自己已经串行化了，还拿到 LOCAL_BUSY 说明有外部进程（用户手动跑的 CLI）。
            drop(guard);
            attempt += 1;
            if attempt > 3 {
                return Ok(output);
            }
            std::thread::sleep(Duration::from_secs(wait));
            continue;
        }
        return Ok(output);
    }
}

fn tail(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars.len().saturating_sub(300);
    chars[start..].iter().collect()
}

fn cli_error(output: &CliOutput) -> String {
    if let Some(error) = output.first_error() {
        return error;
    }
    let text = tail(&output.stderr);
    if text.is_empty() {
        tail(&output.stdout)
    } else {
        text
    }
}

fn args_of(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

// ---------------------------------------------------------------- 状态文件

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    Ok(dir.join("rhtv-canvas.json"))
}

fn read_canvas_id(app: &AppHandle) -> Option<String> {
    let path = state_path(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("canvasId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| !id.trim().is_empty())
}

fn write_canvas_id(app: &AppHandle, canvas_id: &str) -> Result<(), String> {
    let path = state_path(app)?;
    let body = json!({ "canvasId": canvas_id });
    std::fs::write(
        path,
        serde_json::to_string_pretty(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("无法写入画布状态: {error}"))
}

/// 画布 `create` 要求 UUIDv7。项目只引了 uuid 的 v4 feature，这里按 RFC 9562 布局
/// 用 v4 的随机字节补位：前 48 位换成毫秒时间戳，版本位写 7，变体位写 10。
fn uuid_v7() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut bytes = *uuid::Uuid::new_v4().as_bytes();
    for (index, byte) in bytes.iter_mut().take(6).enumerate() {
        *byte = (millis >> (8 * (5 - index))) as u8;
    }
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// 取一个字段（兼容 snake_case / camelCase 两种写法）。
fn pick<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn pick_str(value: &Value, keys: &[&str]) -> Option<String> {
    pick(value, keys)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn rhtv_cli_status(app: AppHandle, executable: Option<String>) -> RhtvCliStatus {
    let raw = executable
        .clone()
        .unwrap_or_else(|| DEFAULT_EXECUTABLE.to_string());
    let Some(path) = resolve_executable(executable.as_deref()) else {
        return RhtvCliStatus {
            found: false,
            executable: raw,
            resolved_path: None,
            version: None,
            logged_in: false,
            user_id: None,
            canvas_id: read_canvas_id(&app),
            message: "未找到 rhtvcli。需要先运行 RunningHub 画布客户端安装包（bootstrap）。".into(),
        };
    };

    let version = run_cli(&path, &args_of(&["--version"]), VERSION_TIMEOUT)
        .ok()
        .and_then(|output| {
            // `--version` 是文本命令：`rhtvcli 0.7.1`
            output
                .stdout
                .split_whitespace()
                .last()
                .map(str::to_string)
        });

    let account = run_cli(
        &path,
        &args_of(&["--json", "account"]),
        ACCOUNT_TIMEOUT,
    );
    let (logged_in, user_id, message) = match account {
        Ok(output) => {
            let data = output
                .values
                .iter()
                .find_map(|value| value.get("data"))
                .cloned()
                .unwrap_or(Value::Null);
            let user_id = data
                .get("actor")
                .and_then(|actor| actor.get("userId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let ok = data.is_object() || output.values.iter().any(|v| v["ok"] == json!(true));
            if ok {
                (true, user_id, "已授权".to_string())
            } else {
                (
                    false,
                    None,
                    format!("未授权：{}", cli_error(&output)),
                )
            }
        }
        Err(error) => (false, None, format!("账号探测失败：{error}")),
    };

    RhtvCliStatus {
        found: true,
        executable: raw,
        resolved_path: Some(path.to_string_lossy().to_string()),
        version,
        logged_in,
        user_id,
        canvas_id: read_canvas_id(&app),
        message,
    }
}

#[tauri::command]
pub fn rhtv_cli_account(executable: Option<String>) -> Result<Value, String> {
    let path = resolve_executable(executable.as_deref()).ok_or("未找到 rhtvcli")?;
    let output = run_cli(&path, &args_of(&["--json", "account"]), ACCOUNT_TIMEOUT)?;
    if let Some(error) = output.first_error() {
        return Err(error);
    }
    Ok(output
        .values
        .into_iter()
        .find(|value| value.get("data").is_some())
        .unwrap_or(Value::Null))
}

/// 画布模型目录。`kind` = image|video|audio|text，`query` 为关键词（空则全量）。
/// 原样返回 CLI 的 `{items:[…]}` —— 字段（modelCode/name/buckets/schemaHash）由服务端定义，
/// 前端只做展示映射，不在这里重建模型。
#[tauri::command]
pub fn rhtv_cli_models(
    executable: Option<String>,
    kind: Option<String>,
    query: Option<String>,
) -> Result<Value, String> {
    let path = resolve_executable(executable.as_deref()).ok_or("未找到 rhtvcli")?;
    let mut args = args_of(&["model", "search"]);
    let trimmed_query = query.unwrap_or_default().trim().to_string();
    if !trimmed_query.is_empty() {
        args.push(trimmed_query);
    }
    if let Some(kind) = kind.filter(|kind| !kind.trim().is_empty()) {
        args.push("--type".into());
        args.push(kind);
    }
    args.push("--all".into());

    let output = run_cli(&path, &args, CATALOG_TIMEOUT)?;
    if let Some(error) = output.first_error() {
        return Err(error);
    }
    let mut items: Vec<Value> = Vec::new();
    for value in &output.values {
        if let Some(list) = value.get("items").and_then(Value::as_array) {
            items.extend(list.iter().cloned());
        }
    }
    Ok(json!({ "items": items }))
}

/// 单个模型的实时 schema。生成前必须用它过滤参数：字段名/枚举不匹配时服务端只回
/// `INVALID_ARGUMENT`，不会告诉你哪个字段错了。
#[tauri::command]
pub fn rhtv_cli_model(
    executable: Option<String>,
    model: String,
    kind: Option<String>,
) -> Result<Value, String> {
    let path = resolve_executable(executable.as_deref()).ok_or("未找到 rhtvcli")?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型编码不能为空".into());
    }
    let mut args = args_of(&["model", model.as_str()]);
    if let Some(kind) = kind.filter(|kind| !kind.trim().is_empty()) {
        args.push("--type".into());
        args.push(kind);
    }
    let output = run_cli(&path, &args, CATALOG_TIMEOUT)?;
    if let Some(error) = output.first_error() {
        return Err(error);
    }
    Ok(output
        .values
        .into_iter()
        .find(|value| value.get("modelCode").is_some())
        .unwrap_or(Value::Null))
}

// ---------------------------------------------------------------- 参数描述

/// 一个可选项。`is_auto` 为真表示"不传这个字段，交给服务端自适应"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvParamOption {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub is_auto: bool,
}

/// 前端按这个结构渲染控件，生成时把 `key=value` 原样交给 `-s/--set`。
///
/// 为什么要归一化：服务端给的是两份互补的数据 —— `schema.properties` 是**权威的参数名
/// 清单**（含类型/枚举/区间），`config[]` 是**界面形态**（标题、顺序、`required`）。
/// 两者字段名对不齐（`config[].paramName` 对 `whAspectRatio` 这类组合控件是 null），
/// 直接拿任一份都会漏字段，所以在这里合并成一份。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvParamSpec {
    /// 真正写进 `-s key=value` 的字段名。
    pub key: String,
    /// 控件形态：prompt / text / select / toggle / number / slider / aspect / resolution / media。
    pub control: String,
    /// 语义槽位：prompt / aspectRatio / resolution / duration / count / other。
    /// 前端按这个把"比例/分辨率/时长"三个通用概念映射到各模型自己的字段名上。
    pub semantic: String,
    pub title: String,
    pub required: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub display: bool,
    pub default_value: Option<String>,
    pub options: Vec<RhtvParamOption>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub max_length: Option<u64>,
    /// 组合控件（`whAspectRatio` / `whResolution`）：CLI 会自己换算成 width/height，
    /// 前端照常传原值即可，不要再去写 width。
    pub composite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvModelRef {
    pub model: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhtvModelParams {
    pub model: String,
    pub kind: Option<String>,
    pub params: Vec<RhtvParamSpec>,
    pub error: Option<String>,
}

fn pick_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        match value.get(*key) {
            Some(Value::Number(number)) => {
                if let Some(text) = number.as_f64() {
                    return Some(text);
                }
            }
            // 服务端偶尔把数值写成字符串。
            Some(Value::String(text)) => {
                if let Ok(parsed) = text.trim().parse::<f64>() {
                    return Some(parsed);
                }
            }
            _ => {}
        }
    }
    None
}

fn pick_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    pick_f64(value, keys).filter(|number| *number >= 0.0).map(|number| number as u64)
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// 选项列表统一成 `{value,label,isAuto}`。字符串选项（`["1K","2K"]`）和对象选项
/// （`{value,labelCn}`）两种写法服务端都在用。
fn normalize_options(raw: Option<&Value>) -> Vec<RhtvParamOption> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut options = Vec::new();
    for item in items {
        match item {
            Value::String(text) => options.push(RhtvParamOption {
                value: text.clone(),
                label: text.clone(),
                is_auto: false,
            }),
            Value::Number(number) => options.push(RhtvParamOption {
                value: number.to_string(),
                label: number.to_string(),
                is_auto: false,
            }),
            Value::Object(map) => {
                let is_auto = map.get("isAuto").and_then(Value::as_bool).unwrap_or(false);
                let value = pick_str(item, &["value", "labelCn", "labelEn"]).unwrap_or_default();
                let label = pick_str(item, &["labelCn", "labelEn", "value"]).unwrap_or_else(|| {
                    if is_auto {
                        "自动".to_string()
                    } else {
                        value.clone()
                    }
                });
                // `{value:null,isAuto:true}` 表示"不传该字段"，用空 value 表达。
                let value = if value == "null" { String::new() } else { value };
                options.push(RhtvParamOption {
                    value,
                    label,
                    is_auto: is_auto || map.get("isAuto").map(Value::is_null).unwrap_or(false),
                });
            }
            _ => {}
        }
    }
    options
}

fn semantic_of(key: &str, kind: &str) -> &'static str {
    let kind_lower = kind.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    if kind_lower.contains("aspect") || key_lower.contains("aspect") {
        return "aspectRatio";
    }
    if kind_lower.contains("resolution") || key_lower.contains("resolution") {
        return "resolution";
    }
    if key_lower.contains("duration") || key_lower == "length" {
        return "duration";
    }
    if key_lower == "prompt" {
        return "prompt";
    }
    if key_lower == "count" || key_lower == "num" || key_lower.contains("quantity") {
        return "count";
    }
    "other"
}

fn control_of(kind: &str) -> &'static str {
    match kind.to_ascii_lowercase().as_str() {
        "prompt" => "prompt",
        "aspectratio" | "whaspectratio" | "ratio" | "whratio" => "aspect",
        "resolution" | "whresolution" => "resolution",
        "slider" => "slider",
        "list" | "select" | "enum" => "select",
        "boolean" | "bool" | "switch" => "toggle",
        "int" | "integer" | "number" | "float" | "long" => "number",
        "media" | "image" | "images" | "video" | "file" | "audio" => "media",
        _ => "text",
    }
}

/// 合并 `schema.properties` 与 `config[]`，产出前端可直接渲染的参数清单。
fn params_from_schema(detail: &Value) -> Vec<RhtvParamSpec> {
    let properties = detail
        .get("schema")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object);
    let configs: Vec<&Value> = detail
        .get("config")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();

    let is_legal = |key: &str| -> bool {
        match properties {
            Some(map) => map.contains_key(key),
            // 拿不到 properties 时退化为「config 里声明过 paramName 的字段」。
            None => configs
                .iter()
                .any(|config| pick_str(config, &["paramName"]).as_deref() == Some(key)),
        }
    };

    let mut specs: Vec<RhtvParamSpec> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for config in &configs {
        let config_type = pick_str(config, &["type"]).unwrap_or_default();
        // `whAspectRatio` / `whResolution` 的 paramName 是 null，字段名就等于控件类型名。
        let key = pick_str(config, &["paramName"])
            .or_else(|| {
                let lower = config_type.to_ascii_lowercase();
                if lower.starts_with("wh") {
                    Some(config_type.clone())
                } else {
                    None
                }
            })
            .unwrap_or_default();
        if key.is_empty() || !is_legal(&key) || seen.iter().any(|item| item == &key) {
            continue;
        }

        let property = properties.and_then(|map| map.get(&key));
        let kind = property
            .and_then(|value| pick_str(value, &["kind"]))
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| config_type.clone());
        let title = pick_str(config, &["title"])
            .or_else(|| property.and_then(|value| pick_str(value, &["title"])))
            .unwrap_or_else(|| key.clone());
        let display = match config.get("display") {
            Some(Value::Bool(flag)) => *flag,
            // `display` 也可能是给界面的提示对象，存在即展示。
            Some(Value::Object(_)) => true,
            _ => true,
        };
        let default_value = scalar_text(config.get("paramValue"))
            .or_else(|| property.and_then(|value| scalar_text(value.get("default"))));
        let options = normalize_options(property.and_then(|value| value.get("options")))
            .into_iter()
            .chain(
                // properties 没给 options 时用控件里的（seedream 的 whAspectRatio 就是这种）。
                if property.and_then(|value| value.get("options")).is_none() {
                    normalize_options(config.get("optionValue"))
                } else {
                    Vec::new()
                },
            )
            .collect::<Vec<_>>();

        seen.push(key.clone());
        specs.push(RhtvParamSpec {
            control: control_of(&kind).to_string(),
            semantic: semantic_of(&key, &kind).to_string(),
            composite: kind.to_ascii_lowercase().starts_with("wh"),
            title,
            required: config
                .get("required")
                .and_then(Value::as_bool)
                .or_else(|| property.and_then(|value| value.get("required")).and_then(Value::as_bool))
                .unwrap_or(false),
            display,
            default_value,
            options,
            min: pick_f64(config, &["min"])
                .or_else(|| property.and_then(|value| pick_f64(value, &["min"]))),
            max: pick_f64(config, &["max"])
                .or_else(|| property.and_then(|value| pick_f64(value, &["max"]))),
            step: pick_f64(config, &["step"])
                .or_else(|| property.and_then(|value| pick_f64(value, &["step", "multipleOf"]))),
            max_length: pick_u64(config, &["maxLength"])
                .or_else(|| property.and_then(|value| pick_u64(value, &["maxLength"]))),
            key,
        });
    }

    // 合法但界面上没登记的参数也要能填，否则"模型全面"会漏掉高级字段。
    if let Some(map) = properties {
        for (key, property) in map {
            if seen.iter().any(|item| item == key) {
                continue;
            }
            let kind = pick_str(property, &["kind"]).unwrap_or_else(|| {
                pick_str(property, &["type"]).unwrap_or_else(|| "string".to_string())
            });
            specs.push(RhtvParamSpec {
                key: key.clone(),
                control: control_of(&kind).to_string(),
                semantic: semantic_of(key, &kind).to_string(),
                title: key.clone(),
                required: property
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                display: true,
                default_value: scalar_text(property.get("default")),
                options: normalize_options(property.get("options")),
                min: pick_f64(property, &["min"]),
                max: pick_f64(property, &["max"]),
                step: pick_f64(property, &["step", "multipleOf"]),
                max_length: pick_u64(property, &["maxLength"]),
                composite: false,
            });
        }
    }

    // 提示词永远排第一个，其余保持界面顺序。
    specs.sort_by_key(|spec| if spec.semantic == "prompt" { 0 } else { 1 });
    specs
}

/// 批量取参数清单。
///
/// 为什么不是前端循环调用：目录有 140 个模型，逐个 IPC + 逐个进程会让首屏等好几分钟。
///
/// 为什么**串行**：CLI 有本机单实例锁，并发调用只会拿到 `LOCAL_BUSY`（实测 4 路并发时
/// 3 个失败）。所以这里一个接一个跑，把"并发"换算成一次 IPC 省下的往返开销即可。
/// 单个模型约 0.5–1 秒，100 个模型首屏几十秒；结果由前端按 `schemaHash` 缓存，
/// 只在画布上新或改参数时才会重来。
#[tauri::command]
pub fn rhtv_cli_model_params_batch(
    executable: Option<String>,
    models: Vec<RhtvModelRef>,
) -> Result<Vec<RhtvModelParams>, String> {
    let path = resolve_executable(executable.as_deref()).ok_or("未找到 rhtvcli")?;
    let mut results = Vec::new();
    for item in models.into_iter().filter(|item| !item.model.trim().is_empty()) {
        let mut args = args_of(&["model", item.model.trim()]);
        if let Some(kind) = item.kind.as_deref().filter(|kind| !kind.trim().is_empty()) {
            args.push("--type".to_string());
            args.push(kind.to_string());
        }
        let entry = match run_cli(&path, &args, CATALOG_TIMEOUT) {
            Ok(output) => match output.first_error() {
                Some(error) => RhtvModelParams {
                    model: item.model.clone(),
                    kind: item.kind.clone(),
                    params: Vec::new(),
                    error: Some(error),
                },
                None => {
                    let detail = output
                        .values
                        .into_iter()
                        .find(|value| value.get("modelCode").is_some())
                        .unwrap_or(Value::Null);
                    RhtvModelParams {
                        model: item.model.clone(),
                        kind: item.kind.clone(),
                        params: params_from_schema(&detail),
                        error: None,
                    }
                }
            },
            Err(error) => RhtvModelParams {
                model: item.model.clone(),
                kind: item.kind.clone(),
                params: Vec::new(),
                error: Some(error),
            },
        };
        results.push(entry);
    }
    Ok(results)
}

#[tauri::command]
pub fn rhtv_cli_forget_canvas(app: AppHandle) -> Result<(), String> {
    let path = state_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("无法清除画布绑定: {error}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- 生成

fn ensure_canvas(exe: &Path, app: &AppHandle) -> Result<String, String> {
    if let Some(canvas_id) = read_canvas_id(app) {
        return Ok(canvas_id);
    }

    let payload = json!({
        "operationId": uuid_v7(),
        "name": CANVAS_NAME,
        "billingScope": { "type": "personal" },
    });
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    let input_path = dir.join("rhtv-create-canvas.json");
    std::fs::write(
        &input_path,
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("无法写入画布创建请求: {error}"))?;

    let input = input_path.to_string_lossy().to_string();
    let output = run_cli(
        exe,
        &args_of(&["create", "--input-file", input.as_str()]),
        WRITE_TIMEOUT,
    )?;
    if let Some(error) = output.first_error() {
        return Err(format!("创建 LenTalk 画布失败：{error}"));
    }
    let canvas_id = output
        .values
        .iter()
        .find_map(|value| pick_str(value, &["canvasId", "canvas_id"]))
        .ok_or_else(|| format!("创建画布未返回 ID：{}", tail(&output.stdout)))?;
    write_canvas_id(app, &canvas_id)?;
    Ok(canvas_id)
}

/// 从任意层级里挑第一个像媒体资源的 URL。`node outputs` 的字段结构会随节点类型变化，
/// 与其逐字段适配，不如按"URL + 扩展名"兜底 —— 这也是官方文档里唯一稳定的约定。
fn find_media_url(value: &Value) -> Option<String> {
    const EXTENSIONS: [&str; 8] = [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".mp3", ".wav"];
    match value {
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            if lower.starts_with("http") && EXTENSIONS.iter().any(|ext| lower.contains(ext)) {
                Some(text.clone())
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().find_map(find_media_url),
        Value::Object(map) => map.values().find_map(find_media_url),
        _ => None,
    }
}

/// 可以安全发给服务端的字段名。
///
/// 以 `schema.properties` 为准：`config[].paramName` 对 `whAspectRatio` / `whResolution`
/// 这类组合控件是 null，只看 config 会把「比例」「分辨率」整个漏掉（seedream 全系如此），
/// 用户选的比例就被静默丢弃了。
#[allow(dead_code)]
fn schema_param_names(schema: &Value) -> Vec<String> {
    let from_properties: Vec<String> = schema
        .get("schema")
        .and_then(|inner| inner.get("properties"))
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    if !from_properties.is_empty() {
        return from_properties;
    }
    schema
        .get("config")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| pick_str(item, &["paramName", "param_name"]))
                .collect()
        })
        .unwrap_or_default()
}

/// `aspectRatio` ↔ `whAspectRatio`：服务端两套命名都可能出现，前端只认前一种。
fn with_wh_variant(key: &str) -> Option<String> {
    if key.len() < 2 || key.to_ascii_lowercase().starts_with("wh") {
        return None;
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    Some(format!(
        "wh{}{}",
        first.to_ascii_uppercase(),
        chars.as_str()
    ))
}

fn without_wh_variant(key: &str) -> Option<String> {
    let rest = key.strip_prefix("wh").or_else(|| key.strip_prefix("Wh"))?;
    let mut chars = rest.chars();
    let first = chars.next()?;
    Some(format!(
        "{}{}",
        first.to_ascii_lowercase(),
        chars.as_str()
    ))
}

/// 前端传上来的是通用参数名（`aspect_ratio` / `duration` / `resolution`），画布 schema
/// 用的是各模型自己的字段名。这里做一次收敛，并按 schema 白名单过滤 —— 多余字段会让
/// 服务端整单 `INVALID_ARGUMENT`，且不告诉你是哪个字段。
fn normalize_params(raw: &[String], specs: &[RhtvParamSpec]) -> Vec<String> {
    let aliases: [(&str, &str); 7] = [
        ("aspect_ratio", "aspectRatio"),
        ("aspectratio", "aspectRatio"),
        ("ratio", "aspectRatio"),
        ("duration_seconds", "duration"),
        ("video_duration", "duration"),
        ("fps", "fps"),
        ("quality", "quality"),
    ];
    let permitted = |name: &str| specs.is_empty() || specs.iter().any(|spec| spec.key == name);
    let mut result: Vec<String> = Vec::new();
    for entry in raw {
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        let mut key = key.trim().to_string();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        for (from, to) in aliases {
            if key.eq_ignore_ascii_case(from) {
                key = to.to_string();
                break;
            }
        }
        if !permitted(&key) {
            // 换另一套命名再试一次（`aspectRatio` → `whAspectRatio`，反之亦然）。
            let candidate = with_wh_variant(&key).or_else(|| without_wh_variant(&key));
            match candidate.filter(|name| permitted(name)) {
                Some(fallback) => key = fallback,
                None => continue,
            }
        }
        // 字段名对了但取值不在该模型枚举里（例如旧节点残留的 1024x1024），
        // 传上去会整单 INVALID_MODEL_PARAMETER；丢掉它，让模型走自己的默认值。
        if let Some(spec) = specs.iter().find(|spec| spec.key == key) {
            if !spec.options.is_empty()
                && !spec.options.iter().any(|option| option.value == value)
            {
                continue;
            }
        }
        result.push(format!("{key}={value}"));
    }
    result
}

/// 画布只吃本地文件：data URL 解码成临时文件，外链先下载。返回 (路径, 是否为临时文件)。
fn materialize_media(source: &str, index: usize) -> Result<(PathBuf, bool), String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("参考图为空".into());
    }

    if let Some(rest) = source.strip_prefix("data:") {
        let (meta, payload) = rest
            .split_once(',')
            .ok_or_else(|| "data URL 缺少数据段".to_string())?;
        if !meta.ends_with(";base64") {
            return Err("参考图只支持 base64 data URL".into());
        }
        let bytes = STANDARD
            .decode(payload.trim())
            .map_err(|error| format!("参考图解码失败: {error}"))?;
        let ext = if meta.contains("png") {
            "png"
        } else if meta.contains("webp") {
            "webp"
        } else if meta.contains("gif") {
            "gif"
        } else {
            "jpg"
        };
        let path = std::env::temp_dir().join(format!(
            "lentalk-rhtv-ref-{index}-{}.{ext}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&path, bytes).map_err(|error| format!("写入临时参考图失败: {error}"))?;
        return Ok((path, true));
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("参考图下载器初始化失败: {error}"))?;
        let response = client
            .get(source)
            .send()
            .map_err(|error| format!("下载参考图失败: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("下载参考图失败: HTTP {}", response.status().as_u16()));
        }
        let lower = source.to_ascii_lowercase();
        let ext = if lower.contains(".png") {
            "png"
        } else if lower.contains(".webp") {
            "webp"
        } else {
            "jpg"
        };
        let bytes = response
            .bytes()
            .map_err(|error| format!("读取参考图失败: {error}"))?;
        let path = std::env::temp_dir().join(format!(
            "lentalk-rhtv-ref-{index}-{}.{ext}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&path, &bytes).map_err(|error| format!("写入临时参考图失败: {error}"))?;
        return Ok((path, true));
    }

    let path = PathBuf::from(source);
    if !path.is_file() {
        return Err(format!("参考图不存在：{source}"));
    }
    Ok((path, false))
}

/// 上传一张参考图，返回画布媒体节点 key。
fn upload_reference(
    exe: &Path,
    canvas_id: &str,
    source: &str,
    index: usize,
) -> Result<Option<String>, String> {
    let (path, temporary) = materialize_media(source, index)?;
    let path_text = path.to_string_lossy().to_string();
    let name = format!("lentalk-ref-{}-{}", index + 1, uuid::Uuid::new_v4().simple());
    let output = run_cli(
        exe,
        &args_of(&["upload", name.as_str(), "-f", path_text.as_str(), "-t", "image", "-p", canvas_id]),
        RUN_TIMEOUT,
    );
    if temporary {
        let _ = std::fs::remove_file(&path);
    }
    let output = output?;
    if let Some(error) = output.first_error() {
        return Err(format!("上传参考图失败：{error}"));
    }
    Ok(output
        .values
        .iter()
        .find_map(|value| pick_str(value, &["nodeKey", "node_key"])))
}

fn generate_blocking(app: AppHandle, request: RhtvGenerateRequest) -> Result<String, String> {
    let exe = resolve_executable(request.executable.as_deref()).ok_or("未找到 rhtvcli")?;
    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err("模型编码不能为空".into());
    }
    let kind = match request.kind.trim() {
        "image" => "image",
        "video" => "video",
        "audio" => "audio",
        other => return Err(format!("画布不支持该输出类型：{other}")),
    };

    let canvas_id = ensure_canvas(&exe, &app)?;

    // 参数必须按该模型的实时 schema 过滤，否则服务端整单拒绝。
    let schema = run_cli(
        &exe,
        &args_of(&["model", model.as_str(), "--type", kind]),
        CATALOG_TIMEOUT,
    )
        .ok()
        .and_then(|output| {
            output
                .values
                .into_iter()
                .find(|value| value.get("config").is_some())
        })
        .unwrap_or(Value::Null);
    // 用归一化后的参数清单做字段名 + 取值双重校验：画布对未知字段/越界取值都是一句
    // `INVALID_ARGUMENT` / `INVALID_MODEL_PARAMETER`，不告诉你是哪个字段。
    let specs = params_from_schema(&schema);
    let params = normalize_params(&request.params.unwrap_or_default(), &specs);

    // 参考图先上传成媒体节点，再用 --left 连到生成节点上。
    let mut reference_keys: Vec<String> = Vec::new();
    for (index, path) in request.images.unwrap_or_default().iter().enumerate() {
        if let Some(key) = upload_reference(&exe, &canvas_id, path, index)? {
            reference_keys.push(key);
        }
    }

    let node_name = format!("lentalk-{}-{}", kind, uuid::Uuid::new_v4().simple());
    let mut create_args = args_of(&[
        "node",
        "create",
        node_name.as_str(),
        "-t",
        kind,
        "-p",
        canvas_id.as_str(),
        "--model",
        model.as_str(),
    ]);
    if let Some(prompt) = request.prompt.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        create_args.push("--prompt".into());
        create_args.push(prompt.to_string());
    }
    for param in &params {
        create_args.push("-s".into());
        create_args.push(param.clone());
    }
    if !reference_keys.is_empty() {
        create_args.push("--left".into());
        create_args.extend(reference_keys.iter().cloned());
    }

    let created = run_cli(&exe, &create_args, WRITE_TIMEOUT)?;
    if let Some(error) = created.first_error() {
        return Err(format!("创建画布节点失败：{error}"));
    }
    let node_key = created
        .values
        .iter()
        .find_map(|value| pick_str(value, &["nodeKey", "node_key"]))
        .ok_or_else(|| format!("创建节点未返回 nodeKey：{}", tail(&created.stdout)))?;

    let timeout_seconds = request.timeout_seconds.unwrap_or(600).clamp(30, 3600);
    let run_timeout = Duration::from_secs(timeout_seconds + 60);
    let mut run_args = args_of(&["node", "run", node_key.as_str(), "-p", canvas_id.as_str(), "--timeout"]);
    run_args.push(timeout_seconds.to_string());
    let ran = run_cli(&exe, &run_args, run_timeout);
    let run_error = match &ran {
        Ok(output) => output.first_error().or_else(|| first_failure(output)),
        Err(error) => Some(error.clone()),
    };
    if let Some(error) = run_error {
        // 运行失败也尽力把节点删掉，避免用户的画布堆满半成品。
        let _ = run_cli(
            &exe,
            &args_of(&["node", "delete", node_key.as_str(), "-p", canvas_id.as_str()]),
            WRITE_TIMEOUT,
        );
        return Err(format!("画布运行失败：{error}"));
    }

    let outputs = run_cli(
        &exe,
        &args_of(&["node", "outputs", node_key.as_str(), "-p", canvas_id.as_str()]),
        CATALOG_TIMEOUT,
    )?;
    if let Some(error) = outputs.first_error() {
        return Err(format!("读取节点产物失败：{error}"));
    }
    let url = outputs
        .values
        .iter()
        .find_map(find_media_url)
        .ok_or_else(|| {
            // 走到这里通常不是"还没跑完"，而是运行失败但错误没在 run 那步暴露出来。
            let reason = first_failure(&outputs).unwrap_or_else(|| tail(&outputs.stdout));
            format!("节点没有产出媒体 URL：{reason}")
        })?;

    // 产物已在 CDN 上，节点只是过程痕迹：删掉节点保持画布干净。
    let _ = run_cli(
        &exe,
        &args_of(&["node", "delete", node_key.as_str(), "-p", canvas_id.as_str()]),
        WRITE_TIMEOUT,
    );

    Ok(url)
}

#[tauri::command]
pub async fn generate_rhtv_canvas_model(
    app: AppHandle,
    request: RhtvGenerateRequest,
) -> Result<String, String> {
    // 生成会等到出片为止（可能十几分钟），不能在主线程上阻塞。
    tokio::task::spawn_blocking(move || generate_blocking(app, request))
        .await
        .map_err(|error| format!("画布任务中断: {error}"))?
}

#[cfg(test)]
mod param_spec_tests {
    use super::*;

    /// seedream 系：`whAspectRatio` 的 paramName 是 null，选项只写在 config 里，
    /// 且每个比例通过 listResolution 带出 width/height。
    fn seedream_like() -> Value {
        json!({
            "modelCode": "text-image-seedream-v5.5",
            "schema": {
                "properties": {
                    "prompt": { "type": "string" },
                    "whAspectRatio": { "type": "string", "default": "1:1" },
                    "whResolution": { "type": "string", "default": "1K" },
                    "width": { "type": "int" },
                    "height": { "type": "int" }
                }
            },
            "config": [
                { "type": "prompt", "paramName": "prompt", "required": true, "display": true, "maxLength": 5000 },
                { "type": "whAspectRatio", "paramName": null, "paramValue": "1:1", "title": "比例",
                  "display": true, "required": true,
                  "optionValue": [
                    { "labelCn": "1:1", "labelEn": "1:1",
                      "listResolution": [{ "resolution": "1K", "widthValue": 960, "heightValue": 960 }] },
                    { "labelCn": "16:9", "labelEn": "16:9",
                      "listResolution": [{ "resolution": "1K", "widthValue": 1280, "heightValue": 720 }] }
                  ] },
                { "type": "whResolution", "paramName": null, "paramValue": "1K", "title": "分辨率",
                  "display": true, "optionValue": ["1K", "2K"] }
            ]
        })
    }

    /// H3 系：比例直接叫 aspectRatio，时长是 slider。
    fn h3_like() -> Value {
        json!({
            "modelCode": "text-video-rhart-video-minimax-h3-rh-enhanced-t2va-app",
            "schema": {
                "properties": {
                    "prompt": { "type": "string" },
                    "aspectRatio": {
                        "type": "string", "kind": "aspectRatio", "default": null,
                        "options": [
                            { "value": null, "isAuto": true, "labelCn": "自适应" },
                            { "value": "16:9", "labelCn": "16:9" }
                        ]
                    },
                    "resolution": { "type": "string", "kind": "list", "default": "768p" },
                    "duration": { "type": "string", "kind": "slider", "default": "5", "min": 4, "max": 15 }
                }
            },
            "config": [
                { "type": "prompt", "paramName": "prompt", "required": true, "display": true },
                { "type": "aspectRatio", "paramName": "aspectRatio", "title": "比例", "required": false,
                  "optionValue": [{ "value": null, "isAuto": true, "labelCn": "自适应" }, { "value": "16:9", "labelCn": "16:9" }] },
                { "type": "list", "paramName": "resolution", "title": "分辨率", "paramValue": "768p",
                  "optionValue": [{ "value": "480p" }, { "value": "768p" }] },
                { "type": "slider", "paramName": "duration", "title": "生成时长", "paramValue": "5",
                  "required": true, "min": 4, "max": 15 }
            ]
        })
    }

    #[test]
    fn keeps_composite_control_without_param_name() {
        let specs = params_from_schema(&seedream_like());
        let ratio = specs
            .iter()
            .find(|spec| spec.semantic == "aspectRatio")
            .expect("比例字段不能因为 paramName 是 null 就被漏掉");
        assert_eq!(ratio.key, "whAspectRatio");
        assert_eq!(ratio.control, "aspect");
        assert!(ratio.composite);
        assert_eq!(ratio.options.len(), 2);
        assert_eq!(ratio.options[1].value, "16:9");

        let resolution = specs
            .iter()
            .find(|spec| spec.semantic == "resolution")
            .expect("分辨率字段");
        assert_eq!(resolution.key, "whResolution");
        assert_eq!(resolution.options.len(), 2);
    }

    #[test]
    fn reads_range_and_semantics() {
        let specs = params_from_schema(&h3_like());
        let duration = specs
            .iter()
            .find(|spec| spec.semantic == "duration")
            .expect("时长字段");
        assert_eq!(duration.key, "duration");
        assert_eq!(duration.control, "slider");
        assert_eq!(duration.min, Some(4.0));
        assert_eq!(duration.max, Some(15.0));
        assert!(duration.required);

        let ratio = specs.iter().find(|spec| spec.semantic == "aspectRatio").unwrap();
        assert_eq!(ratio.key, "aspectRatio");
        assert!(!ratio.composite);
        // 首项是"自适应"：值为空，前端据此决定不传该字段。
        assert!(ratio.options[0].is_auto);
        assert!(ratio.options[0].value.is_empty());
    }

    #[test]
    fn prompt_is_first() {
        let specs = params_from_schema(&h3_like());
        assert_eq!(specs[0].semantic, "prompt");
    }

    #[test]
    fn whitelist_uses_properties_not_only_config() {
        let allowed = schema_param_names(&seedream_like());
        assert!(allowed.contains(&"whAspectRatio".to_string()));
        assert!(allowed.contains(&"whResolution".to_string()));
    }

    #[test]
    fn maps_generic_names_onto_wh_variants() {
        let specs = params_from_schema(&seedream_like());
        let params = normalize_params(
            &[
                "aspectRatio=16:9".to_string(),
                "resolution=2K".to_string(),
                "fps=24".to_string(),
                " ".to_string(),
            ],
            &specs,
        );
        assert_eq!(params, vec!["whAspectRatio=16:9", "whResolution=2K"]);
    }

    #[test]
    fn keeps_native_names_when_supported() {
        let specs = params_from_schema(&h3_like());
        let params = normalize_params(
            &["aspectRatio=16:9".to_string(), "duration=8".to_string()],
            &specs,
        );
        assert_eq!(params, vec!["aspectRatio=16:9", "duration=8"]);
    }
}

#[cfg(test)]
mod param_value_tests {
    use super::*;

    fn schema_with_enum() -> Value {
        json!({
            "modelCode": "x",
            "schema": {
                "properties": {
                    "prompt": { "type": "string" },
                    "resolution": {
                        "type": "string", "kind": "list", "default": "768p",
                        "options": [{ "value": "480p" }, { "value": "768p" }]
                    },
                    "duration": { "type": "string", "kind": "slider", "min": 4, "max": 15 }
                }
            },
            "config": [
                { "type": "list", "paramName": "resolution", "paramValue": "768p",
                  "optionValue": [{ "value": "480p" }, { "value": "768p" }] },
                { "type": "slider", "paramName": "duration", "paramValue": "5", "min": 4, "max": 15 }
            ]
        })
    }

    #[test]
    fn drops_values_outside_enum() {
        let specs = params_from_schema(&schema_with_enum());
        let params = normalize_params(
            &[
                // 旧节点残留的尺寸写法：字段名对、取值不对，必须丢掉，否则整单被拒。
                "resolution=1024x1024".to_string(),
                "duration=8".to_string(),
            ],
            &specs,
        );
        assert_eq!(params, vec!["duration=8"]);
    }

    #[test]
    fn keeps_value_inside_enum() {
        let specs = params_from_schema(&schema_with_enum());
        let params = normalize_params(&["resolution=480p".to_string()], &specs);
        assert_eq!(params, vec!["resolution=480p"]);
    }
}

#[cfg(test)]
mod failure_reason_tests {
    use super::*;

    /// 余额不足的真实返回：没有顶级 `error`，只有 `status: FAILED` + `errorMessage`。
    #[test]
    fn reads_error_message_from_failed_run() {
        let value = json!({
            "taskId": "2124078952857997314",
            "status": "FAILED",
            "errorMessage": "OpenAPI call failed: errorCode: 605, errorMessage: 您的账户余额不足，请充值。",
            "plans": [{ "status": "FAILED", "outputs": [{ "code": -1 }] }]
        });
        let reason = failure_reason(&value).unwrap();
        assert!(reason.contains("余额不足"));
    }

    #[test]
    fn reads_nested_plan_error() {
        let value = json!({
            "plans": [{ "outputs": [{ "errorMessage": "内容不合规" }] }]
        });
        assert_eq!(failure_reason(&value).unwrap(), "内容不合规");
    }

    #[test]
    fn ignores_successful_payload() {
        let value = json!({ "status": "SUCCESS", "outputs": [{ "url": "https://x/y.png" }] });
        assert!(failure_reason(&value).is_none());
    }
}
