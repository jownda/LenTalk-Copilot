//! RunningHub CLI 桥接。
//!
//! 与即梦 CLI 不同，RunningHub 官方 CLI **没有 OAuth 设备码登录**：`auth` 下只有
//! `set-key` / `show` / `set-output-dir`，API Key 必须在网页后台创建。因此这里的
//! 「一键授权」落地为：自动检测/安装 CLI → 打开官方 Key 页 → 轮询系统剪贴板 →
//! 校验通过后写入 CLI 配置，全程不再要求用户手动粘贴。
//!
//! 密钥始终由前端设置页本地保存，仅在用户点击授权/验证时写入官方 CLI 配置。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// 默认命令名（pip 安装后注册的命令）。
const DEFAULT_EXECUTABLE: &str = "rh";

/// RunningHub CLI 没有发布到 PyPI，只能从官方仓库源码安装。
const INSTALL_COMMAND: &str =
    "python -m pip install --user git+https://github.com/HM-RunningHub/RH_CLI.git";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHubCliCheck {
    pub executable: String,
    pub ready: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHubCliDetect {
    pub found: bool,
    pub resolved_path: Option<String>,
    pub source: String,
    pub candidate_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHubCliInstall {
    pub success: bool,
    pub installed: bool,
    pub resolved_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHubCliLogout {
    pub success: bool,
    pub message: String,
}

/// 命令名 → 候选文件名。Windows 上 pip 生成 `rh.exe`，用户也可能填带扩展名的完整名。
#[cfg(windows)]
fn command_file_names(name: &str) -> Vec<String> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat") {
        return vec![name.to_string()];
    }
    vec![
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
        name.to_string(),
    ]
}

#[cfg(not(windows))]
fn command_file_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

/// 列出 Python 版本目录（`Python312` / `3.12` 这类），只读探测。
fn version_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs
}

/// PATH 之外的常见安装位置。
#[cfg(windows)]
fn common_locations(name: &str) -> Vec<PathBuf> {
    let file_names = command_file_names(name);
    let mut roots: Vec<PathBuf> = Vec::new();

    // pip 的脚本目录在 Windows 上通常**不在 PATH 里**，必须显式探测，
    // 否则会出现「明明装好了却报未找到 CLI」。
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let python_root = PathBuf::from(appdata).join("Python");
        for version in version_dirs(&python_root) {
            roots.push(version.join("Scripts"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let python_root = PathBuf::from(local).join("Programs").join("Python");
        for version in version_dirs(&python_root) {
            roots.push(version.join("Scripts"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        roots.push(PathBuf::from(home).join(".local").join("bin"));
    }

    roots
        .into_iter()
        .flat_map(|root| file_names.iter().map(move |file_name| root.join(file_name)))
        .collect()
}

#[cfg(not(windows))]
fn common_locations(name: &str) -> Vec<PathBuf> {
    let file_names = command_file_names(name);
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".local").join("bin"));
        let library = home.join("Library").join("Python");
        for version in version_dirs(&library) {
            roots.push(version.join("bin"));
        }
    }
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        roots.push(PathBuf::from(prefix));
    }

    roots
        .into_iter()
        .flat_map(|root| file_names.iter().map(move |file_name| root.join(file_name)))
        .collect()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let file_names = command_file_names(name);
    for directory in std::env::split_paths(&path) {
        for file_name in &file_names {
            let candidate = directory.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 只读探测：绝对/相对路径 → PATH → 常见安装位置。
fn detect_executable(requested: &str) -> RunningHubCliDetect {
    let trimmed = requested.trim().trim_matches(['"', '\'']);
    if trimmed.is_empty() {
        return RunningHubCliDetect {
            found: false,
            resolved_path: None,
            source: "none".to_string(),
            candidate_paths: Vec::new(),
        };
    }

    if trimmed.contains('/') || trimmed.contains('\\') {
        let path = PathBuf::from(trimmed);
        let found = path.is_file();
        return RunningHubCliDetect {
            found,
            resolved_path: found.then(|| path.to_string_lossy().to_string()),
            source: "settings-absolute".to_string(),
            candidate_paths: Vec::new(),
        };
    }

    if let Some(found) = find_in_path(trimmed) {
        return RunningHubCliDetect {
            found: true,
            resolved_path: Some(found.to_string_lossy().to_string()),
            source: "settings-command-path".to_string(),
            candidate_paths: Vec::new(),
        };
    }

    let candidates = common_locations(trimmed);
    let rendered: Vec<String> = candidates
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    if let Some(found) = candidates.iter().find(|path| path.is_file()) {
        return RunningHubCliDetect {
            found: true,
            resolved_path: Some(found.to_string_lossy().to_string()),
            source: "settings-command-common".to_string(),
            candidate_paths: rendered,
        };
    }

    RunningHubCliDetect {
        found: false,
        resolved_path: None,
        source: "none".to_string(),
        candidate_paths: rendered,
    }
}

fn resolve_executable(value: &str) -> Result<PathBuf, String> {
    let requested = value.trim().trim_matches(['"', '\'']);
    let requested = if requested.is_empty() {
        DEFAULT_EXECUTABLE
    } else {
        requested
    };
    detect_executable(requested)
        .resolved_path
        .map(PathBuf::from)
        .ok_or_else(|| format!("未找到 RunningHub CLI（{requested}）。请先安装：{INSTALL_COMMAND}"))
}

fn run_cli(executable: &Path, arguments: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 子进程不弹终端窗口，也不因无控制台而尝试新建控制台。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|error| format!("无法启动 RunningHub CLI：{error}"))
}

fn output_message(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        text
    }
}

fn tail_of(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }
    format!(
        "…{}",
        chars[chars.len() - max_chars..].iter().collect::<String>()
    )
}

/// 失败时优先取 stderr 的尾部：pip 的报错比 stdout 更有信息量，也不该撑爆界面。
fn failure_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    };
    tail_of(
        &text.split_whitespace().collect::<Vec<_>>().join(" "),
        400,
    )
}

/// CLI 配置文件位置（与 `rh` 自身的解析规则保持一致）。
#[cfg(windows)]
fn cli_config_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        });
    base.join("rh").join("config.toml")
}

#[cfg(not(windows))]
fn cli_config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        });
    base.join("rh").join("config.toml")
}

/// 依次尝试的 Python 启动方式。
///
/// RH_CLI 要求 Python ≥ 3.10，而 Windows 的 `py -3` 未必指向最新版本（实测可能落到
/// 3.9），所以版本号必须钉死在前，裸 `py -3` 只作为最后兜底。
fn python_launchers() -> Vec<(String, String, Vec<String>)> {
    let mut launchers = vec![
        ("python".to_string(), "python".to_string(), Vec::new()),
        ("python3".to_string(), "python3".to_string(), Vec::new()),
    ];
    #[cfg(windows)]
    {
        for version in ["3.13", "3.12", "3.11", "3.10"] {
            launchers.push((
                format!("py -{version}"),
                "py".to_string(),
                vec![format!("-{version}")],
            ));
        }
        launchers.push(("py -3".to_string(), "py".to_string(), vec!["-3".to_string()]));
    }
    launchers
}

fn check_blocking(executable: &str) -> Result<RunningHubCliCheck, String> {
    let path = resolve_executable(executable)?;
    let output = run_cli(&path, &["check"])?;
    // `rh check` 在 Key 无效 / 余额为 0 时同样返回非零退出码，但输出本身可读，
    // 因此这里只上报退出状态与原文，判定交给前端展示。
    Ok(RunningHubCliCheck {
        executable: path.to_string_lossy().to_string(),
        ready: output.status.success(),
        message: output_message(&output),
    })
}

#[tauri::command]
pub async fn runninghub_cli_check(executable: String) -> Result<RunningHubCliCheck, String> {
    tokio::task::spawn_blocking(move || check_blocking(&executable))
        .await
        .map_err(|error| format!("RunningHub CLI 调用中断：{error}"))?
}

fn set_key_blocking(executable: &str, api_key: &str) -> Result<RunningHubCliCheck, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 RunningHub API Key".to_string());
    }
    let path = resolve_executable(executable)?;
    let output = run_cli(&path, &["auth", "set-key", api_key])?;
    if !output.status.success() {
        return Err(format!(
            "保存 RunningHub API Key 失败：{}",
            failure_message(&output)
        ));
    }
    check_blocking(&path.to_string_lossy())
}

#[tauri::command]
pub async fn runninghub_cli_set_key(
    executable: String,
    api_key: String,
) -> Result<RunningHubCliCheck, String> {
    tokio::task::spawn_blocking(move || set_key_blocking(&executable, &api_key))
        .await
        .map_err(|error| format!("RunningHub CLI 调用中断：{error}"))?
}

/// 只读探测本机是否安装 RunningHub CLI，不修改任何文件、不触发安装。
#[tauri::command]
pub async fn runninghub_cli_detect(executable: Option<String>) -> RunningHubCliDetect {
    let requested = executable.unwrap_or_default();
    let requested = if requested.trim().is_empty() {
        DEFAULT_EXECUTABLE
    } else {
        requested.trim()
    };
    detect_executable(requested)
}

/// 自动安装 RunningHub CLI（官方仓库源码安装，只写入当前用户目录）：
/// 1. 已能解析出 `rh` → 直接返回 installed=false，不重复安装；
/// 2. 依次尝试 python / python3 / py -3 执行 pip；
/// 3. 安装后复检。失败路径全部返回可读 message，不向上抛致命错误。
#[tauri::command]
pub async fn runninghub_cli_install() -> Result<RunningHubCliInstall, String> {
    tokio::task::spawn_blocking(runninghub_cli_install_blocking)
        .await
        .map_err(|error| format!("RunningHub CLI 安装任务中断：{error}"))?
}

fn runninghub_cli_install_blocking() -> Result<RunningHubCliInstall, String> {
    if let Some(path) = detect_executable(DEFAULT_EXECUTABLE).resolved_path {
        return Ok(RunningHubCliInstall {
            success: true,
            installed: false,
            resolved_path: Some(path),
            message: "已检测到 RunningHub CLI，无需重复安装。".to_string(),
        });
    }

    let mut errors: Vec<String> = Vec::new();
    for (label, program, prefix) in python_launchers() {
        let mut command = Command::new(&program);
        command.args(&prefix).args([
            "-m",
            "pip",
            "install",
            "--user",
            "--disable-pip-version-check",
            "git+https://github.com/HM-RunningHub/RH_CLI.git",
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        match command.output() {
            Ok(output) if output.status.success() => {
                if let Some(path) = detect_executable(DEFAULT_EXECUTABLE).resolved_path {
                    return Ok(RunningHubCliInstall {
                        success: true,
                        installed: true,
                        resolved_path: Some(path),
                        message: "RunningHub CLI 安装完成。".to_string(),
                    });
                }
                errors.push(format!("{label}：安装命令执行成功，但未找到 rh 可执行文件"));
            }
            Ok(output) => errors.push(format!("{label}：{}", failure_message(&output))),
            Err(error) => errors.push(format!("{label}：{error}")),
        }
    }

    Ok(RunningHubCliInstall {
        success: false,
        installed: false,
        resolved_path: None,
        message: format!(
            "自动安装未完成（{}）。请在终端手动执行：{INSTALL_COMMAND}",
            errors.join("；")
        ),
    })
}

/// CLI 侧退出登录：RunningHub CLI 没有 logout 命令，这里直接移除配置文件里的
/// `api_key`，其余字段（如 `output_dir`）原样保留。
#[tauri::command]
pub async fn runninghub_cli_logout() -> Result<RunningHubCliLogout, String> {
    tokio::task::spawn_blocking(runninghub_cli_logout_blocking)
        .await
        .map_err(|error| format!("RunningHub CLI 退出登录任务中断：{error}"))?
}

fn runninghub_cli_logout_blocking() -> Result<RunningHubCliLogout, String> {
    let path = cli_config_path();
    if !path.is_file() {
        return Ok(RunningHubCliLogout {
            success: true,
            message: "本机还没有 RunningHub CLI 配置，无需清理。".to_string(),
        });
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取 CLI 配置失败（{}）：{error}", path.display()))?;
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| !line.trim_start().starts_with("api_key"))
        .collect();
    let removed = kept.len() != content.lines().count();

    std::fs::write(&path, format!("{}\n", kept.join("\n")))
        .map_err(|error| format!("写入 CLI 配置失败（{}）：{error}", path.display()))?;

    let mut message = if removed {
        format!("已移除 CLI 配置中的 API Key（{}）。", path.display())
    } else {
        format!("CLI 配置中没有 API Key（{}）。", path.display())
    };
    if std::env::var_os("RUNNINGHUB_API_KEY").is_some() {
        message.push_str(" 注意：环境变量 RUNNINGHUB_API_KEY 仍在生效，CLI 会继续使用它。");
    }

    Ok(RunningHubCliLogout {
        success: true,
        message,
    })
}

/// 读取系统剪贴板文本，供「一键授权」识别用户刚从网页复制的 API Key。
///
/// 只读取当前文本，不落盘、不写日志；内容不匹配时由前端直接丢弃。
#[tauri::command]
pub async fn runninghub_cli_read_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    // 剪贴板里是图片或为空时按「没有可用的 Key」处理，不向上抛错。
    Ok(clipboard.get_text().unwrap_or_default())
}
