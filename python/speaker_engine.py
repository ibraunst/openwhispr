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
        self, embedding: np.ndarray, threshold: float = VOICEBANK_MATCH_THRESHOLD
    ) -> Optional[VoicePrint]:
        best: Optional[VoicePrint] = None
        best_sim = -1.0
        for vp in self.get_all():
            sim = _cosine_similarity(embedding, vp.embedding)
            if sim > threshold and sim > best_sim:
                best_sim = sim
                best = vp
        if best is not None:
            logger.info("VoiceBank match: '%s' (sim=%.3f)", best.label, best_sim)
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
    ):
        self.hf_token = hf_token
        self.device = _select_device()
        self.similarity_threshold = similarity_threshold
        self.voicebank_threshold = voicebank_threshold
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
        self, system_audio: str | Path, num_speakers: Optional[int] = None
    ) -> list[DiarizedSegment]:
        """Run pyannote diarization on the system/meeting audio."""
        pipeline = self._get_diarization_pipeline()
        params = {}
        if num_speakers is not None:
            params["num_speakers"] = num_speakers

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
    ) -> list[DiarizedSegment]:
        """Resolve each pyannote speaker ID to 'Me', a known voice, or 'Guest N'."""
        speaker_embeddings: dict[str, list[np.ndarray]] = {}
        for seg in segments:
            emb = self._extract_segment_embedding(system_audio, seg.start, seg.end)
            if emb is not None:
                speaker_embeddings.setdefault(seg.speaker, []).append(emb)

        speaker_avg: dict[str, np.ndarray] = {
            spk: np.mean(embs, axis=0) for spk, embs in speaker_embeddings.items()
        }

        label_map: dict[str, str] = {}
        guest_counter = 0

        for spk, avg_emb in speaker_avg.items():
            sim = _cosine_similarity(avg_emb, mic_embedding)
            logger.info("Speaker %s ↔ mic: %.4f", spk, sim)

            if sim >= self.similarity_threshold:
                label_map[spk] = ME_LABEL
                continue

            match = self.voice_bank.find_match(avg_emb, threshold=self.voicebank_threshold)
            if match is not None:
                match.meeting_count += 1
                alpha = 1.0 / match.meeting_count
                match.embedding = (1 - alpha) * match.embedding + alpha * avg_emb
                self.voice_bank.upsert(match)
                label_map[spk] = match.label
            else:
                guest_counter += 1
                guest_label = f"Guest {guest_counter}"
                vp = VoicePrint(
                    id=str(uuid.uuid4()),
                    label=guest_label,
                    embedding=avg_emb,
                    meeting_count=1,
                )
                self.voice_bank.upsert(vp)
                label_map[spk] = guest_label

        for seg in segments:
            seg.resolved_label = label_map.get(seg.speaker, f"Unknown ({seg.speaker})")

        return segments

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

        segments = self.diarize(system_audio, num_speakers=num_speakers)
        if not segments:
            logger.warning("No speech segments detected in system audio")
            return json.loads(transcript_path.read_text(encoding="utf-8"))

        segments = self.identify_speakers(segments, system_audio, mic_embedding)
        transcript = self.merge_transcript(transcript_path, segments)

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
    parser.add_argument("--similarity", type=float, default=SIMILARITY_THRESHOLD)
    args = parser.parse_args()

    engine = SpeakerEngine(
        hf_token=args.hf_token,
        voice_db_path=args.voice_db,
        similarity_threshold=args.similarity,
    )
    try:
        result = engine.process(
            system_audio=args.system_audio,
            mic_audio=args.mic_audio,
            transcript_path=args.transcript,
            num_speakers=args.num_speakers,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
    finally:
        engine.close()


if __name__ == "__main__":
    main()
