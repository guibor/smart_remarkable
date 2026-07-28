import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recoverTranscriptMessages } from "../src/transcript-recovery.mjs";

const SESSION_ID = "captured-session";
const REQUEST_ID = "smart-remarkable-transcript-test-0001";
const STAMP = "2026-07-28T10-00-00.000Z";

async function createFixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-transcript-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionsPath = path.join(directory, "sessions.json");
  await fs.writeFile(sessionsPath, "{}\n", { mode: 0o600 });
  return { directory, sessionsPath };
}

function archivePath(directory, sessionId, stamp = STAMP) {
  return path.join(directory, `${sessionId}.jsonl.reset.${stamp}`);
}

function transcriptRecords({
  sessionId = SESSION_ID,
  requestId = REQUEST_ID,
  response = "captured response",
  includeAnchor = true,
} = {}) {
  return [
    { type: "session", id: sessionId, version: 3 },
    ...(includeAnchor
      ? [
          {
            type: "message",
            message: {
              role: "user",
              idempotencyKey: `${requestId}:user`,
              content: [{ type: "text", text: "captured request" }],
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: response }],
            },
          },
        ]
      : []),
  ];
}

async function writeJsonl(filePath, records) {
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

async function recover(sessionsPath) {
  return recoverTranscriptMessages({
    sessionsPath,
    sessionId: SESSION_ID,
    requestId: REQUEST_ID,
  });
}

test("recovers the exact request from a sole OpenClaw reset archive", async (t) => {
  const fixture = await createFixture(t);
  await writeJsonl(
    archivePath(fixture.directory, SESSION_ID),
    transcriptRecords(),
  );

  const recovered = await recover(fixture.sessionsPath);
  assert.equal(recovered.sessionId, SESSION_ID);
  assert.equal(recovered.source, "captured-transcript");
  assert.equal(recovered.messages.length, 2);
  assert.equal(
    recovered.messages[0].idempotencyKey,
    `${REQUEST_ID}:user`,
  );
  assert.equal(recovered.messages[1].content[0].text, "captured response");
});

test("uses the uniquely anchored matching archive and ignores a wrong header", async (t) => {
  const fixture = await createFixture(t);
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T11-00-00.000Z",
    ),
    transcriptRecords({ sessionId: "replacement-session" }),
  );
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T10-00-00.000Z",
    ),
    transcriptRecords({ response: "correct archived response" }),
  );
  await writeJsonl(
    path.join(fixture.directory, `${SESSION_ID}.jsonl.reset.invalid`),
    transcriptRecords({ response: "invalid suffix" }),
  );
  await writeJsonl(
    path.join(fixture.directory, `${SESSION_ID}.jsonl.deleted.${STAMP}`),
    transcriptRecords({ response: "deleted sibling" }),
  );

  const recovered = await recover(fixture.sessionsPath);
  assert.equal(
    recovered.messages[1].content[0].text,
    "correct archived response",
  );
});

test("rejects multiple reset archives containing the exact request anchor", async (t) => {
  const fixture = await createFixture(t);
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T10-00-00.000Z",
    ),
    transcriptRecords({ response: "first" }),
  );
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T11-00-00.000Z",
    ),
    transcriptRecords({ response: "second" }),
  );

  await assert.rejects(
    recover(fixture.sessionsPath),
    /captured transcript is ambiguous/,
  );
});

test("uses the only anchored archive among multiple matching session headers", async (t) => {
  const fixture = await createFixture(t);
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T10-00-00.000Z",
    ),
    transcriptRecords({ includeAnchor: false }),
  );
  await writeJsonl(
    archivePath(
      fixture.directory,
      SESSION_ID,
      "2026-07-28T11-00-00.000Z",
    ),
    transcriptRecords({ response: "uniquely anchored" }),
  );

  const recovered = await recover(fixture.sessionsPath);
  assert.equal(
    recovered.messages[1].content[0].text,
    "uniquely anchored",
  );
});

test("a valid active transcript takes precedence over reset archives", async (t) => {
  const fixture = await createFixture(t);
  await writeJsonl(
    path.join(fixture.directory, `${SESSION_ID}.jsonl`),
    transcriptRecords({ response: "active response" }),
  );
  await writeJsonl(
    archivePath(fixture.directory, SESSION_ID),
    transcriptRecords({ response: "archived response" }),
  );

  const recovered = await recover(fixture.sessionsPath);
  assert.equal(recovered.messages[1].content[0].text, "active response");
});

test("rejects active and reset transcript symlinks without following them", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.directory, "outside.jsonl");
  await writeJsonl(outside, transcriptRecords({ response: "must not leak" }));
  const active = path.join(fixture.directory, `${SESSION_ID}.jsonl`);
  await fs.symlink(outside, active);
  await assert.rejects(recover(fixture.sessionsPath), /not a regular file/);

  await fs.unlink(active);
  await fs.symlink(outside, archivePath(fixture.directory, SESSION_ID));
  await assert.rejects(recover(fixture.sessionsPath), /not a regular file/);
});

test("rejects nonregular, oversized, and malformed transcript candidates", async (t) => {
  const fixture = await createFixture(t);
  const active = path.join(fixture.directory, `${SESSION_ID}.jsonl`);
  await fs.mkdir(active);
  await assert.rejects(recover(fixture.sessionsPath), /not a regular file/);

  await fs.rm(active, { recursive: true });
  await writeJsonl(active, transcriptRecords());
  await fs.truncate(active, 64 * 1024 * 1024 + 1);
  await assert.rejects(recover(fixture.sessionsPath), /exceeded the recovery limit/);

  await fs.unlink(active);
  await writeJsonl(active, [
    {
      type: "message",
      message: {
        role: "user",
        idempotencyKey: `${REQUEST_ID}:user`,
      },
    },
    ...transcriptRecords(),
  ]);
  await assert.rejects(recover(fixture.sessionsPath), /session header is invalid/);
});

test("bounds exact reset archive discovery", async (t) => {
  const fixture = await createFixture(t);
  await Promise.all(
    Array.from({ length: 129 }, (_, index) =>
      writeJsonl(
        archivePath(
          fixture.directory,
          SESSION_ID,
          `2026-07-28T10-${String(Math.floor(index / 60)).padStart(2, "0")}-${String(index % 60).padStart(2, "0")}.000Z`,
        ),
        transcriptRecords({ includeAnchor: false }),
      ),
    ),
  );

  await assert.rejects(
    recover(fixture.sessionsPath),
    /candidates exceeded the limit/,
  );
});
