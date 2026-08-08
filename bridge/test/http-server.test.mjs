import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createHttpServer } from "../src/http-server.mjs";
import { createRequestJournal } from "../src/request-journal.mjs";
import { createCapabilityReadiness } from "../src/service-runtime.mjs";
import {
  buildResponseEnvelopeProtocolInstruction,
  RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION,
} from "../src/response-envelope.mjs";
import { SelectionService } from "../src/selection-service.mjs";
import {
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_VERSION,
  ORIGIN_CAPABILITIES_METHOD,
  ORIGIN_BIND_METHOD,
  ORIGIN_CLEAR_METHOD,
  RESPONSE_PDF_DESTINATION,
  RESPONSE_PDF_METHOD,
  RESPONSE_PDF_POLICY,
  SOURCE_PROVENANCE_PROTOCOL_VERSION,
  SMART_REMARKABLE_ATTACHMENT_ROLES,
  SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  SMART_REMARKABLE_SELECTION_KINDS,
  SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
  SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION,
} from "../src/source-provenance.mjs";

const BRIDGE_TOKEN = "bridge-test-token-that-is-at-least-32-characters";
const DELIVERY_METHOD = "smart_remarkable.deliver";
const DEFAULT_RECEIVED_TEXT = "What is six times seven?";
const ORIGIN_BINDING_HANDLE = "A".repeat(43);
const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");
const PAGE_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]).toString("base64");

const config = Object.freeze({
  whatsappTo: "+15551234567",
  whatsappAccountId: "personal",
  channel: "whatsapp",
  agentId: "main",
  sessionKey: "agent:main:main",
  expectedSessionRoutingContract: "per-sender|main|main",
  runTimeoutMs: 250,
  sendTimeoutMs: 100,
  historyPollIntervalMs: 5,
});

function responseEnvelope(
  responseText,
  receivedText = DEFAULT_RECEIVED_TEXT,
) {
  return JSON.stringify({
    received_text: receivedText,
    response_text: responseText,
  });
}

function renderedResponse(
  responseText,
  receivedText = DEFAULT_RECEIVED_TEXT,
  requestId = "smart-remarkable-test-0001",
) {
  return `I read:\n> ${receivedText}\n\n${responseText}\n\nPDF: sent to your reMarkable Cloud library as ${pdfName(requestId)}.`;
}

function pdfName(requestId) {
  const suffix = crypto
    .createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 16);
  return `OpenClaw response ${suffix}.pdf`;
}

function pdfReceipt(requestId, overrides = {}) {
  return {
    status: "uploaded",
    request_id: requestId,
    artifact_key: RESPONSE_PDF_POLICY,
    name: pdfName(requestId),
    document_id: "123e4567-e89b-42d3-a456-426614174000",
    cloud_hash: "a".repeat(64),
    cached: false,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function exactCapabilities() {
  return {
    status: "ready",
    pluginId: OPENCLAW_PLUGIN_ID,
    pluginVersion: OPENCLAW_PLUGIN_VERSION,
    originProtocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
    responsePdfMethod: RESPONSE_PDF_METHOD,
    responsePdfPolicy: RESPONSE_PDF_POLICY,
    responsePdfDestination: RESPONSE_PDF_DESTINATION,
    inputContextVersions: [SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION],
    attachmentRoles: [...SMART_REMARKABLE_ATTACHMENT_ROLES],
    selectionKinds: [...SMART_REMARKABLE_SELECTION_KINDS],
  };
}

class FakeGateway {
  constructor() {
    this.calls = [];
    this.listeners = new Set();
    this.connectionListeners = new Set();
    this.connectionGeneration = 1;
    this.nextConnectionGeneration = 1;
    this.capabilityCalls = 0;
    this.capabilities = exactCapabilities();
    this.chat = [];
    this.ackError = null;
    this.ackDeferred = null;
    this.finalError = null;
    this.pdfError = null;
    this.pdfDeferred = null;
    this.pdfResultOverride = null;
    this.sendResultOverride = null;
    this.chatResultOverride = null;
    this.historyResult = {
      sessionId: "test-canonical-session",
      messages: [],
    };
    this.historyError = null;
    this.historyCallCount = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeConnection(listener) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  getConnectionGeneration() {
    return this.connectionGeneration;
  }

  async requestForGeneration(generation, method, params, options = {}) {
    if (
      generation !== this.connectionGeneration ||
      this.connectionGeneration === null
    ) {
      throw new Error("Gateway generation is unavailable");
    }
    const result = await this.request(method, params, options);
    if (generation !== this.connectionGeneration) {
      throw new Error("Gateway generation changed during request");
    }
    return result;
  }

  disconnect() {
    this.connectionGeneration = null;
    for (const listener of this.connectionListeners) {
      listener({ connected: false, generation: null });
    }
  }

  reconnect() {
    this.connectionGeneration = ++this.nextConnectionGeneration;
    for (const listener of this.connectionListeners) {
      listener({
        connected: true,
        generation: this.connectionGeneration,
      });
    }
  }

  request(method, params, options = {}) {
    if (method === ORIGIN_CAPABILITIES_METHOD) {
      this.capabilityCalls += 1;
      return Promise.resolve(this.capabilities);
    }
    this.calls.push({ method, params, options });
    if (method === DELIVERY_METHOD) {
      if (params.kind === "ack" && this.ackError) {
        return Promise.reject(this.ackError);
      }
      if (params.kind === "ack" && this.ackDeferred) {
        return this.ackDeferred.promise;
      }
      if (params.kind === "final" && this.finalError) {
        return Promise.reject(this.finalError);
      }
      const runId = `${params.requestId}:${params.kind}`;
      if (typeof this.sendResultOverride === "function") {
        return Promise.resolve(this.sendResultOverride(params));
      }
      return Promise.resolve(
        this.sendResultOverride ?? {
          status: "sent",
          runId,
          messageId: `message-${runId}`,
          channel: "whatsapp",
        },
      );
    }
    if (method === RESPONSE_PDF_METHOD) {
      if (this.pdfError) {
        return Promise.reject(this.pdfError);
      }
      if (this.pdfDeferred) {
        return this.pdfDeferred.promise;
      }
      const receipt = pdfReceipt(params.requestId);
      return Promise.resolve(
        typeof this.pdfResultOverride === "function"
          ? this.pdfResultOverride(params)
          : (this.pdfResultOverride ?? receipt),
      );
    }
    if (method === "chat.history") {
      this.historyCallCount += 1;
      if (this.historyError) {
        return Promise.reject(this.historyError);
      }
      const result =
        typeof this.historyResult === "function"
          ? this.historyResult({
              callCount: this.historyCallCount,
              params,
              options,
            })
          : this.historyResult;
      return Promise.resolve(
        result &&
          typeof result === "object" &&
          Object.hasOwn(result, "sessionId")
          ? result
          : { ...result, sessionId: "test-canonical-session" },
      );
    }
    if (method === ORIGIN_BIND_METHOD) {
      const bindCallCount = this.calls.filter(
        (call) =>
          call.method === ORIGIN_BIND_METHOD &&
          call.params.requestId === params.requestId,
      ).length;
      return Promise.resolve({
        protocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
        status: bindCallCount === 1 ? "bound" : "active",
        runId: params.requestId,
        source: "remarkable",
        mode: params.mode,
        selectionKind: params.selectionKind,
        contextVersion: params.contextVersion,
        expectedSessionId: params.expectedSessionId,
        bindingHandle: ORIGIN_BINDING_HANDLE,
      });
    }
    if (method === ORIGIN_CLEAR_METHOD) {
      return Promise.resolve({
        status: "cleared",
        runId: params.requestId,
      });
    }
    assert.equal(method, "chat.send");
    const completion = deferred();
    this.chat.push({ params, options, completion });
    if (this.chatResultOverride !== null) {
      return Promise.resolve(
        typeof this.chatResultOverride === "function"
          ? this.chatResultOverride({ params, options })
          : this.chatResultOverride,
      );
    }
    return completion.promise;
  }

  accept(index = 0, payload = undefined) {
    const chat = this.chat[index];
    assert.ok(chat, `missing chat call ${index}`);
    chat.options.onAccepted(
      payload ?? {
        status: "accepted",
        runId: chat.params.idempotencyKey,
      },
    );
  }

  resolveChat(payload, index = 0) {
    const chat = this.chat[index];
    assert.ok(chat, `missing chat call ${index}`);
    chat.completion.resolve(payload);
  }

  finish(
    responseText,
    index = 0,
    receivedText = DEFAULT_RECEIVED_TEXT,
  ) {
    this.finishRaw(responseEnvelope(responseText, receivedText), index);
  }

  finishRaw(text, index = 0) {
    const chat = this.chat[index];
    assert.ok(chat, `missing chat call ${index}`);
    if (
      this.historyResult &&
      typeof this.historyResult === "object" &&
      !Array.isArray(this.historyResult)
    ) {
      this.historyResult = {
        ...this.historyResult,
        messages: [
          {
            role: "user",
            idempotencyKey: `${chat.params.idempotencyKey}:user`,
            content: [{ type: "text", text: chat.params.message }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        ],
      };
    }
    for (const listener of this.listeners) {
      listener({
        event: "chat",
        payload: {
          state: "final",
          runId: chat.params.idempotencyKey,
          sessionKey: config.sessionKey,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        },
      });
    }
    chat.completion.resolve({
      status: "ok",
      runId: chat.params.idempotencyKey,
    });
  }

  failBeforeAcceptance(error, index = 0) {
    this.chat[index].completion.reject(error);
  }

  failAfterAcceptance(errorMessage, index = 0) {
    const chat = this.chat[index];
    for (const listener of this.listeners) {
      listener({
        event: "chat",
        payload: {
          state: "error",
          runId: chat.params.idempotencyKey,
          sessionKey: config.sessionKey,
          errorMessage,
        },
      });
    }
    chat.completion.resolve({
      status: "error",
      runId: chat.params.idempotencyKey,
      summary: errorMessage,
    });
  }
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

async function fixture({
  journalRoot: suppliedJournalRoot,
  journalMaxEntries = 100,
  configOverrides = {},
} = {}) {
  const ownsJournalRoot = !suppliedJournalRoot;
  const journalRoot =
    suppliedJournalRoot ??
    (await fs.mkdtemp(
      path.join(os.tmpdir(), "smart-remarkable-request-journal-"),
    ));
  const gateway = new FakeGateway();
  const requestJournal = createRequestJournal({
    rootDirectory: journalRoot,
    maxEntries: journalMaxEntries,
  });
  await requestJournal.prepare();
  const capabilityReadiness = createCapabilityReadiness({
    gateway,
    timeoutMs: config.sendTimeoutMs,
  });
  await capabilityReadiness.ensureReady();
  const service = new SelectionService({
    gateway,
    config: { ...config, ...configOverrides },
    requestJournal,
    capabilityReadiness,
    logger: { error() {} },
  });
  const server = createHttpServer({
    service,
    bridgeToken: BRIDGE_TOKEN,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let stopped = false;
  const shutdown = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  };
  cleanups.push(async () => {
    await shutdown();
    if (ownsJournalRoot) {
      await fs.rm(journalRoot, { recursive: true, force: true });
    }
  });
  return {
    gateway,
    journalRoot,
    port: server.address().port,
    service,
    shutdown,
  };
}

function requestBody(prompt = "Read the handwriting and answer.") {
  return {
    model: "openclaw/main",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            x_smart_remarkable_role: "selection",
            image_url: {
              url: `data:image/png;base64,${PNG_BASE64}`,
            },
          },
          {
            type: "image_url",
            x_smart_remarkable_role: "current_page",
            image_url: {
              url: `data:image/png;base64,${PAGE_PNG_BASE64}`,
            },
          },
        ],
      },
    ],
    x_smart_remarkable_context: {
      version: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
      document_display_name: "Project Notes Confidential",
      page_id: "page-0001",
      page_index: 2,
      page_number: 3,
      page_image_scope: "current_page_view",
      page_image_completeness: "full_page",
    },
  };
}

function isDeliveryKind(call, kind) {
  return call.method === DELIVERY_METHOD && call.params.kind === kind;
}

function post({
  port,
  requestId,
  mode,
  selectionKind = "ink",
  contextVersion = SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  body = requestBody(),
  token = BRIDGE_TOKEN,
}) {
  const responseDeferred = deferred();
  const bodyDeferred = deferred();
  const encoded = JSON.stringify(body);
  const request = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
        "x-smart-remarkable-response-mode": mode,
        "x-smart-remarkable-request-id": requestId,
        "x-smart-remarkable-selection-kind": selectionKind,
        "x-smart-remarkable-context-version": contextVersion,
        "x-openclaw-session-key": "agent:main:main",
        "x-openclaw-message-channel": "whatsapp",
      },
    },
    (response) => {
      responseDeferred.resolve(response);
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        bodyDeferred.resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    },
  );
  request.on("error", (error) => {
    responseDeferred.reject(error);
    bodyDeferred.reject(error);
  });
  request.end(encoded);
  return {
    response: responseDeferred.promise,
    body: bodyDeferred.promise,
  };
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      })
      .on("error", reject);
  });
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("serves the tunnel health probe without exposing credentials", async () => {
  const { gateway, port } = await fixture();
  const result = await getHealth(port);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json, { status: "ok" });
  assert.equal(gateway.capabilityCalls, 1);
  assert.equal(gateway.calls.length, 0);
});

test("disconnect and capability drift block health and admission before journal reservation", async () => {
  const { gateway, journalRoot, port } = await fixture();
  const capacityDirectory = path.join(journalRoot, ".capacity-slots");
  assert.equal((await fs.readdir(capacityDirectory)).length, 0);

  gateway.disconnect();
  assert.deepEqual(await getHealth(port), {
    statusCode: 503,
    json: { status: "unavailable" },
  });
  const disconnected = await post({
    port,
    requestId: "smart-remarkable-disconnected-0001",
    mode: "write_back",
  }).body;
  assert.equal(disconnected.statusCode, 502);
  assert.equal((await fs.readdir(capacityDirectory)).length, 0);
  assert.equal(gateway.calls.length, 0);

  gateway.capabilities = {
    ...exactCapabilities(),
    pluginVersion: "0.2.2",
  };
  gateway.reconnect();
  assert.deepEqual(await getHealth(port), {
    statusCode: 503,
    json: { status: "unavailable" },
  });
  const mismatched = await post({
    port,
    requestId: "smart-remarkable-mismatched-plugin-0001",
    mode: "write_back",
  }).body;
  assert.equal(mismatched.statusCode, 502);
  assert.equal((await fs.readdir(capacityDirectory)).length, 0);
  assert.equal(gateway.calls.length, 0);

  gateway.capabilities = exactCapabilities();
  assert.deepEqual(await getHealth(port), {
    statusCode: 200,
    json: { status: "ok" },
  });
  assert.equal(gateway.capabilityCalls, 4);
});

test("withholds HTTP headers until Gateway acceptance, then returns final text", async () => {
  const { gateway, port } = await fixture();
  const pending = post({
    port,
    requestId: "smart-remarkable-test-0001",
    mode: "write_back",
  });

  let headersSeen = false;
  pending.response.then(() => {
    headersSeen = true;
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  assert.equal(gateway.chat.length, 1);
  assert.equal(headersSeen, false);

  gateway.accept();
  const response = await pending.response;
  assert.equal(response.statusCode, 200);
  assert.equal(headersSeen, true);

  let bodySeen = false;
  pending.body.then(() => {
    bodySeen = true;
  });
  await nextTurn();
  assert.equal(bodySeen, false);

  gateway.finish("The answer is 42.", 0, "What is six times seven?");
  const result = await pending.body;
  assert.equal(result.json.choices[0].message.content, "The answer is 42.");
  assert.equal(result.json.x_smart_remarkable.selection_kind, "ink");
  assert.equal(
    result.json.x_smart_remarkable.context_version,
    SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  );
  assert.equal(result.json.openclaw_delivery.acknowledgement.status, "sent");
  assert.equal(result.json.openclaw_delivery.final.status, "sent");
  assert.deepEqual(result.json.remarkable_document, {
    requested: true,
    destination: RESPONSE_PDF_DESTINATION,
    status: "uploaded",
    name: pdfName("smart-remarkable-test-0001"),
    document_id: "123e4567-e89b-42d3-a456-426614174000",
    cloud_hash: "a".repeat(64),
    cached: false,
  });

  const chatCalls = gateway.calls.filter((call) => call.method === "chat.send");
  const ackCalls = gateway.calls.filter((call) =>
    isDeliveryKind(call, "ack"),
  );
  const finalCalls = gateway.calls.filter((call) =>
    isDeliveryKind(call, "final"),
  );
  const responsePdfCalls = gateway.calls.filter(
    (call) => call.method === RESPONSE_PDF_METHOD,
  );
  assert.equal(chatCalls.length, 1);
  assert.equal(ackCalls.length, 1);
  assert.equal(finalCalls.length, 1);
  assert.equal(responsePdfCalls.length, 1);
  assert.deepEqual(responsePdfCalls[0].params, {
    requestId: "smart-remarkable-test-0001",
    bindingHandle: ORIGIN_BINDING_HANDLE,
    receivedText: "What is six times seven?",
    responseText: "The answer is 42.",
  });
  const originBindCalls = gateway.calls.filter(
    (call) => call.method === ORIGIN_BIND_METHOD,
  );
  const originClearCalls = gateway.calls.filter(
    (call) => call.method === ORIGIN_CLEAR_METHOD,
  );
  assert.equal(originBindCalls.length, 2);
  assert.equal(originClearCalls.length, 1);
  assert.deepEqual(originBindCalls[0].params, {
    protocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
    requestId: "smart-remarkable-test-0001",
    mode: "write_back",
    selectionKind: "ink",
    contextVersion: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    expectedSessionId: "test-canonical-session",
  });
  assert.deepEqual(originBindCalls[1].params, originBindCalls[0].params);
  assert.deepEqual(originClearCalls[0].params, {
    requestId: "smart-remarkable-test-0001",
    bindingHandle: ORIGIN_BINDING_HANDLE,
  });
  assert.ok(
    gateway.calls.indexOf(originBindCalls[0]) <
      gateway.calls.indexOf(chatCalls[0]),
    "trusted origin must be bound before chat.send",
  );
  assert.ok(
    gateway.calls.indexOf(originBindCalls[1]) >
      gateway.calls.indexOf(chatCalls[0]) &&
      gateway.calls.indexOf(originBindCalls[1]) <
        gateway.calls.indexOf(responsePdfCalls[0]),
    "the active hook origin must be latched after acceptance and before the response PDF",
  );
  assert.ok(
    gateway.calls.indexOf(originClearCalls[0]) >
      gateway.calls.indexOf(finalCalls[0]),
    "trusted origin must remain active through final delivery",
  );
  assert.ok(
    gateway.calls.indexOf(responsePdfCalls[0]) <
      gateway.calls.indexOf(finalCalls[0]),
    "the final WhatsApp status must follow the terminal PDF receipt",
  );
  assert.deepEqual(
    {
      sessionKey: chatCalls[0].params.sessionKey,
      deliver: chatCalls[0].params.deliver,
      originatingChannel: chatCalls[0].params.originatingChannel,
      originatingTo: chatCalls[0].params.originatingTo,
      originatingAccountId: chatCalls[0].params.originatingAccountId,
      idempotencyKey: chatCalls[0].params.idempotencyKey,
      expectedSessionRoutingContract:
        chatCalls[0].params.expectedSessionRoutingContract,
      systemInputProvenance:
        chatCalls[0].params.systemInputProvenance,
    },
    {
      sessionKey: "agent:main:main",
      deliver: false,
      originatingChannel: "whatsapp",
      originatingTo: "+15551234567",
      originatingAccountId: "personal",
      idempotencyKey: "smart-remarkable-test-0001",
      expectedSessionRoutingContract: "per-sender|main|main",
      systemInputProvenance:
        SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
    },
  );
  assert.ok(
    chatCalls[0].params.message.startsWith(
      "Read the handwriting and answer.\n\n",
    ),
  );
  assert.ok(
    chatCalls[0].params.message.endsWith(
      RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION,
    ),
  );
  assert.equal(
    chatCalls[0].params.message
      .split(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION).length - 1,
    1,
    "the response-envelope protocol must be appended exactly once",
  );
  assert.equal(
    chatCalls[0].params.message
      .split(SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION).length - 1,
    1,
    "trusted transport context must be appended exactly once",
  );
  assert.match(
    SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION,
    /authorize exactly one server-generated response PDF/u,
  );
  assert.match(
    SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION,
    /do not authorize any other side effect/u,
  );
  assert.equal(chatCalls[0].params.message.includes("/verbose"), false);
  assert.equal(chatCalls[0].params.suppressCommandInterpretation, true);
  assert.deepEqual(chatCalls[0].params.attachments, [
    {
      type: "image",
      mimeType: "image/png",
      fileName: "remarkable-selection.png",
      content: PNG_BASE64,
    },
    {
      type: "image",
      mimeType: "image/png",
      fileName: "remarkable-current-page.png",
      content: PAGE_PNG_BASE64,
    },
  ]);
  assert.match(
    chatCalls[0].params.message,
    /Trusted Smart reMarkable capture manifest selection-page-v1/,
  );
  assert.match(
    chatCalls[0].params.message,
    /"display_name":"Project Notes Confidential"/,
  );
  assert.match(
    chatCalls[0].params.message,
    /remarkable-selection\.png.*primary_user_focus/is,
  );
  assert.match(
    chatCalls[0].params.message,
    /remarkable-current-page\.png.*supporting_page_context/is,
  );
  assert.match(
    chatCalls[0].params.message,
    /received_text.*selection attachment.*Never transcribe/is,
  );
  assert.equal(
    ackCalls[0].params.requestId,
    "smart-remarkable-test-0001",
  );
  assert.equal(ackCalls[0].params.kind, "ack");
  assert.equal(
    ackCalls[0].params.text,
    "I’m reading your reMarkable selection now.",
  );
  assert.equal(ackCalls[0].params.sessionKey, undefined);
  assert.equal(
    finalCalls[0].params.requestId,
    "smart-remarkable-test-0001",
  );
  assert.equal(finalCalls[0].params.kind, "final");
  assert.equal(finalCalls[0].params.to, undefined);
  assert.equal(finalCalls[0].params.accountId, undefined);
  assert.equal(finalCalls[0].params.channel, undefined);
  assert.equal(
    finalCalls[0].params.text,
    renderedResponse("The answer is 42."),
  );
  assert.equal(finalCalls[0].params.sessionKey, undefined);
  assert.ok(
    gateway.calls.indexOf(ackCalls[0]) < gateway.calls.indexOf(finalCalls[0]),
    "ack send must be submitted before final send",
  );
});

test("captures the starting session for exact transcript recovery without repinning chat.send", async () => {
  const requestId = "smart-remarkable-remapped-session-0001";
  const sessionsDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-sessions-"),
  );
  cleanups.push(() =>
    fs.rm(sessionsDirectory, { recursive: true, force: true }),
  );
  const sessionsPath = path.join(sessionsDirectory, "sessions.json");
  await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(
      sessionsDirectory,
      "captured-session.jsonl.reset.2026-07-28T10-00-00.000Z",
    ),
    [
      {
        type: "session",
        id: "captured-session",
        version: 3,
      },
      {
        type: "message",
        message: {
          role: "user",
          idempotencyKey: `${requestId}:user`,
          content: [{ type: "text", text: "selection" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          idempotencyKey: "assistant-final",
          content: [
            {
              type: "text",
              text: responseEnvelope(
                "Recovered from the captured transcript.",
              ),
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const { gateway, port } = await fixture({
    configOverrides: { openclawSessionsPath: sessionsPath },
  });
  gateway.historyResult = ({ callCount }) =>
    callCount === 1
      ? { sessionId: "captured-session", messages: [] }
      : {
          sessionId: "replacement-session",
          messages: [
            {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              provenance: SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
              content: [{ type: "text", text: "replacement request" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: responseEnvelope(
                    "REPLACEMENT_HISTORY_MUST_NOT_BE_USED",
                  ),
                },
              ],
            },
          ],
        };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  assert.equal(
    gateway.chat[0].params.sessionId,
    undefined,
    "a captured session ID is for recovery only and must not be sent back",
  );
  gateway.accept();
  gateway.resolveChat({ status: "accepted", runId: requestId });

  const result = await pending.body;
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.json.choices[0].message.content,
    "Recovered from the captured transcript.",
  );
  assert.equal(
    JSON.stringify(result.json).includes(
      "REPLACEMENT_HISTORY_MUST_NOT_BE_USED",
    ),
    false,
  );
  assert.ok(
    gateway.historyCallCount >= 2,
    "completion must first reconcile canonical Gateway history",
  );
});

test("recovers an exact post-admission automatic session successor after proving the captured reset is unanchored", async () => {
  const requestId = "smart-remarkable-session-rollover-0001";
  const sessionsDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-sessions-"),
  );
  cleanups.push(() =>
    fs.rm(sessionsDirectory, { recursive: true, force: true }),
  );
  const sessionsPath = path.join(sessionsDirectory, "sessions.json");
  await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(
      sessionsDirectory,
      "captured-session.jsonl.reset.2026-07-28T10-00-00.000Z",
    ),
    `${JSON.stringify({
      type: "session",
      id: "captured-session",
      version: 3,
    })}\n`,
    { mode: 0o600 },
  );

  const { gateway, port } = await fixture({
    configOverrides: {
      openclawSessionsPath: sessionsPath,
      runTimeoutMs: 75,
    },
  });
  gateway.historyResult = ({ callCount }) =>
    callCount === 1
      ? { sessionId: "captured-session", messages: [] }
      : {
          sessionId: "replacement-session",
          messages: [
            {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              provenance: SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
              content: [{ type: "text", text: "replacement request" }],
            },
            ...(callCount >= 3
              ? [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: responseEnvelope(
                          "Recovered from the new canonical session.",
                        ),
                      },
                    ],
                  },
                ]
              : []),
          ],
        };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.resolveChat({ status: "accepted", runId: requestId });
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "stop");
  assert.equal(
    result.json.choices[0].message.content,
    "Recovered from the new canonical session.",
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    1,
  );
  assert.ok(
    gateway.historyCallCount >= 3,
    "rollover recovery must tolerate the exact request pending in the new session",
  );
});

test("an anchored pending captured session blocks successor history and its live final", async () => {
  const requestId = "smart-remarkable-anchored-pending-rollover-0001";
  const sessionsDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-sessions-"),
  );
  cleanups.push(() =>
    fs.rm(sessionsDirectory, { recursive: true, force: true }),
  );
  const sessionsPath = path.join(sessionsDirectory, "sessions.json");
  await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(
      sessionsDirectory,
      "captured-session.jsonl.reset.2026-07-28T10-00-00.000Z",
    ),
    [
      {
        type: "session",
        id: "captured-session",
        version: 3,
      },
      {
        type: "message",
        message: {
          role: "user",
          idempotencyKey: `${requestId}:user`,
          content: [{ type: "text", text: "captured request" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const { gateway, port } = await fixture({
    configOverrides: {
      openclawSessionsPath: sessionsPath,
      runTimeoutMs: 75,
    },
  });
  gateway.historyResult = ({ callCount }) =>
    callCount === 1
      ? { sessionId: "captured-session", messages: [] }
      : {
          sessionId: "replacement-session",
          messages: [
            {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              provenance: SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
              content: [{ type: "text", text: "successor request" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: responseEnvelope(
                    "SUCCESSOR_HISTORY_MUST_NOT_BE_USED",
                  ),
                },
              ],
            },
          ],
        };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("SUCCESSOR_LIVE_FINAL_MUST_NOT_BE_USED");
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(
    JSON.stringify(result.json).includes(
      "SUCCESSOR_HISTORY_MUST_NOT_BE_USED",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(result.json).includes(
      "SUCCESSOR_LIVE_FINAL_MUST_NOT_BE_USED",
    ),
    false,
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
  assert.ok(
    gateway.historyCallCount >= 2,
    "captured-session precedence must survive successor polling",
  );
});

for (const [label, provenance] of [
  ["missing", undefined],
  [
    "wrong-kind",
    {
      ...SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
      kind: "internal_system",
    },
  ],
  [
    "wrong-source-channel",
    {
      ...SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
      sourceChannel: "whatsapp",
    },
  ],
  [
    "wrong-source-tool",
    {
      ...SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
      sourceTool: "lookalike_smart_remarkable",
    },
  ],
]) {
  test(`does not trust a ${label}-provenance rollover anchor or its live final`, async () => {
    const requestId = `smart-remarkable-${label}-provenance-rollover-0001`;
    const sessionsDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "smart-remarkable-sessions-"),
    );
    cleanups.push(() =>
      fs.rm(sessionsDirectory, { recursive: true, force: true }),
    );
    const sessionsPath = path.join(sessionsDirectory, "sessions.json");
    await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });
    await fs.writeFile(
      path.join(
        sessionsDirectory,
        "captured-session.jsonl.reset.2026-07-28T10-00-00.000Z",
      ),
      `${JSON.stringify({
        type: "session",
        id: "captured-session",
        version: 3,
      })}\n`,
      { mode: 0o600 },
    );

    const { gateway, port } = await fixture({
      configOverrides: {
        openclawSessionsPath: sessionsPath,
        runTimeoutMs: 75,
      },
    });
    gateway.historyResult = ({ callCount }) =>
      callCount === 1
        ? { sessionId: "captured-session", messages: [] }
        : {
            sessionId: "replacement-session",
            messages: [
              {
                role: "user",
                idempotencyKey: `${requestId}:user`,
                ...(provenance ? { provenance } : {}),
                content: [{ type: "text", text: "lookalike request" }],
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: responseEnvelope(
                      "LOOKALIKE_HISTORY_MUST_NOT_BE_USED",
                    ),
                  },
                ],
              },
            ],
          };

    const pending = post({
      port,
      requestId,
      mode: "write_back",
    });
    await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
    gateway.accept();
    gateway.finish("LOOKALIKE_LIVE_FINAL_MUST_NOT_BE_USED");
    const result = await pending.body;

    assert.equal(result.json.choices[0].finish_reason, "error");
    assert.equal(
      JSON.stringify(result.json).includes(
        "LOOKALIKE_HISTORY_MUST_NOT_BE_USED",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(result.json).includes(
        "LOOKALIKE_LIVE_FINAL_MUST_NOT_BE_USED",
      ),
      false,
    );
    assert.equal(
      gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
      0,
    );
    assert.equal(
      gateway.calls.filter((call) => call.method === RESPONSE_PDF_METHOD).length,
      0,
    );
  });
}

test("does not trust rollover history when the captured transcript cannot be verified", async () => {
  const requestId = "smart-remarkable-unverified-rollover-0001";
  const sessionsDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-sessions-"),
  );
  cleanups.push(() =>
    fs.rm(sessionsDirectory, { recursive: true, force: true }),
  );
  const sessionsPath = path.join(sessionsDirectory, "sessions.json");
  await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });

  const { gateway, port } = await fixture({
    configOverrides: {
      openclawSessionsPath: sessionsPath,
      runTimeoutMs: 75,
    },
  });
  gateway.historyResult = ({ callCount }) =>
    callCount === 1
      ? { sessionId: "captured-session", messages: [] }
      : {
          sessionId: "replacement-session",
          messages: [
            {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              provenance: SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE,
              content: [{ type: "text", text: "unverified request" }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: responseEnvelope(
                    "UNVERIFIED_ROLLOVER_MUST_NOT_BE_USED",
                  ),
                },
              ],
            },
          ],
        };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.resolveChat({ status: "accepted", runId: requestId });
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(
    JSON.stringify(result.json).includes(
      "UNVERIFIED_ROLLOVER_MUST_NOT_BE_USED",
    ),
    false,
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
});

test("a live final is usable only after the captured session anchor is verified", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-verified-live-final-0001";
  gateway.historyResult = ({ callCount }) => ({
    sessionId: "test-canonical-session",
    messages:
      callCount === 1
        ? []
        : [
            {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              content: [{ type: "text", text: "captured request" }],
            },
          ],
  });

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("Verified live response.");
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "stop");
  assert.equal(
    result.json.choices[0].message.content,
    "Verified live response.",
  );
});

for (const [label, rawOutput] of [
  ["non-json", "not json"],
  [
    "code-fenced",
    '```json\n{"received_text":"question","response_text":"answer"}\n```',
  ],
  ["missing-field", '{"received_text":"question"}'],
  [
    "extra-field",
    '{"received_text":"question","response_text":"answer","extra":"no"}',
  ],
  [
    "control-character",
    JSON.stringify({
      received_text: "question\u0000hidden",
      response_text: "answer",
    }),
  ],
  [
    "oversized-transcription",
    responseEnvelope("answer", "x".repeat(2_049)),
  ],
]) {
  test(`fails closed on ${label} response envelopes with no final delivery`, async () => {
    const { gateway, port } = await fixture();
    const requestId = `smart-remarkable-malformed-${label}-0001`;
    const pending = post({
      port,
      requestId,
      mode: "write_back",
    });
    await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
    gateway.accept();
    assert.equal((await pending.response).statusCode, 200);
    gateway.finishRaw(rawOutput);
    const result = await pending.body;

    assert.equal(result.statusCode, 200);
    assert.equal(result.json.choices[0].finish_reason, "error");
    assert.equal(
      result.json.choices[0].message.content,
      "OpenClaw could not complete this selection.",
    );
    assert.equal(
      gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
      0,
    );
    assert.equal(
      gateway.calls.filter((call) => call.method === RESPONSE_PDF_METHOD).length,
      0,
    );

    const callCount = gateway.calls.length;
    const replay = await post({
      port,
      requestId,
      mode: "write_back",
    }).body;
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json.x_smart_remarkable.replayed, true);
    assert.equal(replay.json.choices[0].finish_reason, "error");
    assert.equal(gateway.calls.length, callCount);
  });
}

test("waits for the acknowledgement attempt before submitting the final send", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-ack-order-0001";
  gateway.ackDeferred = deferred();
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("Final must wait behind ack.");
  await nextTurn();
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
  gateway.ackDeferred.resolve({
    status: "sent",
    runId: `${requestId}:ack`,
    messageId: "ack-message-id",
    channel: "whatsapp",
  });
  const result = await pending.body;
  assert.equal(result.json.openclaw_delivery.acknowledgement.status, "sent");
  const ackCallIndex = gateway.calls.findIndex((call) =>
    isDeliveryKind(call, "ack"),
  );
  const finalCallIndex = gateway.calls.findIndex((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.ok(ackCallIndex >= 0 && finalCallIndex > ackCallIndex);
});

test("keeps the origin bound and withholds the final until the PDF receipt is terminal", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-pdf-order-0001";
  gateway.pdfDeferred = deferred();
  const pending = post({ port, requestId, mode: "write_back" });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("The PDF must finish first.");
  await waitFor(
    () => gateway.calls.some((call) => call.method === RESPONSE_PDF_METHOD),
    "response PDF was not requested",
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
  assert.equal(
    gateway.calls.filter((call) => call.method === ORIGIN_CLEAR_METHOD).length,
    0,
  );

  gateway.pdfDeferred.resolve(pdfReceipt(requestId));
  const result = await pending.body;
  assert.equal(result.json.openclaw_delivery.final.status, "sent");
  assert.equal(result.json.remarkable_document.status, "uploaded");
  const pdfCallIndex = gateway.calls.findIndex(
    (call) => call.method === RESPONSE_PDF_METHOD,
  );
  const finalCallIndex = gateway.calls.findIndex((call) =>
    isDeliveryKind(call, "final"),
  );
  const clearCallIndex = gateway.calls.findIndex(
    (call) => call.method === ORIGIN_CLEAR_METHOD,
  );
  assert.ok(pdfCallIndex >= 0 && finalCallIndex > pdfCallIndex);
  assert.ok(clearCallIndex > finalCallIndex);
});

test("reports PDF failure in WhatsApp without erasing a successful answer", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-pdf-failure-0001";
  gateway.pdfError = new Error("private cloud provider detail");
  const pending = post({ port, requestId, mode: "write_back" });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("Keep this answer despite the PDF failure.");
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "stop");
  assert.equal(
    result.json.choices[0].message.content,
    "Keep this answer despite the PDF failure.",
  );
  assert.deepEqual(result.json.remarkable_document, {
    requested: true,
    destination: RESPONSE_PDF_DESTINATION,
    status: "failed",
    error: "reMarkable response PDF delivery could not be confirmed.",
  });
  const finalCall = gateway.calls.find((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.equal(
    finalCall.params.text,
    `I read:\n> ${DEFAULT_RECEIVED_TEXT}\n\nKeep this answer despite the PDF failure.\n\nPDF: I could not confirm delivery to your reMarkable Cloud library.`,
  );
  assert.equal(JSON.stringify(result.json).includes("private cloud"), false);
});

test("treats a protocol-invalid PDF receipt as a fixed PDF failure", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-pdf-bad-receipt-0001";
  gateway.pdfResultOverride = pdfReceipt(requestId, {
    request_id: "smart-remarkable-wrong-request-0001",
  });
  const pending = post({ port, requestId, mode: "whatsapp_only" });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("The WhatsApp answer remains valid.");
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "stop");
  assert.equal(
    result.json.choices[0].message.content,
    "OpenClaw handled this selection through WhatsApp.",
  );
  assert.equal(result.json.remarkable_document.status, "failed");
  assert.equal(result.json.openclaw_delivery.final.status, "sent");
});

for (const mode of ["write_back", "whatsapp_only"]) {
  test(`preserves ${mode} mode in its OpenAI-compatible response`, async () => {
    const { gateway, port } = await fixture();
    const requestId = `smart-remarkable-mode-${mode}`;
    const pending = post({
      port,
      requestId,
      mode,
    });
    await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
    gateway.accept();
    gateway.finish(`final for ${mode}`);
    const result = await pending.body;
    assert.equal(result.statusCode, 200);
    assert.equal(
      result.json.x_smart_remarkable.response_mode,
      mode,
    );
    assert.equal(
      result.json.x_smart_remarkable.selection_kind,
      "ink",
    );
    assert.equal(result.json.remarkable_document.status, "uploaded");
    assert.equal(
      gateway.calls.filter((call) => call.method === RESPONSE_PDF_METHOD).length,
      1,
    );
    const responseText = result.json.choices[0].message.content;
    const finalCall = gateway.calls.find((call) =>
      isDeliveryKind(call, "final"),
    );
    assert.equal(
      finalCall.params.text,
      renderedResponse(`final for ${mode}`, DEFAULT_RECEIVED_TEXT, requestId),
    );
    if (mode === "write_back") {
      assert.equal(responseText, "final for write_back");
    } else {
      assert.equal(
        responseText,
        "OpenClaw handled this selection through WhatsApp.",
      );
      assert.equal(
        JSON.stringify(result.json).includes("final for whatsapp_only"),
        false,
      );
      assert.equal(
        JSON.stringify(result.json).includes(DEFAULT_RECEIVED_TEXT),
        false,
      );
    }
  });
}

test("coalesces duplicate IDs into one turn, acknowledgement, and final send", async () => {
  const { gateway, port } = await fixture();
  const first = post({
    port,
    requestId: "smart-remarkable-duplicate-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  const second = post({
    port,
    requestId: "smart-remarkable-duplicate-0001",
    mode: "write_back",
  });
  assert.equal(gateway.chat.length, 1);

  gateway.accept();
  await Promise.all([first.response, second.response]);
  gateway.finish("one final answer");
  const [firstResult, secondResult] = await Promise.all([
    first.body,
    second.body,
  ]);
  assert.equal(firstResult.statusCode, 200);
  assert.equal(secondResult.statusCode, 200);
  assert.equal(firstResult.json.x_smart_remarkable.replayed, false);
  assert.equal(secondResult.json.x_smart_remarkable.replayed, true);
  assert.equal(
    gateway.calls.filter((call) => call.method === "chat.send").length,
    1,
  );
  assert.equal(
    gateway.calls.filter((call) => call.method === DELIVERY_METHOD).length,
    2,
  );
  assert.equal(
    gateway.calls.filter((call) => call.method === RESPONSE_PDF_METHOD).length,
    1,
  );
});

test("a delayed in-process duplicate is replay-labeled and starts no new work", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-delayed-duplicate-0001";
  const first = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("Insert this only for the original caller.");
  const firstResult = await first.body;
  assert.equal(firstResult.json.x_smart_remarkable.replayed, false);
  const callCount = gateway.calls.length;

  const duplicate = await post({
    port,
    requestId,
    mode: "write_back",
  }).body;
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json.x_smart_remarkable.replayed, true);
  assert.equal(
    duplicate.json.choices[0].message.content,
    "Insert this only for the original caller.",
  );
  assert.equal(gateway.calls.length, callCount);
});

test("a completed request replays after bridge restart without chat.send or delivery", async () => {
  const firstFixture = await fixture();
  const requestId = "smart-remarkable-persistent-replay-0001";
  const first = post({
    port: firstFixture.port,
    requestId,
    mode: "write_back",
  });
  await waitFor(
    () => firstFixture.gateway.chat.length === 1,
    "chat.send was not called",
  );
  firstFixture.gateway.accept();
  firstFixture.gateway.finish("Durably cached exact response.");
  const initial = await first.body;
  assert.equal(initial.json.x_smart_remarkable.replayed, false);
  await firstFixture.shutdown();

  const restarted = await fixture({
    journalRoot: firstFixture.journalRoot,
  });
  const replay = await post({
    port: restarted.port,
    requestId,
    mode: "write_back",
  }).body;
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json.x_smart_remarkable.replayed, true);
  assert.equal(
    replay.json.choices[0].message.content,
    "Durably cached exact response.",
  );
  assert.equal(replay.json.openclaw_delivery.acknowledgement.status, "sent");
  assert.equal(replay.json.openclaw_delivery.final.status, "sent");
  assert.equal(restarted.gateway.calls.length, 0);
});

test("an incomplete request reservation blocks chat.send after bridge restart", async () => {
  const firstFixture = await fixture();
  const requestId = "smart-remarkable-incomplete-restart-0001";
  const pending = post({
    port: firstFixture.port,
    requestId,
    mode: "write_back",
  });
  pending.response.catch(() => {});
  pending.body.catch(() => {});
  await waitFor(
    () => firstFixture.gateway.chat.length === 1,
    "chat.send was not called",
  );
  await firstFixture.shutdown();

  const restarted = await fixture({
    journalRoot: firstFixture.journalRoot,
  });
  const blocked = await post({
    port: restarted.port,
    requestId,
    mode: "write_back",
  }).body;
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json.error.message, /cannot be safely retried/);
  assert.equal(restarted.gateway.calls.length, 0);
});

test("rejects reuse of a request ID with different content", async () => {
  const { gateway, port } = await fixture();
  const first = post({
    port,
    requestId: "smart-remarkable-conflict-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  const conflicting = post({
    port,
    requestId: "smart-remarkable-conflict-0001",
    mode: "write_back",
    body: requestBody("Different prompt"),
  });
  const conflictResult = await conflicting.body;
  assert.equal(conflictResult.statusCode, 409);
  assert.match(conflictResult.json.error.message, /different content/);
  assert.equal(gateway.chat.length, 1);

  const conflictingMode = post({
    port,
    requestId: "smart-remarkable-conflict-0001",
    mode: "whatsapp_only",
  });
  const modeConflictResult = await conflictingMode.body;
  assert.equal(modeConflictResult.statusCode, 409);
  assert.match(modeConflictResult.json.error.message, /different content/);

  const conflictingKind = post({
    port,
    requestId: "smart-remarkable-conflict-0001",
    mode: "write_back",
    selectionKind: "image",
  });
  const kindConflictResult = await conflictingKind.body;
  assert.equal(kindConflictResult.statusCode, 409);
  assert.match(kindConflictResult.json.error.message, /selection kind/);

  gateway.accept();
  gateway.finish("finished");
  await first.body;
});

test("binds image kind and appends its exact kind-aware response protocol", async () => {
  const { gateway, port } = await fixture();
  const pending = post({
    port,
    requestId: "smart-remarkable-image-kind-0001",
    mode: "whatsapp_only",
    selectionKind: "image",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  const bind = gateway.calls.find(
    (call) => call.method === ORIGIN_BIND_METHOD,
  );
  assert.equal(bind.params.selectionKind, "image");
  assert.ok(
    gateway.chat[0].params.message.endsWith(
      buildResponseEnvelopeProtocolInstruction("image"),
    ),
  );
  assert.equal(
    gateway.chat[0].params.message.includes(
      '"received_text" must be a literal transcription of the selected handwriting',
    ),
    false,
  );
  gateway.accept();
  gateway.finish("Image explained.", 0, "A diagram of a bridge.");
  const result = await pending.body;
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.json.x_smart_remarkable.selection_kind,
    "image",
  );
});

test("reports acknowledgement delivery failure after the accepted 200", async () => {
  const { gateway, port } = await fixture();
  gateway.ackError = new Error("simulated WhatsApp outage");
  const pending = post({
    port,
    requestId: "smart-remarkable-ack-failure-0001",
    mode: "whatsapp_only",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  const response = await pending.response;
  assert.equal(response.statusCode, 200);
  gateway.finish("The OpenClaw run still completed.");
  const result = await pending.body;
  assert.equal(
    result.json.openclaw_delivery.acknowledgement.status,
    "failed",
  );
  assert.equal(
    result.json.openclaw_delivery.acknowledgement.error,
    "WhatsApp acknowledgement could not be confirmed.",
  );
  assert.equal(JSON.stringify(result.json).includes("simulated"), false);
  assert.equal(result.json.openclaw_delivery.final.status, "sent");
});

test("reports final WhatsApp failure without claiming delivery", async () => {
  const { gateway, port } = await fixture();
  gateway.finalError = new Error("simulated final WhatsApp outage");
  const pending = post({
    port,
    requestId: "smart-remarkable-final-failure-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  assert.equal((await pending.response).statusCode, 200);
  gateway.finish("Keep this exact final text.");
  const result = await pending.body;
  assert.equal(
    result.json.choices[0].message.content,
    "Keep this exact final text.",
  );
  assert.equal(result.json.openclaw_delivery.final.status, "failed");
  assert.equal(
    result.json.openclaw_delivery.final.error,
    "WhatsApp final delivery could not be confirmed.",
  );
  assert.equal(JSON.stringify(result.json).includes("simulated"), false);
  const finalCalls = gateway.calls.filter((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.equal(finalCalls.length, 1);
  assert.equal(
    finalCalls[0].params.text,
    renderedResponse(
      "Keep this exact final text.",
      DEFAULT_RECEIVED_TEXT,
      "smart-remarkable-final-failure-0001",
    ),
  );
});

test("rejects an incomplete native send success payload", async () => {
  const { gateway, port } = await fixture();
  gateway.sendResultOverride = {
    runId: "wrong-run-id",
    messageId: "",
    channel: "whatsapp",
  };
  const pending = post({
    port,
    requestId: "smart-remarkable-unverified-send-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("A valid model answer.");
  const result = await pending.body;
  assert.equal(
    result.json.openclaw_delivery.acknowledgement.status,
    "failed",
  );
  assert.equal(result.json.openclaw_delivery.final.status, "failed");
  assert.equal(
    result.json.openclaw_delivery.final.error,
    "WhatsApp final delivery could not be confirmed.",
  );
  assert.equal(JSON.stringify(result.json).includes("did not confirm"), false);
});

test("rejects native send payloads that omit explicit sent status", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-missing-send-status-0001";
  gateway.sendResultOverride = (params) => ({
    runId: `${params.requestId}:${params.kind}`,
    messageId: `valid-${params.kind}-message-id`,
    channel: "whatsapp",
  });
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.finish("Model answer with unverified outbound status.");
  const result = await pending.body;
  assert.equal(
    result.json.openclaw_delivery.acknowledgement.status,
    "failed",
  );
  assert.equal(result.json.openclaw_delivery.final.status, "failed");
});

test("encodes post-acceptance run failure in a 200 OpenAI response", async () => {
  const { gateway, port } = await fixture();
  const pending = post({
    port,
    requestId: "smart-remarkable-run-failure-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  assert.equal((await pending.response).statusCode, 200);
  gateway.failAfterAcceptance("simulated agent failure");
  const result = await pending.body;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(result.json.openclaw_delivery.final.status, "failed");
  assert.equal(
    result.json.openclaw_delivery.final.error,
    "OpenClaw could not complete this selection.",
  );
  assert.equal(JSON.stringify(result.json).includes("simulated"), false);
});

test("uses pre-acceptance HTTP errors and sends no acknowledgement", async () => {
  const { gateway, port } = await fixture();
  const pending = post({
    port,
    requestId: "smart-remarkable-preaccept-failure-0001",
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.failBeforeAcceptance(new Error("simulated gateway rejection"));
  const result = await pending.body;
  assert.equal(result.statusCode, 502);
  assert.equal(result.json.error.message, "OpenClaw request failed");
  assert.equal(JSON.stringify(result.json).includes("simulated"), false);
  assert.equal(
    gateway.calls.filter((call) => call.method === DELIVERY_METHOD).length,
    0,
  );
  const clearCalls = gateway.calls.filter(
    (call) => call.method === ORIGIN_CLEAR_METHOD,
  );
  assert.equal(clearCalls.length, 1);
  assert.deepEqual(clearCalls[0].params, {
    requestId: "smart-remarkable-preaccept-failure-0001",
    bindingHandle: ORIGIN_BINDING_HANDLE,
  });
});

for (const [label, payload] of [
  ["missing", { status: "accepted" }],
  ["mismatched", { status: "accepted", runId: "another-request-id" }],
]) {
  test(`does not flush success headers for ${label} acceptance run ID`, async () => {
    const { gateway, port } = await fixture();
    const requestId = `smart-remarkable-${label}-run-id-0001`;
    const pending = post({
      port,
      requestId,
      mode: "write_back",
    });
    let responseSeen = false;
    pending.response.then(() => {
      responseSeen = true;
    });
    await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
    gateway.accept(0, payload);
    await nextTurn();
    assert.equal(responseSeen, false);
    gateway.resolveChat({ status: "error", runId: requestId });
    const result = await pending.body;
    assert.equal(result.statusCode, 502);
    assert.equal(result.json.error.message, "OpenClaw request failed");
    assert.equal(
      gateway.calls.filter((call) => call.method === DELIVERY_METHOD).length,
      0,
    );
  });
}

test("recovers a completed Gateway replay from attributable chat history", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-history-replay-0001";
  gateway.historyResult = {
    messages: [
      {
        role: "assistant",
        idempotencyKey: "another-request-id",
        content: [{ type: "text", text: "wrong assistant response" }],
      },
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "canonical user turn" }],
      },
      {
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope(
              "Recovered exact response.",
              "Please recover this answer",
            ),
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "ok", runId: requestId });
  assert.equal((await pending.response).statusCode, 200);
  const result = await pending.body;
  assert.equal(
    result.json.choices[0].message.content,
    "Recovered exact response.",
  );
  assert.equal(result.json.x_smart_remarkable.replayed, true);
  const historyCalls = gateway.calls.filter(
    (call) => call.method === "chat.history",
  );
  assert.equal(historyCalls.length, 2);
  for (const historyCall of historyCalls) {
    assert.deepEqual(historyCall.params, {
      sessionKey: "agent:main:main",
      agentId: "main",
      limit: 1_000,
      maxChars: 500_000,
    });
  }
  const finalCalls = gateway.calls.filter((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.equal(finalCalls.length, 1);
  assert.equal(
    finalCalls[0].params.text,
    renderedResponse(
      "Recovered exact response.",
      "Please recover this answer",
      requestId,
    ),
  );
});

test("fails closed when canonical history contains duplicate request anchors", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-duplicate-anchor-0001";
  gateway.historyResult = {
    messages: [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "first canonical user turn" }],
      },
      {
        role: "user",
        __openclaw: { idempotencyKey: `${requestId}:user` },
        content: [{ type: "text", text: "duplicate canonical user turn" }],
      },
      {
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope("Must not be attributed."),
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "ok", runId: requestId });
  assert.equal((await pending.response).statusCode, 200);
  const result = await pending.body;
  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(result.json.openclaw_delivery.final.status, "failed");
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
});

for (const [label, historyResult] of [
  [
    "top-level truncation metadata",
    {
      truncated: true,
      messages: [
        {
          role: "user",
          idempotencyKey: "smart-remarkable-truncated-replay-0001:user",
          content: [{ type: "text", text: "canonical user turn" }],
        },
        {
          role: "assistant",
          idempotencyKey: "unrelated-assistant-message-id",
          content: [
            {
              type: "text",
              text: responseEnvelope("Incomplete response."),
            },
          ],
        },
      ],
    },
  ],
  [
    "message truncation metadata",
    {
      messages: [
        {
          role: "user",
          idempotencyKey: "smart-remarkable-truncated-replay-0001:user",
          content: [{ type: "text", text: "canonical user turn" }],
        },
        {
          role: "assistant",
          idempotencyKey: "unrelated-assistant-message-id",
          content: [
            {
              type: "text",
              text: responseEnvelope("Incomplete response."),
            },
          ],
          __openclaw: { truncated: true },
        },
      ],
    },
  ],
  [
    "text truncation marker",
    {
      messages: [
        {
          role: "user",
          idempotencyKey: "smart-remarkable-truncated-replay-0001:user",
          content: [{ type: "text", text: "canonical user turn" }],
        },
        {
          role: "assistant",
          idempotencyKey: "unrelated-assistant-message-id",
          content: [
            {
              type: "text",
              text: responseEnvelope("Incomplete response."),
            },
            {
              type: "text",
              text: "\n...(truncated)...",
            },
          ],
        },
      ],
    },
  ],
]) {
  test(`fails closed on completed replay with ${label}`, async () => {
    const { gateway, port } = await fixture();
    gateway.historyResult = historyResult;
    const pending = post({
      port,
      requestId: "smart-remarkable-truncated-replay-0001",
      mode: "write_back",
    });
    await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
    gateway.resolveChat({
      status: "ok",
      runId: "smart-remarkable-truncated-replay-0001",
    });
    assert.equal((await pending.response).statusCode, 200);
    const result = await pending.body;
    assert.equal(result.json.choices[0].finish_reason, "error");
    assert.equal(
      gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
      0,
    );
  });
}

test("does not attribute an assistant response across another user turn", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-cross-user-0001";
  gateway.historyResult = {
    messages: [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "target request" }],
      },
      {
        role: "user",
        idempotencyKey: "newer-whatsapp-user-turn",
        content: [{ type: "text", text: "a later user message" }],
      },
      {
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope(
              "CROSS_USER_RESPONSE_MUST_NOT_BE_DELIVERED",
            ),
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "ok", runId: requestId });
  assert.equal((await pending.response).statusCode, 200);
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(
    JSON.stringify(result.json).includes(
      "CROSS_USER_RESPONSE_MUST_NOT_BE_DELIVERED",
    ),
    false,
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
});

test("uses an attributable recent response even when older history exists", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-history-has-more-0001";
  gateway.historyResult = {
    hasMore: true,
    messages: [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "target request" }],
      },
      {
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope("Recent attributable answer."),
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "ok", runId: requestId });
  const result = await pending.body;

  assert.equal(result.json.choices[0].finish_reason, "stop");
  assert.equal(
    result.json.choices[0].message.content,
    "Recent attributable answer.",
  );
});

test("fails closed when a completed replay has no attributable history", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-history-miss-0001";
  gateway.historyResult = {
    messages: [
      {
        role: "assistant",
        idempotencyKey: "another-request-id",
        content: [
          {
            type: "text",
            text: "RAW_PRIVATE_HISTORY_TEXT_MUST_NOT_LEAK",
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "ok", runId: requestId });
  assert.equal((await pending.response).statusCode, 200);
  const result = await pending.body;
  assert.equal(result.json.choices[0].finish_reason, "error");
  assert.equal(
    result.json.choices[0].message.content,
    "OpenClaw could not complete this selection.",
  );
  assert.equal(
    result.json.openclaw_delivery.final.error,
    "OpenClaw could not complete this selection.",
  );
  assert.equal(
    JSON.stringify(result.json).includes("RAW_PRIVATE_HISTORY_TEXT_MUST_NOT_LEAK"),
    false,
  );
  assert.equal(
    gateway.calls.filter((call) => isDeliveryKind(call, "final")).length,
    0,
  );
});

test("treats an exact in_flight replay as accepted and waits for its final event", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-in-flight-0001";
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.resolveChat({ status: "in_flight", runId: requestId });
  assert.equal((await pending.response).statusCode, 200);
  let bodySeen = false;
  pending.body.then(() => {
    bodySeen = true;
  });
  await nextTurn();
  assert.equal(bodySeen, false);
  gateway.finish("Finished existing in-flight turn.");
  const result = await pending.body;
  assert.equal(
    result.json.choices[0].message.content,
    "Finished existing in-flight turn.",
  );
  assert.equal(result.json.x_smart_remarkable.replayed, true);
  assert.ok(
    gateway.calls.filter((call) => call.method === "chat.history").length >=
      1,
  );
});

test("recovers from history after an empty live final event", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-empty-live-final-0001";
  gateway.historyResult = ({ callCount }) => {
    const messages = [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "canonical user turn" }],
      },
    ];
    if (callCount >= 2) {
      messages.push({
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope(
              "Recovered after the empty event.",
              "Can you still answer this?",
            ),
          },
        ],
      });
    }
    return { messages };
  };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  assert.equal((await pending.response).statusCode, 200);
  await waitFor(
    () => gateway.historyCallCount >= 1,
    "initial history reconciliation did not run",
  );
  gateway.finishRaw("");
  const result = await pending.body;

  assert.equal(
    result.json.choices[0].message.content,
    "Recovered after the empty event.",
  );
  const finalCall = gateway.calls.find((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.equal(
    finalCall.params.text,
    renderedResponse(
      "Recovered after the empty event.",
      "Can you still answer this?",
      requestId,
    ),
  );
  assert.ok(gateway.historyCallCount >= 2);
});

test("recovers a native started run from canonical history without a live final event", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-started-history-0001";
  gateway.chatResultOverride = {
    status: "started",
    runId: requestId,
  };
  gateway.historyResult = ({ callCount }) => {
    const messages = [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "canonical user turn" }],
      },
    ];
    if (callCount >= 2) {
      messages.push({
        role: "assistant",
        idempotencyKey: "assistant-id-does-not-match-request",
        content: [
          {
            type: "text",
            text: responseEnvelope(
              "Recovered native started response.",
              "What did I write?",
            ),
          },
        ],
      });
    }
    return { messages };
  };

  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  const response = await pending.response;
  assert.equal(response.statusCode, 200);
  const result = await pending.body;
  assert.equal(
    result.json.choices[0].message.content,
    "Recovered native started response.",
  );
  const finalCall = gateway.calls.find((call) =>
    isDeliveryKind(call, "final"),
  );
  assert.equal(
    finalCall.params.text,
    renderedResponse(
      "Recovered native started response.",
      "What did I write?",
      requestId,
    ),
  );
  assert.equal(
    gateway.calls.filter((call) => call.method === "chat.send").length,
    1,
  );
  assert.equal(
    gateway.calls.filter((call) => call.method === DELIVERY_METHOD).length,
    2,
  );
  assert.ok(gateway.historyCallCount >= 2);
});

test("continues history recovery when the accepted request callback later fails", async () => {
  const { gateway, port } = await fixture();
  const requestId = "smart-remarkable-callback-failure-0001";
  gateway.historyResult = {
    messages: [
      {
        role: "user",
        idempotencyKey: `${requestId}:user`,
        content: [{ type: "text", text: "canonical user turn" }],
      },
      {
        role: "assistant",
        idempotencyKey: "unrelated-assistant-message-id",
        content: [
          {
            type: "text",
            text: responseEnvelope("History survived callback failure."),
          },
        ],
      },
    ],
  };
  const pending = post({
    port,
    requestId,
    mode: "write_back",
  });
  await waitFor(() => gateway.chat.length === 1, "chat.send was not called");
  gateway.accept();
  gateway.failBeforeAcceptance(new Error("callback disconnected"));
  const result = await pending.body;

  assert.equal(
    result.json.choices[0].message.content,
    "History survived callback failure.",
  );
  assert.equal(result.json.openclaw_delivery.final.status, "sent");
});
