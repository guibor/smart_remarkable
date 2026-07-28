import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { createFileReceiptJournal } from "./file-receipt-journal.mjs";

export const REMARKABLE_BIND_ORIGIN_METHOD =
  "smart_remarkable.bind_origin";
export const REMARKABLE_CLEAR_ORIGIN_METHOD =
  "smart_remarkable.clear_origin";
export const REMARKABLE_UPLOAD_TOOL =
  "remarkable_deliver_document";
export const REMARKABLE_RUN_CONTEXT_NAMESPACE =
  "smart-remarkable-origin-v1";

export const DEFAULT_RM_SYNC_PYTHON =
  "/home/mdf/code/remarkable-sync/.venv/bin/python";
export const DEFAULT_RM_SYNC_CONFIG =
  "/home/mdf/.config/remarkable-sync/config.json";

const CANONICAL_AGENT_ID = "main";
const CANONICAL_SESSION_KEY = "agent:main:main";
const ORIGIN_METHOD_SCOPE = "operator.write";
const UPLOAD_JOURNAL_NAMESPACE =
  "smart-remarkable-cloud-upload-receipts-v1";
const UPLOAD_JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const HEADER_CAPTURE_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLOUD_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const RESPONSE_MODES = new Set(["write_back", "whatsapp_only"]);
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".epub"]);
const BIND_PARAM_KEYS = Object.freeze([
  "expectedSessionId",
  "mode",
  "requestId",
]);
const CLEAR_PARAM_KEYS = Object.freeze(["requestId"]);
const INTERNAL_REQUEST_ID = "__smart_remarkable_request_id";
const INTERNAL_CAPABILITY = "__smart_remarkable_capability";
const nodeExecFileAsync = promisify(nodeExecFile);

const UPLOAD_TOOL_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path", "artifact_key"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description:
        "Path to a completed PDF or EPUB inside the current OpenClaw workspace.",
    },
    artifact_key: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      description:
        "Stable key for this artifact within the current request. Reuse it only when retrying the identical file.",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description:
        "Optional visible filename on reMarkable, including the matching .pdf or .epub extension.",
    },
  },
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicError(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalidRequest(message = "Invalid Smart reMarkable origin request") {
  return publicError("INVALID_REQUEST", message);
}

function originUnavailable() {
  return publicError(
    "UNAVAILABLE",
    "Smart reMarkable origin state is unavailable",
  );
}

function uploadRejected() {
  return publicError(
    "INVALID_ARTIFACT",
    "Document delivery requires a regular PDF or EPUB inside the current workspace",
  );
}

function uploadUnauthorized() {
  return publicError(
    "UNAUTHORIZED",
    "Document delivery is available only for the current reMarkable request",
  );
}

function uploadConflict() {
  return publicError(
    "IDEMPOTENCY_CONFLICT",
    "This document delivery key was already used for different content",
  );
}

function uploadUnavailable() {
  return publicError(
    "UNAVAILABLE",
    "reMarkable Cloud upload could not be confirmed without duplicate risk",
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function requireRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw invalidRequest("Invalid Smart reMarkable request ID");
  }
  return value;
}

function requireMode(value) {
  if (typeof value !== "string" || !RESPONSE_MODES.has(value)) {
    throw invalidRequest(
      "Smart reMarkable mode must be write_back or whatsapp_only",
    );
  }
  return value;
}

function requireSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw invalidRequest("Invalid Smart reMarkable expected session ID");
  }
  return value;
}

function validateBindParams(params) {
  if (!hasExactKeys(params, BIND_PARAM_KEYS)) {
    throw invalidRequest(
      "Origin binding requires only requestId, mode, and expectedSessionId",
    );
  }
  return Object.freeze({
    requestId: requireRequestId(params.requestId),
    mode: requireMode(params.mode),
    expectedSessionId: requireSessionId(params.expectedSessionId),
  });
}

function validateClearParams(params) {
  if (!hasExactKeys(params, CLEAR_PARAM_KEYS)) {
    throw invalidRequest(
      "Origin clearing requires only requestId",
    );
  }
  return Object.freeze({
    requestId: requireRequestId(params.requestId),
  });
}

function isBoundOrigin(value, requestId = undefined) {
  return (
    isRecord(value) &&
    value.protocol === REMARKABLE_RUN_CONTEXT_NAMESPACE &&
    value.source === "remarkable" &&
    typeof value.requestId === "string" &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    (requestId === undefined || value.requestId === requestId) &&
    typeof value.mode === "string" &&
    RESPONSE_MODES.has(value.mode) &&
    typeof value.expectedSessionId === "string" &&
    SESSION_ID_PATTERN.test(value.expectedSessionId) &&
    typeof value.capability === "string" &&
    CAPABILITY_PATTERN.test(value.capability)
  );
}

function readBoundOrigin(runContext, requestId) {
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    return undefined;
  }
  const value = runContext.getRunContext({
    runId: requestId,
    namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
  });
  return isBoundOrigin(value, requestId) ? value : undefined;
}

function respondWithSafeError(respond, error) {
  if (error?.code === "INVALID_REQUEST") {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: error.message,
    });
    return;
  }
  respond(false, undefined, {
    code: "UNAVAILABLE",
    message: "Smart reMarkable origin state is unavailable",
  });
}

export function createOriginBindingHandlers({
  runContext,
  randomBytes = crypto.randomBytes,
}) {
  if (
    !runContext ||
    typeof runContext.getRunContext !== "function" ||
    typeof runContext.setRunContext !== "function" ||
    typeof runContext.clearRunContext !== "function"
  ) {
    throw new Error("OpenClaw run-context API is unavailable");
  }

  return Object.freeze({
    async bind({ params, respond }) {
      try {
        const request = validateBindParams(params);
        const existing = runContext.getRunContext({
          runId: request.requestId,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
        });
        if (existing !== undefined) {
          if (
            !isBoundOrigin(existing, request.requestId) ||
            existing.mode !== request.mode ||
            existing.expectedSessionId !== request.expectedSessionId
          ) {
            throw invalidRequest(
              "Smart reMarkable request ID is already bound to different origin state",
            );
          }
        } else {
          const capability = randomBytes(32).toString("base64url");
          if (!CAPABILITY_PATTERN.test(capability)) {
            throw new Error("Could not create a run capability");
          }
          const stored = runContext.setRunContext({
            runId: request.requestId,
            namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
            value: {
              protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
              source: "remarkable",
              requestId: request.requestId,
              mode: request.mode,
              expectedSessionId: request.expectedSessionId,
              capability,
            },
          });
          if (stored !== true) {
            throw originUnavailable();
          }
        }
        respond(
          true,
          {
            status: "bound",
            runId: request.requestId,
            source: "remarkable",
            mode: request.mode,
            expectedSessionId: request.expectedSessionId,
          },
          undefined,
        );
      } catch (error) {
        respondWithSafeError(respond, error);
      }
    },

    async clear({ params, respond }) {
      try {
        const request = validateClearParams(params);
        const existing = runContext.getRunContext({
          runId: request.requestId,
          namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
        });
        if (
          existing !== undefined &&
          !isBoundOrigin(existing, request.requestId)
        ) {
          throw originUnavailable();
        }
        if (existing !== undefined) {
          runContext.clearRunContext({
            runId: request.requestId,
            namespace: REMARKABLE_RUN_CONTEXT_NAMESPACE,
          });
        }
        respond(
          true,
          {
            status: "cleared",
            runId: request.requestId,
          },
          undefined,
        );
      } catch (error) {
        respondWithSafeError(respond, error);
      }
    },
  });
}

export function registerRemarkableOriginMethods(api, overrides = {}) {
  const handlers = createOriginBindingHandlers({
    runContext: api.runContext,
    ...overrides,
  });
  api.registerGatewayMethod(
    REMARKABLE_BIND_ORIGIN_METHOD,
    handlers.bind,
    { scope: ORIGIN_METHOD_SCOPE },
  );
  api.registerGatewayMethod(
    REMARKABLE_CLEAR_ORIGIN_METHOD,
    handlers.clear,
    { scope: ORIGIN_METHOD_SCOPE },
  );
}

function buildRemarkableTurnGuidance(origin) {
  const responseDestination =
    origin.mode === "write_back"
      ? "The text response is also written back into the selected notebook area."
      : "The text response is delivered through WhatsApp only.";
  return [
    "The current user turn came from the user's reMarkable tablet. Keep using the canonical WhatsApp conversation for conversational continuity and confirmation.",
    responseDestination,
    `If, and only if, this current request asks you to create, export, send, add, or place a document for the user, create a finished PDF or EPUB inside the current workspace and call ${REMARKABLE_UPLOAD_TOOL}. The document's artifact destination is the user's reMarkable Cloud library.`,
    "Do not upload anything merely because the user discusses, summarizes, edits, or asks about a document. Do not upload drafts or unsupported formats.",
    "Use one stable artifact_key per requested artifact. Never claim that a document reached reMarkable unless the tool returns status=uploaded; report an upload failure plainly.",
  ].join("\n");
}

export function createRemarkableOriginHooks({ runContext }) {
  if (
    !runContext ||
    typeof runContext.getRunContext !== "function"
  ) {
    throw new Error("OpenClaw run-context API is unavailable");
  }

  return Object.freeze({
    beforePromptBuild(_event, context) {
      const origin = readBoundOrigin(runContext, context?.runId);
      if (
        !origin ||
        context?.sessionId !== origin.expectedSessionId
      ) {
        return undefined;
      }
      return {
        appendSystemContext: buildRemarkableTurnGuidance(origin),
      };
    },

    beforeToolCall(event, context) {
      if (event?.toolName !== REMARKABLE_UPLOAD_TOOL) {
        return undefined;
      }
      const runId = context?.runId;
      if (
        typeof runId !== "string" ||
        (event.runId !== undefined && event.runId !== runId) ||
        context?.agentId !== CANONICAL_AGENT_ID ||
        context?.sessionKey !== CANONICAL_SESSION_KEY ||
        typeof context?.sessionId !== "string"
      ) {
        return {
          block: true,
          blockReason:
            "reMarkable document delivery is not authorized for this run",
        };
      }
      const origin = readBoundOrigin(runContext, runId);
      if (
        !origin ||
        context.sessionId !== origin.expectedSessionId
      ) {
        return {
          block: true,
          blockReason:
            "reMarkable document delivery is not authorized for this run",
        };
      }
      const params = isRecord(event.params) ? event.params : {};
      return {
        params: {
          path: params.path,
          artifact_key: params.artifact_key,
          ...(Object.hasOwn(params, "name") ? { name: params.name } : {}),
          [INTERNAL_REQUEST_ID]: runId,
          [INTERNAL_CAPABILITY]: origin.capability,
        },
      };
    },
  });
}

export function registerRemarkableOriginHooks(api, overrides = {}) {
  const hooks = createRemarkableOriginHooks({
    runContext: api.runContext,
    ...overrides,
  });
  api.on("before_prompt_build", hooks.beforePromptBuild, {
    priority: 100,
  });
  api.on("before_tool_call", hooks.beforeToolCall, {
    priority: 100,
  });
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function validateAuthorizedToolParams(params, runContext, sessionId) {
  if (!isRecord(params)) {
    throw uploadRejected();
  }
  const allowedKeys = new Set([
    "path",
    "artifact_key",
    "name",
    INTERNAL_REQUEST_ID,
    INTERNAL_CAPABILITY,
  ]);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
    throw uploadRejected();
  }
  if (
    typeof params.path !== "string" ||
    params.path.length === 0 ||
    params.path.length > 4096 ||
    params.path.includes("\0") ||
    typeof params.artifact_key !== "string" ||
    !ARTIFACT_KEY_PATTERN.test(params.artifact_key) ||
    (params.name !== undefined &&
      (typeof params.name !== "string" ||
        params.name.length === 0 ||
        params.name.length > 255))
  ) {
    throw uploadRejected();
  }
  const requestId = params[INTERNAL_REQUEST_ID];
  const capability = params[INTERNAL_CAPABILITY];
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    typeof capability !== "string" ||
    !CAPABILITY_PATTERN.test(capability)
  ) {
    throw uploadUnauthorized();
  }
  const origin = readBoundOrigin(runContext, requestId);
  if (
    !origin ||
    sessionId !== origin.expectedSessionId ||
    !constantTimeEqual(origin.capability, capability)
  ) {
    throw uploadUnauthorized();
  }
  return Object.freeze({
    requestId,
    path: params.path,
    artifactKey: params.artifact_key,
    requestedName: params.name,
  });
}

function isPathInside(rootDirectory, candidatePath) {
  const relative = path.relative(rootDirectory, candidatePath);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function normalizeVisibleName(candidate, requestedName, extension) {
  const rawName =
    requestedName === undefined
      ? path.basename(candidate)
      : requestedName;
  if (typeof rawName !== "string") {
    throw uploadRejected();
  }
  const normalized = rawName.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized !== normalized.trim() ||
    normalized === "." ||
    normalized === ".." ||
    /[\u0000-\u001f\u007f-\u009f/\\]/u.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    path.extname(normalized).toLowerCase() !== extension
  ) {
    throw uploadRejected();
  }
  return normalized;
}

async function ensurePrivateDirectory(directory, trustedRoot) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw uploadRejected();
  }
  await fs.chmod(directory, 0o700);
  const [rootReal, directoryReal] = await Promise.all([
    fs.realpath(trustedRoot),
    fs.realpath(directory),
  ]);
  if (!isPathInside(rootReal, directoryReal)) {
    throw uploadRejected();
  }
}

async function writeAll(handle, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("Snapshot write made no progress");
    }
    offset += bytesWritten;
  }
}

function validatePdfHeader(header) {
  return header.indexOf(Buffer.from("%PDF-", "ascii")) >= 0 &&
    header.indexOf(Buffer.from("%PDF-", "ascii")) < 1024;
}

function validateEpubHeader(header) {
  const mime = Buffer.from("application/epub+zip", "ascii");
  if (
    header.length < 30 ||
    header.readUInt32LE(0) !== 0x04034b50
  ) {
    return false;
  }
  const flags = header.readUInt16LE(6);
  const compression = header.readUInt16LE(8);
  const compressedSize = header.readUInt32LE(18);
  const uncompressedSize = header.readUInt32LE(22);
  const fileNameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const nameStart = 30;
  const nameEnd = nameStart + fileNameLength;
  const dataStart = nameEnd + extraLength;
  const dataEnd = dataStart + compressedSize;
  return (
    (flags & 0x0009) === 0 &&
    compression === 0 &&
    compressedSize === mime.length &&
    uncompressedSize === mime.length &&
    dataEnd <= header.length &&
    header.subarray(nameStart, nameEnd).equals(
      Buffer.from("mimetype", "ascii"),
    ) &&
    header.subarray(dataStart, dataEnd).equals(mime)
  );
}

function validateArtifactMagic(extension, header) {
  const valid =
    extension === ".pdf"
      ? validatePdfHeader(header)
      : validateEpubHeader(header);
  if (!valid) {
    throw uploadRejected();
  }
}

async function closeOpenedFile(opened) {
  try {
    if (typeof opened?.[Symbol.asyncDispose] === "function") {
      await opened[Symbol.asyncDispose]();
      return;
    }
    await opened?.handle?.close();
  } catch {
    // The caller already owns the operation outcome.
  }
}

async function stageWorkspaceArtifact({
  workspaceDir,
  stateDir,
  inputPath,
  requestedName,
  maxUploadBytes,
}) {
  if (
    typeof workspaceDir !== "string" ||
    !path.isAbsolute(workspaceDir) ||
    typeof stateDir !== "string" ||
    !path.isAbsolute(stateDir)
  ) {
    throw uploadRejected();
  }
  let workspaceReal;
  try {
    workspaceReal = await fs.realpath(workspaceDir);
  } catch {
    throw uploadRejected();
  }
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceReal, inputPath);
  if (!isPathInside(workspaceReal, candidate)) {
    throw uploadRejected();
  }
  const relativePath = path.relative(workspaceReal, candidate);

  let opened;
  let snapshotPath;
  let snapshotHandle;
  try {
    opened = await openFileWithinRoot({
      rootDir: workspaceReal,
      relativePath,
      rejectHardlinks: true,
      allowSymlinkTargetWithinRoot: false,
    });
    if (
      !opened.stat.isFile() ||
      opened.stat.size <= 0 ||
      opened.stat.size > maxUploadBytes
    ) {
      throw uploadRejected();
    }
    const extension = path.extname(candidate).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw uploadRejected();
    }
    const visibleName = normalizeVisibleName(
      candidate,
      requestedName,
      extension,
    );

    const stagingDirectory = path.join(
      stateDir,
      "plugins",
      "smart-remarkable-delivery",
      "upload-staging",
    );
    await ensurePrivateDirectory(stagingDirectory, stateDir);
    snapshotPath = path.join(
      stagingDirectory,
      `${crypto.randomUUID()}${extension}`,
    );
    snapshotHandle = await fs.open(snapshotPath, "wx", 0o600);

    const hash = crypto.createHash("sha256");
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    const headerChunks = [];
    let headerBytes = 0;
    let totalBytes = 0;
    let position = 0;
    while (true) {
      const { bytesRead } = await opened.handle.read(
        readBuffer,
        0,
        readBuffer.length,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      totalBytes += bytesRead;
      if (totalBytes > maxUploadBytes) {
        throw uploadRejected();
      }
      const chunk = readBuffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (headerBytes < HEADER_CAPTURE_BYTES) {
        const remaining = HEADER_CAPTURE_BYTES - headerBytes;
        const headerChunk = Buffer.from(
          chunk.subarray(0, Math.min(remaining, chunk.length)),
        );
        headerChunks.push(headerChunk);
        headerBytes += headerChunk.length;
      }
      await writeAll(snapshotHandle, chunk);
    }
    const finalSourceStat = await opened.handle.stat();
    if (
      totalBytes === 0 ||
      totalBytes !== opened.stat.size ||
      totalBytes !== finalSourceStat.size ||
      opened.stat.dev !== finalSourceStat.dev ||
      opened.stat.ino !== finalSourceStat.ino ||
      opened.stat.mtimeMs !== finalSourceStat.mtimeMs
    ) {
      throw uploadRejected();
    }
    await snapshotHandle.sync();
    await snapshotHandle.close();
    snapshotHandle = undefined;
    await fs.chmod(snapshotPath, 0o600);
    validateArtifactMagic(
      extension,
      Buffer.concat(headerChunks, headerBytes),
    );

    return Object.freeze({
      snapshotPath,
      extension,
      visibleName,
      contentHash: hash.digest("hex"),
      size: totalBytes,
    });
  } catch (error) {
    await snapshotHandle?.close().catch(() => {});
    if (snapshotPath) {
      await fs.unlink(snapshotPath).catch(() => {});
    }
    if (
      error?.code === "INVALID_ARTIFACT" ||
      error?.code === "UNAUTHORIZED"
    ) {
      throw error;
    }
    throw uploadRejected();
  } finally {
    await closeOpenedFile(opened);
  }
}

async function validateExecutable(executablePath) {
  if (
    typeof executablePath !== "string" ||
    !path.isAbsolute(executablePath)
  ) {
    throw uploadUnavailable();
  }
  try {
    const realPath = await fs.realpath(executablePath);
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      throw new Error("not executable");
    }
  } catch {
    throw uploadUnavailable();
  }
}

async function validateCredentialFile(configPath) {
  if (
    typeof configPath !== "string" ||
    !path.isAbsolute(configPath)
  ) {
    throw uploadUnavailable();
  }
  try {
    const [lstat, stat] = await Promise.all([
      fs.lstat(configPath),
      fs.stat(configPath),
    ]);
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      lstat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error("unsafe credential file");
    }
  } catch {
    throw uploadUnavailable();
  }
}

function validateCliReceipt(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw uploadUnavailable();
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw uploadUnavailable();
  }
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(",") !== "hash,id" ||
    typeof payload.id !== "string" ||
    !CLOUD_DOCUMENT_ID_PATTERN.test(payload.id) ||
    typeof payload.hash !== "string" ||
    !CLOUD_HASH_PATTERN.test(payload.hash)
  ) {
    throw uploadUnavailable();
  }
  return Object.freeze({
    documentId: payload.id,
    cloudHash: payload.hash.toLowerCase(),
  });
}

function buildUploadIdentity(request, artifact) {
  const uploadId = `${request.requestId}:artifact:${request.artifactKey}`;
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: UPLOAD_JOURNAL_SCHEMA_VERSION,
        protocol: REMARKABLE_RUN_CONTEXT_NAMESPACE,
        requestId: request.requestId,
        artifactKey: request.artifactKey,
        contentHash: artifact.contentHash,
        visibleName: artifact.visibleName,
        parent: "",
      }),
    )
    .digest("hex");
  return Object.freeze({
    uploadId,
    fingerprint,
    requestId: request.requestId,
    artifactKey: request.artifactKey,
    contentHash: artifact.contentHash,
    visibleName: artifact.visibleName,
  });
}

function sameUpload(record, identity) {
  return (
    isRecord(record) &&
    record.schemaVersion === UPLOAD_JOURNAL_SCHEMA_VERSION &&
    record.fingerprint === identity.fingerprint &&
    record.requestId === identity.requestId &&
    record.artifactKey === identity.artifactKey &&
    record.contentHash === identity.contentHash &&
    record.visibleName === identity.visibleName
  );
}

function validateStoredUploadReceipt(receipt, identity) {
  if (
    !isRecord(receipt) ||
    receipt.status !== "uploaded" ||
    receipt.requestId !== identity.requestId ||
    receipt.artifactKey !== identity.artifactKey ||
    receipt.name !== identity.visibleName ||
    typeof receipt.documentId !== "string" ||
    !CLOUD_DOCUMENT_ID_PATTERN.test(receipt.documentId) ||
    typeof receipt.cloudHash !== "string" ||
    !CLOUD_HASH_PATTERN.test(receipt.cloudHash)
  ) {
    return undefined;
  }
  return Object.freeze({
    status: "uploaded",
    request_id: receipt.requestId,
    artifact_key: receipt.artifactKey,
    name: receipt.name,
    document_id: receipt.documentId,
    cloud_hash: receipt.cloudHash.toLowerCase(),
    cached: true,
  });
}

async function loadOrReserveUpload(store, identity) {
  let existing = await store.lookup(identity.uploadId);
  if (!existing) {
    const inserted = await store.registerIfAbsent(
      identity.uploadId,
      {
        schemaVersion: UPLOAD_JOURNAL_SCHEMA_VERSION,
        fingerprint: identity.fingerprint,
        requestId: identity.requestId,
        artifactKey: identity.artifactKey,
        contentHash: identity.contentHash,
        visibleName: identity.visibleName,
        state: "reserved",
      },
    );
    if (inserted) {
      return { kind: "reserved" };
    }
    existing = await store.lookup(identity.uploadId);
    if (!existing) {
      throw uploadUnavailable();
    }
  }
  if (!sameUpload(existing, identity)) {
    throw uploadConflict();
  }
  if (existing.state === "sent") {
    const receipt = validateStoredUploadReceipt(
      existing.receipt,
      identity,
    );
    if (receipt) {
      return { kind: "cached", receipt };
    }
  }
  throw uploadUnavailable();
}

async function markUploadAmbiguous(store, identity) {
  try {
    await store.register(identity.uploadId, {
      schemaVersion: UPLOAD_JOURNAL_SCHEMA_VERSION,
      fingerprint: identity.fingerprint,
      requestId: identity.requestId,
      artifactKey: identity.artifactKey,
      contentHash: identity.contentHash,
      visibleName: identity.visibleName,
      state: "ambiguous",
    });
  } catch {
    // The durable reservation remains the fail-closed fallback.
  }
}

async function executeRmSync({
  identity,
  artifact,
  store,
  pythonPath,
  configPath,
  uploadTimeoutMs,
  signal,
  execFileFn,
}) {
  await Promise.all([
    validateExecutable(pythonPath),
    validateCredentialFile(configPath),
  ]);
  if (signal?.aborted) {
    throw uploadUnavailable();
  }
  const reservation = await loadOrReserveUpload(store, identity);
  if (reservation.kind === "cached") {
    return reservation.receipt;
  }

  let cloudReceipt;
  try {
    const result = await execFileFn(
      pythonPath,
      [
        "-m",
        "rm_sync.cli",
        "upload",
        artifact.snapshotPath,
        "--name",
        artifact.visibleName,
      ],
      {
        cwd: path.dirname(artifact.snapshotPath),
        encoding: "utf8",
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          REMARKABLE_SYNC_CONFIG: configPath,
        },
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
        timeout: uploadTimeoutMs,
        shell: false,
        ...(signal ? { signal } : {}),
      },
    );
    cloudReceipt = validateCliReceipt(result?.stdout);
  } catch {
    await markUploadAmbiguous(store, identity);
    throw uploadUnavailable();
  }

  const durableReceipt = Object.freeze({
    status: "uploaded",
    requestId: identity.requestId,
    artifactKey: identity.artifactKey,
    name: identity.visibleName,
    documentId: cloudReceipt.documentId,
    cloudHash: cloudReceipt.cloudHash,
  });
  try {
    await store.register(identity.uploadId, {
      schemaVersion: UPLOAD_JOURNAL_SCHEMA_VERSION,
      fingerprint: identity.fingerprint,
      requestId: identity.requestId,
      artifactKey: identity.artifactKey,
      contentHash: identity.contentHash,
      visibleName: identity.visibleName,
      state: "sent",
      receipt: durableReceipt,
    });
  } catch {
    throw uploadUnavailable();
  }
  return Object.freeze({
    status: "uploaded",
    request_id: identity.requestId,
    artifact_key: identity.artifactKey,
    name: identity.visibleName,
    document_id: cloudReceipt.documentId,
    cloud_hash: cloudReceipt.cloudHash,
    cached: false,
  });
}

export function createRemarkableUploadTool({
  api,
  context,
  store,
  execFileFn = nodeExecFileAsync,
  pythonPath = DEFAULT_RM_SYNC_PYTHON,
  configPath = DEFAULT_RM_SYNC_CONFIG,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
  uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
}) {
  if (
    context?.agentId !== CANONICAL_AGENT_ID ||
    context?.sessionKey !== CANONICAL_SESSION_KEY ||
    typeof context?.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(context.sessionId)
  ) {
    return null;
  }
  const stateDir = api.runtime.state.resolveStateDir();
  const receiptStore =
    store ??
    createFileReceiptJournal({
      stateDir,
      namespace: UPLOAD_JOURNAL_NAMESPACE,
    });
  const inFlight = new Map();

  return {
    name: REMARKABLE_UPLOAD_TOOL,
    label: "Deliver to reMarkable",
    description:
      "Upload a completed PDF or EPUB from the current workspace to the user's reMarkable Cloud library. Use only when the current reMarkable-origin request asks for a document to be created, exported, sent, added, or placed there.",
    promptSnippet:
      "Deliver a requested finished PDF or EPUB to the user's reMarkable.",
    parameters: UPLOAD_TOOL_SCHEMA,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      let request;
      let artifact;
      try {
        request = validateAuthorizedToolParams(
          params,
          api.runContext,
          context.sessionId,
        );
        artifact = await stageWorkspaceArtifact({
          workspaceDir: context.workspaceDir,
          stateDir,
          inputPath: request.path,
          requestedName: request.requestedName,
          maxUploadBytes,
        });
        const identity = buildUploadIdentity(request, artifact);
        const existing = inFlight.get(identity.uploadId);
        if (existing) {
          await fs.unlink(artifact.snapshotPath).catch(() => {});
          if (existing.fingerprint !== identity.fingerprint) {
            throw uploadConflict();
          }
          const result = await existing.promise;
          return jsonResult({ ...result, cached: true });
        }

        const promise = executeRmSync({
          identity,
          artifact,
          store: receiptStore,
          pythonPath,
          configPath,
          uploadTimeoutMs,
          signal,
          execFileFn,
        }).finally(async () => {
          await fs.unlink(artifact.snapshotPath).catch(() => {});
        });
        inFlight.set(identity.uploadId, {
          fingerprint: identity.fingerprint,
          promise,
        });
        try {
          return jsonResult(await promise);
        } finally {
          if (inFlight.get(identity.uploadId)?.promise === promise) {
            inFlight.delete(identity.uploadId);
          }
        }
      } catch (error) {
        if (artifact?.snapshotPath) {
          await fs.unlink(artifact.snapshotPath).catch(() => {});
        }
        const safeError =
          error?.code === "INVALID_ARTIFACT" ||
          error?.code === "UNAUTHORIZED" ||
          error?.code === "IDEMPOTENCY_CONFLICT" ||
          error?.code === "UNAVAILABLE"
            ? error
            : uploadUnavailable();
        api.logger?.error?.(
          `Smart reMarkable document delivery failed (${safeError.code})`,
        );
        throw safeError;
      }
    },
  };
}

export function registerRemarkableUploadTool(api, overrides = {}) {
  api.registerTool(
    (context) =>
      createRemarkableUploadTool({
        api,
        context,
        ...overrides,
      }),
    { name: REMARKABLE_UPLOAD_TOOL },
  );
}
