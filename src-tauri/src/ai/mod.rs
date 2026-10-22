pub mod error;
pub mod providers;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::info;

use error::AIError;

#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub image_count: Option<u32>,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, serde_json::Value>>,
}

/// 视频任务与图片任务分开建模。视频接口的 duration / 首尾帧 / 音频参数不能
/// 塞进图片请求，避免后端任务执行时丢失语义。
#[derive(Debug, Clone)]
pub struct GenerateVideoRequest {
    pub prompt: String,
    pub model: String,
    pub duration: u32,
    pub aspect_ratio: String,
    pub video_resolution: Option<String>,
    pub image_mode: Option<String>,
    pub reference_images: Option<Vec<String>>,
    pub reference_audio: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone)]
pub struct ProviderTaskHandle {
    pub task_id: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum ProviderTaskSubmission {
    Queued(ProviderTaskHandle),
    Succeeded(String),
}

#[derive(Debug, Clone)]
pub enum ProviderTaskPollResult {
    Running,
    Succeeded(String),
    Failed(String),
}

#[async_trait::async_trait]
pub trait AIProvider: Send + Sync {
    fn name(&self) -> &str;
    fn supports_model(&self, model: &str) -> bool;

    fn list_models(&self) -> Vec<String> {
        Vec::new()
    }

    async fn set_api_key(&self, _api_key: String) -> Result<(), AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support API key configuration",
            self.name()
        )))
    }

    /// 按 provider 子标识存储 key(默认复用 set_api_key;支持多子平台的
    /// provider 可重写此方法按 provider_id 分别存储)
    async fn set_api_key_for(&self, _provider_id: &str, api_key: String) -> Result<(), AIError> {
        self.set_api_key(api_key).await
    }

    fn supports_task_resume(&self) -> bool {
        false
    }

    async fn submit_task(&self, _request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable task submission",
            self.name()
        )))
    }

    async fn poll_task(&self, _handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable task polling",
            self.name()
        )))
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError>;

    async fn generate_video(&self, _request: GenerateVideoRequest) -> Result<String, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support native video generation",
            self.name()
        )))
    }

    /// 视频任务是否支持「提交后落库、之后凭平台任务 ID 续查」。
    ///
    /// 支持时 `submit_generate_video_job` 会在提交后立刻把外部任务 ID 写进
    /// ai_generation_jobs 并结束本地任务, 之后由 `poll_video_task` 续查。这样应用
    /// 重启不会把仍在平台生成(且已计费)的任务判死, 用户也就不需要「重新提交」。
    fn supports_video_task_resume(&self) -> bool {
        false
    }

    /// 提交视频任务并返回平台侧句柄。仅当 `supports_video_task_resume` 为真时使用。
    async fn submit_video_task(
        &self,
        _request: GenerateVideoRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable video submission",
            self.name()
        )))
    }

    /// 凭 `submit_video_task` 返回的句柄查询视频任务状态。
    async fn poll_video_task(
        &self,
        _handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable video polling",
            self.name()
        )))
    }
}

pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn AIProvider>>,
    default_provider: Option<String>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
            default_provider: None,
        }
    }

    pub fn register_provider(&mut self, provider: Arc<dyn AIProvider>) {
        let name = provider.name().to_string();
        info!("Registering AI provider: {}", name);
        self.providers.insert(name.clone(), provider);
        if self.default_provider.is_none() {
            self.default_provider = Some(name);
        }
    }

    pub fn get_provider(&self, name: &str) -> Option<&Arc<dyn AIProvider>> {
        self.providers.get(name)
    }

    pub fn get_default_provider(&self) -> Option<&Arc<dyn AIProvider>> {
        self.default_provider
            .as_ref()
            .and_then(|name| self.providers.get(name))
    }

    pub fn list_providers(&self) -> Vec<String> {
        let mut providers = self.providers.keys().cloned().collect::<Vec<String>>();
        providers.sort();
        providers
    }

    pub fn resolve_provider_for_model(&self, model: &str) -> Option<&Arc<dyn AIProvider>> {
        if let Some((provider_id, _)) = model.split_once('/') {
            if let Some(provider) = self.providers.get(provider_id) {
                return Some(provider);
            }
        }

        self.providers
            .values()
            .find(|provider| provider.supports_model(model))
    }

    pub fn supports_model(&self, model: &str) -> bool {
        self.providers
            .values()
            .any(|provider| provider.supports_model(model))
    }

    pub fn list_models(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut models = Vec::new();

        for model in self
            .providers
            .values()
            .flat_map(|provider| provider.list_models())
        {
            if seen.insert(model.clone()) {
                models.push(model);
            }
        }

        models.sort();
        models
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}
