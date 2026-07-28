import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CANONICAL_AGENT_ID,
  CANONICAL_SESSION_KEY,
  DELIVERY_METHOD,
  createDeliveryHandler,
  default as deliveryPlugin,
  registerDeliveryMethod,
} from "../index.mjs";

const REQUEST_ID = "smart-remarkable-plugin-test-0001";

class FakeStore {
  constructor() {
    this.values = new Map();
    this.registerError = null;
  }

  async lookup(key) {
    return this.values.get(key);
  }

  async registerIfAbsent(key, value) {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, structuredClone(value));
    return true;
  }

  async register(key, value) {
    if (this.registerError) {
      throw this.registerError;
    }
    this.values.set(key, structuredClone(value));
  }
}

function fakeRuntime(store, origin = undefined) {
  const canonicalOrigin =
    origin ??
    {
      provider: "whatsapp",
      chatType: "direct",
      to: "+15551234567",
      accountId: "personal",
    };
  return {
    agent: {
      session: {
        getSessionEntry(params) {
          assert.deepEqual(params, {
            agentId: CANONICAL_AGENT_ID,
            sessionKey: CANONICAL_SESSION_KEY,
            readConsistency: "latest",
          });
          return {
            chatType: canonicalOrigin.chatType,
            origin: canonicalOrigin,
          };
        },
      },
    },
    state: {
      openKeyedStore(options) {
        assert.equal(
          options.namespace,
          "smart-remarkable-delivery-receipts-v1",
        );
        assert.equal(options.overflowPolicy, "reject-new");
        return store;
      },
    },
  };
}

function sentResult(messageId = "wa-message-1") {
  return {
    status: "sent",
    results: [{ channel: "whatsapp", messageId }],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
    },
  };
}

function invocation(overrides = {}) {
  const responses = [];
  return {
    params: {
      requestId: REQUEST_ID,
      kind: "final",
      text: "Exact assistant answer.",
      ...overrides,
    },
    context: {
      getRuntimeConfig() {
        return { channels: { whatsapp: { enabled: true } } };
      },
    },
    respond(ok, payload, error, meta) {
      responses.push({ ok, payload, error, meta });
    },
    responses,
  };
}

function handlerFixture({
  store = new FakeStore(),
  origin,
  sendBatch = async () => sentResult(),
} = {}) {
  const calls = [];
  const wrappedSend = async (params) => {
    calls.push(params);
    return await sendBatch(params);
  };
  const runtime = fakeRuntime(store, origin);
  const handler = createDeliveryHandler({
    runtime,
    logger: { error() {} },
    store,
    sendBatch: wrappedSend,
  });
  return { calls, handler, runtime, store };
}

function fileJournalHandler({ stateDir, sendBatch = async () => sentResult() }) {
  const runtime = fakeRuntime(new FakeStore());
  runtime.state = {
    resolveStateDir() {
      return stateDir;
    },
    openKeyedStore() {
      throw new Error(
        "openKeyedStore is only available for trusted plugins in this release.",
      );
    },
  };
  const calls = [];
  const handler = createDeliveryHandler({
    runtime,
    logger: { error() {} },
    sendBatch: async (params) => {
      calls.push(params);
      return await sendBatch(params);
    },
  });
  return { calls, handler };
}

async function call(handler, overrides = {}) {
  const request = invocation(overrides);
  await handler(request);
  assert.equal(request.responses.length, 1);
  return request.responses[0];
}

test("registers one operator.write Gateway method", () => {
  const store = new FakeStore();
  const runtime = fakeRuntime(store);
  const registrations = [];
  registerDeliveryMethod(
    {
      runtime,
      logger: { error() {} },
      registerGatewayMethod(method, handler, options) {
        registrations.push({ method, handler, options });
      },
    },
    {
      store,
      sendBatch: async () => sentResult(),
    },
  );
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, DELIVERY_METHOD);
  assert.equal(typeof registrations[0].handler, "function");
  assert.deepEqual(registrations[0].options, { scope: "operator.write" });
});

test("the real plugin entry registers without requesting restricted keyed state", () => {
  const store = new FakeStore();
  const runtime = fakeRuntime(store);
  let restrictedStateCalls = 0;
  runtime.state = {
    resolveStateDir() {
      return path.join(os.tmpdir(), "smart-remarkable-registration-smoke");
    },
    openKeyedStore() {
      restrictedStateCalls += 1;
      throw new Error(
        "openKeyedStore is only available for trusted plugins in this release.",
      );
    },
  };
  const registrations = [];
  const tools = [];
  const hooks = [];
  const runContexts = new Map();
  deliveryPlugin.register({
    runtime,
    logger: { error() {} },
    runContext: {
      getRunContext({ runId, namespace }) {
        return runContexts.get(`${runId}:${namespace}`);
      },
      setRunContext({ runId, namespace, value }) {
        runContexts.set(`${runId}:${namespace}`, value);
        return true;
      },
      clearRunContext({ runId, namespace }) {
        runContexts.delete(`${runId}:${namespace}`);
      },
    },
    registerGatewayMethod(method, handler, options) {
      registrations.push({ method, handler, options });
    },
    registerTool(tool, options) {
      tools.push({ tool, options });
    },
    on(name, handler, options) {
      hooks.push({ name, handler, options });
    },
  });
  assert.equal(restrictedStateCalls, 0);
  assert.deepEqual(
    registrations.map((entry) => entry.method),
    [
      DELIVERY_METHOD,
      "smart_remarkable.bind_origin",
      "smart_remarkable.clear_origin",
    ],
  );
  assert.deepEqual(
    registrations.map((entry) => entry.options),
    [
      { scope: "operator.write" },
      { scope: "operator.write" },
      { scope: "operator.write" },
    ],
  );
  assert.equal(tools.length, 1);
  assert.equal(typeof tools[0].tool, "function");
  assert.deepEqual(tools[0].options, {
    name: "remarkable_deliver_document",
  });
  assert.deepEqual(
    hooks.map((entry) => entry.name),
    ["before_prompt_build", "before_tool_call"],
  );
  assert.deepEqual(
    hooks.map((entry) => entry.options),
    [{ priority: 100 }, { priority: 100 }],
  );
});

test("ordinary workspace registration uses its file journal, not restricted plugin state", async (t) => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-plugin-state-"),
  );
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = new FakeStore();
  const runtime = fakeRuntime(store);
  let restrictedStateCalls = 0;
  runtime.state = {
    resolveStateDir() {
      return stateDir;
    },
    openKeyedStore() {
      restrictedStateCalls += 1;
      throw new Error(
        "openKeyedStore is only available for trusted plugins in this release.",
      );
    },
  };

  const firstRegistrations = [];
  let firstSendCount = 0;
  registerDeliveryMethod(
    {
      runtime,
      logger: { error() {} },
      registerGatewayMethod(method, handler, options) {
        firstRegistrations.push({ method, handler, options });
      },
    },
    {
      sendBatch: async () => {
        firstSendCount += 1;
        return sentResult();
      },
    },
  );
  assert.equal(firstRegistrations.length, 1);
  const first = await call(firstRegistrations[0].handler);
  assert.equal(first.ok, true);
  assert.equal(firstSendCount, 1);
  assert.equal(restrictedStateCalls, 0);

  const restartedRegistrations = [];
  let restartedSendCount = 0;
  registerDeliveryMethod(
    {
      runtime,
      logger: { error() {} },
      registerGatewayMethod(method, handler, options) {
        restartedRegistrations.push({ method, handler, options });
      },
    },
    {
      sendBatch: async () => {
        restartedSendCount += 1;
        return sentResult("must-not-send");
      },
    },
  );
  const replay = await call(restartedRegistrations[0].handler);
  assert.equal(replay.ok, true);
  assert.equal(replay.meta.cached, true);
  assert.equal(replay.payload.messageId, "wa-message-1");
  assert.equal(restartedSendCount, 0);
  assert.equal(restrictedStateCalls, 0);
});

test("the file journal fails closed on an incomplete mkdir reservation", async (t) => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-incomplete-state-"),
  );
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const deliveryId = `${REQUEST_ID}:final`;
  const entryDirectory = path.join(
    stateDir,
    "plugins",
    "smart-remarkable-delivery",
    "smart-remarkable-delivery-receipts-v1",
    crypto.createHash("sha256").update(deliveryId).digest("hex"),
  );
  await fs.mkdir(entryDirectory, { recursive: true, mode: 0o700 });

  const restarted = fileJournalHandler({ stateDir });
  const response = await call(restarted.handler);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNAVAILABLE");
  assert.equal(restarted.calls.length, 0);
});

test("independent file-journal handlers cannot enqueue the same delivery twice", async (t) => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-concurrent-state-"),
  );
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const first = fileJournalHandler({
    stateDir,
    sendBatch: async () => {
      markStarted();
      await blocked;
      return sentResult();
    },
  });
  const second = fileJournalHandler({ stateDir });

  const firstInvocation = invocation();
  const firstPromise = first.handler(firstInvocation);
  await started;
  const competing = await call(second.handler);
  assert.equal(competing.ok, false);
  assert.equal(competing.error.code, "UNAVAILABLE");
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);

  release();
  await firstPromise;
  assert.equal(firstInvocation.responses[0].ok, true);
});

test("derives the fixed direct WhatsApp route and omits all mirror/session fields", async () => {
  const { calls, handler } = handlerFixture();
  const response = await call(handler);

  assert.equal(response.ok, true);
  assert.deepEqual(response.payload, {
    runId: `${REQUEST_ID}:final`,
    status: "sent",
    channel: "whatsapp",
    messageId: "wa-message-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "whatsapp");
  assert.equal(calls[0].to, "+15551234567");
  assert.equal(calls[0].accountId, "personal");
  assert.deepEqual(calls[0].payloads, [{ text: "Exact assistant answer." }]);
  assert.equal(calls[0].durability, "required");
  assert.deepEqual(calls[0].gatewayClientScopes, ["operator.write"]);
  assert.equal(Object.hasOwn(calls[0], "mirror"), false);
  assert.equal(Object.hasOwn(calls[0], "session"), false);
  assert.equal(Object.hasOwn(calls[0], "idempotencyKey"), false);
  assert.equal(JSON.stringify(response).includes("+15551234567"), false);
  assert.equal(JSON.stringify(response).includes("personal"), false);
});

test("rejects route overrides and all other unknown params before delivery", async () => {
  const { calls, handler } = handlerFixture();
  const response = await call(handler, { to: "+19999999999" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 0);
});

for (const [label, origin] of [
  [
    "non-WhatsApp",
    {
      provider: "telegram",
      chatType: "direct",
      to: "123",
      accountId: "personal",
    },
  ],
  [
    "group",
    {
      provider: "whatsapp",
      chatType: "group",
      to: "123@g.us",
      accountId: "personal",
    },
  ],
  [
    "threaded",
    {
      provider: "whatsapp",
      chatType: "direct",
      to: "+15551234567",
      accountId: "personal",
      threadId: "unexpected",
    },
  ],
  [
    "missing-account",
    {
      provider: "whatsapp",
      chatType: "direct",
      to: "+15551234567",
    },
  ],
]) {
  test(`fails closed for a ${label} canonical route`, async () => {
    const { calls, handler } = handlerFixture({ origin });
    const response = await call(handler);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "UNAVAILABLE");
    assert.equal(calls.length, 0);
  });
}

test("coalesces identical in-flight calls and rejects conflicting reuse", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, handler } = handlerFixture({
    sendBatch: async () => {
      await blocked;
      return sentResult();
    },
  });
  const first = invocation();
  const duplicate = invocation();
  const conflict = invocation({ text: "Different answer." });
  const firstPromise = handler(first);
  const duplicatePromise = handler(duplicate);
  await handler(conflict);
  assert.equal(conflict.responses[0].ok, false);
  assert.equal(conflict.responses[0].error.code, "INVALID_REQUEST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([firstPromise, duplicatePromise]);
  assert.equal(first.responses[0].ok, true);
  assert.equal(first.responses[0].meta.cached, false);
  assert.equal(duplicate.responses[0].ok, true);
  assert.equal(duplicate.responses[0].meta.cached, true);
  assert.equal(calls.length, 1);
});

test("replays a durably journaled receipt across handler restarts", async () => {
  const store = new FakeStore();
  const first = handlerFixture({ store });
  const initial = await call(first.handler);
  assert.equal(initial.ok, true);
  assert.equal(first.calls.length, 1);

  const restarted = handlerFixture({ store });
  const replay = await call(restarted.handler);
  assert.equal(replay.ok, true);
  assert.equal(replay.meta.cached, true);
  assert.deepEqual(replay.payload, initial.payload);
  assert.equal(restarted.calls.length, 0);
});

test("never resends a reservation left ambiguous across restart", async () => {
  const store = new FakeStore();
  const first = handlerFixture({
    store,
    sendBatch: async () => {
      throw new Error("provider outcome unknown");
    },
  });
  const initial = await call(first.handler);
  assert.equal(initial.ok, false);
  assert.equal(initial.error.code, "UNAVAILABLE");
  assert.equal(first.calls.length, 1);

  const restarted = handlerFixture({ store });
  const replay = await call(restarted.handler);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "UNAVAILABLE");
  assert.equal(restarted.calls.length, 0);
});

test("does not start a second batch while a prior random queue entry may recover", async () => {
  const store = new FakeStore();
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${REQUEST_ID}:final`)
    .update("\0")
    .update("Exact assistant answer.")
    .digest("hex");
  store.values.set(`${REQUEST_ID}:final`, {
    schemaVersion: 1,
    fingerprint,
    kind: "final",
    state: "reserved",
  });

  const restarted = handlerFixture({ store });
  const replay = await call(restarted.handler);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "UNAVAILABLE");
  assert.equal(restarted.calls.length, 0);
});

test("fails closed when the platform result has no matching native receipt", async () => {
  const invalidResults = [
    { status: "sent", results: [], receipt: {} },
    {
      status: "sent",
      results: [{ channel: "telegram", messageId: "wrong-channel" }],
      receipt: { primaryPlatformMessageId: "wrong-channel" },
    },
    {
      status: "sent",
      results: [{ channel: "whatsapp", messageId: "actual" }],
      receipt: { primaryPlatformMessageId: "different" },
    },
    {
      status: "suppressed",
      results: [],
      receipt: { primaryPlatformMessageId: "suppressed" },
    },
  ];
  for (const result of invalidResults) {
    const { handler } = handlerFixture({
      sendBatch: async () => result,
    });
    const response = await call(handler);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "UNAVAILABLE");
  }
});

test("does not claim success when durable receipt commit fails after send", async () => {
  const store = new FakeStore();
  const { handler } = handlerFixture({
    store,
    sendBatch: async () => {
      store.registerError = new Error("journal unavailable");
      return sentResult();
    },
  });
  const response = await call(handler);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNAVAILABLE");
  assert.equal(store.values.get(`${REQUEST_ID}:final`).state, "reserved");
});

test("enforces bounded request IDs, kinds, and UTF-8 text", async () => {
  const { calls, handler } = handlerFixture();
  for (const overrides of [
    { requestId: "short" },
    { kind: "other" },
    { text: " " },
    { text: "x".repeat(32 * 1024 + 1) },
  ]) {
    const response = await call(handler, overrides);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_REQUEST");
  }
  assert.equal(calls.length, 0);
});
