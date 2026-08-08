import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  REMARKABLE_INPUT_CONTEXT_VERSIONS,
  REMARKABLE_RESPONSE_PDF_METHOD,
  REMARKABLE_RESPONSE_PDF_POLICY,
  REMARKABLE_RUN_CONTEXT_NAMESPACE,
  createOriginAdmissionRegistry,
  createOriginBindingHandlers,
  createRemarkableOriginHooks,
  createRemarkableResponsePdfHandler,
  registerRemarkableResponsePdfMethod,
} from "../remarkable-upload.mjs";

const REQUEST_ID = "smart-remarkable-response-pdf-test-0001";
const OTHER_REQUEST_ID = "smart-remarkable-response-pdf-test-0002";
const SESSION_ID = "captured-response-pdf-session-0001";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLOUD_HASH = "a".repeat(64);

class FakeRunContext {
  constructor() {
    this.values = new Map();
  }

  key(runId, namespace) {
    return `${runId}\0${namespace}`;
  }

  getRunContext({ runId, namespace }) {
    return this.values.get(this.key(runId, namespace));
  }

  setRunContext({ runId, namespace, value }) {
    this.values.set(this.key(runId, namespace), value);
    return true;
  }

  clearRunContext({ runId, namespace }) {
    this.values.delete(this.key(runId, namespace));
  }
}

class FakeStore {
  constructor() {
    this.values = new Map();
  }

  async lookup(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async registerIfAbsent(key, value) {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, structuredClone(value));
    return true;
  }

  async register(key, value) {
    this.values.set(key, structuredClone(value));
  }
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

function visibleName(requestId) {
  const suffix = crypto
    .createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 16);
  return `OpenClaw response ${suffix}.pdf`;
}

function createRenderer(stateDir, tracker, { beforeReturn } = {}) {
  return async function renderResponsePdf(input) {
    tracker.inputs.push(structuredClone(input));
    const bytes = Buffer.from(
      `%PDF-1.7\n${input.receivedText}\n${input.responseText}\n%%EOF\n`,
      "utf8",
    );
    const transaction = path.join(
      stateDir,
      "plugins",
      "smart-remarkable-delivery",
      "response-pdf-staging",
      `render-test-${tracker.inputs.length}`,
    );
    await fs.mkdir(transaction, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(transaction, "response.pdf");
    await fs.writeFile(snapshotPath, bytes, { mode: 0o600 });
    await fs.chmod(snapshotPath, 0o600);
    await beforeReturn?.(input);
    let cleaned = false;
    return Object.freeze({
      artifactKey: REMARKABLE_RESPONSE_PDF_POLICY,
      visibleName: visibleName(input.requestId),
      snapshotPath,
      contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      async cleanup() {
        if (cleaned) {
          return;
        }
        cleaned = true;
        tracker.cleanups += 1;
        await fs.rm(transaction, { recursive: true, force: true });
      },
    });
  };
}

async function createFixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-response-pdf-method-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  const pythonPath = path.join(root, "python");
  const configPath = path.join(root, "config.json");
  await fs.writeFile(pythonPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.chmod(pythonPath, 0o700);
  await fs.writeFile(configPath, '{"device_token":"test-only"}\n', {
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600);

  let currentTime = 10_000;
  const now = () => currentTime;
  const runContext = new FakeRunContext();
  let randomByte = 1;
  const admissionRegistry = createOriginAdmissionRegistry({
    now,
    randomBytes: () => Buffer.alloc(32, randomByte++),
  });
  const bindingHandlers = createOriginBindingHandlers({
    admissionRegistry,
    runContext,
    now,
  });
  const binding = await invokeGateway(bindingHandlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: REQUEST_ID,
    mode: "write_back",
    selectionKind: "ink",
    contextVersion: REMARKABLE_INPUT_CONTEXT_VERSIONS[0],
    expectedSessionId: SESSION_ID,
  });
  assert.equal(binding.ok, true);
  const hooks = createRemarkableOriginHooks({
    admissionRegistry,
    runContext,
    now,
  });
  assert.ok(
    hooks.beforePromptBuild(
      { prompt: "answer", messages: [] },
      {
        runId: REQUEST_ID,
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: SESSION_ID,
      },
    ),
  );

  const runtime = {
    state: {
      resolveStateDir() {
        return stateDir;
      },
    },
  };
  const store = new FakeStore();
  const params = Object.freeze({
    requestId: REQUEST_ID,
    bindingHandle: binding.payload.bindingHandle,
    receivedText: "What is six times seven?",
    responseText: "Six times seven is 42.",
  });

  return {
    admissionRegistry,
    stateDir,
    pythonPath,
    configPath,
    runtime,
    runContext,
    bindingHandlers,
    store,
    params,
    now,
    setNow(value) {
      currentTime = value;
    },
    createHandler({
      renderer,
      execFileFn,
      receiptStore = store,
      logger = { error() {} },
      maxInFlight,
    }) {
      return createRemarkableResponsePdfHandler({
        runtime,
        logger,
        admissionRegistry,
        runContext,
        renderResponsePdf: renderer,
        store: receiptStore,
        execFileFn,
        pythonPath,
        configPath,
        now,
        ...(maxInFlight === undefined ? {} : { maxInFlight }),
      });
    },
  };
}

test("registers the exact operator.admin response-PDF RPC", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const registrations = [];
  registerRemarkableResponsePdfMethod(
    {
      runtime: fixture.runtime,
      runContext: fixture.runContext,
      logger: { error() {} },
      registerGatewayMethod(method, handler, options) {
        registrations.push({ method, handler, options });
      },
    },
    {
      admissionRegistry: fixture.admissionRegistry,
      renderResponsePdf: createRenderer(fixture.stateDir, tracker),
      store: fixture.store,
      execFileFn: async () => ({
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      }),
      pythonPath: fixture.pythonPath,
      configPath: fixture.configPath,
      now: fixture.now,
    },
  );
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, REMARKABLE_RESPONSE_PDF_METHOD);
  assert.equal(typeof registrations[0].handler, "function");
  assert.deepEqual(registrations[0].options, { scope: "operator.admin" });
  for (const maxInFlight of [0, 2]) {
    assert.throws(
      () =>
        fixture.createHandler({
          maxInFlight,
          renderer: createRenderer(fixture.stateDir, tracker),
          execFileFn: async () => {
            throw new Error("must not execute");
          },
        }),
      /response PDF delivery is unavailable/,
    );
  }
});

test("renders, uploads, and returns only the exact confirmed receipt", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const execCalls = [];
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async (...args) => {
      execCalls.push(args);
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  const result = await invokeGateway(handler, fixture.params);
  assert.deepEqual(result, {
    ok: true,
    payload: {
      status: "uploaded",
      request_id: REQUEST_ID,
      artifact_key: REMARKABLE_RESPONSE_PDF_POLICY,
      name: visibleName(REQUEST_ID),
      document_id: DOCUMENT_ID,
      cloud_hash: CLOUD_HASH,
      cached: false,
    },
    error: undefined,
    meta: undefined,
  });
  assert.deepEqual(tracker.inputs, [
    {
      stateDir: fixture.stateDir,
      requestId: REQUEST_ID,
      receivedText: fixture.params.receivedText,
      responseText: fixture.params.responseText,
    },
  ]);
  assert.equal(tracker.cleanups, 1);
  assert.equal(execCalls.length, 1);
  const [command, args, options] = execCalls[0];
  assert.equal(command, fixture.pythonPath);
  assert.deepEqual(args.slice(0, 4), ["-m", "rm_sync.cli", "upload", args[3]]);
  assert.equal(path.extname(args[3]), ".pdf");
  assert.deepEqual(args.slice(4), ["--name", visibleName(REQUEST_ID)]);
  assert.equal(options.shell, false);
  assert.equal(options.env.REMARKABLE_SYNC_CONFIG, fixture.configPath);
  await assert.rejects(fs.stat(args[3]), { code: "ENOENT" });
});

test("keeps the activated admission through host run-context teardown", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  fixture.runContext.clearRunContext({
    runId: REQUEST_ID,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
  });
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => ({
      stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
      stderr: "",
    }),
  });

  const result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, true);
  assert.equal(result.payload.status, "uploaded");
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);

  const cleared = await invokeGateway(
    fixture.bindingHandlers.clear,
    {
      requestId: REQUEST_ID,
      bindingHandle: fixture.params.bindingHandle,
    },
  );
  assert.equal(cleared.ok, true);
  const afterClear = await invokeGateway(handler, {
    ...fixture.params,
    responseText: "A different response after explicit clear.",
  });
  assert.equal(afterClear.ok, false);
  assert.equal(afterClear.error.code, "UNAUTHORIZED");
});

test("authorizes the bridge-owned PDF from the exact bounded bind handle", async (t) => {
  const fixture = await createFixture(t);
  const binding = await invokeGateway(fixture.bindingHandlers.bind, {
    protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    requestId: OTHER_REQUEST_ID,
    mode: "whatsapp_only",
    selectionKind: "image",
    contextVersion: REMARKABLE_INPUT_CONTEXT_VERSIONS[0],
    expectedSessionId: SESSION_ID,
  });
  assert.equal(binding.ok, true);
  assert.equal(binding.payload.status, "bound");
  const tracker = { inputs: [], cleanups: 0 };
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => ({
      stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
      stderr: "",
    }),
  });

  const result = await invokeGateway(handler, {
    ...fixture.params,
    requestId: OTHER_REQUEST_ID,
    bindingHandle: binding.payload.bindingHandle,
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.status, "uploaded");
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
});

test("rejects unknown, malformed, inactive, expired, and wrong origin authority before rendering", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => {
      throw new Error("must not upload");
    },
  });
  const malformed = [
    { ...fixture.params, extra: true },
    { ...fixture.params, requestId: "not-a-request" },
    { ...fixture.params, bindingHandle: "short" },
    { ...fixture.params, receivedText: "   " },
    { ...fixture.params, responseText: "bad\tcontrol" },
    { ...fixture.params, responseText: "spoof\u202Etext" },
    { ...fixture.params, receivedText: "unpaired \ud800 surrogate" },
    { ...fixture.params, responseText: "unpaired \udc00 surrogate" },
    { ...fixture.params, responseText: "x".repeat(32_257) },
    { ...fixture.params, responseText: "line\n".repeat(513) },
  ];
  for (const params of malformed) {
    const result = await invokeGateway(handler, params);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_REQUEST");
  }

  for (const params of [
    { ...fixture.params, bindingHandle: "A".repeat(43) },
    { ...fixture.params, requestId: OTHER_REQUEST_ID },
  ]) {
    const result = await invokeGateway(handler, params);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNAUTHORIZED");
  }

  const activeRaw = fixture.runContext.getRunContext({
    runId: REQUEST_ID,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
  });
  const active = JSON.parse(activeRaw);
  fixture.runContext.setRunContext({
    runId: REQUEST_ID,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    value: JSON.stringify({ ...active, state: "pending" }),
  });
  let result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAUTHORIZED");
  fixture.runContext.setRunContext({
    runId: REQUEST_ID,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
    value: activeRaw,
  });
  fixture.setNow(active.expiresAt);
  result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAUTHORIZED");
  assert.equal(tracker.inputs.length, 0);
  assert.equal(tracker.cleanups, 0);
});

test("accepts 512 combined line breaks and rejects the 513th before rendering", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => ({
      stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
      stderr: "",
    }),
  });
  const boundary = await invokeGateway(handler, {
    ...fixture.params,
    responseText: `Family 👨‍👩‍👧‍👦\n${"line\n".repeat(511)}end`,
  });
  assert.equal(boundary.ok, true);
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);

  const overBoundary = await invokeGateway(handler, {
    ...fixture.params,
    responseText: `${"line\n".repeat(513)}end`,
  });
  assert.equal(overBoundary.ok, false);
  assert.equal(overBoundary.error.code, "INVALID_REQUEST");
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
});

test("rechecks the exact binding and captured session after render before upload", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker, {
      beforeReturn() {
        const raw = fixture.runContext.getRunContext({
          runId: REQUEST_ID,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
        });
        const origin = JSON.parse(raw);
        fixture.runContext.setRunContext({
          runId: REQUEST_ID,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
          value: JSON.stringify({
            ...origin,
            expectedSessionId: "replacement-session-0001",
          }),
        });
      },
    }),
    execFileFn: async () => {
      throw new Error("must not upload");
    },
  });
  const result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAUTHORIZED");
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
});

test("rechecks active authority after durable reservation immediately before rm-sync", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const mutatingStore = {
    lookup: (...args) => fixture.store.lookup(...args),
    register: (...args) => fixture.store.register(...args),
    async registerIfAbsent(...args) {
      const inserted = await fixture.store.registerIfAbsent(...args);
      if (inserted) {
        const raw = fixture.runContext.getRunContext({
          runId: REQUEST_ID,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
        });
        const origin = JSON.parse(raw);
        fixture.runContext.setRunContext({
          runId: REQUEST_ID,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
          value: JSON.stringify({ ...origin, state: "pending" }),
        });
      }
      return inserted;
    },
  };
  let execCount = 0;
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    receiptStore: mutatingStore,
    execFileFn: async () => {
      execCount += 1;
      throw new Error("revoked request must not upload");
    },
  });
  const result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAUTHORIZED");
  assert.equal(execCount, 0);
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
});

test("coalesces identical concurrency, rejects conflicts, and cleans one artifact", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  let releaseUpload;
  const uploadStarted = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  let announceUpload;
  const announced = new Promise((resolve) => {
    announceUpload = resolve;
  });
  let execCount = 0;
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => {
      execCount += 1;
      announceUpload();
      await uploadStarted;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  const first = invokeGateway(handler, fixture.params);
  const second = invokeGateway(handler, { ...fixture.params });
  const conflict = await invokeGateway(handler, {
    ...fixture.params,
    responseText: "Different response.",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  await announced;
  releaseUpload();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.payload.cached, false);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.payload.cached, true);
  assert.equal(execCount, 1);
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
});

test("caps distinct render jobs while still coalescing an admitted request", async (t) => {
  const fixture = await createFixture(t);
  const hooks = createRemarkableOriginHooks({
    admissionRegistry: fixture.admissionRegistry,
    runContext: fixture.runContext,
    now: fixture.now,
  });
  async function bindActive(requestId) {
    const binding = await invokeGateway(fixture.bindingHandlers.bind, {
      protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
      requestId,
      mode: "whatsapp_only",
      selectionKind: "image",
      contextVersion: REMARKABLE_INPUT_CONTEXT_VERSIONS[0],
      expectedSessionId: SESSION_ID,
    });
    assert.equal(binding.ok, true);
    assert.ok(
      hooks.beforePromptBuild(
        { prompt: "answer", messages: [] },
        {
          runId: requestId,
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: SESSION_ID,
        },
      ),
    );
    return {
      ...fixture.params,
      requestId,
      bindingHandle: binding.payload.bindingHandle,
    };
  }

  const secondParams = await bindActive(OTHER_REQUEST_ID);
  const tracker = { inputs: [], cleanups: 0 };
  let releaseUploads;
  const uploadsHeld = new Promise((resolve) => {
    releaseUploads = resolve;
  });
  let announceFull;
  const full = new Promise((resolve) => {
    announceFull = resolve;
  });
  let execCount = 0;
  const handler = fixture.createHandler({
    maxInFlight: 1,
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => {
      execCount += 1;
      announceFull();
      await uploadsHeld;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });

  const first = invokeGateway(handler, fixture.params);
  await full;
  const excess = await invokeGateway(handler, secondParams);
  assert.equal(excess.ok, false);
  assert.equal(excess.error.code, "UNAVAILABLE");
  assert.equal(tracker.inputs.length, 1);
  assert.equal(execCount, 1);
  const duplicate = invokeGateway(handler, { ...fixture.params });
  releaseUploads();
  const [firstResult, duplicateResult] = await Promise.all([
    first,
    duplicate,
  ]);
  assert.equal(firstResult.ok, true);
  assert.equal(duplicateResult.ok, true);
  assert.equal(duplicateResult.payload.cached, true);
  assert.equal(tracker.inputs.length, 1);
  assert.equal(tracker.cleanups, 1);
  assert.equal(execCount, 1);
});

test("independent handlers never render or upload across a durable reservation race", async (t) => {
  const fixture = await createFixture(t);
  const firstTracker = { inputs: [], cleanups: 0 };
  const secondTracker = { inputs: [], cleanups: 0 };
  let releaseUpload;
  const heldUpload = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  let announceUpload;
  const uploadAnnounced = new Promise((resolve) => {
    announceUpload = resolve;
  });
  let execCount = 0;
  const firstHandler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, firstTracker),
    execFileFn: async () => {
      execCount += 1;
      announceUpload();
      await heldUpload;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  const secondHandler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, secondTracker),
    execFileFn: async () => {
      execCount += 1;
      throw new Error("reserved replay must not upload");
    },
  });

  const first = invokeGateway(firstHandler, fixture.params);
  await uploadAnnounced;
  try {
    const blocked = await invokeGateway(secondHandler, fixture.params);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "UNAVAILABLE");
    assert.equal(secondTracker.inputs.length, 0);
    assert.equal(secondTracker.cleanups, 0);
    assert.equal(execCount, 1);
  } finally {
    releaseUpload();
  }
  const completed = await first;
  assert.equal(completed.ok, true);
  assert.equal(firstTracker.inputs.length, 1);
  assert.equal(firstTracker.cleanups, 1);
  assert.equal(execCount, 1);
});

test("durable replay is cached without reupload and conflicting text stays rejected", async (t) => {
  const fixture = await createFixture(t);
  const firstTracker = { inputs: [], cleanups: 0 };
  let execCount = 0;
  const firstHandler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, firstTracker),
    execFileFn: async () => {
      execCount += 1;
      return {
        stdout: JSON.stringify({ id: DOCUMENT_ID, hash: CLOUD_HASH }),
        stderr: "",
      };
    },
  });
  const first = await invokeGateway(firstHandler, fixture.params);
  assert.equal(first.ok, true);
  assert.equal(first.payload.cached, false);

  const replayTracker = { inputs: [], cleanups: 0 };
  const replayHandler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, replayTracker),
    execFileFn: async () => {
      execCount += 1;
      throw new Error("cached replay must not upload");
    },
  });
  const replay = await invokeGateway(replayHandler, fixture.params);
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.cached, true);
  assert.equal(execCount, 1);
  assert.equal(replayTracker.inputs.length, 0);
  assert.equal(replayTracker.cleanups, 0);

  const conflict = await invokeGateway(replayHandler, {
    ...fixture.params,
    responseText: "A conflicting completed response.",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(execCount, 1);
  assert.equal(replayTracker.inputs.length, 0);
  assert.equal(replayTracker.cleanups, 0);
});

test("cleans renderer output when cloud confirmation fails", async (t) => {
  const fixture = await createFixture(t);
  const tracker = { inputs: [], cleanups: 0 };
  const handler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, tracker),
    execFileFn: async () => ({ stdout: "not-json", stderr: "" }),
  });
  const result = await invokeGateway(handler, fixture.params);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAVAILABLE");
  assert.equal(tracker.cleanups, 1);

  const retryTracker = { inputs: [], cleanups: 0 };
  const retryHandler = fixture.createHandler({
    renderer: createRenderer(fixture.stateDir, retryTracker),
    execFileFn: async () => {
      throw new Error("ambiguous replay must not upload");
    },
  });
  const retry = await invokeGateway(retryHandler, fixture.params);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, "UNAVAILABLE");
  assert.equal(retryTracker.inputs.length, 0);
  assert.equal(retryTracker.cleanups, 0);
});
