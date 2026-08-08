import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { renderResponsePdf } from "../response-pdf.mjs";

const REQUEST_ID = "smart-remarkable-response-pdf-test-0001";
const RENDERER_PROTOCOL = "response-pdf-pango-v1";
const VERSION_RECEIPT =
  "smart-remarkable-pango-pdf-v1 python=3.10.12 pycairo=1.20.1 cairo=1.16.0 pygobject=3.42.1 pango=1.50.6\n";
const HELPER_PATH = fileURLToPath(
  new URL("../response-pdf-renderer.py", import.meta.url),
);
const BASE_INPUT = Object.freeze({
  requestId: REQUEST_ID,
  receivedText: "Please explain this selection.",
  responseText: "Here is the explanation.",
});

async function fixture(t, label = "renderer") {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `smart-remarkable-${label}-`),
  );
  await fs.chmod(stateDir, 0o700);
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function inputFor(stateDir, overrides = {}) {
  return { stateDir, ...BASE_INPUT, ...overrides };
}

function deterministicPdf(inputBytes) {
  const digest = crypto.createHash("sha256").update(inputBytes).digest("hex");
  return Buffer.from(
    `%PDF-1.7\n% deterministic-pango-test ${digest}\n%%EOF\n`,
    "ascii",
  );
}

function rendererInvocation(args) {
  const index = args.indexOf("--render");
  return index < 0
    ? undefined
    : { inputPath: args[index + 1], outputPath: args[index + 2] };
}

function fakeExecutor(calls = [], mutate) {
  return async (command, args, options) => {
    if (args.at(-1) === "--version") {
      calls.push({ kind: "version", command, args: [...args], options });
      return { stdout: VERSION_RECEIPT, stderr: "" };
    }
    const invocation = rendererInvocation(args);
    assert.ok(invocation, "bounded renderer invocation is present");
    const inputBytes = await fs.readFile(invocation.inputPath);
    const input = JSON.parse(inputBytes.toString("utf8"));
    const pdf = deterministicPdf(inputBytes);
    calls.push({
      kind: "render",
      command,
      args: [...args],
      options,
      input,
      inputBytes,
      ...invocation,
    });
    if (mutate) {
      const result = await mutate({
        command,
        args,
        options,
        input,
        inputBytes,
        pdf,
        ...invocation,
      });
      if (result) return result;
    } else {
      await fs.writeFile(invocation.outputPath, pdf);
    }
    const stat = await fs.stat(invocation.outputPath);
    return {
      stdout: JSON.stringify({
        bytes: stat.size,
        pages: 1,
        renderer: RENDERER_PROTOCOL,
        unknown_glyphs: 0,
      }),
      stderr: "",
    };
  };
}

async function stagingTransactions(stateDir) {
  const staging = path.join(
    stateDir,
    "plugins",
    "smart-remarkable-delivery",
    "response-pdf-staging",
  );
  try {
    return (await fs.readdir(staging)).filter((name) => name.startsWith("render-"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

test("renders literal text through one bounded Pango helper and returns a private artifact", async (t) => {
  const stateDir = await fixture(t, "pango-happy");
  const calls = [];
  const receivedText =
    "Literal \\input{/etc/passwd} <script>alert(1)</script> $(id)";
  const responseText = "שלום English 123 العربيةـ\nEmoji 👩‍💻 and ✈️";
  const artifact = await renderResponsePdf(
    inputFor(stateDir, { receivedText, responseText }),
    { execFileFn: fakeExecutor(calls) },
  );
  t.after(() => artifact.cleanup());

  assert.equal(calls.length, 2);
  const [version, render] = calls;
  assert.equal(version.kind, "version");
  assert.equal(render.kind, "render");
  assert.equal(version.command, "/usr/bin/prlimit");
  assert.equal(render.command, "/usr/bin/prlimit");
  const prefix = [
    "--as=536870912",
    "--cpu=15",
    "--fsize=33554432",
    "--nofile=64",
    "--",
    "/usr/bin/python3",
    "-I",
    "-B",
    HELPER_PATH,
  ];
  assert.deepEqual(version.args, [...prefix, "--version"]);
  assert.deepEqual(render.args, [
    ...prefix,
    "--render",
    render.inputPath,
    render.outputPath,
  ]);
  assert.deepEqual(render.input, {
    protocol: RENDERER_PROTOCOL,
    received_text: receivedText,
    request_id: REQUEST_ID,
    response_text: responseText,
  });
  assert.equal(render.options.shell, false);
  assert.equal(render.options.timeout, 20_000);
  assert.equal(render.options.maxBuffer, 64 * 1024);
  assert.deepEqual(version.options.env, render.options.env);
  assert.deepEqual(Object.keys(render.options.env).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONHASHSEED",
    "PYTHONNOUSERSITE",
    "SOURCE_DATE_EPOCH",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  assert.equal(render.options.env.PATH, "/usr/bin:/bin");
  assert.equal(render.options.env.PYTHONNOUSERSITE, "1");
  assert.equal(render.options.env.PYTHONDONTWRITEBYTECODE, "1");

  const expectedPdf = deterministicPdf(render.inputBytes);
  assert.deepEqual(await fs.readFile(artifact.snapshotPath), expectedPdf);
  assert.equal(artifact.snapshotPath, render.outputPath);
  assert.equal(artifact.artifactKey, "response-pdf-cloud-v1");
  assert.equal(
    artifact.visibleName,
    `OpenClaw response ${crypto
      .createHash("sha256")
      .update(REQUEST_ID)
      .digest("hex")
      .slice(0, 16)}.pdf`,
  );
  assert.equal(
    artifact.contentHash,
    crypto.createHash("sha256").update(expectedPdf).digest("hex"),
  );
  assert.equal(artifact.sizeBytes, expectedPdf.length);

  for (const filePath of [render.inputPath, artifact.snapshotPath]) {
    const stat = await fs.lstat(filePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
  const transactionDir = path.dirname(artifact.snapshotPath);
  assert.equal((await fs.lstat(transactionDir)).mode & 0o777, 0o700);
  await artifact.cleanup();
  await artifact.cleanup();
  await assert.rejects(fs.lstat(transactionDir), { code: "ENOENT" });
});

test("rejects invalid input before creating state or invoking the helper", async (t) => {
  const stateDir = await fixture(t, "pango-validation");
  let calls = 0;
  const execFileFn = async () => {
    calls += 1;
    throw new Error("must not run");
  };
  const invalid = [
    null,
    { stateDir, ...BASE_INPUT, extra: true },
    inputFor(stateDir, { requestId: "wrong-prefix" }),
    inputFor(stateDir, { requestId: "smart-remarkable-bad/path" }),
    inputFor(stateDir, { receivedText: "" }),
    inputFor(stateDir, { responseText: " \n" }),
    inputFor(stateDir, { receivedText: "a".repeat(2_049) }),
    inputFor(stateDir, { responseText: "a".repeat(32_257) }),
    inputFor(stateDir, { responseText: "unpaired \ud800" }),
    inputFor(stateDir, { responseText: "nul\u0000value" }),
    inputFor(stateDir, { responseText: "tab\there" }),
    inputFor(stateDir, { responseText: "override\u202evalue" }),
    inputFor(stateDir, {
      responseText: Array.from({ length: 514 }, () => "x").join("\n"),
    }),
    inputFor(stateDir, {
      responseText: Array.from({ length: 514 }, () => "x").join("\u2028"),
    }),
  ];
  for (const value of invalid) {
    await assert.rejects(
      renderResponsePdf(value, { execFileFn }),
      (error) => error?.code === "INVALID_RESPONSE_PDF_REQUEST",
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(stateDir), []);
});

test("accepts exact UTF-8 and line boundaries and snapshots input before awaiting", async (t) => {
  const stateDir = await fixture(t, "pango-boundaries");
  const calls = [];
  const mutable = inputFor(stateDir, {
    receivedText: "א".repeat(1_024),
    responseText: Array.from({ length: 257 }, () => "€").join("\n"),
  });
  const promise = renderResponsePdf(mutable, { execFileFn: fakeExecutor(calls) });
  mutable.receivedText = "mutated\u0000";
  mutable.responseText = "mutated\u202e";
  const artifact = await promise;
  t.after(() => artifact.cleanup());
  const render = calls.find(({ kind }) => kind === "render");
  assert.equal(render.input.received_text, "א".repeat(1_024));
  assert.equal(Buffer.byteLength(render.input.received_text), 2_048);
  assert.equal(render.input.response_text.includes("mutated"), false);
});

test("fails closed on dependency receipt drift before rendering", async (t) => {
  for (const [label, stdout, stderr] of [
    ["version", VERSION_RECEIPT.replace("1.50.6", "1.50.7"), ""],
    ["control", `${VERSION_RECEIPT.trim()}\u0000\n`, ""],
    ["stderr", VERSION_RECEIPT, "warning"],
    ["oversized", `smart-${"x".repeat(17 * 1024)}`, ""],
  ]) {
    await t.test(label, async (t) => {
      const stateDir = await fixture(t, `pango-version-${label}`);
      let calls = 0;
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: async () => {
            calls += 1;
            return { stdout, stderr };
          },
        }),
        (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
      );
      assert.equal(calls, 1);
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("fails closed on malformed renderer receipts and removes private transactions", async (t) => {
  const cases = [
    ["malformed", "not-json", ""],
    ["stderr", null, "warning"],
    ["wrong renderer", { renderer: "wrong" }],
    ["unknown glyph", { unknown_glyphs: 1 }],
    ["zero pages", { pages: 0 }],
    ["wrong bytes", { bytes: 999 }],
    ["extra key", { extra: true }],
  ];
  for (const [label, override, stderr = ""] of cases) {
    await t.test(label, async (t) => {
      const stateDir = await fixture(t, `pango-receipt-${label}`);
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: fakeExecutor([], async ({ outputPath, pdf }) => {
            await fs.writeFile(outputPath, pdf);
            const base = {
              bytes: pdf.length,
              pages: 1,
              renderer: RENDERER_PROTOCOL,
              unknown_glyphs: 0,
            };
            return {
              stdout:
                typeof override === "string"
                  ? override
                  : JSON.stringify({ ...base, ...override }),
              stderr,
            };
          }),
        }),
        (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
      );
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("rejects unsafe or invalid PDF output", async (t) => {
  const cases = [
    ["empty", async ({ outputPath }) => fs.truncate(outputPath, 0)],
    ["bad magic", async ({ outputPath }) => fs.writeFile(outputPath, "not a PDF %%EOF\n")],
    ["missing eof", async ({ outputPath }) => fs.writeFile(outputPath, "%PDF-1.7\nmissing")],
    ["trailing data", async ({ outputPath }) => fs.writeFile(outputPath, "%PDF-1.7\n%%EOF\nforged")],
    ["broad mode", async ({ outputPath, pdf }) => {
      await fs.writeFile(outputPath, pdf);
      await fs.chmod(outputPath, 0o644);
    }],
    ["hard link", async ({ outputPath, pdf }) => {
      await fs.writeFile(outputPath, pdf);
      await fs.link(outputPath, `${outputPath}.link`);
    }],
  ];
  for (const [label, mutation] of cases) {
    await t.test(label, async (t) => {
      const stateDir = await fixture(t, `pango-output-${label}`);
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: fakeExecutor([], async (context) => {
            await mutation(context);
            const stat = await fs.stat(context.outputPath);
            return {
              stdout: JSON.stringify({
                bytes: stat.size,
                pages: 1,
                renderer: RENDERER_PROTOCOL,
                unknown_glyphs: 0,
              }),
              stderr: "",
            };
          }),
        }),
        (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
      );
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("rejects renderer-owned symlink ancestry", async (t) => {
  const stateDir = await fixture(t, "pango-symlink");
  const outside = await fixture(t, "pango-outside");
  await fs.symlink(outside, path.join(stateDir, "plugins"));
  let calls = 0;
  await assert.rejects(
    renderResponsePdf(inputFor(stateDir), {
      execFileFn: async () => {
        calls += 1;
      },
    }),
    (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
  );
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("bounds renderer failures and cleans every transaction", async (t) => {
  for (const failure of [
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    new Error("renderer failed"),
  ]) {
    await t.test(failure.message, async (t) => {
      const stateDir = await fixture(t, "pango-failure");
      let renderOptions;
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: async (_command, args, options) => {
            if (args.at(-1) === "--version") {
              return { stdout: VERSION_RECEIPT, stderr: "" };
            }
            renderOptions = options;
            throw failure;
          },
        }),
        (error) =>
          error?.code === "RESPONSE_PDF_RENDER_FAILED" &&
          error?.cause === failure,
      );
      assert.equal(renderOptions.timeout, 20_000);
      assert.equal(renderOptions.maxBuffer, 64 * 1024);
      assert.equal(renderOptions.shell, false);
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("repeated renders produce identical bytes, names, keys, and hashes", async (t) => {
  const stateDir = await fixture(t, "pango-repeat");
  const calls = [];
  const executor = fakeExecutor(calls);
  const first = await renderResponsePdf(inputFor(stateDir), { execFileFn: executor });
  const second = await renderResponsePdf(inputFor(stateDir), { execFileFn: executor });
  t.after(() => Promise.all([first.cleanup(), second.cleanup()]));
  assert.notEqual(first.snapshotPath, second.snapshotPath);
  assert.deepEqual(await fs.readFile(first.snapshotPath), await fs.readFile(second.snapshotPath));
  assert.equal(first.artifactKey, second.artifactKey);
  assert.equal(first.visibleName, second.visibleName);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.sizeBytes, second.sizeBytes);
});

test("Python helper uses plain Pango text and fixed no-fallback glyph policy", async () => {
  const source = await fs.readFile(HELPER_PATH, "utf8");
  assert.match(source, /layout\.set_text\(text, -1\)/u);
  assert.doesNotMatch(source, /set_markup|show_text|create_from_cairo_font_face/u);
  assert.match(source, /Pango\.attr_fallback_new\(False\)/u);
  assert.match(source, /get_unknown_glyphs_count\(\) != 0/u);
  assert.match(source, /MAX_PAGES = 64/u);
  assert.match(source, /os\.O_NOFOLLOW/u);
});
