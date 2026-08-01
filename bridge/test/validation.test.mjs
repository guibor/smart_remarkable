import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_VERSION,
  SOURCE_PROVENANCE_PROTOCOL_VERSION,
  SMART_REMARKABLE_ATTACHMENT_ROLES,
  SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  SMART_REMARKABLE_SELECTION_KINDS,
  verifyOriginBinding,
  verifyPluginCapabilities,
} from "../src/source-provenance.mjs";
import {
  authenticateRequest,
  validateOpenAiBody,
  validateRequestHeaders,
} from "../src/validation.mjs";

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

function validContext(overrides = {}) {
  return {
    version: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    document_display_name: "Project Notes",
    page_id: "page-0001",
    page_index: 2,
    page_number: 3,
    page_image_scope: "current_page_view",
    page_image_completeness: "full_page",
    ...overrides,
  };
}

function pngPart(role, image = PNG_BASE64) {
  return {
    type: "image_url",
    x_smart_remarkable_role: role,
    image_url: {
      url: `data:image/png;base64,${image}`,
    },
  };
}

function validBody(overrides = {}) {
  return {
    model: "openclaw/main",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "answer the handwriting" },
          pngPart("selection"),
          pngPart("current_page"),
        ],
      },
    ],
    x_smart_remarkable_context: validContext(),
    ...overrides,
  };
}

test("configuration refuses non-loopback listeners and gateways", () => {
  const temporaryHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-remarkable-bridge-loopback-"),
  );
  const configPath = path.join(temporaryHome, "openclaw.json");
  const sessionsPath = path.join(temporaryHome, "sessions.json");
  fs.writeFileSync(configPath, "{}\n");
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify({
      "agent:main:main": {
        chatType: "direct",
        origin: {
          provider: "whatsapp",
          to: "+15551234567",
          accountId: "personal",
        },
      },
    }),
  );
  const base = {
    SMART_REMARKABLE_BRIDGE_TOKEN:
      "a-bridge-token-that-is-longer-than-thirty-two",
    OPENCLAW_GATEWAY_TOKEN: "server-only-gateway-token",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SESSIONS_PATH: sessionsPath,
  };
  try {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          SMART_REMARKABLE_BRIDGE_HOST: "0.0.0.0",
        }),
      /must remain loopback/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          OPENCLAW_GATEWAY_URL: "ws://10.0.0.1:18789",
        }),
      /loopback URL/,
    );
    assert.equal(loadConfig(base).host, "127.0.0.1");
    assert.equal(
      loadConfig({ ...base, OPENCLAW_GATEWAY_URL: "ws://[::1]:18789" })
        .gatewayUrl,
      "ws://[::1]:18789",
    );
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("loads Gateway auth and direct WhatsApp route from canonical OpenClaw files", () => {
  const temporaryHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-remarkable-bridge-"),
  );
  const configPath = path.join(temporaryHome, "openclaw.json");
  const sessionsPath = path.join(temporaryHome, "sessions.json");
  const bridgeTokenPath = path.join(temporaryHome, "bridge-token");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ gateway: { auth: { token: "canonical-gateway-token" } } }),
  );
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify({
      "agent:main:main": {
        chatType: "direct",
        origin: {
          provider: "whatsapp",
          to: "+15551234567",
          accountId: "personal",
        },
      },
    }),
  );
  fs.writeFileSync(
    bridgeTokenPath,
    "separate-narrow-bridge-token-with-32-characters",
    { mode: 0o600 },
  );

  try {
    const loaded = loadConfig({
      SMART_REMARKABLE_BRIDGE_TOKEN_FILE: bridgeTokenPath,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SESSIONS_PATH: sessionsPath,
      SMART_REMARKABLE_REQUEST_JOURNAL_DIR: path.join(
        temporaryHome,
        "request-journal-v1",
      ),
      SMART_REMARKABLE_REQUEST_JOURNAL_MAX_ENTRIES: "123",
    });
    assert.equal(loaded.gatewayToken, "canonical-gateway-token");
    assert.equal(loaded.whatsappTo, "+15551234567");
    assert.equal(loaded.whatsappAccountId, "personal");
    assert.equal(loaded.routeSource, "main-session-origin");
    assert.equal(
      loaded.expectedSessionRoutingContract,
      "per-sender|main|main",
    );
    assert.equal(
      loaded.requestJournalDir,
      path.join(temporaryHome, "request-journal-v1"),
    );
    assert.equal(loaded.requestJournalMaxEntries, 123);
    assert.throws(
      () =>
        loadConfig({
          SMART_REMARKABLE_BRIDGE_TOKEN_FILE: bridgeTokenPath,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SESSIONS_PATH: sessionsPath,
          SMART_REMARKABLE_REQUEST_JOURNAL_DIR: "relative/journal",
        }),
      /absolute dedicated directory/,
    );
    assert.throws(
      () =>
        loadConfig({
          SMART_REMARKABLE_BRIDGE_TOKEN_FILE: bridgeTokenPath,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SESSIONS_PATH: sessionsPath,
          SMART_REMARKABLE_REQUEST_JOURNAL_MAX_ENTRIES: "100001",
        }),
      /at most 100000/,
    );
    assert.throws(
      () =>
        loadConfig({
          SMART_REMARKABLE_BRIDGE_TOKEN_FILE: bridgeTokenPath,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SESSIONS_PATH: sessionsPath,
          OPENCLAW_WHATSAPP_TO: "+19999999999",
          OPENCLAW_WHATSAPP_ACCOUNT_ID: "other",
        }),
      /route overrides are forbidden/,
    );
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("fails startup when OpenClaw no longer uses the intended main-session routing", () => {
  const temporaryHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-remarkable-bridge-routing-contract-"),
  );
  const configPath = path.join(temporaryHome, "openclaw.json");
  const sessionsPath = path.join(temporaryHome, "sessions.json");
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify({
      "agent:main:main": {
        chatType: "direct",
        origin: {
          provider: "whatsapp",
          to: "+15551234567",
          accountId: "personal",
        },
      },
    }),
  );
  const base = {
    SMART_REMARKABLE_BRIDGE_TOKEN:
      "separate-narrow-bridge-token-with-32-characters",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SESSIONS_PATH: sessionsPath,
  };
  try {
    for (const openclawConfig of [
      {
        gateway: { auth: { token: "canonical-gateway-token" } },
        session: { scope: "global" },
      },
      {
        gateway: { auth: { token: "canonical-gateway-token" } },
        session: { mainKey: "other" },
      },
      {
        gateway: { auth: { token: "canonical-gateway-token" } },
        agents: { list: [{ id: "other", default: true }] },
      },
    ]) {
      fs.writeFileSync(configPath, JSON.stringify(openclawConfig));
      assert.throws(
        () => loadConfig(base),
        /must remain per-sender\|main\|main/,
      );
    }
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("refuses a non-direct or non-WhatsApp canonical main origin", () => {
  const temporaryHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-remarkable-bridge-route-"),
  );
  const configPath = path.join(temporaryHome, "openclaw.json");
  const sessionsPath = path.join(temporaryHome, "sessions.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ gateway: { auth: { token: "canonical-gateway-token" } } }),
  );
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify({
      "agent:main:main": {
        origin: {
          provider: "telegram",
          chatType: "group",
          to: "unsafe-target",
          accountId: "default",
        },
      },
    }),
  );
  try {
    assert.throws(
      () =>
        loadConfig({
          SMART_REMARKABLE_BRIDGE_TOKEN:
            "separate-narrow-bridge-token-with-32-characters",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SESSIONS_PATH: sessionsPath,
        }),
      /origin.provider must be whatsapp/,
    );
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("requires the narrow Bearer token in constant-length-safe form", () => {
  const token = "correct-bridge-token-that-is-long-enough";
  assert.doesNotThrow(() => authenticateRequest(`Bearer ${token}`, token));
  assert.throws(
    () => authenticateRequest("Bearer wrong", token),
    /Invalid bridge token/,
  );
});

test("origin binding receipt must echo the authenticated selection kind", () => {
  const receipt = {
    protocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
    status: "bound",
    runId: "smart-remarkable-receipt-0001",
    source: "remarkable",
    mode: "whatsapp_only",
    selectionKind: "image",
    contextVersion: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    expectedSessionId: "captured-session",
    bindingHandle: "A".repeat(43),
  };
  assert.equal(
    verifyOriginBinding(
      receipt,
      receipt.runId,
      receipt.mode,
      receipt.selectionKind,
      receipt.expectedSessionId,
      receipt.contextVersion,
    ),
    receipt.bindingHandle,
  );
  assert.throws(
    () =>
      verifyOriginBinding(
        { ...receipt, selectionKind: "mixed" },
        receipt.runId,
        receipt.mode,
        "image",
        receipt.expectedSessionId,
        receipt.contextVersion,
      ),
    /did not confirm the reMarkable origin binding/,
  );
  assert.throws(
    () =>
      verifyOriginBinding(
        { ...receipt, runId: "ordinary-client-receipt-0001" },
        "ordinary-client-receipt-0001",
        receipt.mode,
        receipt.selectionKind,
        receipt.expectedSessionId,
        receipt.contextVersion,
      ),
    /did not confirm the reMarkable origin binding/,
  );
});

test("startup capability receipt must match the exact plugin contract", () => {
  const receipt = {
    status: "ready",
    pluginId: OPENCLAW_PLUGIN_ID,
    pluginVersion: OPENCLAW_PLUGIN_VERSION,
    originProtocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
    inputContextVersions: [SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION],
    attachmentRoles: [...SMART_REMARKABLE_ATTACHMENT_ROLES],
    selectionKinds: [...SMART_REMARKABLE_SELECTION_KINDS],
  };
  assert.doesNotThrow(() => verifyPluginCapabilities(receipt));
  assert.throws(
    () =>
      verifyPluginCapabilities({
        ...receipt,
        selectionKinds: ["ink", "mixed", "image"],
      }),
    /capability contract mismatch/,
  );
  assert.throws(
    () =>
      verifyPluginCapabilities({
        ...receipt,
        pluginVersion: "0.2.2",
      }),
    /capability contract mismatch/,
  );
  for (const mismatch of [
    { inputContextVersions: [] },
    {
      inputContextVersions: [
        SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
        "selection-page-v2",
      ],
    },
    { attachmentRoles: ["current_page", "selection"] },
    { attachmentRoles: ["selection", "current_page", "extra"] },
  ]) {
    assert.throws(
      () => verifyPluginCapabilities({ ...receipt, ...mismatch }),
      /capability contract mismatch/,
    );
  }
});

test("requires strict request mode, ID, and fixed legacy routing", () => {
  const validHeaders = {
    "x-smart-remarkable-response-mode": "write_back",
    "x-smart-remarkable-request-id": "smart-remarkable-valid-0001",
    "x-smart-remarkable-selection-kind": "ink",
    "x-smart-remarkable-context-version":
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  };
  assert.deepEqual(
    validateRequestHeaders({
      ...validHeaders,
      "x-openclaw-session-key": "agent:main:main",
      "x-openclaw-message-channel": "whatsapp",
    }),
    {
      mode: "write_back",
      requestId: "smart-remarkable-valid-0001",
      selectionKind: "ink",
      contextVersion: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    },
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-response-mode": "something_else",
      }),
    /must be write_back or whatsapp_only/,
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-openclaw-session-key": "agent:other:main",
      }),
    /server-controlled/,
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-selection-kind": "photo",
      }),
    /must be ink, image, or mixed/,
  );
  for (const selectionKind of ["image", "mixed"]) {
    assert.equal(
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-response-mode": "whatsapp_only",
        "x-smart-remarkable-request-id":
          `smart-remarkable-${selectionKind}-0001`,
        "x-smart-remarkable-selection-kind": selectionKind,
      }).selectionKind,
      selectionKind,
    );
  }
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-selection-kind": undefined,
      }),
    /must be ink, image, or mixed/,
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-request-id": "ordinary-client-request-0001",
      }),
    /Invalid x-smart-remarkable-request-id/,
  );
  assert.equal(
    validateRequestHeaders({
      ...validHeaders,
      "x-smart-remarkable-request-id": `smart-remarkable-${"a".repeat(111)}`,
    }).requestId.length,
    128,
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        ...validHeaders,
        "x-smart-remarkable-request-id": `smart-remarkable-${"a".repeat(112)}`,
      }),
    /Invalid x-smart-remarkable-request-id/,
  );
  for (const contextVersion of [undefined, "selection-page-v0"]) {
    assert.throws(
      () =>
        validateRequestHeaders({
          ...validHeaders,
          "x-smart-remarkable-context-version": contextVersion,
        }),
      /context-version must be selection-page-v1/,
    );
  }
});

test("accepts one text then selection and current-page PNGs", () => {
  const valid = validBody();
  const selection = validateOpenAiBody(
    valid,
    "ink",
    SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  );
  assert.equal(selection.promptText, "answer the handwriting");
  assert.equal(selection.selectionImageBase64, PNG_BASE64);
  assert.equal(selection.currentPageImageBase64, PNG_BASE64);
  assert.equal(selection.selectionKind, "ink");
  assert.deepEqual(selection.captureContext, {
    version: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    documentDisplayName: "Project Notes",
    pageId: "page-0001",
    pageIndex: 2,
    pageNumber: 3,
    pageImageScope: "current_page_view",
    pageImageCompleteness: "full_page",
  });
  assert.match(selection.fingerprint, /^[a-f0-9]{64}$/);

  assert.throws(
    () =>
      validateOpenAiBody(
        {
          ...valid,
          messages: [
            { role: "system", content: valid.messages[0].content },
          ],
        },
        "ink",
        SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
      ),
    /one user message/,
  );
  assert.throws(
    () =>
      validateOpenAiBody(
        {
          ...valid,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "missing image" }],
            },
          ],
        },
        "ink",
        SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
      ),
    /exactly three content items/,
  );
  assert.notEqual(
    validateOpenAiBody(
      valid,
      "image",
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    ).fingerprint,
    selection.fingerprint,
  );
  assert.notEqual(
    validateOpenAiBody(
      valid,
      "mixed",
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    ).fingerprint,
    selection.fingerprint,
  );
  assert.throws(
    () =>
      validateOpenAiBody(
        valid,
        "photo",
        SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
      ),
    /must be ink, image, or mixed/,
  );
});

test("rejects reordered, untagged, extra, or oversized image content", () => {
  const valid = validBody();
  const validate = (body) =>
    validateOpenAiBody(
      body,
      "ink",
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    );
  for (const content of [
    [valid.messages[0].content[0], valid.messages[0].content[2], valid.messages[0].content[1]],
    [valid.messages[0].content[0], { ...valid.messages[0].content[1], x_smart_remarkable_role: undefined }, valid.messages[0].content[2]],
    [...valid.messages[0].content, { type: "text", text: "extra" }],
  ]) {
    assert.throws(
      () => validate({ ...valid, messages: [{ role: "user", content }] }),
      /role-tagged|exactly three content items/,
    );
  }

  const largePng = Buffer.alloc(4 * 1024 * 1024 + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largePng);
  const largeBase64 = largePng.toString("base64");
  assert.throws(
    () =>
      validate({
        ...valid,
        messages: [{
          role: "user",
          content: [
            valid.messages[0].content[0],
            pngPart("selection", largeBase64),
            pngPart("current_page", largeBase64),
          ],
        }],
      }),
    /Combined PNG content must be at most 8 MiB/,
  );

  const oversizedPng = Buffer.alloc(6 * 1024 * 1024 + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    oversizedPng,
  );
  assert.throws(
    () =>
      validate({
        ...valid,
        messages: [{
          role: "user",
          content: [
            valid.messages[0].content[0],
            pngPart("selection", oversizedPng.toString("base64")),
            valid.messages[0].content[2],
          ],
        }],
      }),
    /selection image must be a PNG of at most 6 MiB/,
  );
});

test("strictly validates and fingerprints all page context", () => {
  const base = validBody();
  const fingerprint = (body) =>
    validateOpenAiBody(
      body,
      "ink",
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    ).fingerprint;
  const original = fingerprint(base);
  const contextMutations = [
    { document_display_name: "Other Notes" },
    { page_id: "page-0002" },
    { page_index: 3, page_number: 4 },
    { page_image_completeness: "viewport_only" },
  ];
  for (const mutation of contextMutations) {
    assert.notEqual(
      fingerprint({
        ...base,
        x_smart_remarkable_context: validContext(mutation),
      }),
      original,
    );
  }
  const differentPagePng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]).toString("base64");
  assert.notEqual(
    fingerprint({
      ...base,
      messages: [{
        role: "user",
        content: [
          base.messages[0].content[0],
          base.messages[0].content[1],
          pngPart("current_page", differentPagePng),
        ],
      }],
    }),
    original,
  );
  const differentSelectionPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02,
  ]).toString("base64");
  assert.notEqual(
    fingerprint({
      ...base,
      messages: [{
        role: "user",
        content: [
          base.messages[0].content[0],
          pngPart("selection", differentSelectionPng),
          base.messages[0].content[2],
        ],
      }],
    }),
    original,
  );

  for (const context of [
    validContext({ document_display_name: "Cafe\u0301" }),
    validContext({ document_display_name: "bad\nname" }),
    validContext({ document_display_name: "x".repeat(1025) }),
    validContext({ page_id: "bad page" }),
    validContext({ page_number: 99 }),
    validContext({ page_image_scope: "screen" }),
    validContext({ page_image_completeness: "unknown" }),
    { ...validContext(), extra: true },
  ]) {
    assert.throws(
      () =>
        fingerprint({
          ...base,
          x_smart_remarkable_context: context,
        }),
      /document_display_name|page_id|page_index|page_image_scope|page_image_completeness|must contain exactly/,
    );
  }
  assert.throws(
    () =>
      validateOpenAiBody(base, "ink", "selection-page-v0"),
    /Body and header context versions/,
  );
  assert.throws(
    () =>
      validateOpenAiBody(
        { ...base, temperature: 0 },
        "ink",
        SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
      ),
    /must contain exactly model, messages, and x_smart_remarkable_context/,
  );
});
