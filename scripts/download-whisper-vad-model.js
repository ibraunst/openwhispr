#!/usr/bin/env node
/**
 * Downloads the Silero VAD model for whisper-server voice activity detection.
 *
 * whisper-server is started with --vad --vad-model pointing at this file so
 * local Whisper skips non-speech audio (faster long transcriptions, fewer
 * silence hallucinations). ~864 KB, fetched once and cached in
 * resources/bin/whisper-vad/.
 */

const fs = require("fs");
const path = require("path");
const { downloadFile } = require("./lib/download-utils");

const VAD_MODEL_URL =
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const VAD_MODEL_FILE = "ggml-silero-v5.1.2.bin";
const VAD_DIR = path.join(__dirname, "..", "resources", "bin", "whisper-vad");
const VAD_MODEL_PATH = path.join(VAD_DIR, VAD_MODEL_FILE);

async function main() {
  if (fs.existsSync(VAD_MODEL_PATH) && !process.argv.includes("--force")) {
    console.log(`\n${VAD_MODEL_FILE} already exists, skipping\n`);
    return;
  }

  console.log(`\nDownloading ${VAD_MODEL_FILE}...\n  ${VAD_MODEL_URL}`);
  fs.mkdirSync(VAD_DIR, { recursive: true });

  try {
    await downloadFile(VAD_MODEL_URL, VAD_MODEL_PATH);
    const sizeKb = Math.round(fs.statSync(VAD_MODEL_PATH).size / 1024);
    console.log(`  Saved to ${VAD_MODEL_PATH} (${sizeKb} KB)\n`);
  } catch (err) {
    try {
      if (fs.existsSync(VAD_MODEL_PATH)) fs.unlinkSync(VAD_MODEL_PATH);
    } catch {}
    console.error(`  Failed to download VAD model: ${err.message}\n`);
    process.exitCode = 1;
  }
}

main();
