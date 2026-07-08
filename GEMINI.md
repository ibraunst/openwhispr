# customWhispr — AI Source of Truth

> **Version**: 1.6.2 | **Last scanned**: 2026-03-31

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
  ├─ ipcHandlers.js (252 IPC channels: ~244 handle + 8 on)
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
| `preload.js` | Secure IPC bridge (contextBridge) — ~335 exposed APIs |

### Helpers (`src/helpers/`) — 47 modules
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
| **Database** | `database.js` |
| **IPC** | `ipcHandlers.js` (252 channels) |
| **System** | `environment.js`, `debugLogger.js`, `devServerManager.js`, `tray.js`, `menuManager.js`, `i18nMain.js`, `safeTempDir.js`, `downloadUtils.js`, `modelDirUtils.js`, `modelManagerBridge.js`, `ModelManager.ts`, `ensureYdotool.js` |

### Components (`src/components/`) — ~90 components
| Area | Key Components |
|------|---------------|
| **Core** | `ControlPanel.tsx`, `ControlPanelSidebar.tsx`, `SettingsPage.tsx`, `SettingsModal.tsx`, `OnboardingFlow.tsx` |
| **Transcription** | `HistoryView.tsx`, `TranscriptionModelPicker.tsx`, `LocalWhisperPicker.tsx`, `LocalModelPicker.tsx`, `ReasoningModelSelector.tsx` |
| **Notes** | `NotesView.tsx`, `NoteEditor.tsx`, `notes/PersonalNotesView.tsx`, `notes/UploadAudioView.tsx`, `notes/ActionManagerDialog.tsx`, `notes/ActionPicker.tsx`, `notes/DictationWidget.tsx`, `notes/RealtimeTranscriptionBanner.tsx`, `notes/NoteListItem.tsx`, `notes/ActionProcessingOverlay.tsx`, `notes/NotesOnboarding.tsx` |
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
- [x] Meeting auto-stop on process close or sustained silence
- [x] Speaker diarization (Python + pyannote.audio, requires HuggingFace token set in Integrations)
  - Runs automatically after every meeting recording
  - System + mic audio recorded separately (split recorders) for diarization input
  - WebM → WAV conversion via ffmpeg before passing to Python (torchaudio can't read WebM)
  - Silent system audio (solo recording) → falls back to mic audio as primary diarization source
  - Labels speakers as "Me" / "Guest 1" / "Guest 2" etc. in `**Speaker:** text` markdown format
  - Result persisted to `notes.transcript` column via `updateNote` IPC
  - NoteEditor auto-switches to Transcript tab when diarization completes
  - Exported .md file re-written with speaker labels when diarization finishes
- [x] Calendar-aware notifications

### Infrastructure
- [x] Auto-update (electron-updater)
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

### Speaker Diarization Architecture (critical — do not regress)
- `useMeetingTranscription` runs two parallel `MediaRecorder` instances: one on the system audio stream, one on the mic stream (split recorders).
- After stop, both blobs are saved via `meetingSaveSplitAudio` IPC → `{userData}/meetings/{meetingId}/system_record.webm` and `mic_record.webm`.
- Diarization runs automatically in an async IIFE inside `stopTranscription` — it does NOT block the UI.
- `diarizationNoteIdRef` lives **inside the hook** (not the component) so it survives component unmount. The hook calls `updateNote` IPC directly when diarization finishes.
- Component's `useEffect` on `diarizedTranscript` calls `initializeNotes()` to refresh the store from DB.
- `PersonalNotesView` tracks `lastExportRef` — when diarization completes it overwrites the exported file with speaker-labeled transcript.
- Auto-generate notes after meeting is skipped when `useReasoningModel` is `false`; export still runs immediately in that case.
- HuggingFace token stored as `hfToken` in `settingsStore`, configurable in Integrations view.

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
| `notes` | id, title, content, note_type, source_file, audio_duration_seconds, created_at, updated_at, enhanced_content, enhancement_prompt, enhanced_at_content_hash, cloud_id, folder_id, transcript, calendar_event_id |
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
