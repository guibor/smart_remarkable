use super::{status_update, LLMEngine, Tool};
use crate::cancellation::{with_cancellation, SmartRemarkableCancellation};
use crate::util::{option_or_env, option_or_env_fallback, OptionMap};
use anyhow::Result;
use log::debug;
use serde_json::json;
use serde_json::Value as json;
use std::time::Duration;

pub struct OpenAI {
    model: String,
    base_url: String,
    api_key: String,
    plain_text_response: bool,
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

    /// Build the OpenAI-compatible transport for an OpenClaw Gateway.
    /// OpenClaw runs its own agent/tools and returns final text; the client
    /// then routes that text through the already-registered draw_text tool.
    pub fn new_openclaw(options: &OptionMap) -> Self {
        let api_key = option_or_env(options, "api_key", "OPENCLAW_GATEWAY_TOKEN");
        let base_url = option_or_env_fallback(options, "base_url", "OPENCLAW_BASE_URL", "http://127.0.0.1:18789");
        let model = options.get("model").unwrap().to_string();

        Self {
            model,
            base_url,
            api_key,
            plain_text_response: true,
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
        if self.plain_text_response {
            // Keep reMarkable work off OpenClaw's default/main conversation
            // lane, which may simultaneously be serving WhatsApp.
            body["user"] = json!("smart-remarkable-rmpp");
        } else {
            body["tools"] = json!(self.tools.iter().map(Self::tool_definition_json).collect::<Vec<_>>());
            body["tool_choice"] = json!("required");
            body["parallel_tool_calls"] = json!(false);
        }
        body
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

    async fn execute(&mut self, cancellation: &SmartRemarkableCancellation, mut status_callback: Option<super::StatusCallback>) -> Result<()> {
        let body = self.request_body();

        debug!("Request: {}", body);

        // Notify that we're building context
        status_update!(status_callback, super::ModelExecutionStatus::BuildingContext);

        // Notify that we're processing with LLM
        status_update!(status_callback, super::ModelExecutionStatus::LlmProcessing);

        // Create async HTTP request with cancellation support
        let request_future = async {
            let client = if self.plain_text_response {
                reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(15))
                    .timeout(Duration::from_secs(180))
                    .build()?
            } else {
                reqwest::Client::new()
            };
            let response = client
                .post(format!("{}/v1/chat/completions", self.base_url))
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await?;

            if !response.status().is_success() {
                return Err(anyhow::anyhow!("API Error: {}", response.status()));
            }

            let body_text = response.text().await?;
            let json: json = serde_json::from_str(&body_text)?;
            Ok(json)
        };

        let json: json = with_cancellation(request_future, cancellation).await?;
        debug!("Response: {}", json);

        // Notify that we're processing the response
        status_update!(status_callback, super::ModelExecutionStatus::ProcessingResponse);

        if self.plain_text_response {
            let text = Self::message_text(&json)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .ok_or_else(|| anyhow::anyhow!("No text found in OpenClaw response"))?;
            let tool = self.tools.iter_mut().find(|tool| tool.name == "draw_text");
            if let Some(tool) = tool {
                if let Some(callback) = &mut tool.callback {
                    status_update!(status_callback, super::ModelExecutionStatus::CallingTools);
                    callback(json!({"text": text}));
                    status_update!(status_callback, super::ModelExecutionStatus::Done);
                    return Ok(());
                }
            }
            status_update!(
                status_callback,
                super::ModelExecutionStatus::Error("No draw_text callback registered".to_string())
            );
            return Err(anyhow::anyhow!("No draw_text callback registered"));
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
    use crate::llm_engine::LLMEngine;
    use crate::util::OptionMap;
    use serde_json::json;

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

    #[test]
    fn openclaw_request_uses_a_dedicated_session_without_client_tools() {
        let mut options = OptionMap::new();
        options.insert("model".to_string(), "openclaw/default".to_string());
        options.insert("base_url".to_string(), "http://127.0.0.1:18789".to_string());
        options.insert("api_key".to_string(), "test-gateway-token".to_string());
        let mut engine = OpenAI::new_openclaw(&options);
        engine.add_text_content("What is 7 + 3?");

        let body = engine.request_body();
        assert_eq!(body["user"], "smart-remarkable-rmpp");
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }
}
