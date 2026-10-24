//! Actual subscribed Dot inbox, not an OpenAI-compatible inference endpoint.
//! Request content stays in RAM; retries reuse the same immutable UUID/body.
use super::{status_update, LLMEngine, ModelExecutionStatus, ResponseMode, SelectionKind, SelectionPageContext, StatusCallback, Tool};
use crate::cancellation::{with_cancellation, SmartRemarkableCancellation};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read, time::Duration};
use unicode_normalization::UnicodeNormalization;

const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_IMAGES: usize = 4 * 1024 * 1024;
const WAIT_LIMIT: Duration = Duration::from_secs(180);

pub struct Dot {
    base_url: String,
    key: String,
    mode: ResponseMode,
    kind: Option<SelectionKind>,
    context: Option<SelectionPageContext>,
    tools: HashMap<String, Tool>,
}

fn mode_name(mode: ResponseMode) -> &'static str {
    if mode.writes_to_tablet() {
        "answer_here"
    } else {
        "send_to_dot"
    }
}

fn endpoint(base: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(base).context("Invalid Dot endpoint")?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().trim_end_matches('/') == "/dot",
        "Dot requires a credential-free HTTPS /dot endpoint"
    );
    reqwest::Url::parse(&format!("{}/selection", base.trim_end_matches('/'))).map_err(Into::into)
}

fn new_request_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Python's sorted ensure_ascii JSON, including UTF-16 pairs for astral chars.
/// serde_json's default map is sorted; escaping the resulting Unicode scalar
/// values gives the server's canonical representation without reinterpreting it.
fn canonical_json(value: &Value) -> Result<String> {
    let json = serde_json::to_string(value)?;
    let mut result = String::new();
    for c in json.chars() {
        if c.is_ascii() {
            result.push(c);
        } else {
            for code in c.encode_utf16(&mut [0u16; 2]) {
                result.push_str(&format!("\\u{code:04x}"));
            }
        }
    }
    Ok(result)
}

fn request(context: &SelectionPageContext, kind: SelectionKind, mode: ResponseMode, id: &str) -> Result<(Value, String)> {
    let selected = STANDARD.decode(&context.selection_image_base64).context("Invalid selection image")?;
    let page = STANDARD.decode(&context.current_page_image_base64).context("Invalid page image")?;
    ensure!(selected.len() + page.len() <= MAX_IMAGES, "Dot selection images exceed 4 MiB");
    for bytes in [&selected, &page] {
        ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "Dot selection must be PNG");
    }
    let title: String = context.document_display_name.nfc().collect();
    ensure!(
        !title.trim().is_empty() && title.len() <= 1024 && !title.chars().any(char::is_control),
        "Invalid notebook title"
    );
    ensure!(
        !context.page_id.is_empty()
            && context.page_id.len() <= 128
            && context.page_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && context.page_index < 1_000_000,
        "Invalid notebook page identity"
    );
    let context_json = json!({
        "version": super::SELECTION_PAGE_CONTEXT_VERSION,
        "document_display_name": title, "page_id": context.page_id,
        "page_index": context.page_index, "page_number": context.page_index + 1,
        "page_image_scope": "current_page_view",
        "page_image_completeness": context.page_image_completeness.as_str(),
    });
    let binding = json!({"api_version": "dot-selection-v1", "source": "smart-remarkable",
        "request_id": id, "mode": mode_name(mode), "selection_kind": kind.as_str(),
        "context": context_json, "selection_sha256": sha256(&selected), "current_page_sha256": sha256(&page)});
    let fingerprint = sha256(canonical_json(&binding)?.as_bytes());
    Ok((
        json!({"request_id": id, "mode": mode_name(mode), "selection_kind": kind.as_str(),
        "selection_image_base64": context.selection_image_base64,
        "current_page_image_base64": context.current_page_image_base64, "context": context_json}),
        fingerprint,
    ))
}

fn validate_result<'a>(result: &'a Value, id: &str, mode: ResponseMode, fingerprint: &str) -> Result<Option<&'a str>> {
    ensure!(
        result["accepted"] == true
            && result["api_version"] == "dot-selection-v1"
            && result["source"] == "smart-remarkable"
            && result["request_id"] == id
            && result["mode"] == mode_name(mode)
            && result["request_fingerprint"] == fingerprint
            && result["local_insertion"] == "not_attempted",
        "Dot result did not match the submitted selection"
    );
    let status = result["status"].as_str().context("Missing Dot status")?;
    if status == "answered" {
        let reply = result["reply_markdown"].as_str().context("Dot answer missing")?;
        ensure!(
            !reply.trim().is_empty() && reply.len() <= 120_000 && result["reply_sha256"] == sha256(reply.as_bytes()),
            "Dot reply digest/size invalid"
        );
        Ok(Some(reply))
    } else {
        ensure!(
            ["queued", "awaiting_dot", "notification_failed", "connection_expired"].contains(&status) && result["reply_markdown"].is_null(),
            "Unknown Dot response state"
        );
        Ok(None)
    }
}

async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    ensure!(response.content_length().unwrap_or(0) <= MAX_RESPONSE as u64, "Dot response too large");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= MAX_RESPONSE, "Dot response too large");
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("Invalid Dot response")
}

async fn submit(client: &reqwest::Client, url: reqwest::Url, key: &str, body: &Value, cancellation: &SmartRemarkableCancellation) -> Result<Value> {
    with_cancellation(
        async {
            for attempt in 0..3 {
                match client.post(url.clone()).header("X-Api-Key", key).json(body).send().await {
                    Ok(response) if response.status() == reqwest::StatusCode::ACCEPTED => {
                        if let Ok(result) = bounded_json(response).await {
                            return Ok(result);
                        }
                        // Acceptance followed by a truncated body is ambiguous.
                        // Retrying the SAME body/ID recovers that durable request.
                    }
                    Ok(response) if !response.status().is_server_error() => bail!("Dot submission rejected (HTTP {})", response.status().as_u16()),
                    _ => {}
                }
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(2 + attempt)).await;
                }
            }
            bail!("Dot acceptance could not be confirmed; no new request ID was submitted")
        },
        cancellation,
    )
    .await
}

#[async_trait::async_trait]
impl LLMEngine for Dot {
    fn new(options: &HashMap<String, String>) -> Self {
        Self {
            base_url: options
                .get("base_url")
                .cloned()
                .or_else(|| std::env::var("DOT_BASE_URL").ok())
                .unwrap_or_default(),
            key: options
                .get("api_key")
                .cloned()
                .or_else(|| std::env::var("DOT_TABLET_KEY").ok())
                .unwrap_or_default(),
            mode: ResponseMode::WriteBack,
            kind: None,
            context: None,
            tools: HashMap::new(),
        }
    }
    fn register_tool(&mut self, name: &str, definition: Value, callback: Box<dyn FnMut(Value) + Send>) {
        self.tools.insert(
            name.into(),
            Tool {
                name: name.into(),
                definition,
                callback: Some(callback),
            },
        );
    }
    // The shared server policy owns Dot instructions. Never forward local
    // model prompts or tool schemas as if Dot should execute them.
    fn add_text_content(&mut self, _: &str) {}
    fn add_image_content(&mut self, _: &str) {}
    fn clear_content(&mut self) {
        self.context = None;
    }
    fn set_response_mode(&mut self, mode: ResponseMode) {
        self.mode = mode;
    }
    fn set_selection_kind(&mut self, kind: Option<SelectionKind>) {
        self.kind = kind;
    }
    fn set_selection_page_context(&mut self, context: Option<SelectionPageContext>) {
        self.context = context;
    }

    async fn execute(&mut self, cancellation: &SmartRemarkableCancellation, mut status_callback: Option<StatusCallback>) -> Result<()> {
        ensure!(!self.mode.writes_to_tablet(), "Dot answer-writing is disabled; use Send to Dot");
        let url = endpoint(&self.base_url)?;
        ensure!(!self.key.is_empty(), "Dot tablet key is not configured");
        let context = self.context.take().context("Dot needs a verified same-capture page context (v3 selection)")?;
        let id = new_request_id()?;
        let (body, fingerprint) = request(&context, self.kind.context("Missing selection kind")?, self.mode, &id)?;
        drop(context);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()?;
        status_update!(status_callback, ModelExecutionStatus::LlmProcessing);
        let result = submit(&client, url.clone(), &self.key, &body, cancellation).await?;
        drop(body);
        validate_result(&result, &id, self.mode, &fingerprint)?;
        status_update!(status_callback, ModelExecutionStatus::RemoteAccepted);
        log::info!("Dot accepted selection {}; delivery is asynchronous", id);
        if !self.mode.writes_to_tablet() {
            status_update!(status_callback, ModelExecutionStatus::Done);
            return Ok(());
        }
        let poll_url = reqwest::Url::parse(&format!("{url}/{id}"))?;
        let deadline = tokio::time::Instant::now() + WAIT_LIMIT;
        let reply = with_cancellation(
            async {
                let mut result = result;
                let mut interval = 2;
                loop {
                    if let Some(reply) = validate_result(&result, &id, self.mode, &fingerprint)? {
                        return Ok(Some(reply.to_string()));
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Ok(None);
                    }
                    tokio::time::sleep(Duration::from_secs(interval)).await;
                    interval = (interval + 2).min(10);
                    match client.get(poll_url.clone()).header("X-Api-Key", &self.key).send().await {
                        Ok(response) if response.status() == reqwest::StatusCode::OK => result = bounded_json(response).await?,
                        Ok(response) if !response.status().is_server_error() => {
                            bail!("Dot polling rejected (HTTP {}); answer remains in Dot", response.status().as_u16())
                        }
                        _ => continue,
                    }
                }
            },
            cancellation,
        )
        .await?;
        if let Some(markdown) = reply {
            status_update!(status_callback, ModelExecutionStatus::ProcessingResponse);
            // No remote tool execution. Exactly one locally-owned presentation
            // callback may consume the Markdown, with independent view guards.
            let callback = self
                .tools
                .get_mut("dot_answer")
                .and_then(|tool| tool.callback.as_mut())
                .context("Guarded Dot answer renderer unavailable; use Dot/PDF response")?;
            callback(json!({"markdown": markdown, "request_id": id}));
        } else {
            log::info!("Dot is still working; local insertion window closed, use Dot/PDF response");
        }
        status_update!(status_callback, ModelExecutionStatus::Done);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn answer_writing_is_rejected_before_network_or_tools() {
        let mut dot = Dot::new(&HashMap::new());
        dot.register_tool("dot_answer", json!({}), Box::new(|_| panic!("writer reached")));
        let error = dot.execute(&SmartRemarkableCancellation::new(), None).await.unwrap_err();
        assert!(error.to_string().contains("answer-writing is disabled"));
    }
    #[test]
    fn endpoints_are_https_and_credential_free() {
        assert!(endpoint("https://example.test/dot").is_ok());
        for bad in [
            "http://example.test/dot",
            "https://key@example.test/dot",
            "https://example.test/dot?k=1",
            "https://example.test/else",
        ] {
            assert!(endpoint(bad).is_err());
        }
    }
    #[test]
    fn canonical_unicode_matches_python() {
        assert_eq!(
            canonical_json(&json!({"z":"😀", "a":"שלום"})).unwrap(),
            r#"{"a":"\u05e9\u05dc\u05d5\u05dd","z":"\ud83d\ude00"}"#
        );
    }
    #[test]
    fn uuid_is_v4_and_unique() {
        let a = new_request_id().unwrap();
        let b = new_request_id().unwrap();
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert_ne!(a, b);
    }
    #[test]
    fn results_are_bound_and_digest_checked() {
        let mut value = json!({"accepted":true,"api_version":"dot-selection-v1","source":"smart-remarkable", "request_id":"id", "mode":"answer_here", "request_fingerprint":"fp", "status":"answered", "reply_markdown":"hello", "reply_sha256":sha256(b"hello"), "local_insertion":"not_attempted"});
        assert_eq!(validate_result(&value, "id", ResponseMode::WriteBack, "fp").unwrap(), Some("hello"));
        assert!(validate_result(&value, "other", ResponseMode::WriteBack, "fp").is_err());
        assert!(validate_result(&value, "id", ResponseMode::WhatsappOnly, "fp").is_err());
        assert!(validate_result(&value, "id", ResponseMode::WriteBack, "changed").is_err());
        value["reply_markdown"] = json!("changed");
        assert!(validate_result(&value, "id", ResponseMode::WriteBack, "fp").is_err());
    }
    #[test]
    fn request_matches_python_bridge_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/dot-contract.json")).unwrap();
        let body = &fixture["body"];
        let ctx = &body["context"];
        let context = SelectionPageContext {
            selection_image_base64: body["selection_image_base64"].as_str().unwrap().into(),
            current_page_image_base64: body["current_page_image_base64"].as_str().unwrap().into(),
            document_display_name: ctx["document_display_name"].as_str().unwrap().into(),
            page_id: ctx["page_id"].as_str().unwrap().into(),
            page_index: 0,
            page_image_completeness: crate::touch::PageImageCompleteness::ViewportOnly,
        };
        let (actual, fingerprint) = request(&context, SelectionKind::Ink, ResponseMode::WriteBack, body["request_id"].as_str().unwrap()).unwrap();
        assert_eq!(fingerprint, fixture["fingerprint"]);
        let mut expected = body.clone();
        expected["context"]["page_image_scope"] = json!("current_page_view");
        assert_eq!(actual, expected);
        let (_, other) = request(&context, SelectionKind::Ink, ResponseMode::WhatsappOnly, body["request_id"].as_str().unwrap()).unwrap();
        assert_ne!(other, fingerprint);
    }

    #[tokio::test]
    async fn interrupted_acceptance_retries_identical_body_and_auth() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/dot/selection", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let mut captured = Vec::new();
            for i in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0u8; 1024];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let len: usize = headers.lines().find_map(|l| l.strip_prefix("content-length: ")).unwrap().parse().unwrap();
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                captured.push(bytes);
                let response = if i == 0 {
                    "HTTP/1.1 202 Accepted\r\nContent-Length: 99\r\nConnection: close\r\n\r\n{"
                } else {
                    "HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            captured
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let result = submit(
            &client,
            url,
            "synthetic-test-key",
            &json!({"request_id":"fixed"}),
            &SmartRemarkableCancellation::new(),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"ok":true}));
        let requests = server.await.unwrap();
        assert_eq!(requests[0], requests[1]);
        assert!(String::from_utf8_lossy(&requests[0]).contains("x-api-key: synthetic-test-key"));
    }
}
