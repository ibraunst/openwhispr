const path = require("path");
const Database = require("better-sqlite3");

/**
 * Node-side access to the speaker voicebanks (voiceprints learned by
 * python/speaker_engine.py and the sherpa-onnx engine). Each engine has its
 * own DB file — pyannote and CAM++ embeddings live in incompatible spaces
 * and must never be mixed or migrated. Connections are opened per operation
 * and closed immediately so we never hold a lock while an engine is writing.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS voice_prints (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    embedding     BLOB NOT NULL,
    meeting_count INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

function getVoicebankPath(app, engine) {
  return path.join(
    app.getPath("userData"),
    engine === "sherpa" ? "voicebank-sherpa.db" : "voicebank.db"
  );
}

function withDb(app, engine, fn) {
  const db = new Database(getVoicebankPath(app, engine), { timeout: 5000 });
  try {
    db.exec(SCHEMA);
    return fn(db);
  } finally {
    db.close();
  }
}

function listVoicePrints(app, engine) {
  return withDb(app, engine, (db) =>
    db
      .prepare(
        "SELECT id, label, meeting_count, created_at, updated_at FROM voice_prints ORDER BY meeting_count DESC, updated_at DESC"
      )
      .all()
  );
}

/**
 * Rename a voiceprint by id or by current label. If a different voiceprint
 * already carries the new label (same person enrolled twice), the two are
 * merged: embeddings averaged weighted by meeting count, source row deleted.
 * Returns the number of affected voiceprints (0 if nothing matched — e.g.
 * renaming "Me", which is never stored in the bank).
 */
function renameVoicePrint(app, { id, oldLabel, newLabel, engine }) {
  const label = String(newLabel || "").trim();
  if (!label) throw new Error("New speaker name must not be empty");

  return withDb(app, engine, (db) => {
    const sources = id
      ? db.prepare("SELECT id, label, embedding, meeting_count FROM voice_prints WHERE id = ?").all(id)
      : db
          .prepare("SELECT id, label, embedding, meeting_count FROM voice_prints WHERE label = ?")
          .all(String(oldLabel || ""));

    if (sources.length === 0) return { changes: 0 };

    let changes = 0;
    const findTarget = db.prepare(
      "SELECT id, embedding, meeting_count FROM voice_prints WHERE label = ? AND id != ?"
    );
    const update = db.prepare(
      "UPDATE voice_prints SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    const mergeUpdate = db.prepare(
      "UPDATE voice_prints SET embedding = ?, meeting_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    const remove = db.prepare("DELETE FROM voice_prints WHERE id = ?");

    for (const source of sources) {
      const target = findTarget.get(label, source.id);
      if (target) {
        // Same person enrolled under two voiceprints — merge into the target.
        const merged = mergeEmbeddings(
          target.embedding,
          target.meeting_count,
          source.embedding,
          source.meeting_count
        );
        mergeUpdate.run(merged, target.meeting_count + source.meeting_count, target.id);
        remove.run(source.id);
      } else {
        update.run(label, source.id);
      }
      changes++;
    }
    return { changes };
  });
}

function mergeEmbeddings(bufA, countA, bufB, countB) {
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);
  if (a.length !== b.length) {
    // Dimension mismatch (e.g. embedding model changed) — keep the heavier one.
    return countA >= countB ? bufA : bufB;
  }
  const total = countA + countB;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = (a[i] * countA + b[i] * countB) / total;
  }
  return Buffer.from(out.buffer);
}

function deleteVoicePrint(app, id, engine) {
  return withDb(app, engine, (db) => {
    const result = db.prepare("DELETE FROM voice_prints WHERE id = ?").run(id);
    return { changes: result.changes };
  });
}

module.exports = {
  listVoicePrints,
  renameVoicePrint,
  deleteVoicePrint,
};
