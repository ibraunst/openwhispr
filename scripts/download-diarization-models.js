#!/usr/bin/env node
/**
 * Downloads the ONNX models for the sherpa-onnx speaker diarization engine
 * (Tier 6 A/B alternative to the Python/pyannote engine):
 *
 *   - pyannote-segmentation-3.0 (speech turn segmentation, ~6 MB)
 *   - 3D-Speaker CAM++ (speaker embeddings, ~28 MB)
 *
 * Both are pinned by SHA-256 — a truncated or tampered download is deleted
 * and the script fails instead of shipping a corrupt model.
 *
 * Models land in resources/bin/diarization-models/ and ship via
 * electron-builder extraResources (same pattern as whisper-vad).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { downloadFile } = require("./lib/download-utils");

const MODELS_DIR = path.join(__dirname, "..", "resources", "bin", "diarization-models");

const SEGMENTATION_DIR = "sherpa-onnx-pyannote-segmentation-3-0";
const SEGMENTATION_ARCHIVE = `${SEGMENTATION_DIR}.tar.bz2`;
const SEGMENTATION_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/${SEGMENTATION_ARCHIVE}`;
// SHA-256 of the release archive and of the extracted model.onnx
// (computed 2026-07-10 from the k2-fsa GitHub release assets)
const SEGMENTATION_ARCHIVE_SHA256 =
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488";
const SEGMENTATION_MODEL_SHA256 =
  "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079";

const EMBEDDING_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const EMBEDDING_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${EMBEDDING_FILE}`;
const EMBEDDING_SHA256 = "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b";

const SEGMENTATION_MODEL_PATH = path.join(MODELS_DIR, SEGMENTATION_DIR, "model.onnx");
const EMBEDDING_MODEL_PATH = path.join(MODELS_DIR, EMBEDDING_FILE);

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyChecksum(filePath, expected, label) {
  const actual = sha256File(filePath);
  if (actual !== expected) {
    fs.unlinkSync(filePath);
    throw new Error(
      `${label} checksum mismatch (expected ${expected}, got ${actual}) — deleted ${filePath}`
    );
  }
  console.log(`  ${label}: checksum OK`);
}

async function downloadSegmentationModel(force) {
  if (fs.existsSync(SEGMENTATION_MODEL_PATH) && !force) {
    console.log(`  ${SEGMENTATION_DIR}/model.onnx already exists, skipping`);
    return;
  }

  const archivePath = path.join(MODELS_DIR, SEGMENTATION_ARCHIVE);
  console.log(`  Downloading ${SEGMENTATION_ARCHIVE}...`);
  await downloadFile(SEGMENTATION_URL, archivePath);
  verifyChecksum(archivePath, SEGMENTATION_ARCHIVE_SHA256, SEGMENTATION_ARCHIVE);

  // Extract only model.onnx — the archive also carries export scripts and an
  // int8 variant the engine never loads.
  const extractDir = path.join(MODELS_DIR, "temp-segmentation");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    // Relative paths from the archive dir as cwd, so neither -f nor -C args
    // contain Windows drive letter colons (GNU tar treats C: as remote host)
    execFileSync(
      "tar",
      ["-xjf", path.basename(archivePath), "-C", path.relative(MODELS_DIR, extractDir)],
      { stdio: "inherit", cwd: MODELS_DIR }
    );

    const extractedModel = path.join(extractDir, SEGMENTATION_DIR, "model.onnx");
    if (!fs.existsSync(extractedModel)) {
      throw new Error(`model.onnx not found in extracted archive at ${extractedModel}`);
    }
    verifyChecksum(extractedModel, SEGMENTATION_MODEL_SHA256, `${SEGMENTATION_DIR}/model.onnx`);

    fs.mkdirSync(path.dirname(SEGMENTATION_MODEL_PATH), { recursive: true });
    fs.copyFileSync(extractedModel, SEGMENTATION_MODEL_PATH);
    console.log(`  Saved ${SEGMENTATION_MODEL_PATH}`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

async function downloadEmbeddingModel(force) {
  if (fs.existsSync(EMBEDDING_MODEL_PATH) && !force) {
    console.log(`  ${EMBEDDING_FILE} already exists, skipping`);
    return;
  }

  console.log(`  Downloading ${EMBEDDING_FILE}...`);
  await downloadFile(EMBEDDING_URL, EMBEDDING_MODEL_PATH);
  verifyChecksum(EMBEDDING_MODEL_PATH, EMBEDDING_SHA256, EMBEDDING_FILE);
  console.log(`  Saved ${EMBEDDING_MODEL_PATH}`);
}

async function main() {
  const force = process.argv.includes("--force");
  console.log("\nDownloading speaker diarization models (sherpa-onnx engine)...\n");
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  try {
    await downloadSegmentationModel(force);
    await downloadEmbeddingModel(force);
    console.log("\nDiarization models ready.\n");
  } catch (err) {
    console.error(`\nFailed to download diarization models: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MODELS_DIR,
  SEGMENTATION_DIR,
  SEGMENTATION_MODEL_PATH,
  EMBEDDING_FILE,
  EMBEDDING_MODEL_PATH,
};

if (require.main === module) {
  main();
}
