import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SMART_REMARKABLE_REQUEST_ID_PATTERN } from "./source-provenance.mjs";

const ENVELOPE_VERSION = 1;
const RECORD_VERSION = 2;
const RECORD_FILE = "record.json";
const SLOT_DIRECTORY = ".capacity-slots";
const OWNERSHIP_FILE = ".smart-remarkable-request-journal-v1";
const OWNERSHIP_MARKER = "smart-remarkable-request-journal-v1\n";
const MAX_RECORD_BYTES = 128 * 1024;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MODES = new Set(["write_back", "whatsapp_only"]);
const SELECTION_KINDS = new Set(["ink", "image", "mixed"]);
const SLOT_PATTERN = /^\d{8}\.claim$/;

export class RequestJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RequestJournalError";
    this.code = code;
  }
}

function journalError(code, message) {
  return new RequestJournalError(code, message);
}

function validateIdentity({
  requestId,
  fingerprint,
  mode,
  selectionKind,
}) {
  if (
    typeof requestId !== "string" ||
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId) ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint) ||
    !MODES.has(mode) ||
    !SELECTION_KINDS.has(selectionKind)
  ) {
    throw journalError("invalid", "Invalid request journal identity");
  }
  return Object.freeze({
    requestId,
    fingerprint,
    mode,
    selectionKind,
  });
}

function requestDigest(requestId) {
  return crypto.createHash("sha256").update(requestId).digest("hex");
}

function responseDigest(response) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(response))
    .digest("hex");
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw journalError("corrupt", message);
  }
}

function validateStoredResponse(response, identity) {
  assertPlainObject(response, "Completed request response is invalid");
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECORD_BYTES) {
    throw journalError("corrupt", "Completed request response is oversized");
  }
  if (
    response?.x_smart_remarkable?.request_id !== identity.requestId ||
    response?.x_smart_remarkable?.response_mode !== identity.mode ||
    response?.x_smart_remarkable?.selection_kind !==
      identity.selectionKind ||
    !Array.isArray(response.choices) ||
    response.choices.length !== 1 ||
    !response.openclaw_delivery ||
    typeof response.openclaw_delivery !== "object"
  ) {
    throw journalError("corrupt", "Completed request response failed validation");
  }
  return structuredClone(response);
}

function validateRecord(record, expectedRequestId) {
  assertPlainObject(record, "Request journal record is invalid");
  if (record.schemaVersion === 1) {
    throw journalError(
      "incomplete",
      "Legacy request journal entry cannot be safely replayed",
    );
  }
  if (record.schemaVersion !== RECORD_VERSION) {
    throw journalError("corrupt", "Request journal record version is invalid");
  }
  let identity;
  try {
    identity = validateIdentity(record);
  } catch (error) {
    if (error instanceof RequestJournalError && error.code === "invalid") {
      throw journalError("corrupt", "Request journal identity is invalid");
    }
    throw error;
  }
  if (
    identity.requestId !== expectedRequestId ||
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    typeof record.capacitySlot !== "string" ||
    !SLOT_PATTERN.test(record.capacitySlot)
  ) {
    throw journalError("corrupt", "Request journal record failed validation");
  }
  if (record.state === "reserved") {
    return Object.freeze({
      ...identity,
      state: "reserved",
      capacitySlot: record.capacitySlot,
      createdAt: record.createdAt,
    });
  }
  if (
    record.state !== "completed" ||
    typeof record.completedAt !== "number" ||
    !Number.isSafeInteger(record.completedAt) ||
    typeof record.responseHash !== "string" ||
    !FINGERPRINT_PATTERN.test(record.responseHash)
  ) {
    throw journalError("corrupt", "Request journal state failed validation");
  }
  const response = validateStoredResponse(record.response, identity);
  if (responseDigest(response) !== record.responseHash) {
    throw journalError("corrupt", "Completed request response hash mismatch");
  }
  return Object.freeze({
    ...identity,
    state: "completed",
    capacitySlot: record.capacitySlot,
    createdAt: record.createdAt,
    response,
  });
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectoryDurably(directory, mode = 0o700) {
  try {
    await fs.mkdir(directory, { mode });
    await syncDirectory(path.dirname(directory));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const parent = path.dirname(directory);
  if (parent === directory) {
    throw journalError(
      "unsafe",
      "Request journal directory hierarchy cannot be created",
    );
  }
  await createDirectoryDurably(parent, mode);
  return createDirectoryDurably(directory, mode);
}

async function assertPrivateDirectory(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw journalError("unsafe", `${label} must be a regular directory`);
  }
  await fs.chmod(directory, 0o700);
}

async function ensureOwnershipMarker(rootDirectory) {
  const markerPath = path.join(rootDirectory, OWNERSHIP_FILE);
  async function readMarker() {
    let handle;
    try {
      handle = await fs.open(
        markerPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return "missing";
      }
      if (error?.code === "ELOOP") {
        throw journalError(
          "unsafe",
          "Request journal ownership marker cannot be a symlink",
        );
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 128) {
        throw journalError(
          "unsafe",
          "Request journal ownership marker is invalid",
        );
      }
      if (stat.size === 0) {
        return "pending";
      }
      return (await handle.readFile("utf8")) === OWNERSHIP_MARKER
        ? "valid"
        : "invalid";
    } finally {
      await handle.close();
    }
  }

  async function waitForMarkerWriter() {
    let state = await readMarker();
    for (let attempt = 0; state === "pending" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      state = await readMarker();
    }
    return state;
  }

  let markerState = await waitForMarkerWriter();
  if (markerState === "valid") {
    return;
  }
  if (markerState === "invalid" || markerState === "pending") {
    throw journalError(
      "unsafe",
      "Request journal ownership marker is invalid",
    );
  }
  if ((await fs.readdir(rootDirectory)).length !== 0) {
    // A racing creator may have opened the marker between readMarker and
    // readdir. Re-check once before treating other contents as unowned.
    markerState = await waitForMarkerWriter();
    if (markerState === "valid") {
      return;
    }
    throw journalError(
      "unsafe",
      "Request journal root is not an owned empty directory",
    );
  }

  let handle;
  try {
    handle = await fs.open(markerPath, "wx", 0o600);
    await handle.writeFile(OWNERSHIP_MARKER, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(rootDirectory);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") {
      throw error;
    }
    // Another creator can win `open("wx")` but still be between creation and
    // its fsynced marker write. Treat the zero-byte state as pending for a
    // bounded interval, never as proof of ownership.
    if ((await waitForMarkerWriter()) !== "valid") {
      throw journalError(
        "unsafe",
        "Request journal ownership marker is invalid",
      );
    }
  }
}

async function ensureRootDirectory(rootDirectory, slotDirectory) {
  await createDirectoryDurably(rootDirectory);
  const rootStat = await fs.lstat(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw journalError(
      "unsafe",
      "Request journal root must be a regular directory",
    );
  }
  await ensureOwnershipMarker(rootDirectory);
  await fs.chmod(rootDirectory, 0o700);

  let slotCreated = false;
  try {
    await fs.mkdir(slotDirectory, { mode: 0o700 });
    slotCreated = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  await assertPrivateDirectory(slotDirectory, "Request journal capacity root");
  if (slotCreated) {
    await syncDirectory(rootDirectory);
  }
}

async function openRegularFileNoFollow(filePath) {
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw journalError("unsafe", "Request journal record cannot be a symlink");
    }
    throw error;
  }
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    await handle.close();
    throw journalError("corrupt", "Request journal record size is invalid");
  }
  return handle;
}

async function writeRecord(entryDirectory, requestId, record) {
  const temporaryPath = path.join(
    entryDirectory,
    `.record-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const finalPath = path.join(entryDirectory, RECORD_FILE);
  const data = `${JSON.stringify({
    envelopeVersion: ENVELOPE_VERSION,
    requestDigest: requestDigest(requestId),
    record,
  })}\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) {
    throw journalError("invalid", "Request journal record is too large");
  }

  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, finalPath);
    await syncDirectory(entryDirectory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readRecord(rootDirectory, requestId) {
  const digest = requestDigest(requestId);
  const entryDirectory = path.join(rootDirectory, digest);
  const recordPath = path.join(entryDirectory, RECORD_FILE);
  try {
    await assertPrivateDirectory(entryDirectory, "Request journal entry");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let handle;
  try {
    handle = await openRegularFileNoFollow(recordPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    throw journalError(
      "incomplete",
      "Request journal reservation is incomplete",
    );
  }

  let raw;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw journalError("corrupt", "Request journal record is not valid JSON");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.envelopeVersion !== ENVELOPE_VERSION ||
    envelope.requestDigest !== digest
  ) {
    throw journalError("corrupt", "Request journal envelope failed validation");
  }
  return validateRecord(envelope.record, requestId);
}

function sameIdentity(record, identity) {
  return (
    record.requestId === identity.requestId &&
    record.fingerprint === identity.fingerprint &&
    record.mode === identity.mode &&
    record.selectionKind === identity.selectionKind
  );
}

function slotName(index) {
  return `${String(index).padStart(8, "0")}.claim`;
}

function firstSlotIndex(digest, maxEntries) {
  return Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(maxEntries));
}

async function claimCapacitySlot(slotDirectory, digest, maxEntries) {
  const first = firstSlotIndex(digest, maxEntries);
  for (let probe = 0; probe < maxEntries; probe += 1) {
    const index = (first + probe) % maxEntries;
    const name = slotName(index);
    const slotPath = path.join(slotDirectory, name);
    let handle;
    try {
      handle = await fs.open(slotPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        continue;
      }
      throw error;
    }
    try {
      await handle.writeFile(`${digest}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(slotDirectory);
      return name;
    } catch (error) {
      await handle?.close().catch(() => {});
      // Keep a partially-created capacity claim fail-closed. It can consume
      // one slot, but can never permit the journal to exceed its hard cap.
      throw error;
    }
  }
  throw journalError("capacity", "Request journal capacity is exhausted");
}

async function releaseUnusedSlot(slotDirectory, slot) {
  try {
    await fs.unlink(path.join(slotDirectory, slot));
    await syncDirectory(slotDirectory);
  } catch {
    // A leaked slot reduces capacity but cannot weaken idempotency.
  }
}

export function markResponseReplayed(response) {
  const replay = structuredClone(response);
  assertPlainObject(
    replay.x_smart_remarkable,
    "Response replay metadata is missing",
  );
  replay.x_smart_remarkable.replayed = true;
  return replay;
}

/**
 * Persistent fail-closed request journal.
 *
 * Reservation directories and fixed-capacity slot claims are atomic across
 * processes. No network call is made while a filesystem lock is held. Records
 * contain only request metadata and the final safe response; selected PNG data
 * is represented only by its SHA-256 fingerprint.
 */
export function createRequestJournal({
  rootDirectory,
  maxEntries = 20_000,
}) {
  if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
    throw new Error("Request journal root must be an absolute path");
  }
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    maxEntries > 100_000
  ) {
    throw new Error("Request journal maxEntries must be from 1 to 100000");
  }

  const slotDirectory = path.join(rootDirectory, SLOT_DIRECTORY);
  const ready = () => ensureRootDirectory(rootDirectory, slotDirectory);

  return Object.freeze({
    async prepare() {
      await ready();
    },

    async reserve(input) {
      const identity = validateIdentity(input);
      await ready();
      const existing = await readRecord(rootDirectory, identity.requestId);
      if (existing) {
        if (!sameIdentity(existing, identity)) {
          throw journalError(
            "conflict",
            "Request ID was already used for different content, response mode, or selection kind",
          );
        }
        if (existing.state === "completed") {
          return {
            kind: "completed",
            response: markResponseReplayed(existing.response),
          };
        }
        throw journalError(
          "incomplete",
          "Request is reserved and cannot be safely retried",
        );
      }

      const digest = requestDigest(identity.requestId);
      const capacitySlot = await claimCapacitySlot(
        slotDirectory,
        digest,
        maxEntries,
      );
      const entryDirectory = path.join(rootDirectory, digest);
      try {
        await fs.mkdir(entryDirectory, { mode: 0o700 });
      } catch (error) {
        await releaseUnusedSlot(slotDirectory, capacitySlot);
        if (error?.code !== "EEXIST") {
          throw error;
        }
        await assertPrivateDirectory(entryDirectory, "Request journal entry");
        const raced = await readRecord(rootDirectory, identity.requestId);
        if (!raced) {
          throw journalError(
            "incomplete",
            "Request reservation disappeared during creation",
          );
        }
        if (!sameIdentity(raced, identity)) {
          throw journalError(
            "conflict",
            "Request ID was already used for different content, response mode, or selection kind",
          );
        }
        if (raced.state === "completed") {
          return {
            kind: "completed",
            response: markResponseReplayed(raced.response),
          };
        }
        throw journalError(
          "incomplete",
          "Request is reserved and cannot be safely retried",
        );
      }

      const record = {
        schemaVersion: RECORD_VERSION,
        requestId: identity.requestId,
        fingerprint: identity.fingerprint,
        mode: identity.mode,
        selectionKind: identity.selectionKind,
        state: "reserved",
        capacitySlot,
        createdAt: Date.now(),
      };
      // Never remove the slot or directory after this point. Any incomplete
      // creation must remain a fail-closed barrier to a future chat.send.
      await writeRecord(entryDirectory, identity.requestId, record);
      await syncDirectory(rootDirectory);
      return { kind: "reserved" };
    },

    async complete(input) {
      const identity = validateIdentity(input);
      const response = validateStoredResponse(input.response, identity);
      await ready();
      const existing = await readRecord(rootDirectory, identity.requestId);
      if (!existing || !sameIdentity(existing, identity)) {
        throw journalError(
          "conflict",
          "Cannot complete a missing or conflicting request reservation",
        );
      }
      if (existing.state === "completed") {
        if (responseDigest(existing.response) !== responseDigest(response)) {
          throw journalError(
            "conflict",
            "Completed request response cannot be replaced",
          );
        }
        return;
      }

      const digest = requestDigest(identity.requestId);
      const entryDirectory = path.join(rootDirectory, digest);
      await writeRecord(entryDirectory, identity.requestId, {
        schemaVersion: RECORD_VERSION,
        requestId: identity.requestId,
        fingerprint: identity.fingerprint,
        mode: identity.mode,
        selectionKind: identity.selectionKind,
        state: "completed",
        capacitySlot: existing.capacitySlot,
        createdAt: existing.createdAt,
        completedAt: Date.now(),
        response,
        responseHash: responseDigest(response),
      });
    },
  });
}
