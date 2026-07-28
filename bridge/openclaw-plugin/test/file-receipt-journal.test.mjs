import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileReceiptJournal } from "../file-receipt-journal.mjs";

const NAMESPACE = "journal-hardening-test-v1";
const KEY = "smart-remarkable-journal-hardening-0001:final";
const VALUE = Object.freeze({
  schemaVersion: 1,
  fingerprint: "a".repeat(64),
  state: "reserved",
});

async function fixture(t) {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-journal-hardening-"),
  );
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const rootDirectory = path.join(
    stateDir,
    "plugins",
    "smart-remarkable-delivery",
    NAMESPACE,
  );
  const entryDirectory = path.join(
    rootDirectory,
    crypto.createHash("sha256").update(KEY).digest("hex"),
  );
  const recordPath = path.join(entryDirectory, "record.json");
  return {
    stateDir,
    rootDirectory,
    entryDirectory,
    recordPath,
    journal: createFileReceiptJournal({
      stateDir,
      namespace: NAMESPACE,
    }),
  };
}

test("round trips through private single-link record files", async (t) => {
  const subject = await fixture(t);
  assert.equal(
    await subject.journal.registerIfAbsent(KEY, VALUE),
    true,
  );
  assert.deepEqual(await subject.journal.lookup(KEY), VALUE);

  const rootStat = await fs.lstat(subject.rootDirectory);
  const entryStat = await fs.lstat(subject.entryDirectory);
  const recordStat = await fs.lstat(subject.recordPath);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.isSymbolicLink(), false);
  assert.equal(rootStat.mode & 0o777, 0o700);
  assert.equal(entryStat.isDirectory(), true);
  assert.equal(entryStat.isSymbolicLink(), false);
  assert.equal(entryStat.mode & 0o777, 0o700);
  assert.equal(recordStat.isFile(), true);
  assert.equal(recordStat.isSymbolicLink(), false);
  assert.equal(recordStat.mode & 0o777, 0o600);
  assert.equal(recordStat.nlink, 1);
  if (typeof process.getuid === "function") {
    assert.equal(recordStat.uid, process.getuid());
  }
});

test("rejects a symlink anywhere in plugin-owned root ancestry", async (t) => {
  const subject = await fixture(t);
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-journal-outside-"),
  );
  t.after(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(
    outside,
    path.join(subject.stateDir, "plugins"),
    "dir",
  );

  await assert.rejects(subject.journal.lookup(KEY));
  assert.deepEqual(await fs.readdir(outside), []);
});

test("rejects a symlinked entry directory without writing through it", async (t) => {
  const subject = await fixture(t);
  assert.equal(await subject.journal.lookup(KEY), undefined);
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-entry-outside-"),
  );
  t.after(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(outside, subject.entryDirectory, "dir");

  await assert.rejects(
    subject.journal.registerIfAbsent(KEY, VALUE),
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("opens records without following symlinks", async (t) => {
  const subject = await fixture(t);
  await subject.journal.registerIfAbsent(KEY, VALUE);
  const outsideRecord = path.join(subject.stateDir, "outside.json");
  await fs.writeFile(
    outsideRecord,
    `${JSON.stringify({
      envelopeVersion: 1,
      key: KEY,
      value: VALUE,
    })}\n`,
    { mode: 0o600 },
  );
  await fs.unlink(subject.recordPath);
  await fs.symlink(outsideRecord, subject.recordPath);

  await assert.rejects(subject.journal.lookup(KEY));
});

test("rejects records with broad permissions or multiple hard links", async (t) => {
  const broad = await fixture(t);
  await broad.journal.registerIfAbsent(KEY, VALUE);
  await fs.chmod(broad.recordPath, 0o640);
  await assert.rejects(broad.journal.lookup(KEY));

  const linked = await fixture(t);
  await linked.journal.registerIfAbsent(KEY, VALUE);
  await fs.link(
    linked.recordPath,
    path.join(linked.entryDirectory, "record-hardlink.json"),
  );
  await assert.rejects(linked.journal.lookup(KEY));
});

test("rejects oversized records before parsing", async (t) => {
  const subject = await fixture(t);
  await subject.journal.registerIfAbsent(KEY, VALUE);
  await fs.writeFile(subject.recordPath, Buffer.alloc(64 * 1024 + 1), {
    mode: 0o600,
  });
  await fs.chmod(subject.recordPath, 0o600);

  await assert.rejects(
    subject.journal.lookup(KEY),
    /size limit|private regular file/,
  );
});

test("rejects non-files, invalid UTF-8, and forged envelopes", async (t) => {
  const directoryRecord = await fixture(t);
  await directoryRecord.journal.registerIfAbsent(KEY, VALUE);
  await fs.unlink(directoryRecord.recordPath);
  await fs.mkdir(directoryRecord.recordPath, { mode: 0o700 });
  await assert.rejects(directoryRecord.journal.lookup(KEY));

  const invalidUtf8 = await fixture(t);
  await invalidUtf8.journal.registerIfAbsent(KEY, VALUE);
  await fs.writeFile(
    invalidUtf8.recordPath,
    Buffer.from([0xff, 0xfe, 0xfd]),
    { mode: 0o600 },
  );
  await fs.chmod(invalidUtf8.recordPath, 0o600);
  await assert.rejects(
    invalidUtf8.journal.lookup(KEY),
    /valid UTF-8/,
  );

  const forged = await fixture(t);
  await forged.journal.registerIfAbsent(KEY, VALUE);
  await fs.writeFile(
    forged.recordPath,
    `${JSON.stringify({
      envelopeVersion: 1,
      key: "different-key",
      value: VALUE,
    })}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(forged.recordPath, 0o600);
  await assert.rejects(
    forged.journal.lookup(KEY),
    /failed validation/,
  );
});
