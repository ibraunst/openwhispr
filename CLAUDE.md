# customWhispr — AI Source of Truth

> **Version**: 1.6.2 | **Last scanned**: 2026-03-26

---

## 1. Current Architecture

### Tech Stack
- **Runtime**: Electron 36 (Node 22 LTS)
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite 6
- **State**: Zustand 5 (4 stores)
- **Database**: better-sqlite3 (12 tables)
- **UI Kit**: shadcn/ui + Radix primitives + Lucide icons
- **Speech-to-Text**: whisper.cpp, NVIDIA Parakeet (sherpa-onnx), OpenAI/Groq/Mistral cloud, AssemblyAI/Deepgram/OpenAI Realtime streaming
- **AI Reasoning**: OpenAI, Anthropic, Google Gemini, Groq, local GGUF via llama.cpp
- **Audio**: FFmpeg (bundled via ffmpeg-static)
- **Auth**: Neon Auth (`@neondatabase/auth`)
- **Cloud**: Neon Postgres, Vercel Blob, customWhispr Cloud API
- **i18n**: react-i18next v15 (10 languages: en, es, fr, de, pt, it, ru, zh-CN, zh-TW, ja)

### How Frontend / Backend / DB Interact
```
Renderer Process (React + Vite)
  ├─ Zustand stores (settings, notes, actions, transcriptions) <- localStorage
  └─ window.electronAPI.* (IPC bridge)
        │
        │ IPC (contextBridge / preload.js)
        ▼
Main Process (Electron)
  ├─ ipcHandlers.js (248 IPC channels: 241 handle + 7 on)
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
| `preload.js` | Secure IPC bridge (contextBridge) |

### Helpers (`src/helpers/`) — 45 modules
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
| **IPC** | `ipcHandlers.js` (248 channels) |
| **System** | `environment.js`, `debugLogger.js`, `devServerManager.js`, `tray.js`, `menuManager.js`, `i18nMain.js`, `safeTempDir.js`, `downloadUtils.js`, `modelDirUtils.js`, `modelManagerBridge.js`, `ModelManager.ts` |

### Components (`src/components/`) — 55 components
| Area | Key Components |
|------|---------------|
| **Core** | `ControlPanel.tsx`, `ControlPanelSidebar.tsx`, `SettingsPage.tsx`, `SettingsModal.tsx`, `OnboardingFlow.tsx` |
| **Transcription** | `HistoryView.tsx`, `TranscriptionModelPicker.tsx`, `LocalWhisperPicker.tsx`, `ReasoningModelSelector.tsx` |
| **Notes** | `NotesView.tsx`, `NoteEditor.tsx`, `notes/PersonalNotesView.tsx`, `notes/UploadAudioView.tsx`, `notes/ActionManagerDialog.tsx`, `notes/ActionPicker.tsx`, `notes/DictationWidget.tsx` |
| **Agent** | `AgentOverlay.tsx`, `agent/AgentChat.tsx`, `agent/AgentInput.tsx`, `agent/AgentMessage.tsx` |
| **Calendar** | `CalendarView.tsx`, `IntegrationsView.tsx`, `UpcomingMeetings.tsx` |
| **Meeting** | `MeetingNotificationOverlay.tsx` |
| **Auth** | `AuthenticationStep.tsx`, `EmailVerificationStep.tsx`, `ForgotPasswordView.tsx`, `ResetPasswordView.tsx` |
| **Referral** | `ReferralDashboard.tsx`, `ReferralModal.tsx` |
| **Shared UI** | `ui/` (27 components: accordion, alert, badge, button, card, dialog, dropdown-menu, input, label, progress, select, skeleton, tabs, textarea, toggle, tooltip + ActivationModeSelector, ApiKeyInput, DownloadProgressBar, HotkeyInput, LanguageSelector, MarkdownRenderer, ModelCardList, PromptStudio, ProviderTabs, SettingsSection, Toast, etc.) |
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
- [x] Fallback: local<->cloud bidirectional fallback on failure
- [x] Media pause/resume during dictation (with playback state check to prevent false starts)
- [x] Auto-learn corrections from text edits

### Notes System
- [x] Personal notes with folders
- [x] Meeting notes (linked to calendar events)
- [x] Audio file upload + transcription
- [x] AI actions (reusable processing templates) — built-in + custom
- [x] Rich text editing
- [x] Note search
- [x] Export (txt/md)
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
- [x] Meeting transcription (streaming + local fallback)
- [x] Meeting auto-stop when app closes
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

### Build & Quality
- Node 22 LTS (pinned in `.nvmrc`)
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
interface SettingsState {
  // Transcription
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: "whisper" | "nvidia";
  parakeetModel: string;
  preferredLanguage: string;                  // ISO code or "auto"
  cloudTranscriptionProvider: string;         // "openai" | "groq" | "mistral"
  cloudTranscriptionModel: string;
  cloudTranscriptionMode: "byok" | "customwhispr";
  cloudTranscriptionBaseUrl: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  customDictionary: string[];
  assemblyAiStreaming: boolean;

  // Reasoning
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;                  // "openai" | "anthropic" | "gemini" | "groq" | "local"
  cloudReasoningMode: "byok" | "customwhispr";
  cloudReasoningBaseUrl: string;

  // Agent
  agentEnabled: boolean;
  agentModel: string;
  agentProvider: string;
  agentKey: string;
  agentSystemPrompt: string;
  cloudAgentMode: "byok" | "customwhispr";

  // API Keys
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  mistralApiKey: string;
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;

  // Hotkey
  dictationKey: string;
  activationMode: "tap" | "push";

  // Microphone
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;

  // UI
  theme: "light" | "dark" | "auto";
  uiLanguage: string;
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  keepTranscriptionInClipboard: boolean;

  // Privacy
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;

  // Calendar
  gcalAccounts: GoogleCalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  meetingAudioDetection: boolean;

  // Per-App Profiles
  appProfiles: Record<string, AppProfile>;   // keyed by bundle ID
  activeAppBundleId: string | null;

  // Export
  exportDirectory: string;
  defaultExportFormat: "txt" | "md";

  // Auth
  isSignedIn: boolean;
}

interface AppProfile {
  name: string;
  correctionEnabled: boolean | null;  // null = global default
  customPrompt: string | null;        // null = global default
}
```

### Database Tables (SQLite)
| Table | Key Columns |
|-------|-------------|
| `transcriptions` | id, text, raw_text, timestamp, audio_file_path, audio_size_bytes, audio_duration_seconds |
| `custom_dictionary` | id, word (UNIQUE) |
| `notes` | id, title, content, note_type, folder_id, cloud_id, meeting_prompt, calendar_event_id |
| `folders` | id, name (UNIQUE), is_default, sort_order |
| `actions` | id, name, description, prompt, icon, is_builtin, sort_order |
| `agent_conversations` | id, title, created_at, updated_at |
| `agent_messages` | id, conversation_id (FK), role, content |
| `google_calendar_tokens` | id, google_email (UNIQUE), access_token, refresh_token, expires_at |
| `google_calendars` | id, summary, background_color, is_selected, sync_token, account_email |
| `apple_calendars` | id, title, color, is_selected |
| `calendar_events` | id, calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link |
| `settings` | key (PK), value |

---

## 6. Next Immediate Task

Based on uncommitted changes (6 files modified):
1. **`macos-media-remote.swift`** + **`mediaPlayer.js`** — Just fixed: added `--is-playing` check via MediaRemote private framework to prevent Apple Music from launching when no media is playing during dictation. Needs testing.
2. **`macos-fast-paste.swift`** — Paste improvements.
3. **`textEditMonitor.js`** — AXEnhancedUserInterface reset logic (prevents screen-reader mode side effect).
4. **`useAudioRecording.jsx`** — Recording hook changes.

**Recommended next step**: Test the media pause fix end-to-end, then commit the batch of fixes.

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
