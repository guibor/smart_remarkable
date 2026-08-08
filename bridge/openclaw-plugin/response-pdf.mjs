import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PRLIMIT_PATH = "/usr/bin/prlimit";
const PYTHON_PATH = "/usr/bin/python3";
const RENDERER_PATH = fileURLToPath(
  new URL("./response-pdf-renderer.py", import.meta.url),
);
const RENDERER_PROTOCOL = "response-pdf-pango-v1";
const RENDERER_VERSION_LINE =
  "smart-remarkable-pango-pdf-v1 python=3.10.12 pycairo=1.20.1 cairo=1.16.0 pygobject=3.42.1 pango=1.50.6";
const ARTIFACT_KEY = "response-pdf-cloud-v1";
const SOURCE_DATE_EPOCH = "946684800";
const MAX_RECEIVED_TEXT_BYTES = 2_048;
const MAX_RESPONSE_TEXT_BYTES = 32_256;
const MAX_COMBINED_TEXT_BYTES =
  MAX_RECEIVED_TEXT_BYTES + MAX_RESPONSE_TEXT_BYTES;
const MAX_COMBINED_LINE_BREAKS = 512;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const RENDER_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const PDF_TAIL_BYTES = 1024;
const REQUEST_ID_PATTERN =
  /^smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$/;
const C0_C1_EXCEPT_LF_PATTERN =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_PATTERN = /\p{Bidi_Control}/u;
const VERSION_CONTROL_PATTERN =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const RENDER_RECEIPT_KEYS = Object.freeze([
  "bytes",
  "pages",
  "renderer",
  "unknown_glyphs",
]);
const PRLIMIT_ARGUMENTS = Object.freeze([
  "--as=536870912",
  "--cpu=15",
  "--fsize=33554432",
  "--nofile=64",
  "--",
]);
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
    if (
      character === "\n" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
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
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    XDG_CACHE_HOME: runtimeDirectories.cache,
    XDG_CONFIG_HOME: runtimeDirectories.config,
    XDG_DATA_HOME: runtimeDirectories.data,
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

function boundedRendererArguments(rendererArguments) {
  return [
    ...PRLIMIT_ARGUMENTS,
    PYTHON_PATH,
    "-I",
    "-B",
    RENDERER_PATH,
    ...rendererArguments,
  ];
}

async function verifyRendererDependencies({ execFileFn, cwd, env }) {
  const options = {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    shell: false,
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  };
  const receipt = await execFileFn(
    PRLIMIT_PATH,
    boundedRendererArguments(["--version"]),
    options,
  );
  if (
    versionFirstLine(receipt?.stdout, "Pango response renderer") !==
      RENDERER_VERSION_LINE ||
    receipt?.stderr !== ""
  ) {
    throw new Error("Response PDF renderer dependency identity drifted");
  }
}

function validateRenderReceipt(result, expectedBytes) {
  if (
    result?.stderr !== "" ||
    typeof result?.stdout !== "string" ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES ||
    VERSION_CONTROL_PATTERN.test(result.stdout)
  ) {
    throw new Error("Response PDF renderer returned an invalid receipt");
  }
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Response PDF renderer returned malformed JSON", {
      cause: error,
    });
  }
  if (
    !hasExactKeys(receipt, RENDER_RECEIPT_KEYS) ||
    receipt.renderer !== RENDERER_PROTOCOL ||
    receipt.unknown_glyphs !== 0 ||
    !Number.isSafeInteger(receipt.pages) ||
    receipt.pages < 1 ||
    receipt.pages > 64 ||
    receipt.bytes !== expectedBytes
  ) {
    throw new Error("Response PDF renderer receipt did not match the output");
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
 * Smart reMarkable response. User-controlled text crosses the renderer boundary
 * only as validated JSON strings and is passed to Pango as plain text, never as
 * markup, HTML, Markdown, or TeX.
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

    const inputPath = path.join(transactionDir, "renderer-input.json");
    const snapshotPath = path.join(transactionDir, "response.pdf");
    const inputBytes = Buffer.from(
      JSON.stringify({
        protocol: RENDERER_PROTOCOL,
        received_text: validated.receivedText,
        request_id: validated.requestId,
        response_text: validated.responseText,
      }),
      "utf8",
    );
    await writePrivateFile(inputPath, inputBytes, expectedUid);
    await createPrivateOutput(snapshotPath, expectedUid);

    const renderResult = await execFileFn(
      PRLIMIT_PATH,
      boundedRendererArguments(["--render", inputPath, snapshotPath]),
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
    validateRenderReceipt(renderResult, validatedPdf.sizeBytes);
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
