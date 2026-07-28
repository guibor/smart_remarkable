import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridgeSelectionService } from "../src/service-runtime.mjs";

test("production service wiring supplies a persistent request journal", async (t) => {
  const requestJournalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-main-wiring-"),
  );
  t.after(async () => {
    await fs.rm(requestJournalDir, { recursive: true, force: true });
  });
  let unsubscribed = false;
  const gateway = {
    subscribe() {
      return () => {
        unsubscribed = true;
      };
    },
  };
  const service = await createBridgeSelectionService({
    gateway,
    config: {
      requestJournalDir,
      requestJournalMaxEntries: 10,
    },
    logger: { error() {} },
  });
  assert.ok(service);
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
  const gateway = {
    subscribe() {
      return () => {};
    },
  };
  await assert.rejects(
    createBridgeSelectionService({
      gateway,
      config: {
        requestJournalDir,
        requestJournalMaxEntries: 10,
      },
      logger: { error() {} },
    }),
    /not an owned empty directory/,
  );
});
