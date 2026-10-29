//! 通用文本文件读写。
//!
//! 给「导入 / 保存工作流 JSON」这类**用户主动选路径**的场景用。
//!
//! 为什么不用前端 `@tauri-apps/plugin-fs`：capabilities 只放开了
//! `$HOME/**` 与 `$TEMP/**`，而用户的工作流文件经常放在 D 盘、移动硬盘或
//! 网络盘 —— 那样会被权限直接拒掉，报错还是 `forbidden path` 这种看不出原因的文案。
//! 走 Rust 命令则没有 scope 限制，错误也能翻译成人话。

use std::path::Path;

/// 读取文本文件。
///
/// 会**去掉 UTF-8 BOM**：ComfyUI / Windows 记事本导出的 JSON 常带 BOM，
/// 而 `JSON.parse` 遇到 BOM 会直接抛 "Unexpected token"，用户看到的是
/// "文件明明是对的却解析不了"。前端不必各自处理一遍。
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径为空".to_string());
    }
    let target = Path::new(trimmed);
    if !target.is_file() {
        return Err(format!("文件不存在：{trimmed}"));
    }
    let bytes = std::fs::read(target).map_err(|error| format!("读取文件失败：{error}"))?;
    // 先按 UTF-8 解，失败再按 GBK 兜一层（老的中文 Windows 环境存出来的文件）。
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            let raw = error.into_bytes();
            decode_gbk(&raw).ok_or_else(|| "文件不是 UTF-8 或 GBK 编码，无法按文本读取".to_string())?
        }
    };
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// 写入文本文件（覆盖）。
///
/// 不做「目录不存在就创建」：路径来自系统的保存对话框，父目录一定存在；
/// 真不存在时说明调用方传错了，静默造目录会把文件写到意料之外的位置。
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径为空".to_string());
    }
    std::fs::write(trimmed, contents.as_bytes()).map_err(|error| format!("写入文件失败：{error}"))
}

/// 按 GBK 解码。没有内置依赖时手写表不现实，这里只做「尽力而为」：
/// 用 Windows 的 MultiByteToWideChar（编码页 936）转成 UTF-16，再转 UTF-8。
#[cfg(windows)]
fn decode_gbk(bytes: &[u8]) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            multi_byte_count: i32,
            wide_char_str: *mut u16,
            wide_char_count: i32,
        ) -> i32;
    }

    const CP_ACP: u32 = 0;
    let length = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if length <= 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            buffer.as_mut_ptr(),
            length,
        )
    };
    if written <= 0 {
        return None;
    }
    Some(OsString::from_wide(&buffer).to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn decode_gbk(_bytes: &[u8]) -> Option<String> {
    None
}
