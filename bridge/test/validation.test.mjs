import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  RESPONSE_ENVELOPE_PROTOCOL_VERSION,
} from "../src/response-envelope.mjs";
import {
  SOURCE_PROVENANCE_PROTOCOL_VERSION,
} from "../src/source-provenance.mjs";
import {
  authenticateRequest,
  validateOpenAiBody,
  validateRequestHeaders,
} from "../src/validation.mjs";

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

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

test("requires strict request mode, ID, and fixed legacy routing", () => {
  assert.deepEqual(
    validateRequestHeaders({
      "x-smart-remarkable-response-mode": "write_back",
      "x-smart-remarkable-request-id": "smart-remarkable-valid-0001",
      "x-openclaw-session-key": "agent:main:main",
      "x-openclaw-message-channel": "whatsapp",
    }),
    {
      mode: "write_back",
      requestId: "smart-remarkable-valid-0001",
    },
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        "x-smart-remarkable-response-mode": "something_else",
        "x-smart-remarkable-request-id": "smart-remarkable-valid-0001",
      }),
    /must be write_back or whatsapp_only/,
  );
  assert.throws(
    () =>
      validateRequestHeaders({
        "x-smart-remarkable-response-mode": "write_back",
        "x-smart-remarkable-request-id": "smart-remarkable-valid-0001",
        "x-openclaw-session-key": "agent:other:main",
      }),
    /server-controlled/,
  );
});

test("accepts exactly one PNG and rejects client-supplied message types", () => {
  const valid = {
    model: "openclaw/main",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "answer the handwriting" },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${PNG_BASE64}`,
            },
          },
        ],
      },
    ],
  };
  const selection = validateOpenAiBody(valid);
  assert.equal(selection.promptText, "answer the handwriting");
  assert.equal(selection.imageBase64, PNG_BASE64);
  assert.equal(
    selection.fingerprint,
    crypto
      .createHash("sha256")
      .update("openclaw/main")
      .update("\0")
      .update("answer the handwriting")
      .update("\0")
      .update(PNG_BASE64)
      .update("\0")
      .update(RESPONSE_ENVELOPE_PROTOCOL_VERSION)
      .update("\0")
      .update(SOURCE_PROVENANCE_PROTOCOL_VERSION)
      .digest("hex"),
  );

  assert.throws(
    () =>
      validateOpenAiBody({
        ...valid,
        messages: [{ role: "system", content: valid.messages[0].content }],
      }),
    /one multimodal user message/,
  );
  assert.throws(
    () =>
      validateOpenAiBody({
        ...valid,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "missing image" }],
          },
        ],
      }),
    /exactly one PNG/,
  );
});
