import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createRequestJournal,
  RequestJournalError,
} from "../src/request-journal.mjs";

const REQUEST_ID = "smart-remarkable-journal-test-0001";
const FINGERPRINT = crypto.createHash("sha256").update("selection").digest("hex");

function identity(
  requestId = REQUEST_ID,
  fingerprint = FINGERPRINT,
  selectionKind = "ink",
) {
  return {
    requestId,
    fingerprint,
    mode: "write_back",
    selectionKind,
  };
}

function response(requestId = REQUEST_ID, replayed = false) {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    model: "openclaw/main",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Safe final response." },
        finish_reason: "stop",
      },
    ],
    openclaw_delivery: {
      requested: true,
      channel: "whatsapp",
      acknowledgement: { status: "sent" },
      final: { status: "sent" },
    },
    x_smart_remarkable: {
      request_id: requestId,
      response_mode: "write_back",
      selection_kind: "ink",
      replayed,
    },
  };
}

async function temporaryJournal(t, maxEntries = 10) {
  const rootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-journal-unit-"),
  );
  t.after(async () => {
    await fs.rm(rootDirectory, { recursive: true, force: true });
  });
  return {
    journal: createRequestJournal({ rootDirectory, maxEntries }),
    rootDirectory,
  };
}

function digest(requestId) {
  return crypto.createHash("sha256").update(requestId).digest("hex");
}

function responseDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

async function rewriteEntryAsSchemaV1(rootDirectory, requestId) {
  const recordPath = path.join(
    rootDirectory,
    digest(requestId),
    "record.json",
  );
  const envelope = JSON.parse(await fs.readFile(recordPath, "utf8"));
  envelope.record.schemaVersion = 1;
  delete envelope.record.selectionKind;
  if (envelope.record.state === "completed") {
    delete envelope.record.response.x_smart_remarkable.selection_kind;
    envelope.record.responseHash = responseDigest(envelope.record.response);
  }
  await fs.writeFile(recordPath, `${JSON.stringify(envelope)}\n`, {
    mode: 0o600,
  });
}

async function allRegularFileContents(rootDirectory) {
  const contents = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        contents.push(await fs.readFile(filePath, "utf8"));
      }
    }
  }
  await visit(rootDirectory);
  return contents;
}

test("durably replays a completed response without persisting the selected PNG", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  assert.deepEqual(await journal.reserve(identity()), { kind: "reserved" });
  await journal.complete({
    ...identity(),
    response: response(),
  });

  const restarted = createRequestJournal({
    rootDirectory,
    maxEntries: 10,
  });
  const replay = await restarted.reserve(identity());
  assert.equal(replay.kind, "completed");
  assert.equal(replay.response.x_smart_remarkable.replayed, true);
  assert.equal(
    replay.response.choices[0].message.content,
    "Safe final response.",
  );
  await assert.rejects(
    journal.reserve(identity(REQUEST_ID, FINGERPRINT, "image")),
    (error) =>
      error instanceof RequestJournalError &&
      error.code === "conflict",
  );

  const persisted = (await allRegularFileContents(rootDirectory)).join("\n");
  assert.equal(persisted.includes("data:image/png;base64,"), false);
  assert.equal(persisted.includes("iVBORw0KGgo"), false);
  const rootMode = (await fs.stat(rootDirectory)).mode & 0o777;
  assert.equal(rootMode, 0o700);
  const recordPath = path.join(
    rootDirectory,
    digest(REQUEST_ID),
    "record.json",
  );
  assert.equal((await fs.stat(recordPath)).mode & 0o777, 0o600);
  assert.equal(
    (await fs.readdir(path.dirname(recordPath))).some((name) =>
      name.endsWith(".tmp"),
    ),
    false,
  );
});

test("an incomplete atomic directory reservation is never treated as absent", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  const seedId = "smart-remarkable-journal-seed-0001";
  await journal.reserve(identity(seedId));
  await fs.mkdir(path.join(rootDirectory, digest(REQUEST_ID)), {
    mode: 0o700,
  });

  await assert.rejects(
    journal.reserve(identity()),
    (error) =>
      error instanceof RequestJournalError && error.code === "incomplete",
  );
});

test("journal identities require the worker-owned request ID namespace", async (t) => {
  const { journal } = await temporaryJournal(t);
  await assert.rejects(
    journal.reserve(identity("ordinary-client-journal-0001")),
    (error) =>
      error instanceof RequestJournalError && error.code === "invalid",
  );
});

test("a schema-v1 reservation remains a fail-closed barrier", async (t) => {
  const requestId = "smart-remarkable-schema-v1-reserved-0001";
  const { journal, rootDirectory } = await temporaryJournal(t);
  await journal.reserve(identity(requestId));
  await rewriteEntryAsSchemaV1(rootDirectory, requestId);

  const restarted = createRequestJournal({ rootDirectory, maxEntries: 10 });
  await assert.rejects(
    restarted.reserve(identity(requestId)),
    (error) =>
      error instanceof RequestJournalError && error.code === "incomplete",
  );
});

test("a schema-v1 completion is never replayed and retains capacity", async (t) => {
  const legacyId = "smart-remarkable-schema-v1-completed-0001";
  const currentId = "smart-remarkable-schema-v2-current-0001";
  const overflowId = "smart-remarkable-schema-v2-overflow-0001";
  const { journal, rootDirectory } = await temporaryJournal(t, 2);
  await journal.reserve(identity(legacyId));
  await journal.complete({
    ...identity(legacyId),
    response: response(legacyId),
  });
  await rewriteEntryAsSchemaV1(rootDirectory, legacyId);

  const restarted = createRequestJournal({ rootDirectory, maxEntries: 2 });
  await assert.rejects(
    restarted.reserve(identity(legacyId)),
    (error) =>
      error instanceof RequestJournalError && error.code === "incomplete",
  );
  assert.deepEqual(await restarted.reserve(identity(currentId)), {
    kind: "reserved",
  });
  await assert.rejects(
    restarted.reserve(identity(overflowId)),
    (error) =>
      error instanceof RequestJournalError && error.code === "capacity",
  );
});

test("a corrupt record fails closed", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  const seedId = "smart-remarkable-journal-seed-0002";
  await journal.reserve(identity(seedId));
  const entryDirectory = path.join(rootDirectory, digest(REQUEST_ID));
  await fs.mkdir(entryDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(entryDirectory, "record.json"), "{not-json", {
    mode: 0o600,
  });

  await assert.rejects(
    journal.reserve(identity()),
    (error) =>
      error instanceof RequestJournalError && error.code === "corrupt",
  );
});

test("symlinked roots, entries, and records are rejected", async (t) => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-journal-symlink-"),
  );
  t.after(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  const target = path.join(parent, "target");
  const linkedRoot = path.join(parent, "linked-root");
  await fs.mkdir(target);
  await fs.symlink(target, linkedRoot);
  const rootJournal = createRequestJournal({
    rootDirectory: linkedRoot,
    maxEntries: 10,
  });
  await assert.rejects(
    rootJournal.reserve(identity()),
    (error) => error instanceof RequestJournalError && error.code === "unsafe",
  );

  const { journal, rootDirectory } = await temporaryJournal(t);
  const seedId = "smart-remarkable-journal-seed-0003";
  await journal.reserve(identity(seedId));
  const entryDirectory = path.join(rootDirectory, digest(REQUEST_ID));
  await fs.symlink(target, entryDirectory);
  await assert.rejects(
    journal.reserve(identity()),
    (error) => error instanceof RequestJournalError && error.code === "unsafe",
  );
  await fs.unlink(entryDirectory);

  const externalJournalRoot = path.join(parent, "external-journal");
  const externalJournal = createRequestJournal({
    rootDirectory: externalJournalRoot,
    maxEntries: 10,
  });
  await externalJournal.reserve(identity());
  await fs.symlink(
    path.join(externalJournalRoot, digest(REQUEST_ID)),
    entryDirectory,
  );
  await assert.rejects(
    journal.reserve(identity()),
    (error) => error instanceof RequestJournalError && error.code === "unsafe",
  );
  await fs.unlink(entryDirectory);

  await fs.mkdir(entryDirectory, { mode: 0o700 });
  const externalRecord = path.join(parent, "external-record.json");
  await fs.writeFile(externalRecord, "{}");
  await fs.symlink(externalRecord, path.join(entryDirectory, "record.json"));
  await assert.rejects(
    journal.reserve(identity()),
    (error) => error instanceof RequestJournalError && error.code === "unsafe",
  );
});

test("capacity uses atomic fixed slots and rejects new IDs at the hard cap", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t, 1);
  await journal.reserve(identity());
  await assert.rejects(
    journal.reserve(
      identity(
        "smart-remarkable-journal-capacity-0002",
        crypto.createHash("sha256").update("other").digest("hex"),
      ),
    ),
    (error) =>
      error instanceof RequestJournalError && error.code === "capacity",
  );
  const slots = await fs.readdir(path.join(rootDirectory, ".capacity-slots"));
  assert.equal(slots.length, 1);
});

test("two journal instances atomically reserve a request only once", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  const competing = createRequestJournal({
    rootDirectory,
    maxEntries: 10,
  });
  const results = await Promise.allSettled([
    journal.reserve(identity()),
    competing.reserve(identity()),
  ]);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "fulfilled" && result.value.kind === "reserved",
    ).length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof RequestJournalError &&
        result.reason.code === "incomplete",
    ).length,
    1,
  );
  assert.equal(
    (await fs.readdir(path.join(rootDirectory, ".capacity-slots"))).length,
    1,
  );
});

test("journal preparation waits for a racing ownership-marker writer", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  const markerPath = path.join(
    rootDirectory,
    ".smart-remarkable-request-journal-v1",
  );
  await fs.writeFile(markerPath, "", { flag: "wx", mode: 0o600 });
  const writer = new Promise((resolve, reject) => {
    setTimeout(() => {
      fs.writeFile(
        markerPath,
        "smart-remarkable-request-journal-v1\n",
        "utf8",
      ).then(resolve, reject);
    }, 10);
  });

  try {
    await journal.prepare();
  } finally {
    await writer;
  }
  assert.equal(
    (await fs.stat(path.join(rootDirectory, ".capacity-slots"))).isDirectory(),
    true,
  );
});

test("preparation durably creates every missing journal ancestor", async (t) => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-journal-ancestors-"),
  );
  t.after(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });
  const rootDirectory = path.join(
    parent,
    "missing-one",
    "missing-two",
    "request-journal-v1",
  );
  const journal = createRequestJournal({
    rootDirectory,
    maxEntries: 10,
  });
  await journal.prepare();
  assert.equal((await fs.stat(rootDirectory)).mode & 0o777, 0o700);
  assert.equal(
    await fs.readFile(
      path.join(rootDirectory, ".smart-remarkable-request-journal-v1"),
      "utf8",
    ),
    "smart-remarkable-request-journal-v1\n",
  );
});

test("orphan temporary files cannot replace the last committed record", async (t) => {
  const { journal, rootDirectory } = await temporaryJournal(t);
  await journal.reserve(identity());
  const entryDirectory = path.join(rootDirectory, digest(REQUEST_ID));
  await fs.writeFile(
    path.join(entryDirectory, ".record-interrupted.tmp"),
    '{"partial":',
    { mode: 0o600 },
  );

  await journal.complete({ ...identity(), response: response() });
  const replay = await journal.reserve(identity());
  assert.equal(replay.kind, "completed");
  assert.equal(replay.response.x_smart_remarkable.replayed, true);
});
