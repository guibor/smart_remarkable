import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const PANDOC_PATH = "/usr/bin/pandoc";
const XELATEX_PATH = "/usr/bin/xelatex";
const PANDOC_VERSION_LINE = "pandoc 3.6.3";
const PANDOC_API_VERSION = Object.freeze([1, 23, 1]);
const ARTIFACT_KEY = "response-pdf-cloud-v1";
const SOURCE_DATE_EPOCH = "946684800";
const MAX_RECEIVED_TEXT_BYTES = 2_048;
const MAX_RESPONSE_TEXT_BYTES = 32_256;
const MAX_COMBINED_TEXT_BYTES =
  MAX_RECEIVED_TEXT_BYTES + MAX_RESPONSE_TEXT_BYTES;
const MAX_COMBINED_LINE_BREAKS = 512;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const RENDER_TIMEOUT_MS = 90_000;
const VERSION_TIMEOUT_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const PDF_TAIL_BYTES = 1024;
const REQUEST_ID_PATTERN =
  /^smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$/;
const C0_C1_EXCEPT_LF_PATTERN =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_PATTERN = /\p{Bidi_Control}/u;
const HEBREW_SCRIPT_PATTERN = /\p{Script_Extensions=Hebrew}/u;
const ARABIC_SCRIPT_PATTERN = /\p{Script_Extensions=Arabic}/u;
const LETTER_PATTERN = /\p{Letter}/u;
const VERSION_CONTROL_PATTERN =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const XETEX_VERSION_LINE_PATTERN =
  /^XeTeX [0-9][0-9A-Za-z.+-]{0,63} \(TeX Live [0-9]{4}(?:\/[A-Za-z0-9._+-]{1,32})?\)$/u;
const INPUT_KEYS = Object.freeze([
  "receivedText",
  "requestId",
  "responseText",
  "stateDir",
]);
const DIRECTORY_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_DIRECTORY |
  fsConstants.O_NOFOLLOW;
const PDF_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const nodeExecFileAsync = promisify(nodeExecFile);

function rendererError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function invalidRequest(message) {
  return rendererError("INVALID_RESPONSE_PDF_REQUEST", message);
}

function renderFailed(cause) {
  return rendererError(
    "RESPONSE_PDF_RENDER_FAILED",
    "OpenClaw response PDF rendering failed",
    cause,
  );
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function requireExpectedUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : NaN;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw invalidRequest("Response PDF rendering requires POSIX ownership checks");
  }
  return uid;
}

function validateInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) {
    throw invalidRequest(
      `Response PDF input must contain exactly ${INPUT_KEYS.join(", ")}`,
    );
  }
  const snapshot = Object.freeze({
    receivedText: input.receivedText,
    requestId: input.requestId,
    responseText: input.responseText,
    stateDir: input.stateDir,
  });
  if (
    typeof snapshot.stateDir !== "string" ||
    !path.isAbsolute(snapshot.stateDir)
  ) {
    throw invalidRequest("OpenClaw state directory must be an absolute path");
  }
  if (
    typeof snapshot.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(snapshot.requestId)
  ) {
    throw invalidRequest("Invalid Smart reMarkable request ID");
  }
  validateText(
    snapshot.receivedText,
    "receivedText",
    MAX_RECEIVED_TEXT_BYTES,
  );
  validateText(
    snapshot.responseText,
    "responseText",
    MAX_RESPONSE_TEXT_BYTES,
  );
  const combinedBytes =
    Buffer.byteLength(snapshot.receivedText, "utf8") +
    Buffer.byteLength(snapshot.responseText, "utf8");
  const combinedLineBreaks =
    countLineBreaks(snapshot.receivedText) +
    countLineBreaks(snapshot.responseText);
  if (
    combinedBytes > MAX_COMBINED_TEXT_BYTES ||
    combinedLineBreaks > MAX_COMBINED_LINE_BREAKS
  ) {
    throw invalidRequest(
      "Response PDF text exceeds the combined document complexity limit",
    );
  }
  return snapshot;
}

function countLineBreaks(value) {
  let count = 0;
  for (const character of value) {
    if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

function validateText(value, label, maxBytes) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw invalidRequest(`${label} must be non-empty bounded UTF-8 text`);
  }
  if (C0_C1_EXCEPT_LF_PATTERN.test(value)) {
    throw invalidRequest(`${label} contains a forbidden control character`);
  }
  if (BIDI_CONTROL_PATTERN.test(value)) {
    throw invalidRequest(`${label} contains a forbidden bidi control`);
  }
}

function validateDependencies(dependencies) {
  if (dependencies === undefined) {
    return Object.freeze({ execFileFn: nodeExecFileAsync });
  }
  if (!isRecord(dependencies)) {
    throw invalidRequest("Response PDF dependencies must be an object");
  }
  const keys = Object.keys(dependencies);
  if (
    keys.some((key) => key !== "execFileFn") ||
    (dependencies.execFileFn !== undefined &&
      typeof dependencies.execFileFn !== "function")
  ) {
    throw invalidRequest("Invalid response PDF renderer dependencies");
  }
  return Object.freeze({
    execFileFn: dependencies.execFileFn ?? nodeExecFileAsync,
  });
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

function assertOwnedDirectoryStat(stat, expectedUid, privateMode, label) {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (privateMode && (stat.mode & 0o777) !== 0o700)
  ) {
    throw new Error(`${label} is not a private owned directory`);
  }
}

async function inspectDirectory(
  directory,
  expectedUid,
  { privateMode = false, makePrivate = false, label = "Directory" } = {},
) {
  const handle = await fs.open(directory, DIRECTORY_OPEN_FLAGS);
  try {
    let handleStat = await handle.stat();
    assertOwnedDirectoryStat(handleStat, expectedUid, false, label);
    if (makePrivate && (handleStat.mode & 0o777) !== 0o700) {
      await handle.chmod(0o700);
      handleStat = await handle.stat();
    }
    assertOwnedDirectoryStat(handleStat, expectedUid, privateMode, label);
    const pathStat = await fs.lstat(directory);
    assertOwnedDirectoryStat(pathStat, expectedUid, privateMode, label);
    if (!sameFileIdentity(handleStat, pathStat)) {
      throw new Error(`${label} changed during validation`);
    }
    return handleStat;
  } finally {
    await handle.close();
  }
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function ensureDirectory({
  directory,
  expectedUid,
  rootReal,
  privateMode = false,
  label,
}) {
  try {
    await fs.mkdir(directory, { mode: privateMode ? 0o700 : 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  await inspectDirectory(directory, expectedUid, {
    privateMode,
    makePrivate: privateMode,
    label,
  });
  const directoryReal = await fs.realpath(directory);
  if (!isInsideRoot(rootReal, directoryReal)) {
    throw new Error(`${label} escaped the OpenClaw state directory`);
  }
  return directory;
}

async function createTransaction(stateDir, expectedUid) {
  await inspectDirectory(stateDir, expectedUid, {
    label: "OpenClaw state directory",
  });
  const rootReal = await fs.realpath(stateDir);
  let parent = stateDir;
  for (const [component, privateMode] of [
    ["plugins", false],
    ["smart-remarkable-delivery", false],
    ["response-pdf-staging", true],
  ]) {
    parent = path.join(parent, component);
    await ensureDirectory({
      directory: parent,
      expectedUid,
      rootReal,
      privateMode,
      label: "Response PDF staging directory",
    });
  }

  const transactionDir = await fs.mkdtemp(path.join(parent, "render-"));
  try {
    await fs.chmod(transactionDir, 0o700);
    await inspectDirectory(transactionDir, expectedUid, {
      privateMode: true,
      label: "Response PDF transaction",
    });
    const transactionReal = await fs.realpath(transactionDir);
    if (!isInsideRoot(rootReal, transactionReal)) {
      throw new Error(
        "Response PDF transaction escaped the OpenClaw state directory",
      );
    }
    return transactionDir;
  } catch (error) {
    await fs.rm(transactionDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function createPrivateDirectory(directory, expectedUid) {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await inspectDirectory(directory, expectedUid, {
    privateMode: true,
    label: "Response PDF private runtime directory",
  });
}

const ENGLISH_DIRECTION = Object.freeze({ lang: "en", dir: "ltr" });
const HEBREW_DIRECTION = Object.freeze({ lang: "he", dir: "rtl" });
const ARABIC_DIRECTION = Object.freeze({ lang: "ar", dir: "rtl" });

function strongDirection(character) {
  if (!LETTER_PATTERN.test(character)) {
    return undefined;
  }
  if (HEBREW_SCRIPT_PATTERN.test(character)) {
    return HEBREW_DIRECTION;
  }
  if (ARABIC_SCRIPT_PATTERN.test(character)) {
    return ARABIC_DIRECTION;
  }
  return ENGLISH_DIRECTION;
}

function firstStrongDirection(text) {
  for (const character of text) {
    const direction = strongDirection(character);
    if (direction) {
      return direction;
    }
  }
  return ENGLISH_DIRECTION;
}

function directionAttributes(direction) {
  return [
    "",
    [],
    [
      ["lang", direction.lang],
      ["dir", direction.dir],
    ],
  ];
}

function textToDirectionalSpans(text) {
  const runs = [];
  let run = "";
  let runDirection;
  for (const character of text) {
    const characterDirection = strongDirection(character);
    if (
      characterDirection &&
      runDirection &&
      characterDirection !== runDirection
    ) {
      runs.push({ text: run, direction: runDirection });
      run = "";
      runDirection = characterDirection;
    }
    run += character;
    runDirection ??= characterDirection;
  }
  if (run.length > 0) {
    runs.push({
      text: run,
      direction: runDirection ?? ENGLISH_DIRECTION,
    });
  }
  return runs.map(({ text: runText, direction }) => ({
    t: "Span",
    c: [directionAttributes(direction), [{ t: "Str", c: runText }]],
  }));
}

function textToInlines(text) {
  const inlines = [];
  for (const part of text.split(/( +)/u)) {
    if (part.length === 0) {
      continue;
    }
    if (/^ +$/u.test(part)) {
      for (let index = 0; index < part.length; index += 1) {
        inlines.push({ t: "Space" });
      }
    } else {
      inlines.push(...textToDirectionalSpans(part));
    }
  }
  return inlines;
}

function textToBlocks(text) {
  const blocks = [];
  let paragraphLines = [];
  const flush = () => {
    if (paragraphLines.length > 0) {
      const paragraph = [];
      for (const line of paragraphLines) {
        if (paragraph.length > 0) {
          paragraph.push({ t: "LineBreak" });
        }
        paragraph.push(...textToInlines(line));
      }
      blocks.push({
        t: "Div",
        c: [
          directionAttributes(firstStrongDirection(paragraphLines.join("\n"))),
          [{ t: "Para", c: paragraph }],
        ],
      });
      paragraphLines = [];
    }
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    paragraphLines.push(line);
  }
  flush();
  return blocks;
}

function metaString(value) {
  return { t: "MetaString", c: value };
}

function buildPandocAst(receivedText, responseText) {
  return {
    "pandoc-api-version": [...PANDOC_API_VERSION],
    meta: {
      documentclass: metaString("article"),
      classoption: {
        t: "MetaList",
        c: [metaString("onecolumn")],
      },
      papersize: metaString("a4"),
      fontsize: metaString("11pt"),
      mainfont: metaString("DejaVu Sans"),
      lang: metaString("en"),
      dir: metaString("ltr"),
      "babel-otherlangs": {
        t: "MetaList",
        c: [metaString("hebrew"), metaString("arabic")],
      },
      babelfonts: {
        t: "MetaMap",
        c: {
          hebrew: metaString("Noto Sans Hebrew"),
          arabic: metaString("Noto Sans Arabic"),
        },
      },
      geometry: {
        t: "MetaList",
        c: [
          metaString("top=22mm"),
          metaString("bottom=22mm"),
          metaString("left=24mm"),
          metaString("right=24mm"),
        ],
      },
      colorlinks: { t: "MetaBool", c: false },
    },
    blocks: [
      {
        t: "Header",
        c: [
          1,
          ["selection-received", [], []],
          textToInlines("Selection received"),
        ],
      },
      ...textToBlocks(receivedText),
      {
        t: "Header",
        c: [
          1,
          ["openclaw-response", [], []],
          textToInlines("OpenClaw response"),
        ],
      },
      ...textToBlocks(responseText),
    ],
  };
}

async function writePrivateFile(filePath, data, expectedUid) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size !== Buffer.byteLength(data)
    ) {
      throw new Error("Response PDF private input file failed validation");
    }
  } finally {
    await handle.close();
  }
}

async function createPrivateOutput(filePath, expectedUid) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size !== 0
    ) {
      throw new Error("Response PDF output reservation failed validation");
    }
  } finally {
    await handle.close();
  }
}

function assertPdfStat(stat, expectedUid) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 16 ||
    stat.size > MAX_PDF_BYTES
  ) {
    throw new Error("Rendered response PDF is not a private bounded regular file");
  }
}

async function validatePdf(filePath, expectedUid) {
  const handle = await fs.open(filePath, PDF_READ_FLAGS);
  try {
    const initialStat = await handle.stat();
    assertPdfStat(initialStat, expectedUid);

    const hash = crypto.createHash("sha256");
    const header = Buffer.alloc(8);
    let headerBytes = 0;
    let tail = Buffer.alloc(0);
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= MAX_PDF_BYTES) {
      const remaining = MAX_PDF_BYTES + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      if (headerBytes < header.length) {
        const copied = chunk.copy(
          header,
          headerBytes,
          0,
          Math.min(header.length - headerBytes, chunk.length),
        );
        headerBytes += copied;
      }
      hash.update(chunk);
      tail = Buffer.concat([tail, chunk]).subarray(-PDF_TAIL_BYTES);
      totalBytes += bytesRead;
      position += bytesRead;
    }
    if (
      totalBytes !== initialStat.size ||
      totalBytes > MAX_PDF_BYTES ||
      headerBytes < 5 ||
      !header.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")) ||
      !/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/u.test(
        tail.toString("latin1"),
      )
    ) {
      throw new Error("Rendered response PDF failed format validation");
    }

    const finalStat = await handle.stat();
    assertPdfStat(finalStat, expectedUid);
    if (
      !sameFileIdentity(initialStat, finalStat) ||
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ctimeMs !== initialStat.ctimeMs
    ) {
      throw new Error("Rendered response PDF changed during validation");
    }
    const pathStat = await fs.lstat(filePath);
    assertPdfStat(pathStat, expectedUid);
    if (!sameFileIdentity(finalStat, pathStat)) {
      throw new Error("Rendered response PDF changed during path validation");
    }
    return Object.freeze({
      contentHash: hash.digest("hex"),
      sizeBytes: totalBytes,
    });
  } finally {
    await handle.close();
  }
}

function stableVisibleName(requestId) {
  const suffix = crypto
    .createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 16);
  return `OpenClaw response ${suffix}.pdf`;
}

function buildEnvironment(runtimeDirectories) {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    HOME: runtimeDirectories.home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SOURCE_DATE_EPOCH,
    FORCE_SOURCE_DATE: "1",
    XDG_CACHE_HOME: runtimeDirectories.cache,
    XDG_CONFIG_HOME: runtimeDirectories.config,
    XDG_DATA_HOME: runtimeDirectories.data,
    TEXMFHOME: runtimeDirectories.texmfHome,
    TEXMFVAR: runtimeDirectories.texmfVar,
    TEXMFCONFIG: runtimeDirectories.texmfConfig,
    TEXMFOUTPUT: runtimeDirectories.texmfOutput,
    TMPDIR: runtimeDirectories.tmp,
  });
}

function versionFirstLine(stdout, label) {
  if (
    typeof stdout !== "string" ||
    stdout.length === 0 ||
    Buffer.byteLength(stdout, "utf8") > MAX_VERSION_OUTPUT_BYTES ||
    VERSION_CONTROL_PATTERN.test(stdout)
  ) {
    throw new Error(`${label} returned an invalid version receipt`);
  }
  const firstLine = stdout.split("\n", 1)[0].replace(/\r$/u, "");
  if (firstLine.length === 0 || Buffer.byteLength(firstLine, "utf8") > 160) {
    throw new Error(`${label} returned an invalid version receipt`);
  }
  return firstLine;
}

async function verifyRendererDependencies({
  execFileFn,
  cwd,
  env,
}) {
  const options = {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    shell: false,
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  };
  const [pandocReceipt, xetexReceipt] = await Promise.all([
    execFileFn(PANDOC_PATH, ["--version"], options),
    execFileFn(XELATEX_PATH, ["--version"], options),
  ]);
  if (
    versionFirstLine(pandocReceipt?.stdout, "pandoc") !==
    PANDOC_VERSION_LINE
  ) {
    throw new Error(
      `Response PDF rendering requires ${PANDOC_VERSION_LINE} with Pandoc JSON API ${PANDOC_API_VERSION.join(".")}`,
    );
  }
  const xetexVersionLine = versionFirstLine(xetexReceipt?.stdout, "XeTeX");
  if (!XETEX_VERSION_LINE_PATTERN.test(xetexVersionLine)) {
    throw new Error("Response PDF rendering requires a supported XeTeX engine");
  }
}

async function removeTransaction(transactionDir) {
  if (!transactionDir) {
    return;
  }
  await fs.rm(transactionDir, { recursive: true, force: true });
}

/**
 * Render one deterministic, upload-ready PDF snapshot for an authenticated
 * Smart reMarkable response. User-controlled text is represented exclusively
 * as Pandoc `Str` nodes; it is never parsed as Markdown, HTML, or TeX.
 */
export async function renderResponsePdf(input, dependencies) {
  const validated = validateInput(input);
  const { execFileFn } = validateDependencies(dependencies);
  const expectedUid = requireExpectedUid();
  let transactionDir;
  try {
    transactionDir = await createTransaction(validated.stateDir, expectedUid);
    const runtimeDirectories = {
      home: path.join(transactionDir, "home"),
      cache: path.join(transactionDir, "cache"),
      config: path.join(transactionDir, "config"),
      data: path.join(transactionDir, "data"),
      texmfHome: path.join(transactionDir, "texmf-home"),
      texmfVar: path.join(transactionDir, "texmf-var"),
      texmfConfig: path.join(transactionDir, "texmf-config"),
      texmfOutput: path.join(transactionDir, "texmf-output"),
      tmp: path.join(transactionDir, "tmp"),
    };
    for (const directory of Object.values(runtimeDirectories)) {
      await createPrivateDirectory(directory, expectedUid);
    }
    const renderEnvironment = buildEnvironment(runtimeDirectories);
    await verifyRendererDependencies({
      execFileFn,
      cwd: transactionDir,
      env: renderEnvironment,
    });

    const astPath = path.join(transactionDir, "document.json");
    const snapshotPath = path.join(transactionDir, "response.pdf");
    const ast = buildPandocAst(
      validated.receivedText,
      validated.responseText,
    );
    const astBytes = Buffer.from(JSON.stringify(ast), "utf8");
    await writePrivateFile(astPath, astBytes, expectedUid);
    await createPrivateOutput(snapshotPath, expectedUid);

    await execFileFn(
      PANDOC_PATH,
      [
        "--from=json",
        "--standalone",
        "--sandbox",
        `--pdf-engine=${XELATEX_PATH}`,
        "--pdf-engine-opt=-no-shell-escape",
        "--pdf-engine-opt=-halt-on-error",
        "--pdf-engine-opt=-interaction=nonstopmode",
        "--pdf-engine-opt=-file-line-error",
        `--output=${snapshotPath}`,
        astPath,
      ],
      {
        cwd: transactionDir,
        encoding: "utf8",
        env: renderEnvironment,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        shell: false,
        timeout: RENDER_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    const validatedPdf = await validatePdf(snapshotPath, expectedUid);
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) {
        return;
      }
      await removeTransaction(transactionDir);
      cleaned = true;
    };
    return Object.freeze({
      artifactKey: ARTIFACT_KEY,
      visibleName: stableVisibleName(validated.requestId),
      snapshotPath,
      contentHash: validatedPdf.contentHash,
      sizeBytes: validatedPdf.sizeBytes,
      cleanup,
    });
  } catch (error) {
    await removeTransaction(transactionDir).catch(() => {});
    if (error?.code === "INVALID_RESPONSE_PDF_REQUEST") {
      throw error;
    }
    throw renderFailed(error);
  }
}
