use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

fn search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = directories::BaseDirs::new() {
        for suffix in [".npm-global/bin", ".local/bin", ".volta/bin", "AppData/Roaming/npm"] {
            paths.push(home.home_dir().join(suffix));
        }
        let nvm = home.home_dir().join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm) {
            let mut versions: Vec<_> = entries.flatten().map(|entry| entry.path().join("bin")).collect();
            versions.sort();
            versions.reverse();
            paths.extend(versions);
        }
    }
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        paths.push(PathBuf::from(program_files).join("nodejs"));
    }
    paths
}

fn resolve(requested: &str, paths: &[PathBuf]) -> Result<PathBuf, String> {
    let requested = requested.trim().trim_matches('"');
    if requested.is_empty() { return Err("请在设置中填写万相 CLI 命令或完整路径".into()); }
    let expanded = if let Some(suffix) = requested.strip_prefix("~/") {
        directories::BaseDirs::new().map(|base| base.home_dir().join(suffix))
            .unwrap_or_else(|| PathBuf::from(requested))
    } else { PathBuf::from(requested) };
    if expanded.is_absolute() || expanded.components().count() > 1 {
        return expanded.is_file().then_some(expanded).ok_or_else(|| "万相 CLI 路径不存在".into());
    }
    for directory in paths {
        for name in [requested.to_string(), format!("{requested}.cmd"), format!("{requested}.exe")] {
            let candidate = directory.join(name);
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    Err("未找到万相 CLI，请先运行 npm install --global @wan-ai/cli，或填写完整路径".into())
}

fn command(executable: &str) -> Result<Command, String> {
    let mut paths = search_paths();
    let executable = resolve(executable, &paths)?;
    if let Some(parent) = executable.parent() { paths.insert(0, parent.to_path_buf()); }
    // Run npm's JavaScript entry directly on Windows; never interpolate prompts
    // or credentials into cmd.exe / PowerShell command strings.
    let mut command = if executable.extension().is_some_and(|ext| ext == "cmd" || ext == "ps1") {
        let parent = executable.parent().unwrap_or(Path::new("."));
        let script = parent.join("node_modules/@wan-ai/cli/dist/index.js");
        if !script.is_file() { return Err("找不到万相 npm 入口，请填写官方 wan 命令路径".into()); }
        let node = resolve("node.exe", &paths)?;
        let mut command = Command::new(node);
        command.arg(script);
        command
    } else { Command::new(executable) };
    if let Ok(path) = std::env::join_paths(paths) { command.env("PATH", path); }
    if let Some(base) = directories::BaseDirs::new() { command.current_dir(base.home_dir()); }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    Ok(command)
}

pub(super) fn error_message(value: &Value) -> String {
    fn has_error_code(value: &Value, target: &[u64]) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)|
                (key == "errorCode" && target.iter().any(|code| value == &Value::from(*code) || value == &Value::from(code.to_string())))
                    || has_error_code(value, target)),
            Value::Array(values) => values.iter().any(|value| has_error_code(value, target)),
            _ => false,
        }
    }
    if has_error_code(value, &[4018]) {
        return "万相 CLI 仅会员可用，当前账号需要开通有效会员后重试（4018）".into();
    }
    if let Some(code) = [9007_u64, 9008, 9012, 10017].into_iter().find(|code| has_error_code(value, &[*code])) {
        return format!("万相内容安全审核未通过（{code}）：请删减或改写武器、伤害、危险行为等高风险描述后重试");
    }
    let message = value.get("errorMsg").and_then(Value::as_str).unwrap_or("万相 CLI 命令失败");
    let code = value.get("errorCode").map(|value| format!(" [{value}]")).unwrap_or_default();
    // Redact AccessKeys from CLI errors before they enter app error reports.
    message.split_whitespace().map(|word| {
        if word.contains("wan-sk.") { "[REDACTED]" } else { word }
    }).collect::<Vec<_>>().join(" ") + &code
}

pub(super) async fn run(executable: &str, args: &[String], seconds: u64) -> Result<Value, String> {
    let mut process = command(executable)?;
    process.args(args).args(["--output", "json", "--quiet", "--timeout", &seconds.to_string()]);
    let output = tokio::time::timeout(Duration::from_secs(seconds + 5), process.output())
        .await.map_err(|_| "万相 CLI 命令超时，请检查任务状态后再重试".to_string())?
        .map_err(|error| format!("无法启动万相 CLI（需要 Node.js）：{error}"))?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "万相 CLI 未返回有效 JSON，请检查 Node.js 和 CLI 安装".to_string())?;
    if !output.status.success() { return Err(error_message(&value)); }
    Ok(value)
}

pub(super) fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}
