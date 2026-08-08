import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderResponsePdf } from "../response-pdf.mjs";

const REQUEST_ID = "smart-remarkable-response-pdf-test-0001";
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
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  return stateDir;
}

function inputFor(stateDir, overrides = {}) {
  return {
    stateDir,
    ...BASE_INPUT,
    ...overrides,
  };
}

function outputPathFrom(args) {
  const output = args.find((argument) => argument.startsWith("--output="));
  assert.ok(output, "pandoc output argument is present");
  return output.slice("--output=".length);
}

function astPathFrom(args) {
  const astPath = args.at(-1);
  assert.match(astPath, /document\.json$/u);
  return astPath;
}

function deterministicPdf(astBytes) {
  const digest = crypto.createHash("sha256").update(astBytes).digest("hex");
  return Buffer.from(
    `%PDF-1.7\n% deterministic-test-pdf ${digest}\n%%EOF\n`,
    "ascii",
  );
}

function validVersionStdout(command) {
  return command === "/usr/bin/pandoc"
    ? "pandoc 3.6.3\nFeatures: +server +lua\n"
    : "XeTeX 3.141592653-2.6-0.999996 (TeX Live 2024/Debian)\n";
}

function capturingExecutor(calls, mutateOutput, versionCalls = []) {
  return async (command, args, options) => {
    if (args.length === 1 && args[0] === "--version") {
      versionCalls.push({ command, args: [...args], options });
      return {
        stdout: validVersionStdout(command),
        stderr: "",
      };
    }
    const astPath = astPathFrom(args);
    const outputPath = outputPathFrom(args);
    const astBytes = await fs.readFile(astPath);
    calls.push({
      command,
      args: [...args],
      options,
      astBytes,
      ast: JSON.parse(astBytes.toString("utf8")),
      outputPath,
    });
    if (mutateOutput) {
      await mutateOutput({ astBytes, outputPath, options });
    } else {
      await fs.writeFile(outputPath, deterministicPdf(astBytes));
    }
    return { stdout: "", stderr: "" };
  };
}

function inlineText(inlines) {
  return inlines
    .map((inline) => {
      if (inline.t === "Str") {
        return inline.c;
      }
      if (inline.t === "Space") {
        return " ";
      }
      if (inline.t === "LineBreak") {
        return "\n";
      }
      if (inline.t === "Span") {
        return inlineText(inline.c[1]);
      }
      return "";
    })
    .join("");
}

function allNodes(value, result = []) {
  if (Array.isArray(value)) {
    for (const child of value) {
      allNodes(child, result);
    }
  } else if (value && typeof value === "object") {
    if (typeof value.t === "string") {
      result.push(value);
    }
    for (const child of Object.values(value)) {
      allNodes(child, result);
    }
  }
  return result;
}

async function assertMissing(filePath) {
  await assert.rejects(fs.lstat(filePath), { code: "ENOENT" });
}

async function stagingTransactions(stateDir) {
  const staging = path.join(
    stateDir,
    "plugins",
    "smart-remarkable-delivery",
    "response-pdf-staging",
  );
  try {
    return (await fs.readdir(staging)).filter((name) =>
      name.startsWith("render-"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("renders only literal Pandoc AST text into a private upload snapshot", async (t) => {
  const stateDir = await fixture(t, "renderer-ast");
  const calls = [];
  const receivedText =
    "Literal \\input{/etc/passwd} <script>alert(1)</script> $(id)\nSecond line";
  const responseText =
    "תשובה בעברית\nإجابة باللغة العربية\nEmoji 👩‍💻 and ✈️";
  const artifact = await renderResponsePdf(
    inputFor(stateDir, { receivedText, responseText }),
    { execFileFn: capturingExecutor(calls) },
  );
  t.after(() => artifact.cleanup());

  assert.equal(calls.length, 1);
  const [{ ast, astBytes, outputPath }] = calls;
  assert.deepEqual(ast["pandoc-api-version"], [1, 23, 1]);
  assert.deepEqual(ast.meta.documentclass, {
    t: "MetaString",
    c: "article",
  });
  assert.deepEqual(ast.meta.classoption, {
    t: "MetaList",
    c: [{ t: "MetaString", c: "onecolumn" }],
  });
  assert.deepEqual(ast.meta.papersize, { t: "MetaString", c: "a4" });
  assert.deepEqual(ast.meta.fontsize, { t: "MetaString", c: "11pt" });
  assert.deepEqual(ast.meta.mainfont, {
    t: "MetaString",
    c: "DejaVu Sans",
  });
  assert.deepEqual(ast.meta.lang, { t: "MetaString", c: "en" });
  assert.deepEqual(ast.meta.dir, { t: "MetaString", c: "ltr" });
  assert.deepEqual(ast.meta["babel-otherlangs"], {
    t: "MetaList",
    c: [
      { t: "MetaString", c: "hebrew" },
      { t: "MetaString", c: "arabic" },
    ],
  });
  assert.deepEqual(ast.meta.babelfonts, {
    t: "MetaMap",
    c: {
      hebrew: { t: "MetaString", c: "Noto Sans Hebrew" },
      arabic: { t: "MetaString", c: "Noto Sans Arabic" },
    },
  });
  assert.deepEqual(
    ast.blocks
      .filter((block) => block.t === "Header")
      .map((block) => inlineText(block.c[2])),
    ["Selection received", "OpenClaw response"],
  );

  const nodes = allNodes(ast);
  assert.equal(
    nodes.some((node) => node.t === "RawInline" || node.t === "RawBlock"),
    false,
  );
  const literalStrings = nodes
    .filter((node) => node.t === "Str")
    .map((node) => node.c);
  assert.ok(literalStrings.includes("\\input{/etc/passwd}"));
  assert.ok(literalStrings.includes("<script>alert(1)</script>"));
  assert.ok(literalStrings.includes("$(id)"));
  assert.ok(literalStrings.includes("תשובה"));
  assert.ok(literalStrings.includes("إجابة"));
  assert.ok(literalStrings.includes("👩‍💻"));
  assert.ok(literalStrings.includes("✈️"));
  assert.ok(nodes.some((node) => node.t === "LineBreak"));
  const directionalAttributes = nodes
    .filter((node) => node.t === "Div" || node.t === "Span")
    .map((node) => node.c[0][2]);
  assert.ok(
    directionalAttributes.some(
      (attributes) =>
        JSON.stringify(attributes) ===
        JSON.stringify([
          ["lang", "he"],
          ["dir", "rtl"],
        ]),
    ),
  );
  assert.ok(
    directionalAttributes.some(
      (attributes) =>
        JSON.stringify(attributes) ===
        JSON.stringify([
          ["lang", "ar"],
          ["dir", "rtl"],
        ]),
    ),
  );
  assert.ok(
    directionalAttributes.some(
      (attributes) =>
        JSON.stringify(attributes) ===
        JSON.stringify([
          ["lang", "en"],
          ["dir", "ltr"],
        ]),
    ),
  );
  assert.equal(
    JSON.stringify(ast).includes("RawInline") ||
      JSON.stringify(ast).includes("RawBlock"),
    false,
  );

  const expectedPdf = deterministicPdf(astBytes);
  assert.deepEqual(await fs.readFile(artifact.snapshotPath), expectedPdf);
  assert.equal(artifact.snapshotPath, outputPath);
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

  const transactionDir = path.dirname(artifact.snapshotPath);
  const transactionStat = await fs.lstat(transactionDir);
  const astStat = await fs.lstat(path.join(transactionDir, "document.json"));
  const pdfStat = await fs.lstat(artifact.snapshotPath);
  assert.equal(transactionStat.mode & 0o777, 0o700);
  assert.equal(astStat.mode & 0o777, 0o600);
  assert.equal(astStat.nlink, 1);
  assert.equal(pdfStat.mode & 0o777, 0o600);
  assert.equal(pdfStat.nlink, 1);
  if (typeof process.getuid === "function") {
    assert.equal(transactionStat.uid, process.getuid());
    assert.equal(astStat.uid, process.getuid());
    assert.equal(pdfStat.uid, process.getuid());
  }

  await artifact.cleanup();
  await artifact.cleanup();
  await assertMissing(transactionDir);
});

test("labels exact mixed Hebrew and English runs without carrying the old direction", async (t) => {
  const stateDir = await fixture(t, "renderer-bidi-runs");
  const calls = [];
  const artifact = await renderResponsePdf(
    inputFor(stateDir, {
      responseText: "שלום-English-123-תשובה\n\nاـب-English",
    }),
    { execFileFn: capturingExecutor(calls) },
  );
  t.after(() => artifact.cleanup());

  const expectedRuns = new Set([
    "שלום-",
    "English-123-",
    "תשובה",
    "اـب-",
    "English",
  ]);
  const runs = allNodes(calls[0].ast)
    .filter((node) => node.t === "Span")
    .map((node) => ({
      text: inlineText(node.c[1]),
      attributes: node.c[0][2],
    }))
    .filter(({ text }) => expectedRuns.has(text));
  assert.deepEqual(runs, [
    {
      text: "שלום-",
      attributes: [
        ["lang", "he"],
        ["dir", "rtl"],
      ],
    },
    {
      text: "English-123-",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
    {
      text: "תשובה",
      attributes: [
        ["lang", "he"],
        ["dir", "rtl"],
      ],
    },
    {
      text: "اـب-",
      attributes: [
        ["lang", "ar"],
        ["dir", "rtl"],
      ],
    },
    {
      text: "English",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
  ]);
});

test("chooses paragraph direction from letters rather than leading digits or marks", async (t) => {
  const stateDir = await fixture(t, "renderer-bidi-strong-letters");
  const calls = [];
  const artifact = await renderResponsePdf(
    inputFor(stateDir, {
      responseText: "2026 שלום\n\n\u05B0ABC\n\n٢ test",
    }),
    { execFileFn: capturingExecutor(calls) },
  );
  t.after(() => artifact.cleanup());

  const paragraphs = allNodes(calls[0].ast)
    .filter((node) => node.t === "Div")
    .map((node) => ({
      text: inlineText(allNodes(node).find((child) => child.t === "Para").c),
      attributes: node.c[0][2],
    }))
    .filter(({ text }) =>
      new Set(["2026 שלום", "\u05B0ABC", "٢ test"]).has(text),
    );
  assert.deepEqual(paragraphs, [
    {
      text: "2026 שלום",
      attributes: [
        ["lang", "he"],
        ["dir", "rtl"],
      ],
    },
    {
      text: "\u05B0ABC",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
    {
      text: "٢ test",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
  ]);

  const spans = allNodes(calls[0].ast)
    .filter((node) => node.t === "Span")
    .map((node) => ({
      text: inlineText(node.c[1]),
      attributes: node.c[0][2],
    }));
  assert.deepEqual(
    spans.find(({ text }) => text === "\u05B0ABC"),
    {
      text: "\u05B0ABC",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
  );
  assert.deepEqual(
    spans.find(({ text }) => text === "٢"),
    {
      text: "٢",
      attributes: [
        ["lang", "en"],
        ["dir", "ltr"],
      ],
    },
  );
});

test("uses fixed absolute sandboxed commands and a minimal private environment", async (t) => {
  const stateDir = await fixture(t, "renderer-command");
  const calls = [];
  const versionCalls = [];
  const artifact = await renderResponsePdf(inputFor(stateDir), {
    execFileFn: capturingExecutor(calls, undefined, versionCalls),
  });
  t.after(() => artifact.cleanup());

  const [{ command, args, options }] = calls;
  const transactionDir = path.dirname(artifact.snapshotPath);
  const astPath = path.join(transactionDir, "document.json");
  assert.equal(command, "/usr/bin/pandoc");
  assert.deepEqual(args, [
    "--from=json",
    "--standalone",
    "--sandbox",
    "--pdf-engine=/usr/bin/xelatex",
    "--pdf-engine-opt=-no-shell-escape",
    "--pdf-engine-opt=-halt-on-error",
    "--pdf-engine-opt=-interaction=nonstopmode",
    "--pdf-engine-opt=-file-line-error",
    `--output=${artifact.snapshotPath}`,
    astPath,
  ]);
  assert.equal(options.cwd, transactionDir);
  assert.equal(options.encoding, "utf8");
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 90_000);
  assert.equal(options.maxBuffer, 256 * 1024);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(
    versionCalls.map(({ command, args }) => ({ command, args })),
    [
      { command: "/usr/bin/pandoc", args: ["--version"] },
      { command: "/usr/bin/xelatex", args: ["--version"] },
    ],
  );
  for (const versionCall of versionCalls) {
    assert.equal(versionCall.options.cwd, transactionDir);
    assert.equal(versionCall.options.encoding, "utf8");
    assert.equal(versionCall.options.shell, false);
    assert.equal(versionCall.options.timeout, 5_000);
    assert.equal(versionCall.options.maxBuffer, 16 * 1024);
    assert.equal(versionCall.options.windowsHide, true);
    assert.deepEqual(versionCall.options.env, options.env);
  }
  assert.deepEqual(Object.keys(options.env).sort(), [
    "FORCE_SOURCE_DATE",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SOURCE_DATE_EPOCH",
    "TEXMFCONFIG",
    "TEXMFHOME",
    "TEXMFOUTPUT",
    "TEXMFVAR",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  assert.equal(options.env.PATH, "/usr/bin:/bin");
  assert.equal(options.env.SOURCE_DATE_EPOCH, "946684800");
  assert.equal(options.env.FORCE_SOURCE_DATE, "1");
  assert.equal(options.env.TZ, "UTC");
  assert.equal(options.env.LANG, "C.UTF-8");
  assert.equal(options.env.LC_ALL, "C.UTF-8");

  for (const name of [
    "HOME",
    "TEXMFCONFIG",
    "TEXMFHOME",
    "TEXMFOUTPUT",
    "TEXMFVAR",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]) {
    assert.equal(
      path.relative(transactionDir, options.env[name]).startsWith(".."),
      false,
    );
    const stat = await fs.lstat(options.env[name]);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o700);
  }
});

test("rejects invalid requests and unsafe text before invoking the renderer", async (t) => {
  const stateDir = await fixture(t, "renderer-validation");
  let invocations = 0;
  const execFileFn = async () => {
    invocations += 1;
    throw new Error("must not run");
  };
  const invalidInputs = [
    null,
    { stateDir, ...BASE_INPUT, extra: true },
    { stateDir, ...BASE_INPUT, requestId: "wrong-prefix" },
    { stateDir, ...BASE_INPUT, requestId: "smart-remarkable-bad/path" },
    {
      stateDir,
      ...BASE_INPUT,
      requestId: `smart-remarkable-${"a".repeat(112)}`,
    },
    { stateDir: "relative", ...BASE_INPUT },
    inputFor(stateDir, { receivedText: "" }),
    inputFor(stateDir, { responseText: "   \n" }),
    inputFor(stateDir, { receivedText: "a".repeat(2_048 + 1) }),
    inputFor(stateDir, { responseText: "a".repeat(32_256 + 1) }),
    inputFor(stateDir, { responseText: 42 }),
    inputFor(stateDir, { responseText: "unpaired \ud800 surrogate" }),
    inputFor(stateDir, {
      responseText: Array.from({ length: 514 }, () => "x").join("\n"),
    }),
  ];
  for (const unsafe of [
    "nul\u0000here",
    "tab\there",
    "return\rhere",
    "unit\u001fseparator",
    "delete\u007fhere",
    "c1\u0085here",
    "arabic-mark\u061chere",
    "left-to-right-mark\u200ehere",
    "override\u202ehere",
    "isolate\u2066here",
  ]) {
    invalidInputs.push(inputFor(stateDir, { responseText: unsafe }));
  }

  for (const invalidInput of invalidInputs) {
    await assert.rejects(
      renderResponsePdf(invalidInput, { execFileFn }),
      (error) => error?.code === "INVALID_RESPONSE_PDF_REQUEST",
    );
  }
  assert.equal(invocations, 0);
  assert.deepEqual(await fs.readdir(stateDir), []);

  await assert.rejects(
    renderResponsePdf(inputFor(stateDir), { execFileFn: "not-a-function" }),
    (error) => error?.code === "INVALID_RESPONSE_PDF_REQUEST",
  );
  await assert.rejects(
    renderResponsePdf(inputFor(stateDir), {
      execFileFn,
      executable: "/tmp/pandoc",
    }),
    (error) => error?.code === "INVALID_RESPONSE_PDF_REQUEST",
  );
  assert.equal(invocations, 0);
});

test("accepts exact multibyte byte and combined-line boundaries", async (t) => {
  const stateDir = await fixture(t, "renderer-boundaries");
  const execFileFn = capturingExecutor([]);
  const byteBoundary = await renderResponsePdf(
    inputFor(stateDir, {
      receivedText: "א".repeat(1_024),
      responseText: "€".repeat(10_752),
    }),
    { execFileFn },
  );
  const lineBoundary = await renderResponsePdf(
    inputFor(stateDir, {
      receivedText: Array.from({ length: 257 }, () => "א").join("\n"),
      responseText: Array.from({ length: 257 }, () => "ب").join("\n"),
    }),
    { execFileFn },
  );
  t.after(async () => {
    await Promise.all([byteBoundary.cleanup(), lineBoundary.cleanup()]);
  });

  assert.equal(Buffer.byteLength("א".repeat(1_024), "utf8"), 2_048);
  assert.equal(Buffer.byteLength("€".repeat(10_752), "utf8"), 32_256);
  assert.equal(
    [
      Array.from({ length: 257 }, () => "א").join("\n"),
      Array.from({ length: 257 }, () => "ب").join("\n"),
    ]
      .join("")
      .split("")
      .filter((character) => character === "\n").length,
    512,
  );
  assert.match(byteBoundary.contentHash, /^[0-9a-f]{64}$/u);
  assert.match(lineBoundary.contentHash, /^[0-9a-f]{64}$/u);
});

test("renders an immutable snapshot when the caller mutates input after invocation", async (t) => {
  const stateDir = await fixture(t, "renderer-input-mutation");
  const calls = [];
  const mutableInput = inputFor(stateDir, {
    receivedText: "original selection",
    responseText: "original response",
  });
  const rendering = renderResponsePdf(mutableInput, {
    execFileFn: capturingExecutor(calls),
  });
  mutableInput.stateDir = "/tmp";
  mutableInput.requestId = "invalid-after-validation";
  mutableInput.receivedText = "mutated\u0000selection";
  mutableInput.responseText = "mutated\u202eresponse";

  const artifact = await rendering;
  t.after(() => artifact.cleanup());
  assert.equal(calls.length, 1);
  const astJson = calls[0].astBytes.toString("utf8");
  assert.deepEqual(
    allNodes(calls[0].ast)
      .filter((block) => block.t === "Para")
      .map((block) => inlineText(block.c)),
    ["original selection", "original response"],
  );
  assert.doesNotMatch(astJson, /mutated/u);
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
    path.relative(stateDir, artifact.snapshotPath).startsWith(".."),
    false,
  );
});

test("fails closed before rendering on Pandoc or XeTeX version drift", async (t) => {
  const cases = [
    {
      label: "pandoc version",
      overrideCommand: "/usr/bin/pandoc",
      stdout: "pandoc 3.6.4\n",
    },
    {
      label: "pandoc output bound",
      overrideCommand: "/usr/bin/pandoc",
      stdout: `pandoc 3.6.3${"x".repeat(16 * 1024)}\n`,
    },
    {
      label: "engine family",
      overrideCommand: "/usr/bin/xelatex",
      stdout: "pdfTeX 3.141592653 (TeX Live 2024/Debian)\n",
    },
    {
      label: "engine version receipt control",
      overrideCommand: "/usr/bin/xelatex",
      stdout:
        "XeTeX 3.141592653-2.6-0.999996 (TeX Live 2024/Debian)\u0000\n",
    },
    {
      label: "engine version receipt shape",
      overrideCommand: "/usr/bin/xelatex",
      stdout: "XeTeX unknown development build\n",
    },
  ];

  for (const versionCase of cases) {
    await t.test(versionCase.label, async (t) => {
      const stateDir = await fixture(t, `renderer-version-${versionCase.label}`);
      let renderInvocations = 0;
      let transactionDir;
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: async (command, args, options) => {
            transactionDir = options.cwd;
            if (args.length === 1 && args[0] === "--version") {
              return {
                stdout:
                  command === versionCase.overrideCommand
                    ? versionCase.stdout
                    : validVersionStdout(command),
                stderr: "",
              };
            }
            renderInvocations += 1;
            return { stdout: "", stderr: "" };
          },
        }),
        (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
      );
      assert.equal(renderInvocations, 0);
      await assertMissing(transactionDir);
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("rejects symlinks in renderer-owned ancestry without writing outside state", async (t) => {
  const stateDir = await fixture(t, "renderer-symlink-state");
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "smart-remarkable-renderer-outside-"),
  );
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(stateDir, "plugins"), "dir");
  let invoked = false;

  await assert.rejects(
    renderResponsePdf(inputFor(stateDir), {
      execFileFn: async () => {
        invoked = true;
      },
    }),
    (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
  );
  assert.equal(invoked, false);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("rejects symlinked, hard-linked, or broadly-readable PDF output", async (t) => {
  await t.test("symlink", async (t) => {
    const stateDir = await fixture(t, "renderer-output-symlink");
    const outsidePdf = path.join(stateDir, "outside.pdf");
    const outsideBytes = deterministicPdf(Buffer.from("outside"));
    await fs.writeFile(outsidePdf, outsideBytes, { mode: 0o600 });
    let transactionDir;
    await assert.rejects(
      renderResponsePdf(inputFor(stateDir), {
        execFileFn: capturingExecutor([], async ({ outputPath }) => {
          transactionDir = path.dirname(outputPath);
          await fs.unlink(outputPath);
          await fs.symlink(outsidePdf, outputPath);
        }),
      }),
      (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
    );
    assert.deepEqual(await fs.readFile(outsidePdf), outsideBytes);
    await assertMissing(transactionDir);
  });

  await t.test("hard link", async (t) => {
    const stateDir = await fixture(t, "renderer-output-hardlink");
    const outsidePdf = path.join(stateDir, "outside.pdf");
    await fs.writeFile(outsidePdf, deterministicPdf(Buffer.from("outside")), {
      mode: 0o600,
    });
    let transactionDir;
    await assert.rejects(
      renderResponsePdf(inputFor(stateDir), {
        execFileFn: capturingExecutor([], async ({ outputPath }) => {
          transactionDir = path.dirname(outputPath);
          await fs.unlink(outputPath);
          await fs.link(outsidePdf, outputPath);
        }),
      }),
      (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
    );
    await assertMissing(transactionDir);
    assert.equal((await fs.lstat(outsidePdf)).nlink, 1);
  });

  await t.test("broad permissions", async (t) => {
    const stateDir = await fixture(t, "renderer-output-mode");
    let transactionDir;
    await assert.rejects(
      renderResponsePdf(inputFor(stateDir), {
        execFileFn: capturingExecutor(
          [],
          async ({ astBytes, outputPath }) => {
            transactionDir = path.dirname(outputPath);
            await fs.writeFile(outputPath, deterministicPdf(astBytes));
            await fs.chmod(outputPath, 0o644);
          },
        ),
      }),
      (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
    );
    await assertMissing(transactionDir);
  });
});

test("fails closed on invalid or oversized PDF output and removes transactions", async (t) => {
  const cases = [
    ["empty", async ({ outputPath }) => fs.truncate(outputPath, 0)],
    [
      "bad magic",
      async ({ outputPath }) =>
        fs.writeFile(outputPath, Buffer.from("not-a-pdf document %%EOF\n")),
    ],
    [
      "missing eof",
      async ({ outputPath }) =>
        fs.writeFile(outputPath, Buffer.from("%PDF-1.7\nno trailer here")),
    ],
    [
      "trailing data",
      async ({ outputPath }) =>
        fs.writeFile(outputPath, Buffer.from("%PDF-1.7\n%%EOF\nforged")),
    ],
    [
      "oversized",
      async ({ outputPath }) => {
        await fs.writeFile(outputPath, Buffer.from("%PDF-1.7\n"));
        await fs.truncate(outputPath, 32 * 1024 * 1024 + 1);
      },
    ],
  ];

  for (const [label, mutateOutput] of cases) {
    await t.test(label, async (t) => {
      const stateDir = await fixture(t, `renderer-invalid-${label}`);
      let transactionDir;
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: capturingExecutor(
            [],
            async (context) => {
              transactionDir = path.dirname(context.outputPath);
              await mutateOutput(context);
            },
          ),
        }),
        (error) => error?.code === "RESPONSE_PDF_RENDER_FAILED",
      );
      await assertMissing(transactionDir);
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("bounds the process and cleans up timeout or executor failure", async (t) => {
  for (const failure of [
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    new Error("pandoc failed"),
  ]) {
    await t.test(failure.message, async (t) => {
      const stateDir = await fixture(t, "renderer-process-failure");
      let options;
      let transactionDir;
      await assert.rejects(
        renderResponsePdf(inputFor(stateDir), {
          execFileFn: async (_command, _args, receivedOptions) => {
            if (_args.length === 1 && _args[0] === "--version") {
              return {
                stdout: validVersionStdout(_command),
                stderr: "",
              };
            }
            options = receivedOptions;
            transactionDir = receivedOptions.cwd;
            throw failure;
          },
        }),
        (error) =>
          error?.code === "RESPONSE_PDF_RENDER_FAILED" &&
          error?.cause === failure,
      );
      assert.equal(options.timeout, 90_000);
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.equal(options.shell, false);
      await assertMissing(transactionDir);
      assert.deepEqual(await stagingTransactions(stateDir), []);
    });
  }
});

test("repeated renders use identical AST, bytes, name, key, and hash", async (t) => {
  const stateDir = await fixture(t, "renderer-repeat");
  const calls = [];
  const execFileFn = capturingExecutor(calls);
  const first = await renderResponsePdf(inputFor(stateDir), { execFileFn });
  const second = await renderResponsePdf(inputFor(stateDir), { execFileFn });
  t.after(async () => {
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  assert.notEqual(first.snapshotPath, second.snapshotPath);
  assert.deepEqual(calls[0].astBytes, calls[1].astBytes);
  assert.deepEqual(
    await fs.readFile(first.snapshotPath),
    await fs.readFile(second.snapshotPath),
  );
  assert.equal(first.artifactKey, second.artifactKey);
  assert.equal(first.artifactKey, "response-pdf-cloud-v1");
  assert.equal(first.visibleName, second.visibleName);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.sizeBytes, second.sizeBytes);
  assert.equal(
    calls[0].options.env.SOURCE_DATE_EPOCH,
    calls[1].options.env.SOURCE_DATE_EPOCH,
  );
});
