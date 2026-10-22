use std::sync::Arc;

use super::AIProvider;

pub mod ppio;
pub mod grsai;
pub mod kie;
pub mod fal;
pub mod openai_compat;
/// 专有视频协议(炳火 / WGSPAI / 知鸟 …)的后端实现。原先跑在前端 WebView 的
/// 兼容 worker 里, 迁到后端后任务状态才落库、才能跨会话续查。
pub mod video_protocols;

pub use fal::FalProvider;
pub use grsai::GrsaiProvider;
pub use kie::KieProvider;
pub use openai_compat::OpenAICompatibleProvider;
pub use ppio::PPIOProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(PPIOProvider::new()),
        Arc::new(GrsaiProvider::new()),
        Arc::new(KieProvider::new()),
        Arc::new(FalProvider::new()),
        Arc::new(OpenAICompatibleProvider::new()),
    ]
}
