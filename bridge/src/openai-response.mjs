import {
  RESPONSE_PDF_DESTINATION,
  RESPONSE_PDF_POLICY,
} from "./source-provenance.mjs";

export const PUBLIC_ACK_ERROR =
  "WhatsApp acknowledgement could not be confirmed.";
export const PUBLIC_FINAL_ERROR =
  "WhatsApp final delivery could not be confirmed.";
export const PUBLIC_RUN_ERROR =
  "OpenClaw could not complete this selection.";
export const PUBLIC_REMARKABLE_DOCUMENT_ERROR =
  "reMarkable response PDF delivery could not be confirmed.";
export const WHATSAPP_ONLY_RECEIPT =
  "OpenClaw handled this selection through WhatsApp.";
export const REMARKABLE_ARTIFACT_POLICY = RESPONSE_PDF_POLICY;

const CLOUD_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isSafePdfName(value) {
  return (
    typeof value === "string" &&
    value.length > 4 &&
    value === value.normalize("NFC") &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    !/[\u0000-\u001f\u007f-\u009f/\\]/u.test(value) &&
    /\.pdf$/iu.test(value)
  );
}

function buildRemarkableDocumentResponse(outcome) {
  if (
    hasExactKeys(outcome, ["status"]) &&
    outcome.status === "failed"
  ) {
    return {
      requested: true,
      destination: RESPONSE_PDF_DESTINATION,
      status: "failed",
      error: PUBLIC_REMARKABLE_DOCUMENT_ERROR,
    };
  }
  if (
    !hasExactKeys(outcome, [
      "cached",
      "cloudHash",
      "documentId",
      "name",
      "status",
    ]) ||
    outcome.status !== "uploaded" ||
    !isSafePdfName(outcome.name) ||
    typeof outcome.documentId !== "string" ||
    !CLOUD_DOCUMENT_ID_PATTERN.test(outcome.documentId) ||
    typeof outcome.cloudHash !== "string" ||
    !CLOUD_HASH_PATTERN.test(outcome.cloudHash) ||
    typeof outcome.cached !== "boolean"
  ) {
    throw new TypeError("Invalid reMarkable response PDF outcome");
  }
  return {
    requested: true,
    destination: RESPONSE_PDF_DESTINATION,
    status: "uploaded",
    name: outcome.name,
    document_id: outcome.documentId.toLowerCase(),
    cloud_hash: outcome.cloudHash.toLowerCase(),
    cached: outcome.cached,
  };
}

function responseContent(mode, text) {
  return mode === "whatsapp_only" ? WHATSAPP_ONLY_RECEIPT : text;
}

export function buildSuccessResponse({
  requestId,
  mode,
  selectionKind,
  contextVersion,
  text,
  ack,
  finalDelivery,
  remarkableDocument,
  replayed,
  created = Math.floor(Date.now() / 1000),
}) {
  const remarkableDocumentResponse =
    buildRemarkableDocumentResponse(remarkableDocument);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created,
    model: "openclaw/main",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: responseContent(mode, text),
        },
        finish_reason: "stop",
      },
    ],
    openclaw_delivery: {
      requested: true,
      channel: "whatsapp",
      acknowledgement: ack.ok
        ? { status: "sent" }
        : { status: "failed", error: PUBLIC_ACK_ERROR },
      final: finalDelivery.ok
        ? { status: "sent" }
        : {
            status: "failed",
            error: PUBLIC_FINAL_ERROR,
          },
    },
    remarkable_document: remarkableDocumentResponse,
    x_smart_remarkable: {
      request_id: requestId,
      response_mode: mode,
      selection_kind: selectionKind,
      context_version: contextVersion,
      replayed,
    },
  };
}

export function buildPostAcceptanceErrorResponse({
  requestId,
  mode,
  selectionKind,
  contextVersion,
  ack,
  replayed,
  created = Math.floor(Date.now() / 1000),
}) {
  const message = PUBLIC_RUN_ERROR;
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created,
    model: "openclaw/main",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: message },
        finish_reason: "error",
      },
    ],
    openclaw_delivery: {
      requested: true,
      channel: "whatsapp",
      acknowledgement: ack?.ok
        ? { status: "sent" }
        : {
            status: ack ? "failed" : "unknown",
            ...(ack ? { error: PUBLIC_ACK_ERROR } : {}),
          },
      final: {
        status: "failed",
        error: PUBLIC_RUN_ERROR,
      },
    },
    remarkable_document: {
      requested: true,
      destination: RESPONSE_PDF_DESTINATION,
      status: "failed",
      error: PUBLIC_REMARKABLE_DOCUMENT_ERROR,
    },
    x_smart_remarkable: {
      request_id: requestId,
      response_mode: mode,
      selection_kind: selectionKind,
      context_version: contextVersion,
      replayed,
    },
  };
}
