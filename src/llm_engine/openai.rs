use super::{
    status_update, LLMEngine, ResponseMode, SelectionKind, SelectionPageContext,
    Tool, SELECTION_PAGE_CONTEXT_VERSION,
};
use crate::cancellation::{with_cancellation, SmartRemarkableCancellation};
use crate::util::{option_or_env, option_or_env_fallback, OptionMap};
use anyhow::Result;
use log::debug;
use serde_json::json;
use serde_json::Value as json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

static OPENCLAW_REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);
const OPENCLAW_TRANSPORT_RECOVERY_TIMEOUT: Duration = Duration::from_secs(900);

pub struct OpenAI {
    model: String,
    base_url: String,
    api_key: String,
    plain_text_response: bool,
    response_mode: ResponseMode,
    selection_kind: Option<SelectionKind>,
    selection_page_context: Option<SelectionPageContext>,
    tools: Vec<Tool>,
    content: Vec<json>,
}

impl OpenAI {
    pub fn add_content(&mut self, content: json) {
        self.content.push(content);
    }

    fn tool_definition_json(tool: &Tool) -> json {
        json!({
            "type": "function",
            "function": {
                "name": tool.definition["name"],
                "description": tool.definition["description"],
                "parameters": tool.definition["parameters"],
            }
        })
    }

    /// Build the OpenAI-compatible transport for the narrow OpenClaw bridge.
    /// The bridge owns Gateway/session/delivery authority and returns final
    /// text; this client never accepts the full Gateway credential.
    pub fn new_openclaw(options: &OptionMap) -> Self {
        let api_key = option_or_env(options, "api_key", "OPENCLAW_BRIDGE_TOKEN");
        let base_url = option_or_env_fallback(
            options,
            "base_url",
            "OPENCLAW_BRIDGE_BASE_URL",
            "http://127.0.0.1:18790",
        );
        let model = options.get("model").unwrap().to_string();

        Self {
            model,
            base_url,
            api_key,
            plain_text_response: true,
            response_mode: ResponseMode::WriteBack,
            selection_kind: None,
            selection_page_context: None,
            tools: Vec::new(),
            content: Vec::new(),
        }
    }

    fn message_text(response: &json) -> Option<String> {
        let content = &response["choices"][0]["message"]["content"];
        if let Some(text) = content.as_str() {
            return Some(text.to_string());
        }

        content
            .as_array()
            .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""))
    }

    fn request_body(&self) -> json {
        let content = if self.plain_text_response {
            if let Some(context) = &self.selection_page_context {
                let text_parts: Vec<_> = self
                    .content
                    .iter()
                    .filter(|part| part["type"].as_str() == Some("text"))
                    .cloned()
                    .collect();
                if text_parts.len() == 1 && self.content.len() == 1 {
                    vec![
                        text_parts[0].clone(),
                        json!({
                            "type": "image_url",
                            "x_smart_remarkable_role": "selection",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", context.selection_image_base64)
                            }
                        }),
                        json!({
                            "type": "image_url",
                            "x_smart_remarkable_role": "current_page",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", context.current_page_image_base64)
                            }
                        }),
                    ]
                } else {
                    // execute() rejects this malformed local shape before it
                    // can reach the transport.
                    self.content.clone()
                }
            } else {
                self.content.clone()
            }
        } else {
            self.content.clone()
        };
        let mut body = json!({
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": content
            }]
        });
        if self.plain_text_response {
            if let Some(context) = &self.selection_page_context {
                body["x_smart_remarkable_context"] = json!({
                    "version": SELECTION_PAGE_CONTEXT_VERSION,
                    "document_display_name": context.document_display_name,
                    "page_id": context.page_id,
                    "page_index": context.page_index,
                    "page_number": u64::from(context.page_index) + 1,
                    "page_image_scope": "current_page_view",
                    "page_image_completeness": context.page_image_completeness.as_str(),
                });
            }
        }
        if !self.plain_text_response {
            body["tools"] = json!(self.tools.iter().map(Self::tool_definition_json).collect::<Vec<_>>());
            body["tool_choice"] = json!("required");
            body["parallel_tool_calls"] = json!(false);
        }
        body
    }

    fn next_request_id() -> String {
        let timestamp_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let sequence = OPENCLAW_REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!(
            "smart-remarkable-{:x}-{:x}-{:x}",
            std::process::id(),
            timestamp_nanos,
            sequence
        )
    }

    fn request_builder(
        &self,
        client: &reqwest::Client,
        body: &json,
        request_id: &str,
    ) -> reqwest::RequestBuilder {
        let mut request = client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json");

        if self.plain_text_response {
            request = request
                .header(
                    "x-smart-remarkable-response-mode",
                    self.response_mode.as_str(),
                )
                .header("x-smart-remarkable-request-id", request_id);
            if let Some(kind) = self.selection_kind {
                request = request.header(
                    "x-smart-remarkable-selection-kind",
                    kind.as_str(),
                );
            }
            if self.selection_page_context.is_some() {
                request = request.header(
                    "x-smart-remarkable-context-version",
                    SELECTION_PAGE_CONTEXT_VERSION,
                );
            }
        }

        request.json(body)
    }

    fn is_retryable_openclaw_transport_error(error: &anyhow::Error) -> bool {
        error
            .downcast_ref::<reqwest::Error>()
            .is_some_and(|error| {
                !error.is_builder()
                    && (error.is_connect()
                        || error.is_timeout()
                        || error.is_body()
                        || error.is_decode()
                        || error.is_request())
            })
    }

    fn is_retryable_openclaw_status(status: reqwest::StatusCode) -> bool {
        matches!(status.as_u16(), 502 | 503 | 504)
    }

    fn openclaw_retry_delay(attempt: u32) -> Duration {
        Duration::from_secs(match attempt {
            0 | 1 => 1,
            2 => 2,
            3 => 4,
            4 => 8,
            _ => 15,
        })
    }

    async fn wait_before_openclaw_retry(
        deadline: tokio::time::Instant,
        attempt: u32,
        cancellation: &SmartRemarkableCancellation,
    ) -> Result<()> {
        with_cancellation(
            async {
                tokio::time::timeout_at(
                    deadline,
                    tokio::time::sleep(Self::openclaw_retry_delay(attempt)),
                )
                .await
                .map_err(|_| anyhow::anyhow!("OpenClaw transport recovery window expired"))?;
                Ok(())
            },
            cancellation,
        )
        .await
    }

    /// Rebuild interrupted tablet-to-bridge HTTP connections with one stable
    /// request identity. The bridge's live job map and persistent completion
    /// journal make the replay idempotent; changing the ID here could create a
    /// second OpenClaw turn after a lost response. Selected content remains in
    /// this process only and the retry window is bounded.
    async fn send_openclaw_with_recovery(
        client: &reqwest::Client,
        base_url: String,
        api_key: String,
        response_mode: ResponseMode,
        selection_kind: SelectionKind,
        context_version: Option<&str>,
        body: &json,
        request_id: &str,
        cancellation: &SmartRemarkableCancellation,
        status_callback: &mut Option<super::StatusCallback>,
    ) -> Result<String> {
        let deadline = tokio::time::Instant::now() + OPENCLAW_TRANSPORT_RECOVERY_TIMEOUT;
        let mut remote_accepted = false;
        let mut attempt = 0_u32;
        let mut request_builder = client
            .post(format!("{}/v1/chat/completions", base_url))
            .bearer_auth(&api_key)
            .header("Content-Type", "application/json")
            .header(
                "x-smart-remarkable-response-mode",
                response_mode.as_str(),
            )
            .header("x-smart-remarkable-request-id", request_id)
            .header(
                "x-smart-remarkable-selection-kind",
                selection_kind.as_str(),
            );
        if let Some(context_version) = context_version {
            request_builder = request_builder.header(
                "x-smart-remarkable-context-version",
                context_version,
            );
        }
        let request_template = request_builder
            .json(body)
            .build()?;

        loop {
            attempt = attempt.saturating_add(1);
            let request = request_template.try_clone().ok_or_else(|| {
                anyhow::anyhow!("OpenClaw request body cannot be replayed safely")
            })?;
            let response_result = with_cancellation(
                async {
                    tokio::time::timeout_at(deadline, client.execute(request))
                        .await
                        .map_err(|_| anyhow::anyhow!("OpenClaw transport recovery window expired"))?
                        .map_err(anyhow::Error::from)
                },
                cancellation,
            )
            .await;

            let response = match response_result {
                Ok(response) => response,
                Err(error) => {
                    if cancellation.should_cancel()
                        || tokio::time::Instant::now() >= deadline
                        || !Self::is_retryable_openclaw_transport_error(&error)
                    {
                        return Err(error);
                    }
                    debug!("OpenClaw transport attempt {} was interrupted; retrying with the same request ID", attempt);
                    Self::wait_before_openclaw_retry(deadline, attempt, cancellation).await?;
                    continue;
                }
            };

            if response.status() != reqwest::StatusCode::OK {
                if Self::is_retryable_openclaw_status(response.status())
                    && tokio::time::Instant::now() < deadline
                {
                    debug!("OpenClaw bridge attempt {} was temporarily unavailable; retrying with the same request ID", attempt);
                    drop(response);
                    Self::wait_before_openclaw_retry(deadline, attempt, cancellation).await?;
                    continue;
                }
                return Err(anyhow::anyhow!("API Error: {}", response.status()));
            }
            if !remote_accepted {
                status_update!(
                    status_callback,
                    super::ModelExecutionStatus::RemoteAccepted
                );
                remote_accepted = true;
            }

            let body_result = with_cancellation(
                async {
                    tokio::time::timeout_at(deadline, response.text())
                        .await
                        .map_err(|_| anyhow::anyhow!("OpenClaw response recovery window expired"))?
                        .map_err(anyhow::Error::from)
                },
                cancellation,
            )
            .await;
            match body_result {
                Ok(body_text) => return Ok(body_text),
                Err(error) => {
                    if cancellation.should_cancel()
                        || tokio::time::Instant::now() >= deadline
                        || !Self::is_retryable_openclaw_transport_error(&error)
                    {
                        return Err(error);
                    }
                    debug!("OpenClaw response attempt {} was interrupted; replaying the same request ID", attempt);
                    Self::wait_before_openclaw_retry(deadline, attempt, cancellation).await?;
                }
            }
        }
    }

    fn validate_bridge_response(
        &self,
        response: &json,
        request_id: &str,
        expected_context_version: Option<&str>,
    ) -> Result<bool> {
        let metadata = &response["x_smart_remarkable"];
        let expected_selection_kind = self.selection_kind.ok_or_else(|| {
            anyhow::anyhow!("OpenClaw bridge request has no trusted selection kind")
        })?;
        if metadata["request_id"].as_str() != Some(request_id) {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge response request ID mismatch"
            ));
        }
        if metadata["response_mode"].as_str() != Some(self.response_mode.as_str()) {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge response mode mismatch"
            ));
        }
        if metadata["selection_kind"].as_str() != Some(expected_selection_kind.as_str()) {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge response selection kind mismatch"
            ));
        }
        if let Some(expected_context_version) = expected_context_version {
            if metadata["context_version"].as_str() != Some(expected_context_version) {
                return Err(anyhow::anyhow!(
                    "OpenClaw bridge response context version mismatch"
                ));
            }
        }
        let replayed = metadata["replayed"].as_bool().ok_or_else(|| {
            anyhow::anyhow!("OpenClaw bridge response has invalid replay metadata")
        })?;

        let delivery = &response["openclaw_delivery"];
        if delivery["requested"].as_bool() != Some(true)
            || delivery["channel"].as_str() != Some("whatsapp")
        {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge response has invalid delivery metadata"
            ));
        }
        if !matches!(
            delivery["acknowledgement"]["status"].as_str(),
            Some("sent" | "delivered")
        ) {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge did not complete the WhatsApp acknowledgement"
            ));
        }
        match delivery["final"]["status"].as_str() {
            Some("sent" | "delivered") => Ok(replayed),
            _ => Err(anyhow::anyhow!(
                "OpenClaw bridge did not complete WhatsApp delivery"
            )),
        }
    }

    fn handle_plain_text_response(
        &mut self,
        response: &json,
        status_callback: &mut Option<super::StatusCallback>,
        replayed: bool,
    ) -> Result<()> {
        let text = Self::message_text(response)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| anyhow::anyhow!("No text found in OpenClaw response"))?;
        if replayed || !self.response_mode.writes_to_tablet() {
            // The bridge has already delivered the canonical run through
            // WhatsApp. Parsing a non-empty final response above validates
            // completion, but Send mode and replayed Write Back responses must
            // never render on the tablet. Suppressing a replay is deliberately
            // at-most-once: a lost first response may omit local insertion,
            // but a retry cannot duplicate notebook text.
            status_update!(status_callback, super::ModelExecutionStatus::Done);
            return Ok(());
        }
        let tool = self.tools.iter_mut().find(|tool| tool.name == "draw_text");
        if let Some(tool) = tool {
            if let Some(callback) = &mut tool.callback {
                status_update!(
                    status_callback,
                    super::ModelExecutionStatus::CallingTools
                );
                callback(json!({"text": text}));
                status_update!(status_callback, super::ModelExecutionStatus::Done);
                return Ok(());
            }
        }
        status_update!(
            status_callback,
            super::ModelExecutionStatus::Error(
                "No draw_text callback registered".to_string()
            )
        );
        Err(anyhow::anyhow!("No draw_text callback registered"))
    }
}

#[async_trait::async_trait]
impl LLMEngine for OpenAI {
    fn new(options: &OptionMap) -> Self {
        let api_key = option_or_env(options, "api_key", "OPENAI_API_KEY");
        let base_url = option_or_env_fallback(options, "base_url", "OPENAI_BASE_URL", "https://api.openai.com");
        let model = options.get("model").unwrap().to_string();

        Self {
            model,
            base_url,
            api_key,
            plain_text_response: false,
            response_mode: ResponseMode::WriteBack,
            selection_kind: None,
            selection_page_context: None,
            tools: Vec::new(),
            content: Vec::new(),
        }
    }

    fn register_tool(&mut self, name: &str, definition: json, callback: Box<dyn FnMut(json) + Send>) {
        self.tools.push(Tool {
            name: name.to_string(),
            definition,
            callback: Some(callback),
        });
    }

    fn add_text_content(&mut self, text: &str) {
        self.add_content(json!({
            "type": "text",
            "text": text,
        }));
    }

    fn add_image_content(&mut self, base64_image: &str) {
        self.add_content(json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:image/png;base64,{}", base64_image)
            }
        }));
    }

    fn clear_content(&mut self) {
        self.content.clear();
        self.selection_page_context = None;
    }

    fn set_response_mode(&mut self, mode: ResponseMode) {
        self.response_mode = mode;
    }

    fn set_selection_kind(&mut self, kind: Option<SelectionKind>) {
        self.selection_kind = kind;
    }

    fn set_selection_page_context(&mut self, context: Option<SelectionPageContext>) {
        self.selection_page_context = context;
    }

    async fn execute(&mut self, cancellation: &SmartRemarkableCancellation, mut status_callback: Option<super::StatusCallback>) -> Result<()> {
        if self.plain_text_response && self.selection_kind.is_none() {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge request has no trusted selection kind"
            ));
        }
        if self.plain_text_response && self.selection_page_context.is_some() {
            let valid_local_shape = self.content.len() == 1
                && self.content[0]["type"].as_str() == Some("text")
                && self.content[0]["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty());
            if !valid_local_shape {
                return Err(anyhow::anyhow!(
                    "OpenClaw selection-page request must contain exactly one non-empty text part"
                ));
            }
        }
        let expected_context_version = self
            .selection_page_context
            .as_ref()
            .map(|_| SELECTION_PAGE_CONTEXT_VERSION);
        let body = self.request_body();
        let content_items = body["messages"][0]["content"]
            .as_array()
            .map_or(0, Vec::len);
        if self.plain_text_response {
            // The immutable serialized body below owns the images for every
            // replay. Drop the engine's second copy before network I/O.
            self.content.clear();
            self.selection_page_context = None;
        }

        debug!(
            "OpenAI-compatible request prepared (model={}, content_items={}, tool_count={})",
            self.model,
            content_items,
            self.tools.len()
        );

        // Notify that we're building context
        status_update!(status_callback, super::ModelExecutionStatus::BuildingContext);

        // Notify that we're processing with LLM
        status_update!(status_callback, super::ModelExecutionStatus::LlmProcessing);

        // Clone only the narrow OpenClaw transport fields before awaiting so
        // the recovery future never borrows this engine's non-Sync tool
        // callbacks across an await point.
        let client = if self.plain_text_response {
            reqwest::Client::builder()
                // Never forward the selected PNG or bridge token to a redirect
                // target. The pinned loopback bridge contract is one exact URL.
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                // Canonical OpenClaw turns may legitimately queue behind the
                // user's WhatsApp turn or run tools. Keep the request bounded
                // while allowing the bridge's ten-minute reconciliation
                // window plus final provider delivery.
                .timeout(Duration::from_secs(620))
                .build()?
        } else {
            reqwest::Client::new()
        };
        let request_id = Self::next_request_id();
        let body_text = if self.plain_text_response {
            let selection_kind = self.selection_kind.ok_or_else(|| {
                anyhow::anyhow!("OpenClaw bridge request has no trusted selection kind")
            })?;
            Self::send_openclaw_with_recovery(
                &client,
                self.base_url.clone(),
                self.api_key.clone(),
                self.response_mode,
                selection_kind,
                expected_context_version,
                &body,
                &request_id,
                cancellation,
                &mut status_callback,
            )
            .await?
        } else {
            let request = self.request_builder(&client, &body, &request_id);
            let response = with_cancellation(
                async { Ok::<_, anyhow::Error>(request.send().await?) },
                cancellation,
            )
            .await?;
            if !response.status().is_success() {
                return Err(anyhow::anyhow!("API Error: {}", response.status()));
            }
            status_update!(
                status_callback,
                super::ModelExecutionStatus::RemoteAccepted
            );
            with_cancellation(
                async { Ok::<_, anyhow::Error>(response.text().await?) },
                cancellation,
            )
            .await?
        };
        let json: json = serde_json::from_str(&body_text)?;
        debug!("OpenAI-compatible response received and parsed");

        // Notify that we're processing the response
        status_update!(status_callback, super::ModelExecutionStatus::ProcessingResponse);

        if self.plain_text_response {
            let replayed = self.validate_bridge_response(
                &json,
                &request_id,
                expected_context_version,
            )?;
            return self.handle_plain_text_response(
                &json,
                &mut status_callback,
                replayed,
            );
        }

        let tool_calls = &json["choices"][0]["message"]["tool_calls"];

        if let Some(tool_call) = tool_calls.get(0) {
            // Notify that we're calling tools
            status_update!(status_callback, super::ModelExecutionStatus::CallingTools);

            let function_name = tool_call["function"]["name"].as_str().unwrap();
            let function_input_raw = tool_call["function"]["arguments"].as_str().unwrap();
            let function_input = serde_json::from_str::<json>(function_input_raw).unwrap();
            let tool = self.tools.iter_mut().find(|tool| tool.name == function_name);

            if let Some(tool) = tool {
                if let Some(callback) = &mut tool.callback {
                    callback(function_input.clone());
                    // Notify that we're done
                    status_update!(status_callback, super::ModelExecutionStatus::Done);
                    Ok(())
                } else {
                    status_update!(
                        status_callback,
                        super::ModelExecutionStatus::Error("No callback registered for tool".to_string())
                    );
                    Err(anyhow::anyhow!("No callback registered for tool {}", function_name))
                }
            } else {
                status_update!(status_callback, super::ModelExecutionStatus::Error("No tool registered".to_string()));
                Err(anyhow::anyhow!("No tool registered with name {}", function_name))
            }
        } else {
            status_update!(
                status_callback,
                super::ModelExecutionStatus::Error("No tool calls found in response".to_string())
            );
            Err(anyhow::anyhow!("No tool calls found in response"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAI;
    use crate::cancellation::SmartRemarkableCancellation;
    use crate::llm_engine::{
        LLMEngine, ModelExecutionStatus, ResponseMode, SelectionKind,
        SelectionPageContext, SELECTION_PAGE_CONTEXT_VERSION,
    };
    use crate::touch::PageImageCompleteness;
    use crate::util::OptionMap;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn extracts_openclaw_string_response() {
        let response = json!({"choices": [{"message": {"content": "  10  "}}]});
        assert_eq!(OpenAI::message_text(&response).as_deref(), Some("  10  "));
    }

    #[test]
    fn extracts_openclaw_content_parts() {
        let response = json!({
            "choices": [{"message": {"content": [
                {"type": "text", "text": "first"},
                {"type": "text", "text": " second"}
            ]}}]
        });
        assert_eq!(OpenAI::message_text(&response).as_deref(), Some("first second"));
    }

    fn openclaw_options() -> OptionMap {
        let mut options = OptionMap::new();
        options.insert("model".to_string(), "openclaw/main".to_string());
        options.insert("base_url".to_string(), "http://127.0.0.1:18791".to_string());
        options.insert("api_key".to_string(), "test-bridge-token".to_string());
        options
    }

    fn bridge_response(
        request_id: &str,
        response_mode: &str,
        selection_kind: &str,
        delivery_status: &str,
    ) -> serde_json::Value {
        json!({
            "choices": [{
                "message": {
                    "content": "Delivered answer"
                }
            }],
            "openclaw_delivery": {
                "requested": true,
                "channel": "whatsapp",
                "acknowledgement": {
                    "status": "sent"
                },
                "final": {
                    "status": delivery_status
                }
            },
            "x_smart_remarkable": {
                "request_id": request_id,
                "response_mode": response_mode,
                "selection_kind": selection_kind,
                "replayed": false
            }
        })
    }

    fn bridge_response_with_context(
        request_id: &str,
        response_mode: &str,
        selection_kind: &str,
        delivery_status: &str,
    ) -> serde_json::Value {
        let mut response = bridge_response(
            request_id,
            response_mode,
            selection_kind,
            delivery_status,
        );
        response["x_smart_remarkable"]["context_version"] =
            json!(SELECTION_PAGE_CONTEXT_VERSION);
        response
    }

    fn selection_page_context() -> SelectionPageContext {
        SelectionPageContext {
            selection_image_base64: "c2VsZWN0aW9u".to_string(),
            current_page_image_base64: "Y3VycmVudC1wYWdl".to_string(),
            document_display_name: "Project notes".to_string(),
            page_id: "page-1".to_string(),
            page_index: 4,
            page_image_completeness: PageImageCompleteness::ViewportOnly,
        }
    }

    fn request_header(request: &[u8], name: &str) -> String {
        String::from_utf8_lossy(request)
            .split("\r\n")
            .filter_map(|line| line.split_once(':'))
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_else(|| panic!("missing request header {name}"))
    }

    fn request_body_bytes(request: &[u8]) -> &[u8] {
        let body_start = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .expect("request must contain a complete HTTP header block");
        &request[body_start..]
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        const MAX_TEST_REQUEST_BYTES: usize = 16 * 1024 * 1024;
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0, "connection closed before the request completed");
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() <= MAX_TEST_REQUEST_BYTES);

            if let Some(header_index) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            {
                let body_start = header_index + 4;
                let content_length = request_header(&request[..body_start], "content-length")
                    .parse::<usize>()
                    .unwrap();
                if request.len() >= body_start + content_length {
                    request.truncate(body_start + content_length);
                    return request;
                }
            }
        }
    }

    #[test]
    fn bridge_request_has_no_client_controlled_session_or_channel() {
        let mut options = openclaw_options();
        options.insert("session_key".to_string(), "agent:main:main".to_string());
        options.insert("message_channel".to_string(), "whatsapp".to_string());
        options.insert("user".to_string(), "must-be-ignored".to_string());
        let mut engine = OpenAI::new_openclaw(&options);
        engine.add_text_content("What is 7 + 3?");
        engine.set_selection_kind(Some(SelectionKind::Image));

        let body = engine.request_body();
        assert_eq!(body["model"], "openclaw/main");
        assert!(body.get("user").is_none());
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());

        let request_id = "smart-remarkable-test-0001";
        let request = engine
            .request_builder(&reqwest::Client::new(), &body, request_id)
            .build()
            .expect("request should build");
        assert!(request.headers().get("x-openclaw-session-key").is_none());
        assert!(request
            .headers()
            .get("x-openclaw-message-channel")
            .is_none());
        assert_eq!(
            request.headers()["x-smart-remarkable-response-mode"],
            "write_back"
        );
        assert_eq!(
            request.headers()["x-smart-remarkable-request-id"],
            request_id
        );
        assert_eq!(
            request.headers()["x-smart-remarkable-selection-kind"],
            "image"
        );
        assert!(request.headers()[reqwest::header::AUTHORIZATION].is_sensitive());
        assert_eq!(request.url().as_str(), "http://127.0.0.1:18791/v1/chat/completions");
    }

    #[test]
    fn selection_page_request_has_exact_context_and_role_order() {
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.set_selection_kind(Some(SelectionKind::Mixed));
        engine.set_selection_page_context(Some(selection_page_context()));
        engine.add_text_content("Use the selected region as the focal input.");

        let body = engine.request_body();
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "Use the selected region as the focal input.");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["x_smart_remarkable_role"], "selection");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,c2VsZWN0aW9u");
        assert_eq!(content[2]["type"], "image_url");
        assert_eq!(content[2]["x_smart_remarkable_role"], "current_page");
        assert_eq!(content[2]["image_url"]["url"], "data:image/png;base64,Y3VycmVudC1wYWdl");
        assert_eq!(
            body["x_smart_remarkable_context"],
            json!({
                "version": "selection-page-v1",
                "document_display_name": "Project notes",
                "page_id": "page-1",
                "page_index": 4,
                "page_number": 5,
                "page_image_scope": "current_page_view",
                "page_image_completeness": "viewport_only",
            })
        );

        let request = engine
            .request_builder(
                &reqwest::Client::new(),
                &body,
                "smart-remarkable-context-test",
            )
            .build()
            .unwrap();
        assert_eq!(
            request.headers()["x-smart-remarkable-context-version"],
            SELECTION_PAGE_CONTEXT_VERSION
        );

        engine.clear_content();
        assert!(engine
            .request_body()
            .get("x_smart_remarkable_context")
            .is_none());
    }

    #[test]
    fn only_expected_transient_bridge_statuses_are_retryable() {
        for status in [502, 503, 504] {
            assert!(OpenAI::is_retryable_openclaw_status(
                reqwest::StatusCode::from_u16(status).unwrap()
            ));
        }
        for status in [200, 202, 307, 400, 409, 429, 500, 505] {
            assert!(!OpenAI::is_retryable_openclaw_status(
                reqwest::StatusCode::from_u16(status).unwrap()
            ));
        }
        assert_eq!(OpenAI::openclaw_retry_delay(1), Duration::from_secs(1));
        assert_eq!(OpenAI::openclaw_retry_delay(4), Duration::from_secs(8));
        assert_eq!(OpenAI::openclaw_retry_delay(5), Duration::from_secs(15));
        assert_eq!(OpenAI::openclaw_retry_delay(100), Duration::from_secs(15));
    }

    #[test]
    fn direct_openai_request_does_not_receive_openclaw_selection_headers() {
        let mut options = OptionMap::new();
        options.insert("model".to_string(), "gpt-test".to_string());
        options.insert("base_url".to_string(), "https://api.openai.example".to_string());
        options.insert("api_key".to_string(), "test-key".to_string());
        let mut engine = OpenAI::new(&options);
        engine.set_selection_kind(Some(SelectionKind::Mixed));
        engine.set_selection_page_context(Some(selection_page_context()));
        engine.add_text_content("Describe this");
        let body = engine.request_body();
        let request = engine
            .request_builder(
                &reqwest::Client::new(),
                &body,
                "smart-remarkable-test-direct",
            )
            .build()
            .unwrap();

        assert!(request
            .headers()
            .get("x-smart-remarkable-selection-kind")
            .is_none());
        assert!(request
            .headers()
            .get("x-smart-remarkable-response-mode")
            .is_none());
        assert!(request
            .headers()
            .get("x-smart-remarkable-context-version")
            .is_none());
        assert!(body.get("x_smart_remarkable_context").is_none());
    }

    #[test]
    fn bridge_response_requires_matching_request_mode_and_delivery() {
        let request_id = "smart-remarkable-test-0002";
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Image));
        let valid = bridge_response(request_id, "whatsapp_only", "image", "sent");
        assert!(engine
            .validate_bridge_response(&valid, request_id, None)
            .is_ok_and(|replayed| !replayed));

        let wrong_id = bridge_response(
            "smart-remarkable-test-other",
            "whatsapp_only",
            "image",
            "sent",
        );
        assert!(engine
            .validate_bridge_response(&wrong_id, request_id, None)
            .is_err());

        let wrong_mode = bridge_response(request_id, "write_back", "image", "sent");
        assert!(engine
            .validate_bridge_response(&wrong_mode, request_id, None)
            .is_err());

        let wrong_kind = bridge_response(request_id, "whatsapp_only", "ink", "sent");
        assert!(engine
            .validate_bridge_response(&wrong_kind, request_id, None)
            .is_err());

        let mut missing_kind =
            bridge_response(request_id, "whatsapp_only", "image", "sent");
        missing_kind["x_smart_remarkable"]
            .as_object_mut()
            .unwrap()
            .remove("selection_kind");
        assert!(engine
            .validate_bridge_response(&missing_kind, request_id, None)
            .is_err());

        let failed_delivery =
            bridge_response(request_id, "whatsapp_only", "image", "failed");
        assert!(engine
            .validate_bridge_response(&failed_delivery, request_id, None)
            .is_err());

        let mut failed_ack =
            bridge_response(request_id, "whatsapp_only", "image", "sent");
        failed_ack["openclaw_delivery"]["acknowledgement"]["status"] =
            json!("failed");
        assert!(engine
            .validate_bridge_response(&failed_ack, request_id, None)
            .is_err());

        let merely_requested =
            bridge_response(request_id, "whatsapp_only", "image", "requested");
        assert!(engine
            .validate_bridge_response(&merely_requested, request_id, None)
            .is_err());
    }

    #[test]
    fn selection_page_response_requires_the_exact_context_echo() {
        let request_id = "smart-remarkable-test-context";
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Image));
        let valid = bridge_response_with_context(
            request_id,
            "whatsapp_only",
            "image",
            "sent",
        );
        assert!(engine
            .validate_bridge_response(
                &valid,
                request_id,
                Some(SELECTION_PAGE_CONTEXT_VERSION),
            )
            .is_ok());
        let missing = bridge_response(request_id, "whatsapp_only", "image", "sent");
        assert!(engine
            .validate_bridge_response(
                &missing,
                request_id,
                Some(SELECTION_PAGE_CONTEXT_VERSION),
            )
            .is_err());
        let mut wrong = valid;
        wrong["x_smart_remarkable"]["context_version"] = json!("selection-page-v0");
        assert!(engine
            .validate_bridge_response(
                &wrong,
                request_id,
                Some(SELECTION_PAGE_CONTEXT_VERSION),
            )
            .is_err());
    }

    #[test]
    fn request_ids_are_unique_and_mode_is_request_scoped() {
        let options = openclaw_options();
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        let client = reqwest::Client::new();
        let body = engine.request_body();
        let first_id = OpenAI::next_request_id();
        let second_id = OpenAI::next_request_id();
        let first = engine
            .request_builder(&client, &body, &first_id)
            .build()
            .unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(
            first.headers()["x-smart-remarkable-request-id"],
            first_id
        );
        assert_eq!(
            first.headers()["x-smart-remarkable-response-mode"],
            "whatsapp_only"
        );
    }

    #[test]
    fn only_write_back_invokes_draw_text() {
        let response =
            json!({"choices": [{"message": {"content": "A delivered answer"}}]});

        let write_back_count = Arc::new(AtomicUsize::new(0));
        let mut write_back = OpenAI::new_openclaw(&openclaw_options());
        let count = Arc::clone(&write_back_count);
        write_back.register_tool(
            "draw_text",
            json!({}),
            Box::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
            }),
        );
        write_back.set_response_mode(ResponseMode::WriteBack);
        write_back
            .handle_plain_text_response(&response, &mut None, false)
            .unwrap();
        assert_eq!(write_back_count.load(Ordering::Relaxed), 1);

        let whatsapp_count = Arc::new(AtomicUsize::new(0));
        let mut whatsapp_only = OpenAI::new_openclaw(&openclaw_options());
        let count = Arc::clone(&whatsapp_count);
        whatsapp_only.register_tool(
            "draw_text",
            json!({}),
            Box::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
            }),
        );
        whatsapp_only.set_response_mode(ResponseMode::WhatsappOnly);
        whatsapp_only
            .handle_plain_text_response(&response, &mut None, false)
            .unwrap();
        assert_eq!(whatsapp_count.load(Ordering::Relaxed), 0);

        let replay_count = Arc::new(AtomicUsize::new(0));
        let mut replayed_write_back = OpenAI::new_openclaw(&openclaw_options());
        let count = Arc::clone(&replay_count);
        replayed_write_back.register_tool(
            "draw_text",
            json!({}),
            Box::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
            }),
        );
        replayed_write_back.set_response_mode(ResponseMode::WriteBack);
        replayed_write_back
            .handle_plain_text_response(&response, &mut None, true)
            .unwrap();
        assert_eq!(replay_count.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn whatsapp_only_still_validates_a_nonempty_final_response() {
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.set_response_mode(ResponseMode::WhatsappOnly);

        assert!(engine
            .handle_plain_text_response(
                &json!({"choices": [{"message": {"content": ""}}]}),
                &mut None,
                false,
            )
            .is_err());
    }

    #[tokio::test]
    async fn interrupted_openclaw_before_headers_reuses_the_exact_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_request = read_http_request(&mut first).await;
            let first_id = request_header(&first_request, "x-smart-remarkable-request-id");
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let second_request = read_http_request(&mut second).await;
            let second_id = request_header(&second_request, "x-smart-remarkable-request-id");
            let response_body = bridge_response_with_context(
                &second_id,
                "whatsapp_only",
                "ink",
                "sent",
            )
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            second.write_all(response.as_bytes()).await.unwrap();
            (first_request, second_request, first_id, second_id)
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Ink));
        engine.set_selection_page_context(Some(selection_page_context()));
        engine.add_text_content("test");

        engine
            .execute(&SmartRemarkableCancellation::new(), None)
            .await
            .unwrap();
        let (first_request, second_request, first_id, second_id) = server.await.unwrap();
        assert_eq!(first_id, second_id);
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-response-mode"),
            request_header(&second_request, "x-smart-remarkable-response-mode")
        );
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-selection-kind"),
            request_header(&second_request, "x-smart-remarkable-selection-kind")
        );
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-context-version"),
            request_header(&second_request, "x-smart-remarkable-context-version")
        );
        assert_eq!(
            request_body_bytes(&first_request),
            request_body_bytes(&second_request)
        );
    }

    #[tokio::test]
    async fn interrupted_openclaw_body_reuses_id_and_emits_acceptance_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_request = read_http_request(&mut first).await;
            let first_id = request_header(&first_request, "x-smart-remarkable-request-id");
            first
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n{\"partial\":true}",
                )
                .await
                .unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let second_request = read_http_request(&mut second).await;
            let second_id = request_header(&second_request, "x-smart-remarkable-request-id");
            let response_body = bridge_response(
                &second_id,
                "whatsapp_only",
                "image",
                "sent",
            )
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            second.write_all(response.as_bytes()).await.unwrap();
            (first_request, second_request, first_id, second_id)
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Image));
        engine.add_text_content("test");
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let callback_statuses = Arc::clone(&statuses);
        let callback = Some(Box::new(move |status| {
            callback_statuses.lock().unwrap().push(status);
        }) as super::super::StatusCallback);

        engine
            .execute(&SmartRemarkableCancellation::new(), callback)
            .await
            .unwrap();
        let (first_request, second_request, first_id, second_id) = server.await.unwrap();
        assert_eq!(first_id, second_id);
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-response-mode"),
            request_header(&second_request, "x-smart-remarkable-response-mode")
        );
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-selection-kind"),
            request_header(&second_request, "x-smart-remarkable-selection-kind")
        );
        assert_eq!(
            request_body_bytes(&first_request),
            request_body_bytes(&second_request)
        );
        assert_eq!(
            statuses
                .lock()
                .unwrap()
                .iter()
                .filter(|status| **status == ModelExecutionStatus::RemoteAccepted)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn non_retryable_http_failure_never_emits_remote_accepted() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            socket
                .write_all(
                    b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_selection_kind(Some(SelectionKind::Ink));
        engine.add_text_content("test");
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let callback_statuses = Arc::clone(&statuses);
        let callback = Some(Box::new(move |status| {
            callback_statuses.lock().unwrap().push(status);
        }) as super::super::StatusCallback);

        assert!(engine
            .execute(&SmartRemarkableCancellation::new(), callback)
            .await
            .is_err());
        server.await.unwrap();
        assert!(!statuses
            .lock()
            .unwrap()
            .contains(&ModelExecutionStatus::RemoteAccepted));
    }

    #[tokio::test]
    async fn openclaw_redirect_is_terminal_and_never_receives_the_selection_twice() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut first).await;
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                address
            );
            first.write_all(response.as_bytes()).await.unwrap();
            drop(first);
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_selection_kind(Some(SelectionKind::Image));
        engine.add_text_content("private selection");

        let error = engine
            .execute(&SmartRemarkableCancellation::new(), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("307 Temporary Redirect"));
        assert!(!server.await.unwrap(), "redirect target received a second POST");
    }

    #[tokio::test]
    async fn cancellation_interrupts_openclaw_retry_backoff() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            drop(socket);
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_selection_kind(Some(SelectionKind::Ink));
        engine.add_text_content("test");
        let cancellation = SmartRemarkableCancellation::new();
        let cancellation_trigger = cancellation.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancellation_trigger.cancel_all();
        });

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            engine.execute(&cancellation, None),
        )
        .await
        .expect("cancellation must stop retry well before the backoff deadline");
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        cancel_task.await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn transient_bridge_unavailability_reuses_the_exact_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_request = read_http_request(&mut first).await;
            first
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let second_request = read_http_request(&mut second).await;
            let request_id =
                request_header(&second_request, "x-smart-remarkable-request-id");
            let response_body = bridge_response(
                &request_id,
                "whatsapp_only",
                "image",
                "sent",
            )
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            second.write_all(response.as_bytes()).await.unwrap();
            (first_request, second_request)
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Image));
        engine.add_text_content("test");
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let callback_statuses = Arc::clone(&statuses);
        let callback = Some(Box::new(move |status| {
            callback_statuses.lock().unwrap().push(status);
        }) as super::super::StatusCallback);

        engine
            .execute(&SmartRemarkableCancellation::new(), callback)
            .await
            .unwrap();
        let (first_request, second_request) = server.await.unwrap();
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-request-id"),
            request_header(&second_request, "x-smart-remarkable-request-id")
        );
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-response-mode"),
            request_header(&second_request, "x-smart-remarkable-response-mode")
        );
        assert_eq!(
            request_header(&first_request, "x-smart-remarkable-selection-kind"),
            request_header(&second_request, "x-smart-remarkable-selection-kind")
        );
        assert_eq!(
            request_body_bytes(&first_request),
            request_body_bytes(&second_request)
        );
        assert_eq!(
            statuses
                .lock()
                .unwrap()
                .iter()
                .filter(|status| **status == ModelExecutionStatus::RemoteAccepted)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn successful_headers_emit_acceptance_before_body_processing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let request_len = socket.read(&mut request).await.unwrap();
            let request_id = request_header(
                &request[..request_len],
                "x-smart-remarkable-request-id",
            );
            let response_body = bridge_response(
                &request_id,
                "whatsapp_only",
                "mixed",
                "delivered",
            )
            .to_string();
            let response_head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            socket.write_all(response_head.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(25)).await;
            socket.write_all(response_body.as_bytes()).await.unwrap();
        });

        let mut options = openclaw_options();
        options.insert("base_url".to_string(), format!("http://{}", address));
        let mut engine = OpenAI::new_openclaw(&options);
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Mixed));
        engine.add_text_content("test");
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let callback_statuses = Arc::clone(&statuses);
        let callback = Some(Box::new(move |status| {
            callback_statuses.lock().unwrap().push(status);
        }) as super::super::StatusCallback);

        engine
            .execute(&SmartRemarkableCancellation::new(), callback)
            .await
            .unwrap();
        server.await.unwrap();
        let statuses = statuses.lock().unwrap();
        let accepted = statuses
            .iter()
            .position(|status| *status == ModelExecutionStatus::RemoteAccepted)
            .unwrap();
        let processing = statuses
            .iter()
            .position(|status| *status == ModelExecutionStatus::ProcessingResponse)
            .unwrap();
        assert!(accepted < processing);
    }

    #[tokio::test]
    async fn openclaw_request_without_selection_kind_fails_before_transport() {
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.add_text_content("test");
        let error = engine
            .execute(&SmartRemarkableCancellation::new(), None)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("no trusted selection kind"));
    }
}
