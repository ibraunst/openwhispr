# customWhispr — AI Source of Truth

> **Version**: 1.6.2 | **Last scanned**: 2026-07-09

---

## 1. Current Architecture

### Tech Stack
- **Runtime**: Electron 36 (Node 20/22 LTS)
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 6
- **State**: Zustand 5 (4 stores)
- **Database**: better-sqlite3 (14 tables + FTS5 virtual table)
- **UI Kit**: shadcn/ui + Radix primitives + Lucide icons
- **Speech-to-Text**: whisper.cpp, NVIDIA Parakeet (sherpa-onnx), OpenAI/Groq/Mistral cloud, AssemblyAI/Deepgram/OpenAI Realtime streaming
- **AI Reasoning**: OpenAI, Anthropic, Google Gemini, Groq, local GGUF via llama.cpp
- **Audio**: FFmpeg (bundled via ffmpeg-static)
- **Auth**: Neon Auth (`@neondatabase/auth`)
- **Cloud**: Neon Postgres, Vercel Blob, customWhispr Cloud API
- **i18n**: react-i18next v15 (10 languages: en, es, fr, de, pt, it, ru, zh-CN, zh-TW, ja)
- **Speaker Diarization**: Python (pyannote.audio + mlx-whisper) in `python/`

### How Frontend / Backend / DB Interact
```
Renderer Process (React + Vite)
  ├─ Zustand stores (settings, notes, actions, transcriptions) <- localStorage
  └─ window.electronAPI.* (IPC bridge)
        │
        │ IPC (contextBridge / preload.js)
        ▼
Main Process (Electron)
  ├─ ipcHandlers.js (260 IPC channels: 253 handle + 7 on)
  ├─ database.js (SQLite via better-sqlite3)
  ├─ Helper modules (audio, whisper, streaming, calendar, meeting, clipboard, etc.)
  └─ Native Swift/C binaries (resources/bin/)
        │
        │ HTTPS / WebSocket
        ▼
External Services
  ├─ customWhispr Cloud (Neon Postgres, Vercel)
  ├─ OpenAI / Anthropic / Gemini / Groq / Mistral
  └─ AssemblyAI / Deepgram (WebSocket streaming)
```

### Multi-Window Architecture
| Window | Size | Traits |
|--------|------|--------|
| Main (dictation pill) | 96x96 idle, 340x96 recording | `focusable:false`, transparent, alwaysOnTop, NSPanel |
| Control Panel | 900x700, resizable | Frameless, hiddenInset titlebar (macOS) |
| Agent Overlay | 420x300, resizable | `focusable:true`, transparent, alwaysOnTop |
| Notification | 380x88 | `focusable:false`, transparent, alwaysOnTop |

---

## 2. File Map

### Main Process (root)
| File | Purpose |
|------|---------|
| `main.js` | App entry, initializes all managers |
| `preload.js` | Secure IPC bridge (contextBridge) — ~344 exposed APIs |

### Helpers (`src/helpers/`) — 49 modules
| Category | Files |
|----------|-------|
| **Audio** | `audioManager.js`, `audioStorage.js`, `audioActivityDetector.js`, `ffmpegUtils.js` |
| **Transcription (local)** | `whisper.js`, `whisperServer.js`, `whisperCudaManager.js`, `parakeet.js`, `parakeetServer.js`, `parakeetWsServer.js` |
| **Transcription (streaming)** | `assemblyAiStreaming.js`, `deepgramStreaming.js`, `openaiRealtimeStreaming.js` |
| **AI/LLM** | `llamaServer.js`, `llamaCppInstaller.js/.ts`, `llamaVulkanManager.js` |
| **Clipboard & Paste** | `clipboard.js`, `mediaPlayer.js` |
| **Window** | `windowManager.js`, `windowConfig.js`, `dragManager.js` |
| **Input** | `hotkeyManager.js`, `globeKeyManager.js`, `windowsKeyManager.js`, `gnomeShortcut.js`, `textEditMonitor.js` |
| **Calendar** | `googleCalendarManager.js`, `googleCalendarOAuth.js`, `appleCalendarManager.js` |
| **Meeting** | `meetingDetectionEngine.js`, `meetingProcessDetector.js`, `processListCache.js` |
| **Speaker ID** | `voicebank.js` (voiceprint store), `pythonResolver.js` (diarization interpreter) |
| **Database** | `database.js` |
| **IPC** | `ipcHandlers.js` (252 channels) |
| **System** | `environment.js`, `debugLogger.js`, `devServerManager.js`, `tray.js`, `menuManager.js`, `i18nMain.js`, `safeTempDir.js`, `downloadUtils.js`, `modelDirUtils.js`, `modelManagerBridge.js`, `ModelManager.ts`, `ensureYdotool.js` |

### Components (`src/components/`) — ~90 components
| Area | Key Components |
|------|---------------|
| **Core** | `ControlPanel.tsx`, `ControlPanelSidebar.tsx`, `SettingsPage.tsx`, `SettingsModal.tsx`, `OnboardingFlow.tsx` |
| **Transcription** | `HistoryView.tsx`, `TranscriptionModelPicker.tsx`, `LocalWhisperPicker.tsx`, `LocalModelPicker.tsx`, `ReasoningModelSelector.tsx` |
| **Notes** | `NotesView.tsx`, `NoteEditor.tsx`, `notes/PersonalNotesView.tsx`, `notes/UploadAudioView.tsx`, `notes/ActionManagerDialog.tsx`, `notes/ActionPicker.tsx`, `notes/DictationWidget.tsx`, `notes/LiveTranscriptPanel.tsx`, `notes/RealtimeTranscriptionBanner.tsx`, `notes/NoteListItem.tsx`, `notes/ActionProcessingOverlay.tsx`, `notes/NotesOnboarding.tsx`, `notes/SpeakerRenameDialog.tsx`, `notes/TranscriptPlayer.tsx` |
| **Agent** | `AgentOverlay.tsx`, `agent/AgentChat.tsx`, `agent/AgentInput.tsx`, `agent/AgentMessage.tsx`, `agent/AgentTitleBar.tsx` |
| **Calendar** | `CalendarView.tsx`, `IntegrationsView.tsx`, `UpcomingMeetings.tsx` |
| **Meeting** | `MeetingNotificationOverlay.tsx` |
| **Auth** | `AuthenticationStep.tsx`, `EmailVerificationStep.tsx`, `ForgotPasswordView.tsx`, `ResetPasswordView.tsx` |
| **Referral** | `ReferralDashboard.tsx`, `ReferralModal.tsx` |
| **Settings** | `settings/AgentModeSettings.tsx` |
| **Shared UI** | `ui/` (43 components) |
| **Window** | `TitleBar.tsx`, `WindowControls.tsx`, `CommandSearch.tsx` |

### Hooks (`src/hooks/`) — 25 hooks
`useActionProcessing`, `useAudioRecording`, `useAuth`, `useClipboard`, `useDebouncedCallback`, `useDialogs`, `useFolderManagement`, `useHotkey`, `useHotkeyRegistration`, `useLocalModels`, `useLocalStorage`, `useMeetingTranscription`, `useModelDownload`, `useNoteDragAndDrop`, `useNoteRecording`, `useNotesOnboarding`, `usePermissions`, `useScreenRecordingPermission`, `useSettings`, `useTheme`, `useUpcomingEvents`, `useUpdater`, `useUsage`, `useWhisper`, `useWindowDrag`

### Stores (`src/stores/`) — 4 stores
| Store | Purpose |
|-------|---------|
| `settingsStore.ts` | All app settings, persisted to localStorage, synced across windows |
| `noteStore.ts` | Notes CRUD state |
| `actionStore.ts` | AI processing action templates |
| `transcriptionStore.ts` | Transcription history |

### Services (`src/services/`)
`ReasoningService.ts`, `BaseReasoningService.ts`, `LocalReasoningService.ts`, `NotesService.ts`, `localReasoningBridge.js`

### Python (`python/`)
Speaker diarization engine:
- `speaker_engine.py` — pyannote.audio pipeline: diarize → extract user embedding → label speakers → output timestamped transcript
- `requirements.txt` — torch, torchaudio, pyannote.audio, soundfile, mlx-whisper (Apple Silicon)
- Requires HuggingFace token, used by `meeting-run-diarization` IPC

### Native Binaries (`resources/`)
| Platform | Binaries |
|----------|----------|
| **macOS (Swift)** | `macos-globe-listener`, `macos-mic-listener`, `macos-fast-paste`, `macos-text-monitor`, `macos-media-remote`, `calendar-sync` |
| **Windows (C)** | `windows-key-listener`, `windows-mic-listener`, `windows-fast-paste`, `windows-text-monitor` |
| **Linux (C)** | `linux-fast-paste`, `linux-text-monitor` |

---

## 3. The 'Truth' List — Functional Features

### Core Dictation
- [x] Local transcription via whisper.cpp (tiny/base/small/medium/large/turbo models)
- [x] Local transcription via NVIDIA Parakeet (sherpa-onnx)
- [x] Cloud transcription via OpenAI, Groq, Mistral
- [x] Streaming transcription via AssemblyAI, Deepgram, OpenAI Realtime
- [x] Tap-to-talk and Push-to-talk activation modes
- [x] Globe/Fn key hotkey (macOS), configurable hotkeys (all platforms)
- [x] AI text correction via OpenAI, Anthropic, Gemini, Groq, local GGUF
- [x] Native clipboard paste (macOS: CGEvent, Windows: SendInput, Linux: XTest/ydotool/wtype)
- [x] Custom dictionary for improved recognition
- [x] Per-app dictation profiles (custom prompts, correction toggle per bundle ID)
- [x] Language support: 58 transcription languages, 10 UI languages
- [x] Fallback: local↔cloud bidirectional fallback on failure
- [x] Media pause/resume during dictation (MediaRemote private framework, with `--is-playing` guard to prevent false starts)
- [x] Auto-learn corrections from text edits

### Notes System
- [x] Personal notes with folders
- [x] Meeting notes (linked to calendar events)
- [x] Audio file upload + transcription
- [x] AI actions (reusable processing templates) — built-in + custom
- [x] Rich text editing
- [x] Note search (full-text via SQLite FTS5)
- [x] Export (txt/md) — filename is `{title} | MM-DD-YY.{ext}`, always includes Attendees line
- [x] Cloud sync (cloud_id)

### Agent Mode
- [x] Separate hotkey-triggered conversational AI
- [x] Floating overlay window with chat UI
- [x] Conversation persistence (SQLite)
- [x] Cloud streaming via customWhispr Cloud
- [x] Recording lock (prevents simultaneous dictation + agent)

### Calendar & Meetings
- [x] Google Calendar OAuth (multi-account)
- [x] Apple Calendar integration (macOS native)
- [x] Calendar event sync with exponential backoff
- [x] Meeting detection: process-based (Zoom, Teams, Webex, FaceTime)
- [x] Meeting detection: microphone-based (unscheduled/browser meetings)
- [x] Meeting transcription via `useMeetingTranscription` hook (system audio + mic mix)
  - Local path: MediaRecorder → `meeting-transcribe-local` IPC → whisper/parakeet
  - Cloud path: WebSocket streaming → OpenAI Realtime
- [x] Manual meeting recording: "Record meetings" label in CalendarView becomes a clickable blue mic button when toggle is on
- [x] Manual meeting-recording fallback from Notes (when detection misses a meeting)
  - New notes created in the Meetings folder get `note_type: "meeting"`
  - The record button on ANY meeting-type note runs the full meeting pipeline (system audio + mic, live transcript, diarization) — not plain dictation; personal notes keep dictation
  - Start checks the calendar (`get-imminent-calendar-event`, includes currently-running events) → auto-titles the note + captures attendees, but never clobbers a non-default title
  - Picking a meeting back up: `baseTranscriptRef` (in `useMeetingTranscription`) holds the note's existing transcript at manual start; the new session's raw AND diarized transcripts are appended after it (`withBase`) instead of overwriting — an interrupted meeting's first half survives
- [x] Meeting re-detection resumes the existing note (no duplicates): `handleNotificationResponse` looks up `getNoteByCalendarEventId` for real calendar events (never synthetic `__detected__` ones) and navigates to that note instead of creating a new one; its current transcript rides in the `navigate-to-meeting-note` payload as `existingTranscript` → renderer seeds `baseTranscriptRef` so the new session appends. `getNoteByCalendarEventId` prefers transcript-bearing notes when duplicates exist.
- [x] Transcript tab visibility is per-note: `NoteEditor.hasMeetingTranscript` gates on `isMeetingRecordingThisNote` (`isMeetingNoteActive && isMeetingRecording`), NOT the global `isMeetingRecording` — a live recording on one note must not blank out every other note's transcript view. The global flag still drives the DictationWidget (prevents starting a second recording).
- [x] Speaker names display as formatted names (`formatSpeakerName` in `src/utils/speakerNameFormatter.ts`): emails → username before `@`; dots split into title-cased First Last ("chris.jang@toptal.com" → "Chris Jang"); non-emails pass through. Applied in TranscriptPlayer labels + NoteEditor chips + dropdown suggestions; the underlying stored labels stay raw (renames still operate on the real label)
- [x] Persistent recording indicator on the floating pill while a meeting records (Granola-style capsule: red dot + pulsing bars; survives auto-hide; click opens control panel)
- [x] Meeting recording survives sidebar navigation (PersonalNotesView stays mounted while recording/processing/diarizing)
- [x] Calendar refresh button performs a real Google+Apple provider sync (not just a local-cache re-read)
- [x] Meeting auto-stop on process close or sustained silence (5s "Keep Recording" grace toast)
- [x] Live transcript preview during local meeting recordings (`LiveTranscriptPanel`) — 16kHz tap on mixed stream, 4-10s silence-boundary chunks through Parakeet, cleared at stop so the final pass isn't polluted
- [x] Pause/resume for local meeting recordings — `MediaRecorder.pause()`/`resume()` on both split recorders (no gap in the blob, timestamps stay aligned for diarization); live-transcript tap is suspended while paused. Cloud/streaming meetings cannot pause (timestamps would drift out of sync with diarization audio)
- [x] Speaker diarization (Python + pyannote.audio, requires HuggingFace token set in Integrations)
  - Runs automatically after every meeting recording
  - System + mic audio recorded separately (split recorders) for diarization input
  - WebM → WAV conversion via ffmpeg before passing to Python (torchaudio can't read WebM)
  - Silent system audio (solo recording) → falls back to mic audio as primary diarization source
  - Labels speakers as "Me" / "Guest 1" / "Guest 2" etc. in `**Speaker:** text` markdown format
  - Result persisted to `notes.transcript` column via `updateNote` IPC
  - NoteEditor auto-switches to Transcript tab when diarization completes
  - Exported .md file re-written with speaker labels when diarization finishes
- [x] Speaker voice learning (VoiceBank)
  - Persistent voiceprints in `{userData}/voicebank.db` — speakers recognized across meetings
  - Guest numbering is globally unique (seeded from voicebank, never resets per meeting)
  - Speaker chips in Transcript tab are dropdowns: one-click assignment from the meeting's calendar attendees (own accounts excluded, already-assigned names filtered) + "Custom name…" free-text dialog; rename updates voiceprint + rewrites note transcript
  - Auto-naming: 1 new guest + 1 non-user calendar attendee → guest auto-renamed to attendee
  - Known voices managed (rename/forget) in Integrations view under HuggingFace panel
  - Renaming to an existing name merges the two voiceprints (weighted embedding average)
- [x] Meeting audio playback with karaoke transcript (`TranscriptPlayer.tsx`)
  - Notes link to their recording via `notes.meeting_id` (set after split audio saves)
  - `meeting-get-playback` IPC lazily mixes system+mic webm → `playback.m4a` (ffmpeg amix, cached in meeting folder) and returns timestamped segments from transcript.json
  - Transcript tab shows a sticky player bar (play/pause, seek slider, time); words color along with playback (per-word linear interpolation inside whisper segments); click any word to seek; active segment auto-scrolls
  - `transcript.json` is the label source for the karaoke view — speaker renames (manual + auto-name) are synced to it (`meeting-update-speaker-label` IPC / re-save after `autoNameLoneGuest`)
  - Fallback when audio/segments missing: static scrollable transcript render (the old disabled-`MarkdownTextarea` view couldn't scroll long transcripts at all — its textarea was the only scrollable element and had `pointer-events-none`)
- [x] Calendar-aware notifications

### Infrastructure
- [ ] Auto-update — HARD-DISABLED (`FEED_SHIPS_THIS_APP = false` in `src/updater.js`; feed points at upstream OpenWhispr and would replace this fork — see §6)
- [x] Authentication (Neon Auth)
- [x] BYOK + customWhispr Cloud modes (transcription, reasoning, agent)
- [x] Referral system
- [x] Usage tracking + billing
- [x] Audio storage with configurable retention
- [x] Debug logging system
- [x] GPU acceleration: CUDA (whisper), Vulkan (llama.cpp)
- [x] System tray
- [x] Cross-platform: macOS, Windows, Linux

---

## 4. Active Constraints & Coding Standards

### Language & Framework
- **TypeScript** for all new React components, hooks, stores, services
- **JavaScript** acceptable for main process helpers (existing pattern)
- **Swift** for macOS native binaries, **C** for Windows/Linux native binaries
- **Tailwind CSS v4** for all styling — no inline styles, no CSS modules
- **shadcn/ui** patterns for UI components (`src/components/ui/`)
- **Zustand** for state — no raw localStorage in components, use stores

### Internationalization (REQUIRED)
- Every user-facing string must use `t("key.path")` via `useTranslation()`
- Keys in all 10 locale files (`src/locales/{lang}/translation.json`)
- Do NOT translate: brand names, technical terms, format names, AI system prompts

### Architecture Rules
- All renderer-to-main communication through `preload.js` bridge
- New IPC channels: add to both `ipcHandlers.js` AND `preload.js`
- New settings: add to `settingsStore.ts` (state + setter + localStorage persistence)
- New database tables: CREATE TABLE in `database.js` init + IPC handlers
- Context isolation enabled on all windows; `sandbox: true` where possible
- API keys: localStorage + `.env` file, synced on startup

### Meeting Transcription Architecture (critical — do not regress)
- Auto-detected meetings: `meetingDetectionEngine.handleNotificationResponse` calls `setUserRecording(true)` and navigates the control panel. It does **NOT** call `sendStartDictation()`.
- The control panel's `useMeetingTranscription` hook (in `PersonalNotesView`) owns all meeting recording, triggered by the `meetingRecordingRequest` prop.
- `useMeetingTranscription` signals recording state to the main process via `meetingSetUserRecording` IPC.
- The pill's `useAudioRecording` (dictation) must **not** run simultaneously with meeting transcription — doing so causes whisper-server conflicts.
- `onMeetingAutoStopExecute` is handled by both `useAudioRecording` (shows toast only) and `useMeetingTranscription` (actual stop + transcription).
- **Pause/resume (local only)**: `pauseTranscription`/`resumeTranscription` in `useMeetingTranscription` call `MediaRecorder.pause()`/`.resume()` on both split recorders and suspend/resume the live-transcript tap's `AudioContext` — keeps one continuous blob (no gap) so post-stop diarization timestamps stay aligned. `isPaused`/`canPause` reset at recording start/stop. Not offered for cloud/streaming meetings.
- **Whisper timeout scales with audio length**: `whisperServer.js` computes `requestTimeoutMs = Math.max(300000, Math.ceil(audioSeconds * 2000))` before the `/inference` call — a flat 5-minute cap killed transcription on meetings past ~25-30 minutes (medium model runs slower than 2x realtime at the margin).
- **Queued meeting-detected notifications are dropped, not flushed, at recording stop**: `meetingDetectionEngine.setUserRecording(false)` clears `_notificationQueue` for audio-sourced detections instead of flushing them after the cooldown — otherwise a detection that fired mid-meeting surfaces as a stale "Meeting Detected" popup right after hangup.
- **Meeting notification (join/start-recording) auto-dismiss is 15s** (`windowManager.js` timer + `MeetingNotificationOverlay.tsx` countdown animation) — was 60s, too slow for a decision that's usually made in a few seconds; briefly cut to 5s, restored to 15s (5s was too easy to miss).

### Speaker Diarization Architecture (critical — do not regress)
- `useMeetingTranscription` runs two parallel `MediaRecorder` instances: one on the system audio stream, one on the mic stream (split recorders).
- After stop, both blobs are saved via `meetingSaveSplitAudio` IPC → `{userData}/meetings/{meetingId}/system_record.webm` and `mic_record.webm`.
- Diarization runs automatically in an async IIFE inside `stopTranscription` — it does NOT block the UI.
- `diarizationNoteIdRef` lives **inside the hook** (not the component) so it survives component unmount. The hook calls `updateNote` IPC directly when diarization finishes.
- Component's `useEffect` on `diarizedTranscript` calls `initializeNotes()` to refresh the store from DB.
- `PersonalNotesView` tracks `lastExportRef` — when diarization completes it overwrites the exported file with speaker-labeled transcript.
- Auto-generate notes after meeting is skipped when `useReasoningModel` is `false`; export still runs immediately in that case.
- HuggingFace token stored as `hfToken` in `settingsStore`, configurable in Integrations view.
- **Python resolution**: diarization NEVER spawns bare `python3` — packaged GUI apps get a minimal PATH that resolves to Apple's torch-less interpreter. `src/helpers/pythonResolver.js` probes login-shell `python3` + known install paths, validates torch/torchaudio/pyannote via `find_spec`, and caches the winner. `CUSTOMWHISPR_PYTHON` env var overrides.
- **Result transport**: Node reads the diarization result from `transcript.json` (the engine rewrites it with the `speakers` array), NOT from stdout — stray library prints to stdout must never break the pipeline. The engine prints only a compact summary. `execFile` has a 15-min timeout (`killSignal: SIGKILL`) so a hung run can't strand the renderer in "diarizing".
- **Silence check**: the system-audio silence fallback uses `sampleWavRMS` in `ffmpegUtils.js` (async positioned reads, ~200 sampled windows, int16-normalized) — never full-file sync reads (blocks the main process) and never byte-wise RMS on a raw Buffer (mathematically wrong; only detects bit-exact silence).
- **VoiceBank**: `python/speaker_engine.py` persists per-speaker embeddings to `{userData}/voicebank.db` and matches new meetings against them. Node reads the same SQLite file via `src/helpers/voicebank.js` (short-lived connections only — never hold a lock while Python writes). IPC: `voicebank-list` / `voicebank-rename` / `voicebank-delete`.
- Engine output (`transcript.json` + stdout) includes a `speakers` array (`{label, voiceprint_id, is_new, is_me}`) so the app can map labels → voiceprints.
- `diarizationAttendeesRef` lives inside `useMeetingTranscription` (like `diarizationNoteIdRef`) and feeds `autoNameLoneGuest`: exactly 1 new guest + exactly 1 non-user attendee → voiceprint renamed + segments relabeled before formatting. Any ambiguity skips auto-naming.
- Speaker rename flow: `PersonalNotesView.handleRenameSpeaker` renames the voiceprint by label, rewrites `**Old:**` → `**New:**` in the note transcript, and syncs the hook state via `overrideDiarizedTranscript`.

### Build & Quality
- Node 20/22 LTS (pinned in `.nvmrc`)
- `npm run typecheck` — TypeScript checking
- `npm run lint` — ESLint
- `npm run quality-check` — format + typecheck
- `npm run i18n:check` — translation coverage
- `npm run pack` — unsigned local build (dev install: copy to /Applications)
- Native binaries compile automatically via `predev` hook

### Code Quality
- Production-ready only — no placeholder TODOs
- Handle loading, error, and empty states
- Surface errors to user or log explicitly
- Clean up resources (files, listeners, processes)
- Descriptive error messages

---

## 5. State Schema

### Zustand Settings Store (`settingsStore.ts`)
```typescript
// SettingsState extends these interfaces from src/hooks/useSettings.ts:

interface TranscriptionSettings {
  uiLanguage: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: "whisper" | "nvidia";
  parakeetModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;               // ISO code or "auto"
  cloudTranscriptionProvider: string;      // "openai" | "groq" | "mistral"
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;          // "byok" | "customwhispr"
  customDictionary: string[];
  assemblyAiStreaming: boolean;
}

interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;               // "openai" | "anthropic" | "gemini" | "groq" | "local"
  cloudReasoningBaseUrl?: string;
  cloudReasoningMode: string;
}

interface HotkeySettings {
  dictationKey: string;
  activationMode: "tap" | "push";
}

interface MicrophoneSettings {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
}

interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  mistralApiKey: string;
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;
}

interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;
}

interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

interface AgentModeSettings {
  agentModel: string;
  agentProvider: string;
  agentKey: string;
  agentSystemPrompt: string;
  agentEnabled: boolean;
  cloudAgentMode: string;
}

// Direct fields on SettingsState:
interface SettingsState extends /* above interfaces */ {
  isSignedIn: boolean;
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  gcalAccounts: GoogleCalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  meetingAudioDetection: boolean;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  keepTranscriptionInClipboard: boolean;
  appProfiles: Record<string, AppProfile>;
  activeAppBundleId: string | null;
  exportDirectory: string;
  defaultExportFormat: "txt" | "md";
}

interface AppProfile {
  name: string;
  correctionEnabled: boolean | null;  // null = global default
  customPrompt: string | null;        // null = global default
}
```

### Database Tables (SQLite) — 14 tables
| Table | Key Columns |
|-------|-------------|
| `transcriptions` | id, text, raw_text, timestamp, created_at, has_audio, audio_duration_ms, provider, model, status, error_message |
| `custom_dictionary` | id, word (UNIQUE), created_at |
| `notes` | id, title, content, note_type, source_file, audio_duration_seconds, created_at, updated_at, enhanced_content, enhancement_prompt, enhanced_at_content_hash, cloud_id, folder_id, transcript, calendar_event_id, export_path, export_header, meeting_id |
| `notes_fts` | (virtual FTS5) title, content, enhanced_content — auto-synced via triggers |
| `folders` | id, name (UNIQUE), is_default, sort_order, created_at |
| `actions` | id, name, description, prompt, icon, is_builtin, sort_order, created_at, updated_at, translation_key |
| `agent_conversations` | id, title, created_at, updated_at |
| `agent_messages` | id, conversation_id (FK), role, content, created_at |
| `google_calendar_tokens` | id, google_email (UNIQUE), access_token, refresh_token, expires_at, scope, created_at, updated_at |
| `google_calendars` | id, summary, description, background_color, is_selected, sync_token, account_email, created_at |
| `apple_calendars` | id, title, color, is_selected, created_at |
| `calendar_events` | id, calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at |
| `settings` | key (PK), value |

---

## 6. Key Architectural Decisions & Known Fixes

### Focus stealing fix (resolved)
- **Cause**: "Pause media on dictation" → AppleScript sends media key → briefly activates foreground app
- **Fix**: Added `--is-playing` check in `macos-media-remote.swift` via MediaRemote private framework
- Overlay: NSPanel, `focusable:false`, `type:"panel"`, `showInactive()` → no focus steal

### AXEnhancedUserInterface side effect (mitigated)
- `textEditMonitor._enableAccessibility()` sets AXEnhancedUserInterface=true on target Electron apps
- This puts them in screen-reader mode until app restarts
- **Fix**: `_resetAccessibility()` called in both `stopMonitoring()` and `captureTargetPid()`

### Meeting transcription double-recording bug (fixed)
- **Cause**: `meetingDetectionEngine.handleNotificationResponse` called both `navigate-to-meeting-note` (triggering `useMeetingTranscription`) AND `sendStartDictation()` (starting a conflicting pill dictation). When the meeting ended, the pill's audioManager tried to transcribe a long audio blob → whisper-server died during startup.
- **Fix**: Removed `sendStartDictation()` from `handleNotificationResponse`. Added `meetingSetUserRecording` IPC so `useMeetingTranscription` signals recording state to the detection engine directly.

### Speaker diarization result not persisting to UI (fixed)
- **Cause**: `diarizationNoteIdRef` was a local ref in `PersonalNotesView`. Diarization takes 30+ seconds; if the component unmounted before completion, the ref was null and `updateNote` was never called.
- **Fix**: Moved `diarizationNoteIdRef` into `useMeetingTranscription` hook. Hook calls `updateNote` IPC directly (awaited) then `setDiarizedTranscript`. Component effect calls `initializeNotes()` to refresh store.

### Diarization infinite re-render loop (fixed)
- **Cause**: `useEffect` in `PersonalNotesView` watched `[meetingDiarizedTranscript, notes, toast]` and called `updateNoteInStore` inside, which mutated `notes`, re-triggering the effect.
- **Fix**: Removed `notes` from dependency array; effect now just calls `initializeNotes()` to re-fetch from DB.

### WebM diarization producing 0 segments (fixed)
- **Cause**: `MediaRecorder` produces WebM/Opus without duration headers; `torchaudio` cannot read it.
- **Fix**: `ipcHandlers.js` converts both split audio files to WAV via `convertToWav` (ffmpeg) before passing to Python.

### Silent system audio producing 0 segments (fixed)
- **Cause**: System audio stream captures display audio only — empty during solo/mic-only recordings.
- **Fix**: RMS check on system WAV; if `rms < 0.001`, use mic WAV as primary diarization source instead.

### Exported transcript file missing speaker labels (fixed)
- **Cause**: File export ran at AI-completion time, before diarization finished. Also didn't run when AI was disabled.
- **Fix**: `PersonalNotesView` stores export metadata in `lastExportRef`; when diarization completes it overwrites the file. Export now also triggers on AI error state and when `useReasoningModel` is off.

### Full-app bug-scan fixes (2026-07-07) — do not regress
- **Note saves flush, never cancel**: `PersonalNotesView` keeps pending save payloads in `pendingSaveRef`/`pendingEnhancedSaveRef` and flushes them when switching notes or unmounting. Clearing the debounce timer on note switch loses edits permanently.
- **Meeting auto-stop grace period**: `meetingDetectionEngine._handleMeetingEndSignal` broadcasts `meeting-auto-stop-suggested` and arms a 5s `_autoStopTimer` (`AUTO_STOP_GRACE_MS`) before `meeting-auto-stop-execute`; `cancelAutoStop` clears it. Never execute immediately — the renderer's "Meeting Ended" toast depends on the delay (countdown text derives from `autoStopInMs`, not a hardcoded number).
- **Batch stop deferral**: `audioManager.stopRecording()` sets `_stopRequestedDuringBatchStart` when setup is in flight (mic acquisition), applied after `mediaRecorder.start()`. Without it a quick push-to-talk release leaves recording stuck on.
- **FTS search quoting**: `database.searchNotes` wraps every token in FTS5 string-literal quotes (unicode-preserving, operator-neutralizing). The old `\w`-only sanitizer broke all non-Latin search; bare AND/OR/NOT crash FTS5.
- **Apple calendar sync**: `_parseEvents` THROWS on binary failure/malformed output (returning `[]` wipes all stored future events via `clearFutureEventsByCalendarId`). That query must compare `datetime(start_time)`, not the raw ISO string (lexical compare classifies all of today as "future").
- **Updater is hard-disabled** (`FEED_SHIPS_THIS_APP = false` in `src/updater.js`): the GitHub feed points at upstream OpenWhispr; installing an upstream release would replace this fork. Flip only after repointing the feed.
- **Audio retention**: renderer pushes `audioRetentionDays` to main via `set-audio-retention-days` (stored in SQLite settings); `_setupAudioCleanup` reads it per run. It was previously hard-coded to 30 days.
- **BYOK agent streaming**: anthropic/gemini route to their OpenAI-compatible endpoints; the provider switch must never fall through to another provider's host (key exfiltration).
- **DB timestamps are UTC**: always parse via `normalizeDbDate` (appends "Z" only when no timezone marker present) — `new Date("YYYY-MM-DD HH:MM:SS")` parses as local time.
- **Meeting context is captured at stop**: `stopTranscription` copies `diarizationNoteIdRef`/`diarizationAttendeesRef`/`meetingIdRef` into locals and clears the refs before the async diarization IIFE. Reading the shared refs inside the IIFE writes meeting A's transcript into meeting B's note when meetings run back-to-back.
- **Diarized state resets at start**: `startTranscription` clears `diarizedTranscript`/`diarizationError` — otherwise meeting B's note displays meeting A's speakers until B finishes.
- **Transcript props are note-gated**: `PersonalNotesView` tracks `meetingNoteId` (state) and only passes the hook's transcripts to NoteEditor/ActionPicker/rename when `activeNoteId === meetingNoteId`. Ungated, the meeting transcript renders on every note and a speaker rename copies it into the wrong note's DB row.
- **The hook persists raw transcripts** (both local and cloud paths) via `updateNote` with the captured note id — the component's transition effect misses the local path entirely (transcript state arrives after the recording flag flips).
- **Unmount runs `stopTranscription`, never bare `cleanup()`**: bare cleanup destroys the recording silently and leaves `setSleepBlocker(true)` + `meetingSetUserRecording(true)` stuck on forever.
- **Warm cloud connections call `resetSession()` at recording start** (`openaiRealtimeStreaming.js`): segment timestamps are measured from `recordingStartTime`, which connect() sets at pre-warm time — without the reset every segment is offset by the idle gap and diarization mislabels speakers.
- **Diarization-complete effect fires on empty→set transition only** (`prevDiarizedRef`) — manual speaker renames update the same state and must not re-toast/re-export; `initializeNotes` there must pass `activeFolderId` or the sidebar resets to all folders.
- **Local meeting transcripts carry per-segment timestamps**: `meeting-transcribe-local` requests `withSegments: true` → whisper-server `verbose_json` → `{start, end, text}` segments saved to transcript.json. A single whole-meeting segment can only ever receive ONE speaker label from `merge_transcript`. The no-segments fallback duration comes from `recordingStartedAtRef` elapsed time, never from `blob.size / (16000*2)` (Opus bytes aren't PCM — ~10× off).
- **`.env` writes are serialized + atomic** (`environment.js`): all writers funnel through `saveAllKeysToEnvFile`'s promise queue and temp-file+rename. Never add a bare `writeFile` of the .env — concurrent fire-and-forget callers corrupt the file holding every API key.
- **Model-server `start(modelPath)` joins an in-flight startup only for the SAME model** (whisper/llama/parakeet-ws): returning it unconditionally serves the wrong model while `currentServerModel` records the requested one. Startup timeouts must kill the spawned process (still loading = holds port + GBs of RAM).
- **Parakeet deletes the archive on EXTRACTION_FAILED** — the reuse-existing-archive path would otherwise re-extract the same corrupt file on every retry forever.
- **PersonalNotesView stays mounted during meeting work**: ControlPanel keeps it rendered (hidden) while `onMeetingActivityChange` reports recording/processing/diarizing — conditional unmount stops the recording.
- **Gcal sync = full-window fetch + pagination + reconciliation, NO sync tokens**: tokens pin the original 7-day horizon (new events beyond it never appear). Reconciliation (delete local ids missing from the response) runs only after a fully successful fetch. `syncEvents` throws when ALL calendars fail so interval backoff engages; per-calendar failures only log.
- **gcal scheduleNextMeeting skips `__apple__` events** — Apple manager notifies for its own events; without the filter both fire.
- **OAuth deep links queue** (`pendingOAuthVerifier` in main.js) when the control panel isn't live; flushed after window creation. Dropping the verifier silently fails sign-in.
- **Export files**: `lastExportRef` is cleared at every recording start (stale ref rewrites the previous meeting's file with the new meeting's transcript); export content prefers the diarized transcript when already available; filename separator is platform-aware ("|" is invalid on Windows).
- **Pill meeting indicator**: driven solely by the `meeting-set-user-recording` IPC (main broadcasts `meeting-recording-indicator` to the pill) so every stop path — manual, auto-stop, navigation — clears it; the pill's auto-hide is suppressed while it's active.

---

## Running & Testing

```bash
npm run dev              # Vite + Electron (HMR for renderer only)
npm run pack             # Unsigned local build
# Install:
npm run pack && cp -R dist/mac-arm64/customWhispr.app /Applications/

npm run typecheck        # TypeScript checks
npm run lint             # ESLint
npm run quality-check    # format + typecheck
npm run i18n:check       # Translation coverage
```

### Dev Workflow in Git Worktrees (IMPORTANT)

When working from a Claude-created worktree (`.claude/worktrees/<name>/`):

1. **Symlink node_modules** from the main project so the same Electron binary is used — this keeps macOS TCC permissions intact:
   ```bash
   ln -s /path/to/openwhispr/node_modules .claude/worktrees/<name>/node_modules
   ```
   Also symlink any downloaded binaries (e.g. `whisper-server-darwin-arm64`) from `resources/bin/`.

2. **Always run `npm run dev` from the worktree** (not the main project) so HMR picks up worktree changes.

3. **Always build (`npm run pack`) from the main project directory**, not the worktree — electron-builder cannot resolve the electron version through a symlinked `node_modules`.
   - Copy changed files to main project first, then build there.

4. **Install with `cp -R` only — never `rm -rf` first.** Overwriting in place preserves all TCC permissions (accessibility, mic, calendar) keyed to `/Applications/customWhispr.app` + bundle ID `com.herotools.customwhispr`.

### macOS Accessibility Permission Troubleshooting (dev Electron binary)

The dev Electron binary (`com.github.Electron` in `node_modules/electron/dist/Electron.app`) requires a one-time accessibility grant that should persist. If it stops working:

1. **Never launch Electron from a different path** (e.g. a worktree path with its own node_modules) — macOS creates a new TCC entry for each unique binary path, which can conflict.
2. If permissions are stuck (switch ON but app still reports not trusted):
   ```bash
   # Kill Electron
   pkill -f Electron
   # Reinstall fresh binary (removes any ad-hoc signature that may have changed identity)
   rm -rf node_modules/electron/dist && node node_modules/electron/install.js
   # Clear stale TCC entry
   tccutil reset Accessibility com.github.Electron
   # Relaunch, then dictate something to trigger the system prompt → click Allow
   npm run dev
   ```
3. After granting, the permission persists across `npm run dev` restarts as long as the binary isn't replaced or re-signed.
