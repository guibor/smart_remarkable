use super::{status_update, LLMEngine, ResponseMode, SelectionKind, Tool};
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

pub struct OpenAI {
    model: String,
    base_url: String,
    api_key: String,
    plain_text_response: bool,
    response_mode: ResponseMode,
    selection_kind: Option<SelectionKind>,
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
        let mut body = json!({
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": self.content
            }]
        });
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
            .header("Authorization", format!("Bearer {}", self.api_key))
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
        }

        request.json(body)
    }

    fn validate_bridge_response(&self, response: &json, request_id: &str) -> Result<bool> {
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
    }

    fn set_response_mode(&mut self, mode: ResponseMode) {
        self.response_mode = mode;
    }

    fn set_selection_kind(&mut self, kind: Option<SelectionKind>) {
        self.selection_kind = kind;
    }

    async fn execute(&mut self, cancellation: &SmartRemarkableCancellation, mut status_callback: Option<super::StatusCallback>) -> Result<()> {
        if self.plain_text_response && self.selection_kind.is_none() {
            return Err(anyhow::anyhow!(
                "OpenClaw bridge request has no trusted selection kind"
            ));
        }
        let body = self.request_body();

        debug!(
            "OpenAI-compatible request prepared (model={}, content_items={}, tool_count={})",
            self.model,
            self.content.len(),
            self.tools.len()
        );

        // Notify that we're building context
        status_update!(status_callback, super::ModelExecutionStatus::BuildingContext);

        // Notify that we're processing with LLM
        status_update!(status_callback, super::ModelExecutionStatus::LlmProcessing);

        // Build the request before entering the async cancellation future so
        // the future owns it and does not borrow the engine's non-Sync tool
        // callbacks across an await point.
        let client = if self.plain_text_response {
            reqwest::Client::builder()
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
        let request = self.request_builder(&client, &body, &request_id);

        // Wait only for response headers first. The OpenClaw bridge deliberately
        // flushes a successful status after Gateway chat.send's onAccepted
        // event, while the final answer is still running.
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

        let body_text = with_cancellation(
            async { Ok::<_, anyhow::Error>(response.text().await?) },
            cancellation,
        )
        .await?;
        let json: json = serde_json::from_str(&body_text)?;
        debug!("OpenAI-compatible response received and parsed");

        // Notify that we're processing the response
        status_update!(status_callback, super::ModelExecutionStatus::ProcessingResponse);

        if self.plain_text_response {
            let replayed = self.validate_bridge_response(&json, &request_id)?;
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
    use crate::llm_engine::{LLMEngine, ModelExecutionStatus, ResponseMode, SelectionKind};
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

    fn request_header(request: &[u8], name: &str) -> String {
        String::from_utf8_lossy(request)
            .split("\r\n")
            .filter_map(|line| line.split_once(':'))
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_else(|| panic!("missing request header {name}"))
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
        assert_eq!(request.url().as_str(), "http://127.0.0.1:18791/v1/chat/completions");
    }

    #[test]
    fn direct_openai_request_does_not_receive_openclaw_selection_headers() {
        let mut options = OptionMap::new();
        options.insert("model".to_string(), "gpt-test".to_string());
        options.insert("base_url".to_string(), "https://api.openai.example".to_string());
        options.insert("api_key".to_string(), "test-key".to_string());
        let mut engine = OpenAI::new(&options);
        engine.set_selection_kind(Some(SelectionKind::Mixed));
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
    }

    #[test]
    fn bridge_response_requires_matching_request_mode_and_delivery() {
        let request_id = "smart-remarkable-test-0002";
        let mut engine = OpenAI::new_openclaw(&openclaw_options());
        engine.set_response_mode(ResponseMode::WhatsappOnly);
        engine.set_selection_kind(Some(SelectionKind::Image));
        let valid = bridge_response(request_id, "whatsapp_only", "image", "sent");
        assert!(engine
            .validate_bridge_response(&valid, request_id)
            .is_ok_and(|replayed| !replayed));

        let wrong_id = bridge_response(
            "smart-remarkable-test-other",
            "whatsapp_only",
            "image",
            "sent",
        );
        assert!(engine
            .validate_bridge_response(&wrong_id, request_id)
            .is_err());

        let wrong_mode = bridge_response(request_id, "write_back", "image", "sent");
        assert!(engine
            .validate_bridge_response(&wrong_mode, request_id)
            .is_err());

        let wrong_kind = bridge_response(request_id, "whatsapp_only", "ink", "sent");
        assert!(engine
            .validate_bridge_response(&wrong_kind, request_id)
            .is_err());

        let mut missing_kind =
            bridge_response(request_id, "whatsapp_only", "image", "sent");
        missing_kind["x_smart_remarkable"]
            .as_object_mut()
            .unwrap()
            .remove("selection_kind");
        assert!(engine
            .validate_bridge_response(&missing_kind, request_id)
            .is_err());

        let failed_delivery =
            bridge_response(request_id, "whatsapp_only", "image", "failed");
        assert!(engine
            .validate_bridge_response(&failed_delivery, request_id)
            .is_err());

        let mut failed_ack =
            bridge_response(request_id, "whatsapp_only", "image", "sent");
        failed_ack["openclaw_delivery"]["acknowledgement"]["status"] =
            json!("failed");
        assert!(engine
            .validate_bridge_response(&failed_ack, request_id)
            .is_err());

        let merely_requested =
            bridge_response(request_id, "whatsapp_only", "image", "requested");
        assert!(engine
            .validate_bridge_response(&merely_requested, request_id)
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
    async fn http_failure_never_emits_remote_accepted() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
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
