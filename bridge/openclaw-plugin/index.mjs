import crypto from "node:crypto";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createFileReceiptJournal } from "./file-receipt-journal.mjs";
import { createRunContextControl } from "./run-context-control.mjs";
import {
  REMARKABLE_PLUGIN_ID,
  createOriginAdmissionRegistry,
  registerRemarkableOriginHooks,
  registerRemarkableOriginMethods,
  registerRemarkableUploadTool,
} from "./remarkable-upload.mjs";

export {
  DEFAULT_RM_SYNC_CONFIG,
  DEFAULT_RM_SYNC_PYTHON,
  REMARKABLE_CAPABILITIES_METHOD,
  REMARKABLE_BIND_ORIGIN_METHOD,
  REMARKABLE_CLEAR_ORIGIN_METHOD,
  REMARKABLE_PLUGIN_ID,
  REMARKABLE_PLUGIN_VERSION,
  REMARKABLE_RUN_CONTEXT_NAMESPACE,
  REMARKABLE_SELECTION_KINDS,
  REMARKABLE_UPLOAD_TOOL,
  createOriginAdmissionRegistry,
  createOriginBindingHandlers,
  createRemarkableOriginHooks,
  createRemarkableUploadTool,
  registerRemarkableOriginHooks,
  registerRemarkableOriginMethods,
  registerRemarkableUploadTool,
} from "./remarkable-upload.mjs";
export {
  RUN_CONTEXT_CONTROL_STREAM,
  RUN_CONTEXT_CONTROL_SUBSCRIPTION_ID,
  createRunContextControl,
} from "./run-context-control.mjs";

export const DELIVERY_METHOD = "smart_remarkable.deliver";
export const CANONICAL_SESSION_KEY = "agent:main:main";
export const CANONICAL_AGENT_ID = "main";

export function requireRemarkableHookPolicy(api) {
  const hooks =
    api?.config?.plugins?.entries?.[REMARKABLE_PLUGIN_ID]?.hooks;
  if (
    api?.id !== REMARKABLE_PLUGIN_ID ||
    hooks?.allowPromptInjection !== true ||
    hooks?.allowConversationAccess !== true
  ) {
    throw new Error(
      "Smart reMarkable requires explicit prompt-injection and conversation-access hook policy",
    );
  }
}

const DELIVERY_SCOPE = "operator.write";
const MAX_TEXT_BYTES = 32 * 1024;
const REQUEST_ID_PATTERN =
  /^smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$/;
const ALLOWED_KINDS = new Set(["ack", "final"]);
const EXACT_PARAM_KEYS = Object.freeze(["kind", "requestId", "text"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicError(code, message) {
  return { code, message };
}

function validateParams(params) {
  if (!isRecord(params)) {
    throw publicError("INVALID_REQUEST", "Delivery params must be an object");
  }
  const keys = Object.keys(params).sort();
  if (
    keys.length !== EXACT_PARAM_KEYS.length ||
    keys.some((key, index) => key !== EXACT_PARAM_KEYS[index])
  ) {
    throw publicError(
      "INVALID_REQUEST",
      "Delivery params must contain only requestId, kind, and text",
    );
  }
  if (
    typeof params.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(params.requestId)
  ) {
    throw publicError("INVALID_REQUEST", "Invalid delivery request ID");
  }
  if (typeof params.kind !== "string" || !ALLOWED_KINDS.has(params.kind)) {
    throw publicError("INVALID_REQUEST", "Delivery kind must be ack or final");
  }
  if (
    typeof params.text !== "string" ||
    params.text.trim() === "" ||
    Buffer.byteLength(params.text, "utf8") > MAX_TEXT_BYTES
  ) {
    throw publicError(
      "INVALID_REQUEST",
      "Delivery text must be non-empty and at most 32768 UTF-8 bytes",
    );
  }

  const deliveryId = `${params.requestId}:${params.kind}`;
  const fingerprint = crypto
    .createHash("sha256")
    .update(deliveryId)
    .update("\0")
    .update(params.text)
    .digest("hex");
  return Object.freeze({
    requestId: params.requestId,
    deliveryId,
    kind: params.kind,
    text: params.text,
    fingerprint,
  });
}

function validateCanonicalRoute(runtime) {
  const entry = runtime.agent.session.getSessionEntry({
    agentId: CANONICAL_AGENT_ID,
    sessionKey: CANONICAL_SESSION_KEY,
    readConsistency: "latest",
  });
  const origin = entry?.origin;
  const chatType = origin?.chatType ?? entry?.chatType;
  if (
    !isRecord(origin) ||
    origin.provider !== "whatsapp" ||
    chatType !== "direct" ||
    (origin.threadId !== undefined && origin.threadId !== null)
  ) {
    throw new Error(
      "Canonical session is not an unthreaded direct WhatsApp conversation",
    );
  }
  if (
    typeof origin.to !== "string" ||
    origin.to.trim() === "" ||
    origin.to !== origin.to.trim() ||
    origin.to.length > 256 ||
    /[\0\r\n]/.test(origin.to) ||
    typeof origin.accountId !== "string" ||
    origin.accountId.trim() === "" ||
    origin.accountId !== origin.accountId.trim() ||
    origin.accountId.length > 128 ||
    /[\0\r\n]/.test(origin.accountId)
  ) {
    throw new Error(
      "Canonical WhatsApp route is missing a bounded to or accountId",
    );
  }
  return Object.freeze({
    to: origin.to,
    accountId: origin.accountId,
  });
}

function validateDeliveryReceipt(result, deliveryId) {
  if (
    result?.status !== "sent" ||
    !Array.isArray(result.results) ||
    result.results.length === 0 ||
    !isRecord(result.receipt)
  ) {
    throw new Error("Native WhatsApp delivery did not return a sent receipt");
  }
  const messageIds = new Set();
  for (const item of result.results) {
    if (
      !isRecord(item) ||
      item.channel !== "whatsapp" ||
      typeof item.messageId !== "string" ||
      !item.messageId.trim()
    ) {
      throw new Error("Native WhatsApp delivery returned an invalid result");
    }
    messageIds.add(item.messageId.trim());
  }
  const primaryMessageId = result.receipt.primaryPlatformMessageId;
  if (
    typeof primaryMessageId !== "string" ||
    !primaryMessageId.trim() ||
    !messageIds.has(primaryMessageId.trim())
  ) {
    throw new Error(
      "Native WhatsApp delivery receipt did not match its platform result",
    );
  }
  return Object.freeze({
    runId: deliveryId,
    status: "sent",
    channel: "whatsapp",
    messageId: primaryMessageId.trim(),
  });
}

function sameRequest(record, request) {
  return (
    isRecord(record) &&
    record.schemaVersion === 1 &&
    record.fingerprint === request.fingerprint &&
    record.kind === request.kind
  );
}

function conflictError() {
  return publicError(
    "INVALID_REQUEST",
    "Delivery request ID was already used for different content",
  );
}

function unavailableError() {
  return publicError(
    "UNAVAILABLE",
    "WhatsApp delivery could not be confirmed without duplicate risk",
  );
}

async function loadOrReserve({ store, request }) {
  let existing = await store.lookup(request.deliveryId);
  if (!existing) {
    const inserted = await store.registerIfAbsent(
      request.deliveryId,
      {
        schemaVersion: 1,
        fingerprint: request.fingerprint,
        kind: request.kind,
        state: "reserved",
      },
    );
    if (inserted) {
      return { kind: "reserved" };
    }
    existing = await store.lookup(request.deliveryId);
    if (!existing) {
      throw new Error("Delivery journal reservation disappeared");
    }
  }
  if (!sameRequest(existing, request)) {
    throw conflictError();
  }
  if (
    existing.state === "sent" &&
    isRecord(existing.receipt) &&
    existing.receipt.runId === request.deliveryId &&
    existing.receipt.status === "sent" &&
    existing.receipt.channel === "whatsapp" &&
    typeof existing.receipt.messageId === "string" &&
    existing.receipt.messageId.trim()
  ) {
    return {
      kind: "cached",
      receipt: {
        runId: existing.receipt.runId,
        status: "sent",
        channel: "whatsapp",
        messageId: existing.receipt.messageId.trim(),
      },
    };
  }
  // A reservation that survived the owning promise may be pre-send or
  // post-send. There is no safe provider-level proof that distinguishes the
  // two, so a restarted plugin must never resend it automatically.
  throw unavailableError();
}

async function markAmbiguous(store, request) {
  try {
    await store.register(
      request.deliveryId,
      {
        schemaVersion: 1,
        fingerprint: request.fingerprint,
        kind: request.kind,
        state: "ambiguous",
      },
    );
  } catch {
    // The original durable reservation remains fail-closed.
  }
}

async function executeDelivery({
  request,
  runtime,
  context,
  store,
  sendBatch,
}) {
  const route = validateCanonicalRoute(runtime);
  const reservation = await loadOrReserve({ store, request });
  if (reservation.kind === "cached") {
    return { payload: reservation.receipt, cached: true };
  }

  let receipt;
  try {
    const cfg = context?.getRuntimeConfig?.();
    if (!isRecord(cfg)) {
      throw new Error("Gateway runtime configuration is unavailable");
    }
    const result = await sendBatch({
      cfg,
      channel: "whatsapp",
      to: route.to,
      accountId: route.accountId,
      payloads: [{ text: request.text }],
      durability: "required",
      gatewayClientScopes: [DELIVERY_SCOPE],
    });
    receipt = validateDeliveryReceipt(result, request.deliveryId);
  } catch (error) {
    await markAmbiguous(store, request);
    throw error;
  }

  try {
    await store.register(
      request.deliveryId,
      {
        schemaVersion: 1,
        fingerprint: request.fingerprint,
        kind: request.kind,
        state: "sent",
        receipt,
      },
    );
  } catch (error) {
    // The platform accepted the message, but without a durable receipt we
    // cannot safely tell a future process to reuse rather than resend.
    throw new Error("WhatsApp sent but receipt journal commit failed", {
      cause: error,
    });
  }
  return { payload: receipt, cached: false };
}

export function createDeliveryHandler({
  runtime,
  logger,
  store = createFileReceiptJournal({
    stateDir: runtime.state.resolveStateDir(),
  }),
  sendBatch = sendDurableMessageBatch,
}) {
  const inFlight = new Map();

  return async function handleDelivery({ params, respond, context }) {
    let request;
    try {
      request = validateParams(params);
    } catch (error) {
      const safe = error?.code ? error : publicError("INVALID_REQUEST", "Invalid delivery request");
      respond(false, undefined, safe);
      return;
    }

    const existing = inFlight.get(request.deliveryId);
    if (existing && existing.fingerprint !== request.fingerprint) {
      respond(false, undefined, conflictError());
      return;
    }

    let promise = existing?.promise;
    if (!promise) {
      promise = executeDelivery({
        request,
        runtime,
        context,
        store,
        sendBatch,
      });
      inFlight.set(request.deliveryId, {
        fingerprint: request.fingerprint,
        promise,
      });
    }

    try {
      const result = await promise;
      respond(true, result.payload, undefined, {
        cached: Boolean(existing) || result.cached,
      });
    } catch (error) {
      if (error?.code === "INVALID_REQUEST") {
        respond(false, undefined, conflictError());
      } else {
        logger?.error?.(
          `Smart reMarkable WhatsApp delivery failed for ${request.deliveryId}`,
        );
        respond(false, undefined, unavailableError());
      }
    } finally {
      if (inFlight.get(request.deliveryId)?.promise === promise) {
        inFlight.delete(request.deliveryId);
      }
    }
  };
}

export function registerDeliveryMethod(api, overrides = {}) {
  const handler = createDeliveryHandler({
    runtime: api.runtime,
    logger: api.logger,
    ...overrides,
  });
  api.registerGatewayMethod(DELIVERY_METHOD, handler, {
    scope: DELIVERY_SCOPE,
  });
}

export default definePluginEntry({
  id: "smart-remarkable-delivery",
  name: "Smart reMarkable delivery",
  description:
    "Native WhatsApp continuity and safe reMarkable Cloud document delivery.",
  register(api) {
    requireRemarkableHookPolicy(api);
    const runContext = createRunContextControl({ api });
    const admissionRegistry = createOriginAdmissionRegistry();
    registerDeliveryMethod(api);
    registerRemarkableOriginMethods(api, {
      admissionRegistry,
      runContext,
    });
    registerRemarkableUploadTool(api, { runContext });
    registerRemarkableOriginHooks(api, { runContext });
  },
});
