export const PUBLIC_ACK_ERROR =
  "WhatsApp acknowledgement could not be confirmed.";
export const PUBLIC_FINAL_ERROR =
  "WhatsApp final delivery could not be confirmed.";
export const PUBLIC_RUN_ERROR =
  "OpenClaw could not complete this selection.";
export const WHATSAPP_ONLY_RECEIPT =
  "OpenClaw handled this selection through WhatsApp.";

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
  replayed,
  created = Math.floor(Date.now() / 1000),
}) {
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
    x_smart_remarkable: {
      request_id: requestId,
      response_mode: mode,
      selection_kind: selectionKind,
      context_version: contextVersion,
      replayed,
    },
  };
}
