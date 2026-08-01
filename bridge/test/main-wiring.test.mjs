import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridgeSelectionService } from "../src/service-runtime.mjs";
import {
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_VERSION,
  ORIGIN_CAPABILITIES_METHOD,
  SOURCE_PROVENANCE_PROTOCOL_VERSION,
  SMART_REMARKABLE_ATTACHMENT_ROLES,
  SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  SMART_REMARKABLE_SELECTION_KINDS,
} from "../src/source-provenance.mjs";

function exactCapabilities() {
  return {
    status: "ready",
    pluginId: OPENCLAW_PLUGIN_ID,
    pluginVersion: OPENCLAW_PLUGIN_VERSION,
    originProtocol: SOURCE_PROVENANCE_PROTOCOL_VERSION,
    inputContextVersions: [SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION],
    attachmentRoles: [...SMART_REMARKABLE_ATTACHMENT_ROLES],
    selectionKinds: [...SMART_REMARKABLE_SELECTION_KINDS],
  };
}

function readyGateway(overrides = {}) {
  let generation = 1;
  let nextGeneration = 1;
  let capabilityCalls = 0;
  const connectionListeners = new Set();
  const gateway = {
    capabilities: exactCapabilities(),
    async request(method, params) {
      assert.equal(method, ORIGIN_CAPABILITIES_METHOD);
      assert.deepEqual(params, {});
      capabilityCalls += 1;
      return this.capabilities;
    },
    async requestForGeneration(expectedGeneration, method, params, options) {
      if (expectedGeneration !== generation || generation === null) {
        throw new Error("Gateway generation is unavailable");
      }
      const result = await this.request(method, params, options);
      if (expectedGeneration !== generation) {
        throw new Error("Gateway generation changed");
      }
      return result;
    },
    getConnectionGeneration() {
      return generation;
    },
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    disconnect() {
      generation = null;
      for (const listener of connectionListeners) {
        listener({ connected: false, generation: null });
      }
    },
    reconnect() {
      generation = ++nextGeneration;
      for (const listener of connectionListeners) {
        listener({ connected: true, generation });
      }
    },
    get capabilityCalls() {
      return capabilityCalls;
    },
    subscribe() {
      return () => {};
    },
  };
  return Object.assign(gateway, overrides);
}

test("production service wiring supplies a persistent request journal", async (t) => {
  const requestJournalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-main-wiring-"),
  );
  t.after(async () => {
    await fs.rm(requestJournalDir, { recursive: true, force: true });
  });
  let unsubscribed = false;
  const gateway = readyGateway({
    subscribe() {
      return () => {
        unsubscribed = true;
      };
    },
  });
  const service = await createBridgeSelectionService({
    gateway,
    config: {
      requestJournalDir,
      requestJournalMaxEntries: 10,
      sendTimeoutMs: 100,
    },
    logger: { error() {} },
  });
  assert.ok(service);
  assert.equal(service.isReady(), true);
  assert.equal(gateway.capabilityCalls, 1);
  await service.close();
  assert.equal(unsubscribed, true);
});

test("production service wiring fails before health startup for an unowned journal root", async (t) => {
  const requestJournalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-unowned-journal-"),
  );
  t.after(async () => {
    await fs.rm(requestJournalDir, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(requestJournalDir, "unrelated-owner-data"),
    "must not be overwritten",
  );
  const gateway = readyGateway();
  await assert.rejects(
    createBridgeSelectionService({
      gateway,
      config: {
        requestJournalDir,
        requestJournalMaxEntries: 10,
        sendTimeoutMs: 100,
      },
      logger: { error() {} },
    }),
    /not an owned empty directory/,
  );
});

test("production service wiring refuses a mismatched plugin before health startup", async (t) => {
  const requestJournalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-plugin-mismatch-"),
  );
  t.after(async () => {
    await fs.rm(requestJournalDir, { recursive: true, force: true });
  });
  const gateway = readyGateway({
    async request() {
      return {
        status: "ready",
        pluginId: OPENCLAW_PLUGIN_ID,
        pluginVersion: "0.2.2",
        originProtocol: "smart-remarkable-origin-v2",
        selectionKinds: ["ink"],
      };
    },
  });
  await assert.rejects(
    createBridgeSelectionService({
      gateway,
      config: {
        requestJournalDir,
        requestJournalMaxEntries: 10,
        sendTimeoutMs: 100,
      },
      logger: { error() {} },
    }),
    /capability contract mismatch/,
  );
});

test("capability readiness is invalidated and reprobed for each Gateway generation", async (t) => {
  const requestJournalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-generation-readiness-"),
  );
  t.after(async () => {
    await fs.rm(requestJournalDir, { recursive: true, force: true });
  });
  const gateway = readyGateway();
  const service = await createBridgeSelectionService({
    gateway,
    config: {
      requestJournalDir,
      requestJournalMaxEntries: 10,
      sendTimeoutMs: 100,
    },
    logger: { error() {} },
  });
  t.after(async () => service.close());
  assert.equal(service.isReady(), true);
  assert.equal(gateway.capabilityCalls, 1);

  gateway.disconnect();
  assert.equal(service.isReady(), false);
  await assert.rejects(service.ensureReady(), /not connected/);
  assert.equal(gateway.capabilityCalls, 1);

  gateway.capabilities = {
    ...exactCapabilities(),
    pluginVersion: "0.2.2",
  };
  gateway.reconnect();
  assert.equal(service.isReady(), false);
  await assert.rejects(service.ensureReady(), /capability contract mismatch/);
  assert.equal(service.isReady(), false);
  assert.equal(gateway.capabilityCalls, 2);

  gateway.capabilities = exactCapabilities();
  assert.equal(await service.ensureReady(), 2);
  assert.equal(service.isReady(), true);
  assert.equal(gateway.capabilityCalls, 3);
  assert.equal(await service.ensureReady(), 2);
  assert.equal(gateway.capabilityCalls, 3);
});
