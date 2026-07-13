"""
speaker_engine.py — Local speaker diarization & identification for customWhispr.

Pipeline:
  1. Diarize system_record (meeting audio) via pyannote.audio 3.1 (MPS/CPU)
  2. Extract a 512-d voice embedding from mic_record (user's mic) using pyannote/embedding
  3. Compare each diarized speaker against the mic fingerprint (cosine similarity)
  4. Label matches as "Me", resolve others via a persistent VoiceBank (SQLite)
  5. Merge speaker labels back onto the timestamped transcript.json

Accepts any audio format supported by torchaudio (WAV, WebM, OGG, MP3, etc.)

Requires a HuggingFace token with access to:
  - pyannote/speaker-diarization-3.1
  - pyannote/segmentation-3.0
  - pyannote/speaker-diarization-community-1
  - pyannote/embedding

Usage (CLI):
  python speaker_engine.py \\
    --system-audio system_record.webm \\
    --mic-audio mic_record.webm \\
    --transcript transcript.json \\
    --hf-token hf_...

Usage (from Node.js via IPC):
  engine = SpeakerEngine(hf_token=..., voice_db_path=~/.customwhispr/voicebank.db)
  result = engine.process(system_audio, mic_audio, transcript_path)
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torchaudio

# torchaudio 2.11+ removed list_audio_backends — pyannote's internal
# speechbrain/wespeaker loaders still call it. Patch before importing pyannote.
if not hasattr(torchaudio, "list_audio_backends"):
    torchaudio.list_audio_backends = lambda: ["soundfile"]

from pyannote.audio import Pipeline  # noqa: E402
from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding  # noqa: E402

logger = logging.getLogger("customwhispr.speaker_engine")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ME_LABEL = "Me"
SIMILARITY_THRESHOLD = 0.85
VOICEBANK_MATCH_THRESHOLD = 0.82
MIN_SEGMENT_DURATION = 0.5  # seconds — skip segments too short for reliable embedding

# Anonymous auto-assigned labels — carry no identity, so the attendee
# constraint never applies to them.
_GENERIC_LABEL_RE = re.compile(r"^guest \d+$", re.IGNORECASE)


def normalize_speaker_key(value: str) -> str:
    """Fold a display name or email into a comparable key: emails drop the
    domain, dots/underscores become spaces, case is ignored — so
    'paul.timmermann@toptal.com', 'Paul Timmermann' and 'paul_timmermann'
    all collapse to 'paul timmermann'."""
    v = (value or "").strip().lower()
    at = v.find("@")
    if at > 0:
        v = v[:at]
    return re.sub(r"[._\s]+", " ", v).strip()


# ---------------------------------------------------------------------------
# Device selection — prefer MPS on Apple Silicon, else CPU
# ---------------------------------------------------------------------------

def _select_device() -> torch.device:
    if torch.backends.mps.is_available():
        logger.info("Using MPS (Metal Performance Shaders) backend")
        return torch.device("mps")
    if torch.cuda.is_available():
        logger.info("Using CUDA backend")
        return torch.device("cuda")
    logger.info("Using CPU backend")
    return torch.device("cpu")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DiarizedSegment:
    speaker: str          # raw pyannote label, e.g. "SPEAKER_00"
    start: float          # seconds
    end: float
    resolved_label: str = ""


@dataclass
class VoicePrint:
    id: str
    label: str
    embedding: np.ndarray
    meeting_count: int = 1


# ---------------------------------------------------------------------------
# VoiceBank — persistent SQLite store
# ---------------------------------------------------------------------------

class VoiceBank:
    """Local-only SQLite store that remembers speakers across meetings."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS voice_prints (
                id            TEXT PRIMARY KEY,
                label         TEXT NOT NULL,
                embedding     BLOB NOT NULL,
                meeting_count INTEGER NOT NULL DEFAULT 1,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self._conn.commit()

    def get_all(self) -> list[VoicePrint]:
        rows = self._conn.execute(
            "SELECT id, label, embedding, meeting_count FROM voice_prints"
        ).fetchall()
        return [
            VoicePrint(
                id=r[0], label=r[1],
                embedding=np.frombuffer(r[2], dtype=np.float32).copy(),
                meeting_count=r[3],
            )
            for r in rows
        ]

    def find_match(
        self,
        embedding: np.ndarray,
        threshold: float = VOICEBANK_MATCH_THRESHOLD,
        allowed_keys: Optional[set] = None,
    ) -> Optional[VoicePrint]:
        """allowed_keys (set of normalize_speaker_key results, or None for no
        constraint): a NAMED voiceprint may only match when its owner is on
        the meeting's attendee list — a saved voice must never label someone
        who isn't even in the meeting. Anonymous 'Guest N' prints stay
        matchable everywhere (they carry no identity to misattribute)."""
        best: Optional[VoicePrint] = None
        best_sim = -1.0
        blocked: Optional[VoicePrint] = None
        blocked_sim = -1.0
        for vp in self.get_all():
            sim = _cosine_similarity(embedding, vp.embedding)
            if sim <= threshold:
                continue
            is_allowed = (
                allowed_keys is None
                or _GENERIC_LABEL_RE.match(vp.label) is not None
                or normalize_speaker_key(vp.label) in allowed_keys
            )
            if is_allowed:
                if sim > best_sim:
                    best_sim = sim
                    best = vp
            elif sim > blocked_sim:
                blocked_sim = sim
                blocked = vp
        if best is not None:
            logger.info("VoiceBank match: '%s' (sim=%.3f)", best.label, best_sim)
        if blocked is not None and blocked_sim > best_sim:
            logger.info(
                "VoiceBank match blocked (not an attendee): '%s' (sim=%.3f)",
                blocked.label, blocked_sim,
            )
        return best

    def upsert(self, vp: VoicePrint) -> None:
        self._conn.execute(
            """INSERT INTO voice_prints (id, label, embedding, meeting_count, updated_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(id) DO UPDATE SET
                 label = excluded.label,
                 embedding = excluded.embedding,
                 meeting_count = excluded.meeting_count,
                 updated_at = CURRENT_TIMESTAMP""",
            (vp.id, vp.label, vp.embedding.astype(np.float32).tobytes(), vp.meeting_count),
        )
        self._conn.commit()

    def next_guest_number(self) -> int:
        """Next available N for a 'Guest N' label, unique across all meetings."""
        rows = self._conn.execute(
            "SELECT label FROM voice_prints WHERE label LIKE 'Guest %'"
        ).fetchall()
        max_n = 0
        for (label,) in rows:
            try:
                max_n = max(max_n, int(label.split(" ", 1)[1]))
            except (IndexError, ValueError):
                continue
        return max_n + 1

    def rename(self, voice_id: str, new_label: str) -> bool:
        cur = self._conn.execute(
            "UPDATE voice_prints SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_label, voice_id),
        )
        self._conn.commit()
        return cur.rowcount > 0

    def delete(self, voice_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM voice_prints WHERE id = ?", (voice_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self._conn.close()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a_flat = a.flatten().astype(np.float64)
    b_flat = b.flatten().astype(np.float64)
    denom = np.linalg.norm(a_flat) * np.linalg.norm(b_flat)
    if denom < 1e-12:
        return 0.0
    return float(np.dot(a_flat, b_flat) / denom)


def _load_audio(path: str | Path, target_sr: int = 16000) -> torch.Tensor:
    """Load any audio format to mono float32 tensor at target sample rate."""
    waveform, sr = torchaudio.load(str(path))
    if sr != target_sr:
        waveform = torchaudio.functional.resample(waveform, sr, target_sr)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    return waveform


# ---------------------------------------------------------------------------
# SpeakerEngine
# ---------------------------------------------------------------------------

class SpeakerEngine:
    """Orchestrates diarization, voice identification, and transcript merging."""

    def __init__(
        self,
        hf_token: str,
        voice_db_path: str | Path = "~/.customwhispr/voicebank.db",
        similarity_threshold: float = SIMILARITY_THRESHOLD,
        voicebank_threshold: float = VOICEBANK_MATCH_THRESHOLD,
        update_bank: bool = True,
        allowed_speakers: Optional[list] = None,
    ):
        self.hf_token = hf_token
        self.device = _select_device()
        self.similarity_threshold = similarity_threshold
        self.voicebank_threshold = voicebank_threshold
        # Meeting attendees (names/emails). When present, named voiceprints
        # outside this list are excluded from bank matching.
        self.allowed_keys: Optional[set] = None
        if allowed_speakers:
            keys = {normalize_speaker_key(s) for s in allowed_speakers}
            keys.discard("")
            if keys:
                self.allowed_keys = keys
        # Re-runs (threshold tuning on an already-processed meeting) must not
        # write to the voicebank: every pass would inflate meeting counts,
        # drift stored embeddings, and enroll duplicate guest voiceprints.
        self.update_bank = update_bank
        self.voice_bank = VoiceBank(voice_db_path)

        self._diarization_pipeline: Optional[Pipeline] = None
        self._embedding_model: Optional[PretrainedSpeakerEmbedding] = None

    # -- model loading (lazy) ----------------------------------------------

    def _get_diarization_pipeline(self) -> Pipeline:
        if self._diarization_pipeline is None:
            logger.info("Loading pyannote/speaker-diarization-3.1 …")
            self._diarization_pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=self.hf_token,
            )
            try:
                self._diarization_pipeline.to(self.device)
                logger.info("Diarization pipeline on %s", self.device)
            except Exception as exc:
                logger.warning(
                    "Failed to move pipeline to %s (%s), falling back to CPU",
                    self.device, exc,
                )
                self._diarization_pipeline.to(torch.device("cpu"))
        return self._diarization_pipeline

    def _get_embedding_model(self) -> PretrainedSpeakerEmbedding:
        if self._embedding_model is None:
            logger.info("Loading pyannote/embedding …")
            self._embedding_model = PretrainedSpeakerEmbedding(
                "pyannote/embedding",
                token=self.hf_token,
            )
        return self._embedding_model

    # -- embedding extraction ----------------------------------------------

    def extract_embedding(self, audio_path: str | Path) -> np.ndarray:
        """Extract a 512-d speaker embedding from an audio file (any format)."""
        waveform = _load_audio(audio_path, target_sr=16000)
        model = self._get_embedding_model()
        # PretrainedSpeakerEmbedding expects (batch, channel, time)
        emb = model(waveform.unsqueeze(0))
        return np.array(emb).squeeze()

    def _extract_segment_embedding(
        self, audio_path: str | Path, start: float, end: float
    ) -> Optional[np.ndarray]:
        """Extract embedding from a time-slice of an audio file."""
        waveform = _load_audio(audio_path, target_sr=16000)
        sr = 16000
        start_sample = int(start * sr)
        end_sample = int(end * sr)
        segment = waveform[:, start_sample:end_sample]

        if segment.shape[1] < sr * MIN_SEGMENT_DURATION:
            return None

        model = self._get_embedding_model()
        emb = model(segment.unsqueeze(0))
        return np.array(emb).squeeze()

    # -- diarization -------------------------------------------------------

    def diarize(
        self,
        system_audio: str | Path,
        num_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[DiarizedSegment]:
        """Run pyannote diarization on the system/meeting audio.

        num_speakers forces an exact cluster count; max_speakers only caps it
        (safe when the expected count is an upper bound, e.g. calendar
        attendees — a no-show must not force-split a real speaker in two).
        """
        pipeline = self._get_diarization_pipeline()
        params = {}
        if num_speakers is not None:
            params["num_speakers"] = num_speakers
        elif max_speakers is not None:
            params["max_speakers"] = max_speakers

        logger.info("Running diarization on %s …", system_audio)
        # Load audio as waveform dict to avoid pyannote file-duration telemetry bug
        waveform = _load_audio(system_audio, target_sr=16000)
        audio_input = {"waveform": waveform, "sample_rate": 16000}
        result = pipeline(audio_input, **params)

        # pyannote 4.x returns DiarizeOutput; 3.x returns Annotation directly
        diarization = getattr(result, "speaker_diarization", result)

        segments: list[DiarizedSegment] = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append(DiarizedSegment(
                speaker=speaker,
                start=round(turn.start, 3),
                end=round(turn.end, 3),
            ))
        logger.info(
            "Diarization: %d segments, %d unique speakers",
            len(segments), len({s.speaker for s in segments}),
        )
        return segments

    # -- identification ----------------------------------------------------

    def identify_speakers(
        self,
        segments: list[DiarizedSegment],
        system_audio: str | Path,
        mic_embedding: np.ndarray,
    ) -> tuple[list[DiarizedSegment], list[dict]]:
        """Resolve each pyannote speaker ID to 'Me', a known voice, or 'Guest N'.

        Returns the labeled segments plus per-speaker metadata
        ({label, voiceprint_id, is_new, is_me}) so the app can offer renames.
        """
        speaker_embeddings: dict[str, list[np.ndarray]] = {}
        for seg in segments:
            emb = self._extract_segment_embedding(system_audio, seg.start, seg.end)
            if emb is not None:
                speaker_embeddings.setdefault(seg.speaker, []).append(emb)

        speaker_avg: dict[str, np.ndarray] = {
            spk: np.mean(embs, axis=0) for spk, embs in speaker_embeddings.items()
        }

        label_map: dict[str, str] = {}
        speaker_meta: dict[str, dict] = {}
        # Seed from the voicebank so guest numbers stay unique across meetings —
        # otherwise a new speaker in meeting 2 collides with meeting 1's "Guest 1".
        next_guest = self.voice_bank.next_guest_number()

        for spk, avg_emb in speaker_avg.items():
            sim = _cosine_similarity(avg_emb, mic_embedding)
            logger.info("Speaker %s ↔ mic: %.4f", spk, sim)

            if sim >= self.similarity_threshold:
                label_map[spk] = ME_LABEL
                speaker_meta.setdefault(ME_LABEL, {
                    "label": ME_LABEL, "voiceprint_id": None,
                    "is_new": False, "is_me": True,
                })
                continue

            match = self.voice_bank.find_match(
                avg_emb, threshold=self.voicebank_threshold, allowed_keys=self.allowed_keys
            )
            if match is not None:
                if self.update_bank:
                    match.meeting_count += 1
                    alpha = 1.0 / match.meeting_count
                    match.embedding = (1 - alpha) * match.embedding + alpha * avg_emb
                    self.voice_bank.upsert(match)
                label_map[spk] = match.label
                speaker_meta.setdefault(match.label, {
                    "label": match.label, "voiceprint_id": match.id,
                    "is_new": False, "is_me": False,
                })
            else:
                guest_label = f"Guest {next_guest}"
                next_guest += 1
                voiceprint_id = None
                if self.update_bank:
                    vp = VoicePrint(
                        id=str(uuid.uuid4()),
                        label=guest_label,
                        embedding=avg_emb,
                        meeting_count=1,
                    )
                    self.voice_bank.upsert(vp)
                    voiceprint_id = vp.id
                label_map[spk] = guest_label
                speaker_meta[guest_label] = {
                    "label": guest_label, "voiceprint_id": voiceprint_id,
                    "is_new": True, "is_me": False,
                }

        for seg in segments:
            seg.resolved_label = label_map.get(seg.speaker, f"Unknown ({seg.speaker})")

        return segments, list(speaker_meta.values())

    # -- transcript merging ------------------------------------------------

    @staticmethod
    def merge_transcript(
        transcript_path: str | Path,
        segments: list[DiarizedSegment],
    ) -> dict:
        """Merge speaker labels into transcript.json by matching timestamps.

        Expected transcript.json format:
        {
          "segments": [
            {"start": 0.0, "end": 2.5, "text": "Hello everyone"},
            ...
          ]
        }
        """
        transcript_path = Path(transcript_path)
        with open(transcript_path, "r", encoding="utf-8") as f:
            transcript = json.load(f)

        t_segments = transcript.get("segments", [])
        if not t_segments:
            logger.warning("Transcript has no 'segments' key or it is empty")
            return transcript

        for t_seg in t_segments:
            t_start = t_seg.get("start", 0.0)
            t_end = t_seg.get("end", t_start)
            t_mid = (t_start + t_end) / 2.0

            best_label = "Unknown"
            best_overlap = 0.0

            for d_seg in segments:
                overlap = max(0.0, min(t_end, d_seg.end) - max(t_start, d_seg.start))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_label = d_seg.resolved_label

            if best_overlap == 0.0:
                closest = min(
                    segments,
                    key=lambda s: abs((s.start + s.end) / 2 - t_mid),
                    default=None,
                )
                if closest is not None:
                    best_label = closest.resolved_label

            t_seg["speaker"] = best_label

        with open(transcript_path, "w", encoding="utf-8") as f:
            json.dump(transcript, f, indent=2, ensure_ascii=False)

        logger.info("Transcript merged: %d segments labeled", len(t_segments))
        return transcript

    # -- main orchestrator -------------------------------------------------

    def process(
        self,
        system_audio: str | Path,
        mic_audio: str | Path,
        transcript_path: str | Path,
        num_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> dict:
        """Full pipeline: diarize → identify → merge."""
        system_audio = Path(system_audio)
        mic_audio = Path(mic_audio)
        transcript_path = Path(transcript_path)

        for p, name in [
            (system_audio, "system_audio"),
            (mic_audio, "mic_audio"),
            (transcript_path, "transcript"),
        ]:
            if not p.exists():
                raise FileNotFoundError(f"{name} not found: {p}")

        logger.info("Extracting mic embedding from %s …", mic_audio)
        mic_embedding = self.extract_embedding(mic_audio)

        segments = self.diarize(system_audio, num_speakers=num_speakers, max_speakers=max_speakers)
        if not segments:
            logger.warning("No speech segments detected in system audio")
            return json.loads(transcript_path.read_text(encoding="utf-8"))

        segments, speaker_meta = self.identify_speakers(segments, system_audio, mic_embedding)
        transcript = self.merge_transcript(transcript_path, segments)

        # Attach per-speaker metadata (voiceprint IDs, new-guest flags) and
        # persist it so the app can offer renames after the fact.
        transcript["speakers"] = speaker_meta
        with open(transcript_path, "w", encoding="utf-8") as f:
            json.dump(transcript, f, indent=2, ensure_ascii=False)

        speaker_counts: dict[str, int] = {}
        for seg in segments:
            speaker_counts[seg.resolved_label] = speaker_counts.get(seg.resolved_label, 0) + 1
        logger.info("Speaker breakdown: %s", speaker_counts)

        return transcript

    def close(self) -> None:
        self.voice_bank.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="customWhispr speaker diarization engine")
    parser.add_argument("--system-audio", required=True, help="Meeting/system audio (any format)")
    parser.add_argument("--mic-audio", required=True, help="Local mic recording (any format)")
    parser.add_argument("--transcript", required=True, help="Path to transcript.json")
    parser.add_argument("--hf-token", required=True, help="HuggingFace token")
    parser.add_argument("--voice-db", default="~/.customwhispr/voicebank.db")
    parser.add_argument("--num-speakers", type=int, default=None)
    parser.add_argument(
        "--max-speakers",
        type=int,
        default=None,
        help="Upper bound on speaker clusters (ignored when --num-speakers is set)",
    )
    parser.add_argument("--similarity", type=float, default=SIMILARITY_THRESHOLD)
    parser.add_argument("--voicebank-threshold", type=float, default=VOICEBANK_MATCH_THRESHOLD)
    parser.add_argument(
        "--read-only-bank",
        action="store_true",
        help="Match against the voicebank but never write to it (re-runs/tuning)",
    )
    parser.add_argument(
        "--allowed-speakers",
        default=None,
        help="JSON array of attendee names/emails; named voiceprints outside this list are never matched",
    )
    args = parser.parse_args()

    allowed_speakers = None
    if args.allowed_speakers:
        try:
            parsed = json.loads(args.allowed_speakers)
            if isinstance(parsed, list):
                allowed_speakers = [str(s) for s in parsed]
        except (ValueError, TypeError) as exc:
            logger.warning("Unparseable --allowed-speakers, constraint skipped: %s", exc)

    engine = SpeakerEngine(
        hf_token=args.hf_token,
        voice_db_path=args.voice_db,
        similarity_threshold=args.similarity,
        voicebank_threshold=args.voicebank_threshold,
        update_bank=not args.read_only_bank,
        allowed_speakers=allowed_speakers,
    )
    try:
        result = engine.process(
            system_audio=args.system_audio,
            mic_audio=args.mic_audio,
            transcript_path=args.transcript,
            num_speakers=args.num_speakers,
            max_speakers=args.max_speakers,
        )
        # The full labeled transcript is written to --transcript; keep stdout
        # small — consumers read the file, and a huge stdout can overflow the
        # caller's buffer on long meetings.
        summary = {
            "ok": True,
            "segments": len(result.get("segments", [])),
            "speakers": result.get("speakers", []),
        }
        print(json.dumps(summary, ensure_ascii=False))
    finally:
        engine.close()


if __name__ == "__main__":
    main()
