// ---------------------------------------------------------------------------
// 番茄小说下载器（TomatoNovelDownloader）集成。
//
// 下载器本体是一个第三方单文件可执行程序，作为 Tauri sidecar 随包分发。
// 上游出于防滥用考虑**禁用了命令行新建下载**（`--download` 只会打印友好报错），
// 只保留「服务器模式」：以 `--server` 拉起后会在 127.0.0.1 上开一个 axum 服务，
// 提供搜索 / 预览 / 任务 / 历史 / 配置等 HTTP 接口。
//
// 因此这里做四件事：
// 1. 定位随包二进制（打包后与主程序同目录，开发态回退 src-tauri/binaries）。
// 2. 选一个空闲端口，以 `--server` 拉起子进程，轮询 `/api/status` 等待就绪。
// 3. 用 reqwest 代理前端请求 —— 该服务没有任何 CORS 头，WebView 不能直连；
//    同时必须 `no_proxy()`，否则本机 127.0.0.1 请求会被系统代理劫持成 502。
// 4. 退出时回收子进程。
//
// 数据目录（config.yml / logs / 下载产物）落在 `app_data_dir/novel-downloader`，
// 不污染项目目录；小说最终保存位置由下载器自身的 `save_path` 配置决定。
// ---------------------------------------------------------------------------

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

/// sidecar 的基名，必须与 `tauri.conf.json` 的 `externalBin` 条目一致。
const SIDECAR_STEM: &str = "tomato-novel-downloader";
/// 随包的 openssl 动态库目录名（macOS 专用，见 `resources/novel-downloader/`）。
const OPENSSL_DIR_NAME: &str = "novel-downloader";
/// 运行数据目录名（config.yml / logs / 下载产物）。
const DATA_DIR_NAME: &str = "novel-downloader";
/// 就绪探测：最多等 30 秒。
const READY_ATTEMPTS: u32 = 60;
const READY_INTERVAL: Duration = Duration::from_millis(500);
/// 单次代理请求的超时。搜索/预览会真的出网，给宽松些。
const PROXY_TIMEOUT: Duration = Duration::from_secs(90);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 已拉起的下载器服务。
struct RunningServer {
    child: Child,
    base_url: String,
    port: u16,
    version: Option<String>,
}

impl RunningServer {
    fn info(&self) -> NovelServerInfo {
        NovelServerInfo {
            base_url: self.base_url.clone(),
            port: self.port,
            version: self.version.clone(),
        }
    }
}

/// 服务句柄。子进程需要 `&mut` 才能 `kill`，所以整体放在 `Mutex` 里，
/// 并且**任何 await 之前都必须把锁放掉**（`MutexGuard` 不能跨 await）。
#[derive(Default)]
pub struct NovelState {
    server: Arc<Mutex<Option<RunningServer>>>,
}

impl NovelState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<RunningServer>>, String> {
        self.server.lock().map_err(|_| "下载器进程状态异常".to_string())
    }
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelEnvironment {
    /// sidecar 可执行文件路径；None = 没找到（通常意味着打包时漏了 binaries）。
    pub binary_path: Option<String>,
    pub available: bool,
    /// 面向用户的说明（缺什么）。
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelServerInfo {
    pub base_url: String,
    pub port: u16,
    pub version: Option<String>,
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

fn executable_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

/// 当前构建目标的 Rust triple；本仓库只随包了 macOS arm64 与 Windows x64。
fn target_triple() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Some("aarch64-pc-windows-msvc")
    } else {
        None
    }
}

/// 候选路径：打包后 sidecar 落在主程序同目录（Tauri `externalBin` 的行为），
/// 开发态则直接用源码目录里的 `binaries/<stem>-<triple>`。
fn sidecar_candidates() -> Vec<PathBuf> {
    let file_name = format!("{SIDECAR_STEM}{}", executable_suffix());
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&file_name));
        }
    }
    if let Some(triple) = target_triple() {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("{SIDECAR_STEM}-{triple}{}", executable_suffix())),
        );
    }
    candidates
}

fn resolve_sidecar() -> Option<PathBuf> {
    sidecar_candidates().into_iter().find(|path| path.is_file())
}

/// macOS 上该二进制硬编码链接了 `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`
/// （无 LC_RPATH），所以必须把随包的 openssl 拷进产物，并用 DYLD_LIBRARY_PATH 顶掉。
#[cfg(target_os = "macos")]
fn openssl_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join(OPENSSL_DIR_NAME);
        if candidate.join("libssl.3.dylib").is_file() {
            return Some(candidate);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(OPENSSL_DIR_NAME);
    dev.join("libssl.3.dylib").is_file().then_some(dev)
}

#[cfg(not(target_os = "macos"))]
fn openssl_dir(_app: &AppHandle) -> Option<PathBuf> {
    None
}

/// 运行数据目录：下载器要在这里读 config.yml、写 logs/。
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join(DATA_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// 进程拉起
// ---------------------------------------------------------------------------

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("申请本地端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取本地端口失败：{error}"))?
        .port();
    Ok(port)
}

/// 资源拷贝可能丢掉可执行位（打包/解压流程都不可控），这里补一刀。
#[cfg(unix)]
fn ensure_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 {
            let mut permissions = metadata.permissions();
            permissions.set_mode(mode | 0o755);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
}

#[cfg(not(unix))]
fn ensure_executable(_path: &std::path::Path) {}

fn spawn_server(app: &AppHandle) -> Result<RunningServer, String> {
    let binary = resolve_sidecar().ok_or_else(|| {
        "未找到下载器可执行文件（应为 sidecar：tomato-novel-downloader）".to_string()
    })?;
    ensure_executable(&binary);

    let workdir = data_dir(app)?;
    let port = pick_free_port()?;
    let base_url = format!("http://127.0.0.1:{port}");

    let mut command = Command::new(&binary);
    command
        .arg("--server")
        .current_dir(&workdir)
        .env("TOMATO_WEB_ADDR", format!("127.0.0.1:{port}"))
        // 上游默认 15s 超时对整本目录拉取偏紧，交给它自己的 config.yml 控制，
        // 这里只保证首屏能起来。
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(dir) = openssl_dir(app) {
        let existing = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
        let joined = if existing.is_empty() {
            dir.to_string_lossy().to_string()
        } else {
            format!("{}:{existing}", dir.to_string_lossy())
        };
        command.env("DYLD_LIBRARY_PATH", joined);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("启动下载器进程失败：{error}"))?;

    Ok(RunningServer {
        child,
        base_url,
        port,
        version: None,
    })
}

/// 本机回环请求，必须绕开系统代理。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(PROXY_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化本地请求失败：{error}"))
}

/// 轮询 `/api/status` 直到服务可用。
async fn wait_ready(base_url: &str) -> Result<Value, String> {
    let client = http_client()?;
    let url = format!("{base_url}/api/status");
    let mut last_error = String::from("尚无响应");
    for _ in 0..READY_ATTEMPTS {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                return response
                    .json::<Value>()
                    .await
                    .map_err(|error| format!("解析服务状态失败：{error}"));
            }
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(READY_INTERVAL).await;
    }
    Err(format!("下载器服务启动超时：{last_error}"))
}

fn stop_locked(slot: &mut Option<RunningServer>) {
    if let Some(mut running) = slot.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 探测随包二进制是否就位；打开面板时调用一次。
#[tauri::command]
pub fn novel_environment() -> NovelEnvironment {
    match resolve_sidecar() {
        Some(path) => NovelEnvironment {
            binary_path: Some(path.to_string_lossy().to_string()),
            available: true,
            message: String::new(),
        },
        None => NovelEnvironment {
            binary_path: None,
            available: false,
            message: "下载器组件缺失：安装包内未找到 tomato-novel-downloader".to_string(),
        },
    }
}

/// 确保服务在跑并返回它的地址；已就绪时直接复用。
#[tauri::command]
pub async fn novel_server_start(
    app: AppHandle,
    state: State<'_, NovelState>,
) -> Result<NovelServerInfo, String> {
    // 已有服务：先探活，活着就直接复用。
    let existing = {
        let mut guard = state.lock()?;
        let alive = match guard.as_mut() {
            Some(running) => matches!(running.child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            stop_locked(&mut guard);
        }
        guard.as_ref().map(RunningServer::info)
    };

    if let Some(info) = existing {
        if wait_ready(&info.base_url).await.is_ok() {
            return Ok(info);
        }
        let mut guard = state.lock()?;
        stop_locked(&mut guard);
    }

    let mut running = spawn_server(&app)?;
    let status = match wait_ready(&running.base_url).await {
        Ok(status) => status,
        Err(error) => {
            let _ = running.child.kill();
            let _ = running.child.wait();
            return Err(error);
        }
    };

    running.version = status
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let info = running.info();
    {
        let mut guard = state.lock()?;
        stop_locked(&mut guard);
        *guard = Some(running);
    }
    Ok(info)
}

/// 停止服务并回收子进程。
#[tauri::command]
pub fn novel_server_stop(state: State<'_, NovelState>) -> Result<(), String> {
    let mut guard = state.lock()?;
    stop_locked(&mut guard);
    Ok(())
}

/// 查询服务状态；子进程已退出时返回 None 并顺手清理。
#[tauri::command]
pub fn novel_server_status(state: State<'_, NovelState>) -> Result<Option<NovelServerInfo>, String> {
    let mut guard = state.lock()?;
    let alive = match guard.as_mut() {
        Some(running) => matches!(running.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        stop_locked(&mut guard);
        return Ok(None);
    }
    Ok(guard.as_ref().map(RunningServer::info))
}

/// 应用退出时调用：确保不留下孤儿进程。
pub fn shutdown(state: &NovelState) {
    if let Ok(mut guard) = state.lock() {
        stop_locked(&mut guard);
    }
}

fn current_base_url(state: &State<'_, NovelState>) -> Result<String, String> {
    let guard = state.lock()?;
    guard
        .as_ref()
        .map(|running| running.base_url.clone())
        .ok_or_else(|| "下载器服务尚未启动".to_string())
}

fn normalize_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取下载器响应失败：{error}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(400).collect();
        return Err(format!("下载器返回 {status}：{snippet}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(&text).map_err(|error| format!("解析下载器响应失败：{error}"))
}

/// 代理一次 GET（搜索 / 预览 / 任务 / 历史 / 配置）。
#[tauri::command]
pub async fn novel_api_get(
    state: State<'_, NovelState>,
    path: String,
) -> Result<Value, String> {
    let base_url = current_base_url(&state)?;
    let client = http_client()?;
    let response = client
        .get(format!("{base_url}{}", normalize_path(&path)))
        .send()
        .await
        .map_err(|error| format!("请求下载器失败：{error}"))?;
    read_json(response).await
}

/// 代理一次 POST（新建任务 / 取消 / 保存配置）。
#[tauri::command]
pub async fn novel_api_post(
    state: State<'_, NovelState>,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let base_url = current_base_url(&state)?;
    let client = http_client()?;
    let mut request = client.post(format!("{base_url}{}", normalize_path(&path)));
    if let Some(payload) = body {
        request = request.json(&payload);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求下载器失败：{error}"))?;
    read_json(response).await
}

/// 抓取下载器上的静态资源（封面等）并转成 data URL。
///
/// 下载器返回的 `cover_url` 是相对路径（`/api/preview-cover/<hash>`），WebView
/// 里没法直接当 `<img src>` 用——同源对不上，且它不带 CORS 头。这里由 Rust 取回
/// 二进制再 base64 内联，顺带绕开系统代理对回环地址的劫持。
#[tauri::command]
pub async fn novel_asset_data_url(
    state: State<'_, NovelState>,
    path: String,
) -> Result<String, String> {
    use base64::Engine;
    let base_url = current_base_url(&state)?;
    let client = http_client()?;
    let response = client
        .get(format!("{base_url}{}", normalize_path(&path)))
        .send()
        .await
        .map_err(|error| format!("请求封面失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("封面返回 HTTP {}", response.status()));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取封面失败：{error}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}
