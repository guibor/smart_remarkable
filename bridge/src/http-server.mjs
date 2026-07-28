import http from "node:http";
import { HttpError, publicErrorMessage } from "./errors.mjs";
import {
  authenticateRequest,
  MAX_HTTP_BODY_BYTES,
  validateOpenAiBody,
  validateRequestHeaders,
} from "./validation.mjs";
import { PUBLIC_RUN_ERROR } from "./openai-response.mjs";

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new HttpError(400, "JSON request body required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON request body");
  }
}

function writeJson(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(encoded);
}

function writeAcceptedHeaders(response) {
  if (response.headersSent) {
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "transfer-encoding": "chunked",
    connection: "close",
  });
  response.flushHeaders();
}

export function createHttpServer({
  service,
  bridgeToken,
  logger = console,
}) {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    let requestId;
    let mode;
    try {
      authenticateRequest(request.headers.authorization, bridgeToken);
      ({ requestId, mode } = validateRequestHeaders(request.headers));
      const selection = validateOpenAiBody(await readJsonBody(request));

      const result = await service.submit({
        requestId,
        mode,
        selection,
        onAccepted: () => writeAcceptedHeaders(response),
      });
      writeAcceptedHeaders(response);
      response.end(JSON.stringify(result));
    } catch (error) {
      if (response.headersSent) {
        logger.error?.(`Post-acceptance bridge failure for ${requestId}`);
        response.end(
          JSON.stringify({
            id: `chatcmpl-${requestId ?? "unknown"}`,
            object: "chat.completion",
            model: "openclaw/main",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: PUBLIC_RUN_ERROR,
                },
                finish_reason: "error",
              },
            ],
            openclaw_delivery: {
              requested: true,
              channel: "whatsapp",
              final: {
                status: "failed",
                error: PUBLIC_RUN_ERROR,
              },
            },
            x_smart_remarkable: {
              request_id: requestId ?? null,
              response_mode: mode ?? null,
            },
          }),
        );
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : 502;
      logger.error?.(
        statusCode >= 500
          ? `Pre-acceptance bridge failure for ${requestId ?? "unknown"}`
          : `Rejected bridge request: ${publicErrorMessage(error)}`,
      );
      writeJson(response, statusCode, {
        error: { message: publicErrorMessage(error) },
      });
    }
  });
}
