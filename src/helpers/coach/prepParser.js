// Extract plain text from a prep file the user attached to a meeting note.
// Text formats are read directly; Word/RTF/HTML go through macOS `textutil`;
// PDFs through PDFKit via JXA. Both tools ship with macOS — no bundled deps.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MAX_SOURCE_CHARS = 100000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text", ".csv", ".json", ".yaml", ".yml"]);
const TEXTUTIL_EXTS = new Set([".docx", ".doc", ".rtf", ".rtfd", ".html", ".htm", ".odt", ".webarchive"]);

const PDF_TEXT_JXA = `
ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('Could not open PDF');
  const text = doc.string;
  return text && !text.isNil() ? ObjC.unwrap(text) : '';
}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || "").toString().trim().slice(0, 300)));
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

function normalize(text) {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text: cleaned.length > MAX_SOURCE_CHARS ? cleaned.slice(0, MAX_SOURCE_CHARS) : cleaned,
    truncated: cleaned.length > MAX_SOURCE_CHARS,
  };
}

async function extractPdf(filePath) {
  if (process.platform !== "darwin") {
    throw new Error("PDF prep files are only supported on macOS — paste the text instead");
  }
  // Read via a private temp copy: the app holds access to the user-picked
  // file, while osascript (a separate process) may not.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-prep-"));
  const tmpFile = path.join(tmpDir, "prep.pdf");
  try {
    await fs.promises.copyFile(filePath, tmpFile);
    return await run("osascript", ["-l", "JavaScript", "-e", PDF_TEXT_JXA, tmpFile]);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @returns {Promise<{name: string, text: string, truncated: boolean}>}
 */
async function extractPrepText(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error("File is larger than 25 MB");
  }
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  let raw;

  if (TEXT_EXTS.has(ext)) {
    raw = await fs.promises.readFile(filePath, "utf8");
  } else if (TEXTUTIL_EXTS.has(ext)) {
    if (process.platform !== "darwin") {
      throw new Error(`${ext} prep files are only supported on macOS — paste the text instead`);
    }
    raw = await run("textutil", ["-convert", "txt", "-stdout", filePath]);
  } else if (ext === ".pdf") {
    raw = await extractPdf(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext || "unknown"}`);
  }

  const { text, truncated } = normalize(raw);
  if (!text) {
    throw new Error(
      ext === ".pdf"
        ? "No text found in this PDF (it may be scanned images) — paste the text instead"
        : "The file contains no text"
    );
  }
  return { name, text, truncated };
}

const PREP_FILE_EXTENSIONS = [...TEXT_EXTS, ...TEXTUTIL_EXTS, ".pdf"].map((e) => e.slice(1));

module.exports = { extractPrepText, normalizePrepText: normalize, PREP_FILE_EXTENSIONS, MAX_SOURCE_CHARS };
