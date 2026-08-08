import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { TextDecoder } from "node:util";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES_BIGINT = BigInt(MAX_TRANSCRIPT_BYTES);
const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESET_ARCHIVE_CANDIDATES = 128;
const RESET_ARCHIVE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;

function messageIdempotencyKey(message) {
  if (typeof message?.idempotencyKey === "string") {
    return message.idempotencyKey;
  }
  return typeof message?.__openclaw?.idempotencyKey === "string"
    ? message.__openclaw.idempotencyKey
    : "";
}

function isRequestUserMessage(message, requestId) {
  return (
    message?.role === "user" &&
    messageIdempotencyKey(message) === `${requestId}:user`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeTranscriptLocation(sessionsPath, sessionId) {
  if (
    typeof sessionsPath !== "string" ||
    !path.isAbsolute(sessionsPath) ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new Error("OpenClaw transcript recovery inputs are invalid");
  }
  const directory = path.dirname(sessionsPath);
  const baseName = `${sessionId}.jsonl`;
  return Object.freeze({
    directory,
    activePath: path.join(directory, baseName),
    archiveNamePattern: new RegExp(
      `^${escapeRegExp(baseName)}\\.reset\\.(.+)$`,
    ),
  });
}

function parseResetArchiveTimestamp(raw) {
  if (!RESET_ARCHIVE_TIMESTAMP_PATTERN.test(raw)) {
    return undefined;
  }
  const [datePart, timePart] = raw.split("T");
  const restored = `${datePart}T${timePart.replace(/-/g, ":")}`;
  const timestamp = Date.parse(restored);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

async function openCandidate(candidatePath) {
  return fs.promises.open(
    candidatePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
}

async function inspectCandidate(candidatePath) {
  let handle;
  try {
    handle = await openCandidate(candidatePath);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("OpenClaw transcript is not a regular file");
    }
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error("OpenClaw transcript exceeded the recovery limit");
    }
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function resolveTranscriptCandidates(sessionsPath, sessionId) {
  const location = safeTranscriptLocation(sessionsPath, sessionId);
  const directoryStat = await fs.promises.lstat(location.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("OpenClaw transcript directory is not a regular directory");
  }

  let activeEntry;
  const archives = [];
  let archiveOverflow = false;
  const directory = await fs.promises.opendir(location.directory);
  for await (const entry of directory) {
    if (entry.name === path.basename(location.activePath)) {
      activeEntry = entry;
      continue;
    }
    const match = location.archiveNamePattern.exec(entry.name);
    if (!match) {
      continue;
    }
    const timestamp = parseResetArchiveTimestamp(match[1]);
    if (timestamp === undefined) {
      continue;
    }
    if (archives.length >= MAX_RESET_ARCHIVE_CANDIDATES + 1) {
      archiveOverflow = true;
      continue;
    }
    archives.push({
      entry,
      timestamp,
      candidatePath: path.join(location.directory, entry.name),
    });
  }

  if (
    activeEntry &&
    (!activeEntry.isFile() || activeEntry.isSymbolicLink())
  ) {
    throw new Error("OpenClaw transcript is not a regular file");
  }
  if (activeEntry) {
    return Object.freeze([
      Object.freeze({
        candidatePath: location.activePath,
        allowMismatchedHeader: false,
      }),
    ]);
  }

  for (const archive of archives) {
    if (!archive.entry.isFile() || archive.entry.isSymbolicLink()) {
      throw new Error("OpenClaw reset transcript is not a regular file");
    }
  }
  if (
    archiveOverflow ||
    archives.length > MAX_RESET_ARCHIVE_CANDIDATES
  ) {
    throw new Error("OpenClaw reset transcript candidates exceeded the limit");
  }
  if (archives.length === 0) {
    const error = new Error("OpenClaw captured transcript was not found");
    error.code = "ENOENT";
    throw error;
  }
  return Object.freeze(
    archives
      .sort(
        (left, right) =>
          right.timestamp - left.timestamp ||
          right.entry.name.localeCompare(left.entry.name),
      )
      .map((archive) =>
        Object.freeze({
          candidatePath: archive.candidatePath,
          allowMismatchedHeader: true,
        }),
      ),
  );
}

async function readTranscriptCandidate({
  candidatePath,
  allowMismatchedHeader,
  sessionId,
  requestId,
}) {
  const candidate = await inspectCandidate(candidatePath);
  try {
    const input = candidate.handle.createReadStream({
      autoClose: false,
      encoding: "utf8",
      start: 0,
      end: Math.max(0, candidate.stat.size - 1),
    });
    const lines = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });
    const messages = [];
    let anchorCount = 0;
    let sessionHeaderSeen = false;

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_LINE_BYTES) {
        if (!sessionHeaderSeen || anchorCount > 0) {
          throw new Error("OpenClaw transcript line exceeded the recovery limit");
        }
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        if (!sessionHeaderSeen) {
          throw new Error("OpenClaw transcript session header is invalid");
        }
        if (anchorCount > 0) {
          throw new Error("OpenClaw transcript became invalid after the request");
        }
        continue;
      }
      if (!sessionHeaderSeen) {
        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          record.type !== "session" ||
          typeof record.id !== "string"
        ) {
          throw new Error("OpenClaw transcript session header is invalid");
        }
        if (record.id !== sessionId) {
          if (allowMismatchedHeader) {
            return Object.freeze({
              headerMatches: false,
              messages: null,
            });
          }
          throw new Error(
            "OpenClaw transcript session header did not match the captured session",
          );
        }
        sessionHeaderSeen = true;
        continue;
      }
      const message =
        record?.type === "message" &&
        record.message &&
        typeof record.message === "object"
          ? record.message
          : null;
      if (!message) {
        continue;
      }
      if (isRequestUserMessage(message, requestId)) {
        anchorCount += 1;
        if (anchorCount > 1) {
          throw new Error(
            "OpenClaw request appeared more than once in its transcript",
          );
        }
        messages.length = 0;
        messages.push(message);
        continue;
      }
      if (anchorCount === 1) {
        messages.push(message);
      }
    }

    if (!sessionHeaderSeen) {
      throw new Error("OpenClaw transcript session header is missing");
    }
    return Object.freeze({
      headerMatches: true,
      messages: anchorCount === 0 ? null : messages,
    });
  } finally {
    await candidate.handle.close().catch(() => {});
  }
}

function stableStatMatches(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function inspectStrictUnanchoredCandidate({
  candidatePath,
  sessionId,
  requestId,
}) {
  let handle;
  try {
    handle = await openCandidate(candidatePath);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error("OpenClaw transcript is not a regular file");
    }
    if (before.size > MAX_TRANSCRIPT_BYTES_BIGINT) {
      throw new Error("OpenClaw transcript exceeded the recovery limit");
    }
    const chunks = [];
    let bytesRead = 0;
    if (before.size > 0n) {
      const input = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: Number(before.size) - 1,
      });
      for await (const chunk of input) {
        bytesRead += chunk.length;
        chunks.push(chunk);
      }
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      !stableStatMatches(before, after)
    ) {
      throw new Error(
        "OpenClaw captured transcript changed during rollover verification",
      );
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, bytesRead),
      );
    } catch {
      throw new Error(
        "OpenClaw captured transcript is not valid UTF-8",
      );
    }

    let sessionHeaderSeen = false;
    let anchorCount = 0;
    for (const line of text.split("\n")) {
      if (Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_LINE_BYTES) {
        throw new Error(
          "OpenClaw captured transcript line exceeded the recovery limit",
        );
      }
      if (/^[\x20\t\r]*$/.test(line)) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(
          "OpenClaw captured transcript is not valid JSONL",
        );
      }
      if (!sessionHeaderSeen) {
        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          record.type !== "session" ||
          typeof record.id !== "string"
        ) {
          throw new Error(
            "OpenClaw transcript session header is invalid",
          );
        }
        if (record.id !== sessionId) {
          return Object.freeze({
            headerMatches: false,
            anchored: false,
            identity: after,
          });
        }
        sessionHeaderSeen = true;
        continue;
      }
      if (record?.type === "session") {
        throw new Error(
          "OpenClaw captured transcript contained another session header",
        );
      }
      const message =
        record?.type === "message" &&
        record.message &&
        typeof record.message === "object"
          ? record.message
          : null;
      if (message && isRequestUserMessage(message, requestId)) {
        anchorCount += 1;
        if (anchorCount > 1) {
          throw new Error(
            "OpenClaw request appeared more than once in its transcript",
          );
        }
      }
    }
    if (!sessionHeaderSeen) {
      throw new Error("OpenClaw transcript session header is missing");
    }
    return Object.freeze({
      headerMatches: true,
      anchored: anchorCount === 1,
      identity: after,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function recheckCandidateIdentity(candidatePath, expected) {
  let handle;
  try {
    handle = await fs.promises.open(
      candidatePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const current = await handle.stat({ bigint: true });
    return current.isFile() && stableStatMatches(expected, current);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function recoverTranscriptMessages({
  sessionsPath,
  sessionId,
  requestId,
}) {
  const candidates = await resolveTranscriptCandidates(
    sessionsPath,
    sessionId,
  );
  const eligible = [];
  const anchored = [];
  for (const candidate of candidates) {
    const result = await readTranscriptCandidate({
      ...candidate,
      sessionId,
      requestId,
    });
    if (!result.headerMatches) {
      continue;
    }
    eligible.push(result);
    if (result.messages) {
      anchored.push(result);
    }
  }
  if (anchored.length > 1) {
    throw new Error("OpenClaw captured transcript is ambiguous");
  }
  if (anchored.length === 1) {
    return Object.freeze({
      messages: anchored[0].messages,
      sessionId,
      source: "captured-transcript",
    });
  }
  if (eligible.length > 1) {
    throw new Error("OpenClaw captured transcript is ambiguous");
  }
  if (eligible.length === 1) {
    return null;
  }
  throw new Error(
    "OpenClaw transcript session header did not match the captured session",
  );
}

export async function proveCapturedResetTranscriptUnanchored({
  sessionsPath,
  sessionId,
  requestId,
}) {
  const location = safeTranscriptLocation(sessionsPath, sessionId);
  const candidates = await resolveTranscriptCandidates(
    sessionsPath,
    sessionId,
  );
  if (
    candidates.some(
      (candidate) => candidate.candidatePath === location.activePath,
    )
  ) {
    throw new Error(
      "OpenClaw active transcript cannot prove a completed session rollover",
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      "OpenClaw captured reset transcript is not unique",
    );
  }
  const result = await inspectStrictUnanchoredCandidate({
    candidatePath: candidates[0].candidatePath,
    sessionId,
    requestId,
  });
  const recheckedCandidates = await resolveTranscriptCandidates(
    sessionsPath,
    sessionId,
  );
  if (
    recheckedCandidates.length !== candidates.length ||
    recheckedCandidates.some(
      (candidate, index) =>
        candidate.candidatePath !== candidates[index].candidatePath,
    )
  ) {
    throw new Error(
      "OpenClaw captured transcript set changed during rollover verification",
    );
  }
  if (
    !(await recheckCandidateIdentity(
      candidates[0].candidatePath,
      result.identity,
    ))
  ) {
    throw new Error(
      "OpenClaw captured transcript path changed during rollover verification",
    );
  }
  if (!result.headerMatches) {
    throw new Error(
      "OpenClaw transcript session header did not match the captured session",
    );
  }
  return result.anchored === false;
}
