import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const JOURNAL_ENVELOPE_VERSION = 1;
const RECORD_FILE = "record.json";
const MAX_RECORD_BYTES = 64 * 1024;
const RECORD_READ_CHUNK_BYTES = 8 * 1024;
const DIRECTORY_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_DIRECTORY |
  fsConstants.O_NOFOLLOW;
const RECORD_READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const RECORD_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function assertKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Receipt journal key must be a non-empty string");
  }
}

function entryName(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function assertExpectedOwner(stat, expectedUid, label) {
  if (stat.uid !== expectedUid) {
    throw new Error(`${label} has an unexpected owner`);
  }
}

function assertPrivateDirectoryStat(stat, expectedUid, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a private directory`);
  }
  assertExpectedOwner(stat, expectedUid, label);
}

function assertRecordStat(stat, expectedUid) {
  const permissions = stat.mode & 0o777;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (permissions & ~0o600) !== 0 ||
    stat.nlink !== 1 ||
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0 ||
    stat.size > MAX_RECORD_BYTES
  ) {
    throw new Error("Receipt journal record is not a private regular file");
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

async function inspectDirectory(
  directory,
  expectedUid,
  { privateMode = false } = {},
) {
  const handle = await fs.open(directory, DIRECTORY_OPEN_FLAGS);
  try {
    let stat = await handle.stat();
    assertPrivateDirectoryStat(
      stat,
      expectedUid,
      "Receipt journal directory",
    );
    if (privateMode && (stat.mode & 0o077) !== 0) {
      await handle.chmod(0o700);
      stat = await handle.stat();
      assertPrivateDirectoryStat(
        stat,
        expectedUid,
        "Receipt journal directory",
      );
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("Receipt journal directory is not private");
      }
    }
    const pathStat = await fs.lstat(directory);
    assertPrivateDirectoryStat(
      pathStat,
      expectedUid,
      "Receipt journal directory",
    );
    if (!sameFileIdentity(stat, pathStat)) {
      throw new Error("Receipt journal directory changed during validation");
    }
    return stat;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory, expectedUid) {
  const handle = await fs.open(directory, DIRECTORY_OPEN_FLAGS);
  try {
    const stat = await handle.stat();
    assertPrivateDirectoryStat(
      stat,
      expectedUid,
      "Receipt journal directory",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPathIdentity(filePath, expectedStat, expectedUid) {
  const pathStat = await fs.lstat(filePath);
  assertRecordStat(pathStat, expectedUid);
  if (!sameFileIdentity(expectedStat, pathStat)) {
    throw new Error("Receipt journal record changed during validation");
  }
}

async function writeRecord(entryDirectory, key, value, expectedUid) {
  const temporaryPath = path.join(
    entryDirectory,
    `.record-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const finalPath = path.join(entryDirectory, RECORD_FILE);
  const data = `${JSON.stringify({
    envelopeVersion: JOURNAL_ENVELOPE_VERSION,
    key,
    value,
  })}\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("Receipt journal record exceeds its size limit");
  }
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(
      temporaryPath,
      RECORD_CREATE_FLAGS,
      0o600,
    );
    await handle.writeFile(data, "utf8");
    await handle.sync();
    const tempStat = await handle.stat();
    assertRecordStat(tempStat, expectedUid);
    if (tempStat.size !== Buffer.byteLength(data, "utf8")) {
      throw new Error("Receipt journal record write was incomplete");
    }
    await assertPathIdentity(temporaryPath, tempStat, expectedUid);
    await fs.rename(temporaryPath, finalPath);
    renamed = true;
    await assertPathIdentity(finalPath, tempStat, expectedUid);
    await syncDirectory(entryDirectory, expectedUid);
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!renamed) {
      await fs.unlink(temporaryPath).catch(() => {});
    }
    throw error;
  }
}

async function readRecord(recordPath, expectedUid) {
  const handle = await fs.open(recordPath, RECORD_READ_FLAGS);
  try {
    const initialStat = await handle.stat();
    assertRecordStat(initialStat, expectedUid);

    const chunks = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= MAX_RECORD_BYTES) {
      const remaining = MAX_RECORD_BYTES + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(
        Math.min(RECORD_READ_CHUNK_BYTES, remaining),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
      position += bytesRead;
    }
    if (
      totalBytes > MAX_RECORD_BYTES ||
      totalBytes !== initialStat.size
    ) {
      throw new Error("Receipt journal record exceeds its size limit");
    }

    const finalStat = await handle.stat();
    assertRecordStat(finalStat, expectedUid);
    if (
      !sameFileIdentity(initialStat, finalStat) ||
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ctimeMs !== initialStat.ctimeMs
    ) {
      throw new Error("Receipt journal record changed while being read");
    }
    await assertPathIdentity(recordPath, finalStat, expectedUid);
    try {
      return UTF8_DECODER.decode(Buffer.concat(chunks, totalBytes));
    } catch {
      throw new Error("Receipt journal record is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

/**
 * A plugin-owned receipt journal for ordinary workspace plugins.
 *
 * Each reservation owns an atomically-created, hash-named directory. A crash
 * after mkdir but before the record rename leaves an incomplete directory,
 * which lookup treats as an error rather than as an absent reservation. Record
 * replacement is write-fsync-rename-fsync, so the previous reservation remains
 * the fail-closed fallback until a sent receipt is durably committed.
 */
export function createFileReceiptJournal({
  stateDir,
  namespace = "smart-remarkable-delivery-receipts-v1",
}) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
    throw new Error("OpenClaw state directory must be an absolute path");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(namespace)) {
    throw new Error("Invalid receipt journal namespace");
  }
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error("Receipt journal requires POSIX owner validation");
  }

  const rootDirectory = path.join(
    stateDir,
    "plugins",
    "smart-remarkable-delivery",
    namespace,
  );

  async function ensureRoot() {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await inspectDirectory(stateDir, expectedUid);
    let current = stateDir;
    for (const component of [
      "plugins",
      "smart-remarkable-delivery",
      namespace,
    ]) {
      current = path.join(current, component);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
      await inspectDirectory(current, expectedUid, {
        privateMode: current === rootDirectory,
      });
    }
  }

  function directoryFor(key) {
    assertKey(key);
    return path.join(rootDirectory, entryName(key));
  }

  return Object.freeze({
    async lookup(key) {
      await ensureRoot();
      const entryDirectory = directoryFor(key);
      const recordPath = path.join(entryDirectory, RECORD_FILE);
      let raw;
      try {
        await inspectDirectory(entryDirectory, expectedUid, {
          privateMode: true,
        });
        raw = await readRecord(recordPath, expectedUid);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        try {
          await inspectDirectory(entryDirectory, expectedUid, {
            privateMode: true,
          });
        } catch (entryError) {
          if (entryError?.code === "ENOENT") {
            return undefined;
          }
          throw entryError;
        }
        throw new Error("Receipt journal reservation is incomplete");
      }

      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new Error("Receipt journal record is corrupt");
      }
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        envelope.envelopeVersion !== JOURNAL_ENVELOPE_VERSION ||
        envelope.key !== key ||
        !envelope.value ||
        typeof envelope.value !== "object" ||
        Array.isArray(envelope.value)
      ) {
        throw new Error("Receipt journal record failed validation");
      }
      return structuredClone(envelope.value);
    },

    async registerIfAbsent(key, value) {
      await ensureRoot();
      const entryDirectory = directoryFor(key);
      try {
        await fs.mkdir(entryDirectory, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          await inspectDirectory(entryDirectory, expectedUid, {
            privateMode: true,
          });
          return false;
        }
        throw error;
      }

      // Never remove this directory on failure. Its continued existence is
      // the fail-closed reservation for a process that cannot prove whether a
      // later platform send occurred.
      await inspectDirectory(entryDirectory, expectedUid, {
        privateMode: true,
      });
      await writeRecord(entryDirectory, key, value, expectedUid);
      await syncDirectory(rootDirectory, expectedUid);
      return true;
    },

    async register(key, value) {
      await ensureRoot();
      const entryDirectory = directoryFor(key);
      await inspectDirectory(entryDirectory, expectedUid, {
        privateMode: true,
      });
      await writeRecord(entryDirectory, key, value, expectedUid);
    },
  });
}
