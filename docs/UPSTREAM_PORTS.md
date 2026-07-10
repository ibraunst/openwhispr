# Upstream Port Plan (v1.6.2 → v1.7.4)

Working plan for selectively porting upstream OpenWhispr changes into customWhispr.
Produced 2026-07-09 from the upstream CHANGELOG + verification against this codebase.
**Each session: read this file first, execute one tier, update the Status column, commit.**

## Session prompt pattern

> Read docs/UPSTREAM_PORTS.md. Execute Tier N per the port rules. Commit per theme.

## Setup facts (already done — do not redo)

- Upstream remote is configured and fetched with tags: `upstream` → `https://github.com/OpenWhispr/openwhispr.git`
- **Our fork point is exactly the `v1.6.2` tag** (`11ebd24d`). No local commits predate it.
- To find an upstream change by PR number: `git log v1.6.2..v1.7.4 --oneline --grep="#891"` then `git show <sha>`
- To see all upstream changes to one file: `git diff v1.6.2..v1.7.4 -- src/helpers/audioManager.js` (upstream paths may have moved — check `git log --follow`)
- Upstream renamed things after our fork: `screenRecording`→`systemAudio`, bundle ID → `com.gizmolabs.openwhispr`, Neon Auth → Better Auth. Diffs referencing those need adaptation, not adoption.

## Port rules

1. **Never blind cherry-pick.** Our meeting/diarization/notes code has diverged heavily (VoiceBank, karaoke TranscriptPlayer, per-paragraph reset, tuning sliders, export pipeline — all fork-only). Read the upstream diff, then apply the *idea* to our code by hand.
2. **Do-not-regress list is CLAUDE.md §6 + "Meeting Transcription Architecture" + "Speaker Diarization Architecture" sections.** Read them before touching `useMeetingTranscription.ts`, `PersonalNotesView.tsx`, `audioManager.js`, `meetingDetectionEngine.js`, or `ipcHandlers.js`.
3. Research may fan out to parallel subagents (extracting diffs, scouting our code). **Application is serial** — the hot files overlap across items.
4. After each theme: `npm run typecheck` (baseline: 12 pre-existing errors — see CLAUDE.md; do not add new ones), `node -c` on touched JS helpers, commit with a descriptive message.
5. **Install policy (user-authorized 2026-07-09):** build + install + restart without asking during this effort; user guarantees no meetings run during work sessions. Verify anyway with: `find ~/Library/Application\ Support/custom-whispr/meetings -type f -newermt "-5 minutes"` before killing the app. Direct writes to production DBs still require explicit per-change user confirmation (unchanged rule).
6. Install = `npm run pack && cp -R dist/mac-arm64/customWhispr.app /Applications/` (cp -R overwrite only, never rm -rf first — preserves TCC grants).
7. Recommended models: Sonnet-class for Tiers 1–2 (mechanical ports with diffs in hand); strongest available (Fable/Opus) for Tiers 3–4 (cross-cutting blast radius).

## Verified findings (2026-07-09, don't re-derive)

- `src/helpers/openaiRealtimeStreaming.js:82` still sends `OpenAI-Beta: realtime=v1` + `transcription_session.*` events. **OpenAI removed the Realtime Beta API 2026-05-12** → our cloud streaming (dictation + cloud meeting mode) is broken today. User runs local for everything, so impact is latent.
- `src/helpers/audioManager.js:997` still has `optimizeAudio` (upstream removed it as a dead call that crashed recordings >90s, #524). It's gated by `shouldOptimize` — verify whether the crash path is reachable before/instead of porting.
- Electron `^36.9.5`, better-sqlite3 `^11.10.0` — pre CoreAudio-tap. No `macos-audio-tap` binary in `resources/bin/`.
- System audio capture = `getDisplayMedia` loopback (requires Screen Recording permission, purple indicator).
- `.env` write serialization: **already fixed independently in our fork** — skip upstream #940.
- Model-server same-model startup join: already fixed in our fork.
- macOS is Darwin 25.x (macOS 26) — upstream's 1.7.1 `macos-media-remote` fix targets regressions on this OS; our binary may always report NOT_PLAYING. Low priority: user keeps pauseMediaOnDictation off.

---

## Tier 1 — Quick batch (one session, Sonnet-class OK)

| Status | Item | Upstream ref | Our files (likely) |
|--------|------|-------------|--------------------|
| [x] | `navigate-to-meeting-note` store-and-drain handshake — IPC fired after `did-finish-load` but before React listener mounts is silently lost on a fresh control panel. The notification window already uses the store-and-drain pattern; mirror it. | 1.7.1 "Meeting-detected Start Recording no longer races" | `meetingDetectionEngine.js`, `windowManager.js`, `ControlPanel.tsx` |
| [x] | Cleanup-prompt hardening: transform-don't-reply — `<transcript>` tag framing, trailing output anchor, temperature 0 for cleanup calls | 1.7.4 #1073 (prompt part only; skip agent-routing part — we have no wake-word agent routing) | `src/config/prompts.ts`, ReasoningService |
| [x] | Empty/zero-length recording doesn't crash transcription | 1.7.4 #891 | `audioManager.js` |
| [x] | Mic falls back to default device when pinned `deviceId` no longer resolves | 1.7.4 #978 | `audioManager.js`, `useAudioRecording` |
| [x] | Mic re-acquired when it goes silent after idle | 1.7.3 #922 | `audioManager.js` |
| [x] | Settings stops grabbing the mic for device labels — `enumerateDevices()` first, `getUserMedia` only if labels missing | 1.7.3 "Settings no longer grabs the microphone" | settings/mic-picker component |
| [x] | Local sidecars shut down cleanly on Quit + stale processes cleaned on next launch | 1.7.0 "Local helpers shut down cleanly" | `whisperServer.js`, `parakeetServer.js`, `llamaServer.js`, `main.js` |
| [x] | Investigate `optimizeAudio` >90s crash reachability; remove if dead | 1.6.7 #524 | `audioManager.js:997` |

Done 2026-07-09 (commits `b870cb5a`, `d1a59c57`, `ff05cb3c`, `31dbf83c`, `998005e6`). Notes:
- Cleanup-prompt hardening shipped English only — the other 9 locale cleanup prompts are independent hand-written prompts (not literal translations), each needs its own careful rewrite; left for a follow-up pass. `<transcript>` wrapping + temp-0 applies only to BYOK providers we own both ends of, not customwhispr cloud (server builds its own prompt server-side).
- `optimizeAudio` removal: confirmed reachable (BYOK cloud transcription, non-4o model, blob >1MB) — matched upstream's decision to remove rather than fix.
- Sidecar reaper covers whisper/parakeet/llama only — skipped qdrant/onnx (not in this fork) and diarization (per-request via execFile with its own timeout, not a persistent server).
- Typecheck baseline improved 12→10 as a side effect (added the missing `setSleepBlocker` type, exposed by Tier 2 work touching the same call site twice more).

Verify after: dictate short + long (>90s), open Settings while music plays (no interruption), quit app → `pgrep -f whisper-server` empty.

## Tier 2 — Realtime decision (same session as Tier 1 if quick)

| Status | Item | Notes |
|--------|------|-------|
| [x] | **Decision made 2026-07-09: retire, don't port.** Remove/disable the OpenAI Realtime cloud-streaming meeting path as a silent fallback; surface a clear error if it's ever selected. Local is the only supported meeting path. | If ever revisited: GA migration is 1.7.1 #805 (+ 24kHz upsample 1.7.4 #1044) |

Done 2026-07-09 (commit `2aa62d40`): `startTranscription`/`prepareTranscription` in `useMeetingTranscription.ts` short-circuit on `provider === "openai-realtime"` with a clear `setError()` message instead of attempting the dead IPC round-trip. `openaiRealtimeStreaming.js` itself (and its dictation-streaming callers, including `resetSession()`) was left untouched, per the caution below.

Caution: `resetSession()` at recording start (CLAUDE.md §6) lives in this file — if code is deleted rather than gated, keep AssemblyAI/Deepgram dictation streaming intact.

## Tier 3 — Echo gate / AEC, phase 1 (own session, strongest model)

| Status | Item | Upstream ref | Notes |
|--------|------|-------------|-------|
| [x] | Acoustic gate: prevent system audio leaking into mic channel during meetings, with speech-onset protection so the user's voice isn't clipped | 1.7.0 "Cleaner mic capture" + 1.6.8 echo-leak detector (note 1.6.10 fix: detector must run on the RAW mic buffer, pre-AEC) | Our mic channel feeds diarization's "who is Me" — leak = misattribution. Test with a real recording where both sides talk over each other. |
| [ ] | (Optional phase 2 — only if phase 1 insufficient) Native WebRTC AEC3 sidecar | 1.6.8 "Meeting AEC Helper" (prebuilt binaries on their CI) | New binary to bundle; bigger lift. |
| [x] | Bluetooth: detach meeting AudioContexts from output device; fix system-audio loopback silence with BT output | 1.6.6 "Meeting Bluetooth Audio" | Likely explains silent system-audio recordings when wearing AirPods. |
| [x] | Wire calendar attendee count into diarization `--num-speakers` (engine + IPC already accept it; nothing passes it) | our own item; upstream analog: speaker cap to attendee count (1.6.10/1.7.0) | `useMeetingTranscription.ts` — only when attendee count is reliable; never for unscheduled meetings. |

Done 2026-07-09 (commits `a7caf531`, `8494fa7d`, `cd5cd72e`). Notes:
- Acoustic gate = new `src/utils/echoLeakGate.ts` (port of upstream MeetingEchoLeakDetector's correlation core, plus a fine lag-refinement pass upstream lacks). It gates ONLY the mic split recording via a parallel gain branch — the mixed recording (transcript) and live tap stay raw, so a misfire can't lose transcript content. Detector taps the raw mic pre-gain. Text-level dedupe skipped (needs streaming transcripts; our local path has none). Prod evidence for the leak: every meeting's transcript.json has `is_me: false` — the mic-embedding "Me" match never fires today.
- Attendee count wired as `--max-speakers` (pyannote cap), NOT `--num-speakers` (exact count would force-split a real speaker when an attendee no-shows, and solo prep recordings on a meeting note would be forced into N clusters). Only passed when the meeting matched a calendar event with ≥2 attendees. Re-run speaker ID stays uncapped (escape hatch).
- Bluetooth: loopback constraints (EC/NS/AGC off + applyConstraints), hidden muted `<video>` sink to keep ScreenCaptureKit pumping, macOS `enable-features` loopback flags, `detachFromOutputDevice` (`setSinkId {type:"none"}`) on mix + live-tap contexts, iPhone/iPad treated as external mics. Skipped: 48 kHz downsample (cloud-only, retired), StrictMode deferred-cleanup rework.

Verify after: record a test meeting with system audio playing while speaking; diarization should not attribute system-audio speech to "Me". Check "Echo gate summary" in debug logs (mutedMs > 0 when recording speakerless) and that solo recordings still transcribe + diarize normally. With AirPods as output: system_record.wav should no longer be silent.

## Tier 4 — Whisper VAD + perf (can ride with Tier 1 or 3)

| Status | Item | Upstream ref |
|--------|------|-------------|
| [x] | Silero VAD end-to-end: bundle `ggml-silero-v5.1.2.bin` (~864KB, download script), pass `--vad` flags to whisper-server, restart keyed on VAD model path | 1.7.1 "Local Whisper: voice activity detection" + 1.7.4 #1000 (bundle in packaged builds) |
| [x] | whisper-server thread-count auto-tuning | 1.7.3 #994 |

Done 2026-07-09 (commits `acf3e5cb`, `cd56da7d`). Notes:
- No per-context toggles or tuning UI (upstream's 3 toggles + 6 sliders skipped) — VAD defaults ON; `WHISPER_VAD=off` in the .env is the kill switch, `WHISPER_THREADS=<n>` pins threads. Both keys persisted via `PERSISTED_KEYS`.
- **Binary crash found in testing**: our whisper-server (March build) dies when VAD filters out ALL audio (`--language auto` on 0ms input). Mitigated: the transcribe failure-retry restarts WITHOUT VAD, so silent recordings degrade to the legacy [BLANK_AUDIO] flow; next transcription's signature restart restores VAD. A future whisper-server binary refresh may fix the root cause — retest with `resources/bin/whisper-server-darwin-arm64 --vad ... < silent wav` before removing the mitigation.
- Timestamp safety verified live: VAD verbose_json segments stay mapped to the original timeline (18.5s last-end on an 18.6s file) — diarization merge unaffected.
- This machine: 14 cores → 10 threads (was fixed default 4).

Verify after: transcribe a long meeting recording; compare duration + quality vs. before. Check "whisper-server started successfully" log shows `vad: true, threads: 10`.

## Tier 5 — Electron 39+ / CoreAudio system-audio tap (OWN BRANCH, OWN SESSION, strongest model)

Highest reward (no Screen Recording permission, no purple indicator) and highest risk (NSPanel/focus/vibrancy behaviors are hand-tuned on Electron 36).

| Status | Step |
|--------|------|
| [x] | Zip current working /Applications build as rollback before starting |
| [x] | Branch. Electron 36→39+ (upstream went to 41 by 1.6.9; pick deliberately), better-sqlite3 11→12, rebuild natives. NOTE: better-sqlite3 ABI bump breaks the `ELECTRON_RUN_AS_NODE` maintenance scripts' expectations — they run against the app's own electron, so they keep working, but plain-node access stays broken. |
| [x] | Port `macos-audio-tap` Swift helper (upstream 1.6.6) into `resources/bin/` + build script |
| [x] | Swap `getDisplayMedia` loopback → native tap in `useMeetingTranscription` capture path (split recorders + live-transcript tap sit on top — retest diarization end-to-end) |
| [x] | `NSAudioCaptureUsageDescription` in Info.plist; permission flow `useScreenRecordingPermission` → system-audio consent (macOS 14.2+/15+ dialog, 1.6.3 + 1.6.6) |
| [x] | Regression pass: pill NSPanel no-focus-steal, vibrancy/glass, tray, hotkeys, dictation paste, meeting record→diarize→playback, notification overlay — programmatic checks done; live meeting E2E pending user (checklist below) |
| [ ] | User keeps old Screen Recording grant until confirmed stable; new System Audio grant prompted on first meeting capture |

Done 2026-07-09 (branch `tier5-electron-coreaudio-tap`, commits `67192f0b`, `870f8c97`, `c4925444`, `85855bf9`). Rollback zip: `~/Documents/Projects/customWhispr-rollback-pre-tier5-2026-07-09.zip`. Notes:
- **Electron ^41.2.0 (41.10.1) in one hop** — upstream's 39→41 bump (`397da999`) required zero source changes, so all migration risk was 36→39 anyway. better-sqlite3 pinned `12.11.1` (12.x mandatory for V8 compat on 39+; 12.9.0 = upstream's pin rejects Node 26 under our `engine-strict`). engines/.nvmrc → 24.
- **Key architectural difference from upstream**: upstream consumes tap PCM entirely in the main process (spool → diarization). Our fork's split recorders / echo gate / live tap / karaoke pipeline are renderer Web Audio, so `meeting-tap-chunk` IPC forwards the 100ms PCM chunks to the renderer where `systemAudio.ts` wraps them in a MediaStream (AudioWorklet jitter buffer, 2s cap drop-oldest). Every downstream consumer is untouched.
- **Loopback fallback kept** (upstream deleted it on macOS): tap unsupported/denied/failed → getDisplayMedia loopback (needs old Screen Recording grant). The three Mac `enable-features` loopback flags in main.js stay for that path.
- **Permission**: no OS query API exists — status learned from the tap binary's start/permission_denied stderr events, cached at `{userData}/.system-audio-permission`. `useSystemAudioPermission` (replaces `useScreenRecordingPermission`, same return shape) prefers tap status, degrades to screen-recording semantics only when tap unavailable. First probe run (Grant button or first meeting capture) triggers the macOS consent dialog. Locale keys renamed `screenRecording*` → `systemAudio*` with upstream's translations added to all 10 locales (i18n missing-count 603→540).
- **Tap binary verified live on macOS 26**: standalone run emits `start` JSON + exact-rate PCM (48KB/s), captured real system audio (46% nonzero, peak 8378 during afplay). Registered with sidecar registry + stale-pid reaper (`audiotap`).
- Dev-binary TCC grants (accessibility/calendar) reset when `node_modules/electron/dist` was replaced — re-grant per CLAUDE.md §macOS Accessibility on next `npm run dev` that needs them. Packaged app unaffected.
- **Verify on next real meeting (user)**: consent dialog appears once (customWhispr-attributed, our plist text) → no purple indicator during recording → split recorders + live transcript + diarization + playback all normal → "Native system audio tap stream started" in debug log → Echo gate summary still sane. If the tap misbehaves, revoking System Audio permission forces loopback fallback (old behavior).

## Tier 6 — Dual diarization engines: pyannote ⇄ sherpa-onnx A/B switch (OWN BRANCH, GATED ON TIER 5 MERGE)

Approved 2026-07-10. Full plan: `~/.claude/plans/ok-seems-reasonable-how-joyful-spindle.md`. Promotes the former "escape hatch" item below into an active tier: port upstream's ONNX diarization pipeline (Silero VAD + pyannote-segmentation-3.0 ONNX + CAM++ embeddings + agglomerative clustering, ~45MB, no Python/torch/HF token) and run it side-by-side with the existing pyannote/Python engine behind a UI switch, then keep the winner and delete the loser.

| Status | Step |
|--------|------|
| [x] | **Phase 0 (user gate, not code)**: multi-party meeting validates Tier 5 tap → merge `tier5-electron-coreaudio-tap` to main. Tier 6 branches from post-merge main — never from the unmerged tier5 branch (couples rollback stories; Electron 36/41 native ABI differs). **CLEARED 2026-07-10**: 58-min multi-party meeting validated tap + echo gate + diarization (7 speakers/1489 segs) end-to-end; merged to main (`d2b01936`). Note for is-me work: all 7 speakers `is_me:false` — with the tap, system audio contains only REMOTE voices (own voice never plays back), so a system-audio-sourced diarization may never contain a "me" cluster; Tier 6's JS is-me design must account for this (mic-channel comparison, not cluster-in-system matching). |
| [ ] | Phase 1: engine port, env-flag gated (`CUSTOMWHISPR_DIARIZATION=sherpa`), no UI. New `src/helpers/sherpaDiarization.js` on the sherpa-onnx runtime already bundled for Parakeet, consuming the same split WAVs. Bulk of work = JS reimplementation of what `speaker_engine.py` does beyond diarization: `merge_transcript` rules, mic-channel is-me via CAM++, read-only-bank re-runs. Separate VoiceBank (CAM++ ≠ pyannote embedding space, no migration) + separate threshold settings. Model download w/ checksums (mirror `download-whisper-vad-model.js`). Same 15-min timeout/kill discipline. |
| [ ] | Phase 2: `diarizationEngine` setting + Integrations UI ("Speaker identification" panel; HF token field pyannote-only); "Re-run speaker ID" honors engine (primary A/B lever); per-engine cached outputs (`transcript.pyannote.json` / `transcript.sherpa.json`, `transcript.json` canonical) so flipping is instant + non-destructive. |
| [ ] | Phase 3: evaluate on ≥2 real multi-party TAP-captured meetings (calibrate sherpa thresholds on tap audio only — pre-tap archives valid for contract tests, not tuning). Track crosstalk accuracy, is-me hit rate, runtime. |
| [ ] | Phase 4: pick default, delete the losing engine (no permanent dual-engine maintenance). Sherpa wins → Python subsystem + pythonResolver + HF token UI deletable. |

Port rule (same as Tier 5): upstream spools tap PCM → diarization in the main process — port their **engine**, never their meeting handlers; our input stays the saved split WAVs. Contract is frozen: both engines emit identical `transcript.json` (`segments` + `speakers[{label,voiceprint_id,is_new,is_me}]`); downstream (karaoke, VoiceBank, renames, export) never learns which engine ran.

## Deferred / rejected (decided 2026-07-09)

- **sherpa-onnx diarization**: ~~escape hatch only~~ — **promoted to Tier 6 (2026-07-10)**, see above.
- **Keychain-encrypted API keys** (1.7.0/1.7.1): real improvement, not urgent on a single personal machine.
- **Skip entirely:** cloud sync overhaul, Better Auth/SSO, new providers (Tinfoil/Corti/xAI/Azure), referral/MCP/billing, Windows/Linux fixes, TipTap migration, Qdrant semantic search, onboarding redesigns, Snippets (revisit on request), README/docs.
- **Auto-updater stays hard-disabled** — upstream feed + new bundle ID would replace this fork.
