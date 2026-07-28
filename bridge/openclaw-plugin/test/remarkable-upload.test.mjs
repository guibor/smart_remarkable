import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  REMARKABLE_BIND_ORIGIN_METHOD,
  REMARKABLE_CLEAR_ORIGIN_METHOD,
  REMARKABLE_RUN_CONTEXT_NAMESPACE,
  REMARKABLE_UPLOAD_TOOL,
  createOriginAdmissionRegistry,
  createOriginBindingHandlers,
  createRemarkableOriginHooks,
  createRemarkableUploadTool,
  registerRemarkableOriginMethods,
} from "../remarkable-upload.mjs";

const REQUEST_ID = "smart-remarkable-upload-test-0001";
const OTHER_REQUEST_ID = "smart-remarkable-upload-test-0002";
const SESSION_ID = "captured-session-test-0001";
const OTHER_SESSION_ID = "replacement-session-test-0001";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLOUD_HASH = "a".repeat(64);

function createTestAdmissionRegistry(overrides = {}) {
  return createOriginAdmissionRegistry({
    randomBytes: () => Buffer.alloc(32, 7),
    ...overrides,
  });
}

class FakeHostRunContext {
  constructor(sharedValues = new Map()) {
    this.values = sharedValues;
  }

  key(runId, namespace) {
    return `${runId}\0${namespace}`;
  }

  getRunContext({ runId, namespace }) {
    return this.values.get(this.key(runId, namespace));
  }

  setRunContext({ runId, namespace, value }) {
    assert.equal(typeof value, "string");
    this.values.set(this.key(runId, namespace), value);
    return true;
  }

  clearRunContext({ runId, namespace }) {
    this.values.delete(this.key(runId, namespace));
  }
}

function readStoredTestOrigin(runContext, requestId = REQUEST_ID) {
  const value = runContext.getRunContext({
    runId: requestId,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
  });
  return value === undefined ? undefined : JSON.parse(value);
}

function invokeGateway(handler, params) {
  const responses = [];
  return Promise.resolve(
    handler({
      params,
      respond(ok, payload, error, meta) {
        responses.push({ ok, payload, error, meta });
      },
    }),
  ).then(() => {
    assert.equal(responses.length, 1);
    return responses[0];
  });
}

async function bindOrigin(
  admissionRegistry,
  runContext,
  mode = "write_back",
  expectedSessionId = SESSION_ID,
) {
  const handlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
  });
  const result = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode,
    expectedSessionId,
  });
  assert.equal(result.ok, true);
  return { handlers, result };
}

function validPdf(text = "hello") {
  return Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`, "utf8");
}

function validEpubPrefix() {
  const name = Buffer.from("mimetype", "ascii");
  const mime = Buffer.from("application/epub+zip", "ascii");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(mime.length, 18);
  header.writeUInt32LE(mime.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, mime]);
}

async function createFixture(
  t,
  {
    execFileFn,
    maxUploadBytes,
    bind = true,
    stateDir: sharedStateDir,
  } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-upload-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspaceDir = path.join(root, "workspace");
  const stateDir = sharedStateDir ?? path.join(root, "state");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const pythonPath = path.join(root, "python");
  const configPath = path.join(root, "config.json");
  await fs.writeFile(pythonPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.chmod(pythonPath, 0o700);
  await fs.writeFile(configPath, '{"device_token":"test-only"}\n', {
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600);

  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  let binding;
  if (bind) {
    binding = await bindOrigin(admissionRegistry, runContext);
  }
  const api = {
    runtime: {
      state: {
        resolveStateDir() {
          return stateDir;
        },
      },
    },
    runContext,
    logger: { error() {} },
  };
  const context = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: SESSION_ID,
    workspaceDir,
    fsPolicy: { workspaceOnly: true },
  };
  const calls = [];
  const wrappedExec = async (...args) => {
    calls.push(args);
    if (execFileFn) {
      return await execFileFn(...args);
    }
    return {
      stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
      stderr: "",
    };
  };
  const tool = createRemarkableUploadTool({
    api,
    context,
    pythonPath,
    configPath,
    execFileFn: wrappedExec,
    ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
  });
  assert.equal(tool?.name, REMARKABLE_UPLOAD_TOOL);
  const hooks = createRemarkableOriginHooks({
    runContext,
  });
  if (bind) {
    assert.match(
      hooks.beforePromptBuild(
        { prompt: "document request", messages: [] },
        {
          runId: REQUEST_ID,
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: SESSION_ID,
        },
      ).appendSystemContext,
      /reMarkable/,
    );
  }

  function authorize(params, overrides = {}) {
    const result = hooks.beforeToolCall(
      {
        toolName: REMARKABLE_UPLOAD_TOOL,
        runId: REQUEST_ID,
        params,
      },
      {
        runId: REQUEST_ID,
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: SESSION_ID,
        toolName: REMARKABLE_UPLOAD_TOOL,
        ...overrides,
      },
    );
    assert.equal(result?.block, undefined);
    return result.params;
  }

  return {
    root,
    workspaceDir,
    stateDir,
    pythonPath,
    configPath,
    admissionRegistry,
    runContext,
    originHandlers: binding?.handlers,
    bindingHandle: binding?.result.payload.bindingHandle,
    api,
    context,
    tool,
    hooks,
    calls,
    authorize,
  };
}

test("registers exact operator.write origin bind and clear methods", () => {
  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  const registrations = [];
  registerRemarkableOriginMethods(
    {
      runContext,
      registerGatewayMethod(method, handler, options) {
        registrations.push({ method, handler, options });
      },
    },
    { admissionRegistry },
  );
  assert.deepEqual(
    registrations.map(({ method }) => method),
    [REMARKABLE_BIND_ORIGIN_METHOD, REMARKABLE_CLEAR_ORIGIN_METHOD],
  );
  assert.deepEqual(
    registrations.map(({ options }) => options),
    [{ scope: "operator.write" }, { scope: "operator.write" }],
  );
  assert.throws(
    () => createOriginBindingHandlers({ runContext }),
    /origin registry is unavailable/,
  );
});

test("bind is identical-context idempotent, rejects conflict, and clear is safe", async () => {
  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  const handlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
  });
  const first = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.deepEqual(first.payload, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    status: "bound",
    runId: REQUEST_ID,
    source: "remarkable",
    mode: "write_back",
    expectedSessionId: SESSION_ID,
    bindingHandle: first.payload.bindingHandle,
  });
  assert.match(first.payload.bindingHandle, /^[A-Za-z0-9_-]{43}$/);
  const stored = readStoredTestOrigin(runContext);
  assert.equal(stored.state, "pending");
  assert.equal(stored.source, "remarkable");
  assert.equal(stored.requestId, REQUEST_ID);
  assert.equal(stored.expectedSessionId, SESSION_ID);
  assert.equal(stored.capability.length, 43);

  const replay = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.bindingHandle, first.payload.bindingHandle);
  assert.deepEqual(readStoredTestOrigin(runContext), stored);

  const conflict = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "whatsapp_only",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "INVALID_REQUEST");
  const sessionConflict = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: OTHER_SESSION_ID,
  });
  assert.equal(sessionConflict.ok, false);
  assert.equal(sessionConflict.error.code, "INVALID_REQUEST");

  const staleClear = await invokeGateway(handlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: "Z".repeat(43),
  });
  assert.equal(staleClear.ok, false);
  assert.equal(staleClear.error.code, "INVALID_REQUEST");
  assert.deepEqual(readStoredTestOrigin(runContext), stored);

  const cleared = await invokeGateway(handlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: first.payload.bindingHandle,
  });
  assert.deepEqual(cleared.payload, {
    status: "cleared",
    runId: REQUEST_ID,
  });
  assert.equal(readStoredTestOrigin(runContext), undefined);
  const alreadyCleared = await invokeGateway(handlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: first.payload.bindingHandle,
  });
  assert.equal(alreadyCleared.ok, true);
});

test("origin methods reject unknown params and keep admission state private", async () => {
  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  const handlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
  });
  const invalid = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
    source: "spoof",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_REQUEST");

  const invalidClear = await invokeGateway(handlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: "A".repeat(43),
    source: "spoof",
  });
  assert.equal(invalidClear.ok, false);
  assert.equal(invalidClear.error.code, "INVALID_REQUEST");
  assert.equal(readStoredTestOrigin(runContext), undefined);
});

test("origin admissions are bounded and expire without a clear call", async () => {
  let now = 1_000;
  const admissionRegistry = createTestAdmissionRegistry({
    now: () => now,
    pendingTtlMs: 100,
    maxEntries: 1,
  });
  const runContext = new FakeHostRunContext();
  const handlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
    now: () => now,
  });
  const first = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(first.ok, true);
  const full = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: OTHER_REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, "UNAVAILABLE");

  now = 1_100;
  const afterExpiry = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: OTHER_REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(afterExpiry.ok, true);
  const hooks = createRemarkableOriginHooks({
    runContext,
    now: () => now,
  });
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: "expired", messages: [] },
      {
        runId: REQUEST_ID,
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: SESSION_ID,
      },
    ),
    undefined,
  );
});

test("an active host admission retains its capacity slot until active expiry", async () => {
  let now = 1_000;
  const admissionRegistry = createTestAdmissionRegistry({
    now: () => now,
    pendingTtlMs: 100,
    maxEntries: 1,
  });
  const runContext = new FakeHostRunContext();
  const handlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
    now: () => now,
  });
  const first = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(first.ok, true);
  const hooks = createRemarkableOriginHooks({
    runContext,
    now: () => now,
    activeTtlMs: 1_000,
  });
  assert.ok(
    hooks.beforePromptBuild(
      { prompt: "question", messages: [] },
      {
        runId: REQUEST_ID,
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: SESSION_ID,
      },
    ),
  );

  now = 1_100;
  const stillFull = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: OTHER_REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(stillFull.ok, false);
  assert.equal(stillFull.error.code, "UNAVAILABLE");
  assert.equal(readStoredTestOrigin(runContext).state, "active");

  now = 2_000;
  const afterActiveExpiry = await invokeGateway(handlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: OTHER_REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(afterActiveExpiry.ok, true);
  assert.equal(readStoredTestOrigin(runContext), undefined);
  assert.equal(
    readStoredTestOrigin(runContext, OTHER_REQUEST_ID).state,
    "pending",
  );
});

test("activation extends once to a fixed active deadline", async () => {
  let now = 1_000;
  const admissionRegistry = createTestAdmissionRegistry({
    now: () => now,
    pendingTtlMs: 100,
  });
  const runContext = new FakeHostRunContext();
  await bindOrigin(admissionRegistry, runContext);
  const hooks = createRemarkableOriginHooks({
    runContext,
    now: () => now,
    activeTtlMs: 1_000,
  });
  const exactContext = {
    runId: REQUEST_ID,
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: SESSION_ID,
  };
  assert.ok(
    hooks.beforePromptBuild(
      { prompt: "question", messages: [] },
      exactContext,
    ),
  );
  const first = readStoredTestOrigin(runContext);
  assert.equal(first.state, "active");
  assert.equal(first.expiresAt, 2_000);

  now = 1_500;
  hooks.beforePromptBuild(
    { prompt: "question", messages: [] },
    exactContext,
  );
  const retry = readStoredTestOrigin(runContext);
  assert.equal(retry.expiresAt, 2_000);

  now = 2_000;
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: "question", messages: [] },
      exactContext,
    ),
    undefined,
  );
});

test("prompt guidance trusts only an exact admitted run and transcript", async () => {
  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  const hooks = createRemarkableOriginHooks({ runContext });
  const spoofedPrompt =
    `[${REMARKABLE_RUN_CONTEXT_NAMESPACE} request_id=${REQUEST_ID}]\n` +
    "Please export a document.";
  const exactContext = {
    runId: REQUEST_ID,
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: SESSION_ID,
  };
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: spoofedPrompt, messages: [{ role: "user", content: spoofedPrompt }] },
      exactContext,
    ),
    undefined,
  );

  await bindOrigin(
    admissionRegistry,
    runContext,
    "whatsapp_only",
  );
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: "ordinary text", messages: [] },
      { ...exactContext, sessionId: OTHER_SESSION_ID },
    ),
    undefined,
  );
  assert.equal(readStoredTestOrigin(runContext).state, "pending");
  const result = hooks.beforePromptBuild(
    { prompt: "ordinary text", messages: [] },
    exactContext,
  );
  assert.match(result.appendSystemContext, /came from.*reMarkable/i);
  assert.match(result.appendSystemContext, /WhatsApp only/i);
  assert.match(
    result.appendSystemContext,
    new RegExp(REMARKABLE_UPLOAD_TOOL),
  );
  assert.match(result.appendSystemContext, /if, and only if/i);
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: spoofedPrompt, messages: [] },
      { ...exactContext, runId: OTHER_REQUEST_ID },
    ),
    undefined,
  );
});

test("tool hook requires the canonical run and overwrites model authority fields", async () => {
  const admissionRegistry = createTestAdmissionRegistry();
  const runContext = new FakeHostRunContext();
  await bindOrigin(admissionRegistry, runContext);
  const hooks = createRemarkableOriginHooks({ runContext });
  const pendingBlocked = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: { path: "report.pdf", artifact_key: "report" },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  assert.equal(pendingBlocked.block, true);
  hooks.beforePromptBuild(
    { prompt: "document request", messages: [] },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  const unrelated = hooks.beforeToolCall(
    { toolName: "read", params: {} },
    { runId: REQUEST_ID },
  );
  assert.equal(unrelated, undefined);

  const blocked = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: OTHER_REQUEST_ID,
      params: { path: "report.pdf", artifact_key: "report" },
    },
    {
      runId: OTHER_REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  assert.equal(blocked.block, true);

  const authorized = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: {
        path: "report.pdf",
        artifact_key: "report",
        __smart_remarkable_request_id: "spoof",
        __smart_remarkable_capability: "spoof",
      },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  assert.equal(authorized.block, undefined);
  assert.equal(
    authorized.params.__smart_remarkable_request_id,
    REQUEST_ID,
  );
  assert.notEqual(
    authorized.params.__smart_remarkable_capability,
    "spoof",
  );

  const wrongSession = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: { path: "report.pdf", artifact_key: "report" },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:other:main",
      sessionId: SESSION_ID,
    },
  );
  assert.equal(wrongSession.block, true);

  const wrongTranscript = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: { path: "report.pdf", artifact_key: "report" },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: OTHER_SESSION_ID,
    },
  );
  assert.equal(wrongTranscript.block, true);

  const missingTranscript = hooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: { path: "report.pdf", artifact_key: "report" },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
    },
  );
  assert.equal(missingTranscript.block, true);
  assert.equal(
    hooks.beforePromptBuild(
      { prompt: "document request", messages: [] },
      { runId: REQUEST_ID, sessionId: OTHER_SESSION_ID },
    ),
    undefined,
  );
});

test("tool execution rechecks the bound transcript identity", async (t) => {
  const fixture = await createFixture(t);
  await fs.writeFile(
    path.join(fixture.workspaceDir, "report.pdf"),
    validPdf("report"),
  );
  const authorized = fixture.authorize({
    path: "report.pdf",
    artifact_key: "report",
  });
  const wrongTranscriptTool = createRemarkableUploadTool({
    api: fixture.api,
    context: {
      ...fixture.context,
      sessionId: OTHER_SESSION_ID,
    },
    pythonPath: fixture.pythonPath,
    configPath: fixture.configPath,
    execFileFn: async (...args) => {
      fixture.calls.push(args);
      throw new Error("must not execute");
    },
  });
  await assert.rejects(
    wrongTranscriptTool.execute("wrong-transcript", authorized),
    (error) => error?.code === "UNAUTHORIZED",
  );
  const cleared = await invokeGateway(fixture.originHandlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: fixture.bindingHandle,
  });
  assert.equal(cleared.ok, true);
  await assert.rejects(
    fixture.tool.execute("cleared-origin", authorized),
    (error) => error?.code === "UNAUTHORIZED",
  );
  assert.equal(fixture.calls.length, 0);
});

test("scalar host context bridges startup bind, active hooks, and pinned tools", async (t) => {
  const fixture = await createFixture(t, { bind: false });
  const startupRegistry = createTestAdmissionRegistry();
  const activeRunContext = new FakeHostRunContext(
    fixture.runContext.values,
  );
  const startupHandlers = createOriginBindingHandlers({
    admissionRegistry: startupRegistry,
    runContext: fixture.runContext,
  });
  const binding = await invokeGateway(startupHandlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    expectedSessionId: SESSION_ID,
  });
  assert.equal(binding.ok, true);

  const activeHooks = createRemarkableOriginHooks({
    runContext: activeRunContext,
  });
  const promptResult = activeHooks.beforePromptBuild(
    { prompt: "create a report", messages: [] },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  assert.match(promptResult.appendSystemContext, /reMarkable/);
  const authorization = activeHooks.beforeToolCall(
    {
      toolName: REMARKABLE_UPLOAD_TOOL,
      runId: REQUEST_ID,
      params: {
        path: "cross-registry.pdf",
        artifact_key: "cross-registry",
      },
    },
    {
      runId: REQUEST_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
  );
  assert.equal(authorization.block, undefined);
  await fs.writeFile(
    path.join(fixture.workspaceDir, "cross-registry.pdf"),
    validPdf("cross registry"),
  );
  const uploaded = await fixture.tool.execute(
    "cross-registry",
    authorization.params,
  );
  assert.equal(uploaded.details.status, "uploaded");

  const cleared = await invokeGateway(startupHandlers.clear, {
    requestId: REQUEST_ID,
    bindingHandle: binding.payload.bindingHandle,
  });
  assert.equal(cleared.ok, true);
  await assert.rejects(
    fixture.tool.execute("after-clear", authorization.params),
    (error) => error?.code === "UNAUTHORIZED",
  );
});

test("tool factory exposes uploads only to the canonical main session", () => {
  const api = {
    runtime: {
      state: { resolveStateDir: () => path.join(os.tmpdir(), "unused") },
    },
    runContext: new FakeHostRunContext(),
    logger: { error() {} },
  };
  for (const context of [
    {
      agentId: "other",
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    },
    {
      agentId: "main",
      sessionKey: "agent:other:main",
      sessionId: SESSION_ID,
    },
    { agentId: "main", sessionKey: "agent:main:main" },
    { agentId: "main", sessionId: SESSION_ID },
  ]) {
    assert.equal(
      createRemarkableUploadTool({
        api,
        context,
      }),
      null,
    );
  }
});

test("uploads a private snapshot with exact CLI args and a secret-minimal environment", async (t) => {
  let observedSnapshot;
  const fixture = await createFixture(t, {
    execFileFn: async (file, args, options) => {
      assert.equal(file, fixture.pythonPath);
      assert.deepEqual(args.slice(0, 3), [
        "-m",
        "rm_sync.cli",
        "upload",
      ]);
      observedSnapshot = args[3];
      assert.equal(args[4], "--name");
      assert.equal(args[5], "Report.pdf");
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 180_000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.deepEqual(Object.keys(options.env).sort(), [
        "LANG",
        "PATH",
        "REMARKABLE_SYNC_CONFIG",
      ]);
      assert.equal(
        options.env.REMARKABLE_SYNC_CONFIG,
        fixture.configPath,
      );
      assert.equal(
        (await fs.stat(observedSnapshot)).mode & 0o777,
        0o600,
      );
      assert.deepEqual(
        await fs.readFile(observedSnapshot),
        validPdf("report"),
      );
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  await fs.writeFile(
    path.join(fixture.workspaceDir, "source.pdf"),
    validPdf("report"),
  );
  const result = await fixture.tool.execute(
    "call-1",
    fixture.authorize({
      path: "source.pdf",
      artifact_key: "report-v1",
      name: "Report.pdf",
    }),
  );
  assert.deepEqual(result.details, {
    status: "uploaded",
    request_id: REQUEST_ID,
    artifact_key: "report-v1",
    name: "Report.pdf",
    document_id: DOCUMENT_ID,
    cloud_hash: CLOUD_HASH,
    cached: false,
  });
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(fs.stat(observedSnapshot), { code: "ENOENT" });
});

test("accepts a conforming EPUB whose first uncompressed entry is mimetype", async (t) => {
  const fixture = await createFixture(t);
  await fs.writeFile(
    path.join(fixture.workspaceDir, "book.epub"),
    validEpubPrefix(),
  );
  const result = await fixture.tool.execute(
    "call-epub",
    fixture.authorize({
      path: "book.epub",
      artifact_key: "book-v1",
    }),
  );
  assert.equal(result.details.status, "uploaded");
  assert.equal(result.details.name, "book.epub");
  assert.equal(fixture.calls.length, 1);
});

test("rejects traversal, symlinks, directories, bad magic, and invalid names before exec", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside.pdf");
  await fs.writeFile(outside, validPdf("outside"));
  await fs.writeFile(
    path.join(fixture.workspaceDir, "good.pdf"),
    validPdf("good"),
  );
  await fs.writeFile(
    path.join(fixture.workspaceDir, "bad.pdf"),
    "not a pdf",
  );
  await fs.mkdir(path.join(fixture.workspaceDir, "directory.pdf"));
  await fs.symlink(
    path.join(fixture.workspaceDir, "good.pdf"),
    path.join(fixture.workspaceDir, "link.pdf"),
  );
  const cases = [
    { path: "../outside.pdf", artifact_key: "traversal" },
    { path: "link.pdf", artifact_key: "symlink" },
    { path: "directory.pdf", artifact_key: "directory" },
    { path: "bad.pdf", artifact_key: "magic" },
    {
      path: "good.pdf",
      artifact_key: "name",
      name: "wrong.epub",
    },
    {
      path: "good.pdf",
      artifact_key: "slash",
      name: "../Good.pdf",
    },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    await assert.rejects(
      fixture.tool.execute(
        `bad-${index}`,
        fixture.authorize(cases[index]),
      ),
      (error) => error?.code === "INVALID_ARTIFACT",
    );
  }
  assert.equal(fixture.calls.length, 0);
});

test("rejects oversized artifacts and direct calls without hook capability", async (t) => {
  const fixture = await createFixture(t, { maxUploadBytes: 8 });
  await fs.writeFile(
    path.join(fixture.workspaceDir, "large.pdf"),
    validPdf("too large"),
  );
  await assert.rejects(
    fixture.tool.execute(
      "large",
      fixture.authorize({
        path: "large.pdf",
        artifact_key: "large",
      }),
    ),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
  await assert.rejects(
    fixture.tool.execute("unauthorized", {
      path: "large.pdf",
      artifact_key: "direct",
    }),
    (error) => error?.code === "UNAUTHORIZED",
  );
  assert.equal(fixture.calls.length, 0);
});

test("coalesces identical concurrent uploads into one CLI execution", async (t) => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const fixture = await createFixture(t, {
    execFileFn: async () => {
      startedResolve();
      await blocked;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  await fs.writeFile(
    path.join(fixture.workspaceDir, "same.pdf"),
    validPdf("same"),
  );
  const params = fixture.authorize({
    path: "same.pdf",
    artifact_key: "same-v1",
  });
  const first = fixture.tool.execute("first", params);
  await started;
  const second = fixture.tool.execute("second", params);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.details.cached, false);
  assert.equal(secondResult.details.cached, true);
  assert.equal(fixture.calls.length, 1);
});

test("replays a durable receipt after tool restart and rejects conflicting content", async (t) => {
  const fixture = await createFixture(t);
  const sourcePath = path.join(fixture.workspaceDir, "stable.pdf");
  await fs.writeFile(sourcePath, validPdf("first"));
  const params = fixture.authorize({
    path: "stable.pdf",
    artifact_key: "stable-v1",
  });
  const initial = await fixture.tool.execute("initial", params);
  assert.equal(initial.details.cached, false);
  assert.equal(fixture.calls.length, 1);

  let replayExecCount = 0;
  const restarted = createRemarkableUploadTool({
    api: fixture.api,
    context: fixture.context,
    pythonPath: fixture.pythonPath,
    configPath: fixture.configPath,
    execFileFn: async () => {
      replayExecCount += 1;
      throw new Error("must not execute");
    },
  });
  const replay = await restarted.execute("replay", params);
  assert.equal(replay.details.cached, true);
  assert.equal(replay.details.document_id, DOCUMENT_ID);
  assert.equal(replayExecCount, 0);

  await fs.writeFile(sourcePath, validPdf("different"));
  await assert.rejects(
    restarted.execute("conflict", params),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(replayExecCount, 0);
});

test("malformed CLI output becomes ambiguous and is never retried after restart", async (t) => {
  const fixture = await createFixture(t, {
    execFileFn: async () => ({ stdout: "not-json", stderr: "" }),
  });
  await fs.writeFile(
    path.join(fixture.workspaceDir, "ambiguous.pdf"),
    validPdf("ambiguous"),
  );
  const params = fixture.authorize({
    path: "ambiguous.pdf",
    artifact_key: "ambiguous-v1",
  });
  await assert.rejects(
    fixture.tool.execute("ambiguous", params),
    (error) => error?.code === "UNAVAILABLE",
  );
  assert.equal(fixture.calls.length, 1);

  let retryCount = 0;
  const restarted = createRemarkableUploadTool({
    api: fixture.api,
    context: fixture.context,
    pythonPath: fixture.pythonPath,
    configPath: fixture.configPath,
    execFileFn: async () => {
      retryCount += 1;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  await assert.rejects(
    restarted.execute("retry", params),
    (error) => error?.code === "UNAVAILABLE",
  );
  assert.equal(retryCount, 0);
});

test("manifest declares the document tool contract", async () => {
  const manifest = JSON.parse(
    await fs.readFile(
      new URL("../openclaw.plugin.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.version, "0.2.1");
  assert.deepEqual(manifest.contracts.tools, [
    REMARKABLE_UPLOAD_TOOL,
  ]);
});
