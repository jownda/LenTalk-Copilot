use thiserror::Error;

#[derive(Error, Debug)]
pub enum AIError {
    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// 已经翻译成人话的传输层失败（带重试次数 / 真实 cause）。
    ///
    /// 保留 `Network error:` 前缀是刻意的：前端 `errorDialog` 与错误分类都按这个
    /// 前缀识别网络类故障，换成别的措辞会把既有提示全部打回原始英文。
    /// 单独开一个变体是因为 `Network` 里装的是 `reqwest::Error`，它只能装一个
    /// 真实发生过的错误，没法把"连接被重置 / 已重试 3 次"这类补充写进去。
    #[error("Network error: {0}")]
    NetworkMessage(String),

    #[error("Image processing error: {0}")]
    Image(#[from] image::ImageError),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Model not supported: {0}")]
    ModelNotSupported(String),

    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Task failed: {0}")]
    TaskFailed(String),
}

impl serde::Serialize for AIError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
