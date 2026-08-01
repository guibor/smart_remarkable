pub mod anthropic;
pub mod google;
pub mod openai;

use crate::cancellation::SmartRemarkableCancellation;
use anyhow::Result;
use serde_json::Value as JsonValue;
use std::collections::HashMap;

/// What stock xochitl says the current native selection contains.
///
/// This is captured alongside the selection geometry and remains bound to the
/// request so preprocessing and the OpenClaw bridge cannot silently reinterpret
/// an image selection as handwriting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SelectionKind {
    Ink,
    Image,
    Mixed,
}

pub const SELECTION_PAGE_CONTEXT_VERSION: &str = "selection-page-v1";

/// OpenClaw-only context assembled from one prepared framebuffer. Direct
/// providers keep their historical single-image request shape.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SelectionPageContext {
    pub selection_image_base64: String,
    pub current_page_image_base64: String,
    pub document_display_name: String,
    pub page_id: String,
    pub page_index: u32,
    pub page_image_completeness: crate::touch::PageImageCompleteness,
}

impl SelectionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ink => "ink",
            Self::Image => "image",
            Self::Mixed => "mixed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ink" => Some(Self::Ink),
            "image" => Some(Self::Image),
            "mixed" => Some(Self::Mixed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModelExecutionStatus {
    BuildingContext,
    LlmProcessing,
    /// The remote endpoint accepted this request. For HTTP transports this is
    /// emitted only after a successful response status has been received,
    /// before waiting for the response body.
    RemoteAccepted,
    ProcessingResponse,
    CallingTools,
    Done,
    Error(String),
}

/// Where the response to one selected-page request should be rendered.
///
/// The OpenClaw worker is long lived and can receive both button types, so
/// this is request-scoped rather than an engine-construction option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResponseMode {
    /// Deliver through OpenClaw and also write the returned final text into
    /// the notebook.
    #[default]
    WriteBack,
    /// Deliver through OpenClaw/WhatsApp only; never invoke a tablet drawing
    /// or typing callback.
    WhatsappOnly,
}

impl ResponseMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WriteBack => "write_back",
            Self::WhatsappOnly => "whatsapp_only",
        }
    }

    pub const fn writes_to_tablet(self) -> bool {
        matches!(self, Self::WriteBack)
    }
}

pub struct Tool {
    pub name: String,
    pub definition: JsonValue,
    pub callback: Option<Box<dyn FnMut(JsonValue) + Send>>,
}

pub type StatusCallback = Box<dyn FnMut(ModelExecutionStatus) + Send>;

macro_rules! status_update {
    ($callback:expr, $status:expr) => {
        if let Some(ref mut cb) = $callback {
            cb($status);
        }
    };
}

pub(crate) use status_update;

#[async_trait::async_trait]
pub trait LLMEngine: Send {
    fn new(options: &HashMap<String, String>) -> Self
    where
        Self: Sized;
    fn register_tool(&mut self, name: &str, definition: JsonValue, callback: Box<dyn FnMut(JsonValue) + Send>);
    fn add_text_content(&mut self, text: &str);
    fn add_image_content(&mut self, base64_image: &str);
    fn clear_content(&mut self);
    /// Set the response destination for the next execution. Non-OpenClaw
    /// engines retain their historical behavior through this default no-op.
    fn set_response_mode(&mut self, _mode: ResponseMode) {}
    /// Bind the stock selection classification to the next execution.
    /// Non-OpenClaw engines use it only through local preprocessing.
    fn set_selection_kind(&mut self, _kind: Option<SelectionKind>) {}
    /// Install same-frame selection/page context for an OpenClaw request.
    /// Other engines intentionally ignore it and retain their existing body.
    fn set_selection_page_context(&mut self, _context: Option<SelectionPageContext>) {}
    async fn execute(&mut self, cancellation: &SmartRemarkableCancellation, status_callback: Option<StatusCallback>) -> Result<()>;
}
