//! RunningHub CLI 桥接：密钥始终由前端设置页本地保存，并仅在用户点击验证时写入官方 CLI 配置。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHubCliCheck {
    pub executable: String,
    pub ready: bool,
    pub message: String,
}

fn resolve_executable(value: &str) -> Result<PathBuf, String> {
    let requested = value.trim();
    if requested.contains('/') || requested.contains('\\') {
        let path = PathBuf::from(requested);
        return path.is_file().then_some(path).ok_or_else(|| format!("未找到 RunningHub CLI：{requested}"));
    }

    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join(if cfg!(windows) { "rh.exe" } else { "rh" }));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(Path::new(&home).join(".local/bin/rh"));
        candidates.push(Path::new(&home).join("Library/Python/3.12/bin/rh"));
        candidates.push(Path::new(&home).join("Library/Python/3.11/bin/rh"));
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        "未找到 RunningHub CLI。请先使用 Python 3.10+ 安装 RH_CLI。".to_string()
    })
}

fn output_message(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        text
    }
}

#[tauri::command]
pub fn runninghub_cli_set_key(executable: String, api_key: String) -> Result<RunningHubCliCheck, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 RunningHub API Key".to_string());
    }
    let executable = resolve_executable(&executable)?;
    let output = Command::new(&executable)
        .args(["auth", "set-key", api_key])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 RunningHub CLI：{error}"))?;
    if !output.status.success() {
        return Err(format!("保存 RunningHub API Key 失败：{}", output_message(&output)));
    }
    runninghub_cli_check(executable.to_string_lossy().to_string())
}

#[tauri::command]
pub fn runninghub_cli_check(executable: String) -> Result<RunningHubCliCheck, String> {
    let executable = resolve_executable(&executable)?;
    let output = Command::new(&executable)
        .arg("check")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 RunningHub CLI：{error}"))?;
    let message = output_message(&output);
    Ok(RunningHubCliCheck {
        executable: executable.to_string_lossy().to_string(),
        ready: output.status.success(),
        message,
    })
}
