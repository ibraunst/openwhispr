# customWhispr Technical Reference for AI Assistants

This document provides comprehensive technical details about the customWhispr project architecture for AI assistants working on the codebase.

## Project Overview

customWhispr (formerly OpenWhispr) is an Electron-based desktop dictation and note-taking application. It supports local transcription via whisper.cpp and NVIDIA Parakeet (sherpa-onnx), cloud transcription via OpenAI/Groq/Mistral, streaming transcription via AssemblyAI/Deepgram/OpenAI Realtime, and AI-powered text correction via multiple providers. It includes a full note-taking system, agent mode with conversational AI, per-app dictation profiles, meeting detection and transcription, calendar integration (Google Calendar and Apple Calendar), audio storage, export, referral system, and authentication with customWhispr Cloud.

## Running & Testing

### Prerequisites
- Node 22 LTS (pinned in `.nvmrc`)
- `npm install` (use Node 22 to avoid lockfile incompatibility)

### Development
```bash
npm run dev              # Vite dev server + Electron concurrently (HMR enabled)
npm run dev:renderer     # Renderer only (Vite on port 3000, no Electron)
npm run dev:main         # Electron only (expects renderer already running)
```

HMR works for renderer changes (React/TSX/CSS). Main process (`main.js`) or preload (`preload.js`) changes require restarting `dev:main`.

Native Swift/C binaries compile automatically via `predev` hook (`npm run compile:native`).

### Building & Packaging
```bash
npm run build            # Full build: renderer + electron-builder
npm run build:mac        # macOS only (also build:mac:arm64, build:mac:x64)
npm run build:win        # Windows only
npm run build:linux      # Linux only (also build:linux:appimage, :deb, :rpm, :tar)
npm run pack             # Unsigned local build to dist/ + ad-hoc codesign
```

### Quality Checks
```bash
npm run typecheck        # TypeScript type checking (cd src && tsc --noEmit)
npm run lint             # ESLint
npm run format           # ESLint --fix + Prettier --write
npm run quality-check    # format:check + typecheck
npm run i18n:check       # Verify translation key coverage
```

## Architecture Overview

### Core Technologies
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 36 with context isolation
- **State Management**: Zustand 5 (stores in `src/stores/`)
- **Database**: better-sqlite3 for local data (transcriptions, notes, folders, actions, dictionary, calendar, agent conversations)
- **UI Components**: shadcn/ui with Radix primitives, Lucide icons
- **Speech Processing**: whisper.cpp + NVIDIA Parakeet (sherpa-onnx) + OpenAI/Groq/Mistral cloud APIs
- **Streaming Transcription**: AssemblyAI, Deepgram, OpenAI Realtime API
- **AI Reasoning**: OpenAI, Anthropic, Google Gemini, Groq, local GGUF models via llama.cpp
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)
- **Cloud Backend**: Neon (Postgres), Vercel Blob storage, customWhispr Cloud API
- **Authentication**: Neon Auth (`@neondatabase/auth`)
- **Node.js**: 22 LTS (pinned in `.nvmrc`)

### Key Architectural Decisions

1. **Multi-Window Architecture**:
   - **Main Window**: Minimal overlay for dictation (draggable, always on top, `focusable: false`)
   - **Control Panel**: Full settings/notes/history interface (900x700 default, resizable)
   - **Agent Overlay**: Conversational AI window (420x300, resizable, `focusable: true`)
   - **Notification Window**: Meeting detection notifications (380x88)
   - All windows share same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database, native binary management
   - Renderer Process: React app with context isolation
   - Preload Script: Secure IPC bridge (`preload.js`)

3. **State Management**:
   - Zustand stores: `settingsStore.ts`, `noteStore.ts`, `actionStore.ts`, `transcriptionStore.ts`
   - Settings persisted to localStorage + synced across windows via `storage` event
   - API keys persisted to `.env` file via main process

4. **Audio Pipeline**:
   - Standard: MediaRecorder API -> Blob -> ArrayBuffer -> IPC -> File -> whisper.cpp/cloud API
   - Streaming: MediaRecorder -> chunked audio -> WebSocket (AssemblyAI/Deepgram/OpenAI Realtime) -> partial/final transcripts
   - Meeting: System audio capture -> streaming transcription -> note generation

5. **Cloud Modes** (BYOK vs customWhispr Cloud):
   - `cloudTranscriptionMode`: `"byok"` (bring your own key) or `"customwhispr"` (cloud-managed)
   - `cloudReasoningMode`: `"byok"` or `"customwhispr"`
   - `cloudAgentMode`: `"byok"` or `"customwhispr"`
   - customWhispr Cloud routes through Groq (fast tier) or OpenRouter (balanced/quality tiers)

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via `window.electronAPI`

### Native Resources (resources/)

**macOS (Swift)**:
- `macos-globe-listener.swift`: Globe/Fn key detection for hotkey
- `macos-mic-listener.swift`: CoreAudio mic property listener (event-driven mic detection)
- `macos-fast-paste.swift`: Native clipboard paste via Accessibility API
- `macos-text-monitor.swift`: Text edit monitoring / auto-learning
- `macos-media-remote.swift`: Media playback control (pause/resume)

**Windows (C)**:
- `windows-key-listener.c`: Low-level keyboard hook for Push-to-Talk
- `windows-mic-listener.c`: WASAPI mic session monitor
- `windows-fast-paste.c`: Native clipboard paste
- `windows-text-monitor.c`: Text edit monitoring

**Linux (C)**:
- `linux-fast-paste.c`: XTest-based clipboard paste
- `linux-text-monitor.c`: Text edit monitoring

### Helper Modules (src/helpers/)

- **audioManager.js**: Audio device management, transcription orchestration
- **audioStorage.js**: Audio file retention and storage management
- **assemblyAiStreaming.js**: AssemblyAI WebSocket streaming transcription
- **deepgramStreaming.js**: Deepgram WebSocket streaming transcription
- **openaiRealtimeStreaming.js**: OpenAI Realtime API streaming (dictation)
- **audioActivityDetector.js**: Detects microphone usage for unscheduled meetings
- **clipboard.js**: Cross-platform clipboard operations (AppleScript/PowerShell/XTest)
- **database.js**: SQLite operations for all local data
- **debugLogger.js**: Debug logging system with file output
- **devServerManager.js**: Vite dev server integration
- **downloadUtils.js**: Shared download/extraction utilities
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variable and API key management
- **ffmpegUtils.js**: FFmpeg path resolution and utilities
- **globeKeyManager.js**: macOS Globe key listener management
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration via D-Bus
- **googleCalendarManager.js**: Google Calendar sync with exponential backoff
- **googleCalendarOAuth.js**: Google Calendar OAuth flow
- **appleCalendarManager.js**: Apple Calendar integration (macOS native)
- **hotkeyManager.js**: Global hotkey registration and management
- **i18nMain.js**: i18n support for main process
- **ipcHandlers.js**: Centralized IPC handler registration
- **llamaCppInstaller.js/.ts**: llama.cpp installation management
- **llamaServer.js**: llama.cpp server management for local LLM inference
- **llamaVulkanManager.js**: Vulkan GPU acceleration for llama.cpp
- **mediaPlayer.js**: Media playback pause/resume during dictation
- **meetingDetectionEngine.js**: Orchestrates meeting detection from all sources
- **meetingProcessDetector.js**: Detects running meeting apps (Zoom, Teams, etc.)
- **menuManager.js**: Application menu management
- **modelDirUtils.js**: Model directory path utilities
- **modelManagerBridge.js**: Bridge for local model downloads
- **ModelManager.ts**: Centralized model management
- **parakeet.js**: NVIDIA Parakeet model management via sherpa-onnx
- **parakeetServer.js**: sherpa-onnx CLI wrapper for transcription
- **parakeetWsServer.js**: WebSocket server for Parakeet streaming
- **processListCache.js**: Shared singleton process list cache (5s TTL)
- **safeTempDir.js**: Safe temporary directory management
- **textEditMonitor.js**: Text edit monitoring for auto-learning corrections
- **tray.js**: System tray icon and menu
- **whisper.js**: Local whisper.cpp integration and model management
- **whisperCudaManager.js**: CUDA GPU acceleration for whisper.cpp
- **whisperServer.js**: Whisper server for faster repeated transcriptions
- **windowConfig.js**: Window configurations (main, control panel, agent overlay, notification)
- **windowManager.js**: Window creation and lifecycle management
- **windowsKeyManager.js**: Windows Push-to-Talk with native key listener

### React Components (src/components/)

**Top-level**:
- **ControlPanel.tsx**: Main settings/notes/history interface with responsive sidebar
- **ControlPanelSidebar.tsx**: Navigation sidebar (inline >= 768px, overlay when narrow)
- **OnboardingFlow.tsx**: First-time setup wizard
- **SettingsPage.tsx**: Comprehensive settings interface
- **HistoryView.tsx**: Transcription history
- **NotesView.tsx**: Note listing and management
- **NoteEditor.tsx**: Rich note editor
- **CalendarView.tsx**: Calendar events display
- **DictionaryView.tsx**: Custom dictionary management
- **IntegrationsView.tsx**: Calendar and integration settings
- **AgentOverlay.tsx**: Agent mode floating window
- **MeetingNotificationOverlay.tsx**: Meeting detection notification
- **LocalModelPicker.tsx**: Local GGUF model selection and download
- **LocalWhisperPicker.tsx**: Whisper model selection
- **TranscriptionModelPicker.tsx**: Cloud transcription model picker
- **ReasoningModelSelector.tsx**: AI reasoning model selection
- **CommandSearch.tsx**: Command palette / search
- **ReferralDashboard.tsx / ReferralModal.tsx**: Referral system UI
- **UpgradePrompt.tsx**: Usage limit upgrade prompt
- **UsageDisplay.tsx**: Usage statistics display
- **UpcomingMeetings.tsx**: Upcoming calendar meetings
- **ErrorBoundary.tsx**: React error boundary
- **TitleBar.tsx / WindowControls.tsx**: Custom window chrome

**Subdirectories**:
- `agent/`: AgentChat, AgentInput, AgentMessage, AgentTitleBar
- `notes/`: PersonalNotesView, UploadAudioView, NoteListItem, ActionManagerDialog, ActionPicker, ActionProcessingOverlay, DictationWidget, RealtimeTranscriptionBanner, NotesOnboarding, AddNotesToFolderDialog
- `settings/`: AgentModeSettings
- `referral-cards/`: Referral card components
- `ui/`: Reusable shadcn/ui components (buttons, cards, inputs, dialogs, etc.)

### React Hooks (src/hooks/) -- 25 hooks

- **useActionProcessing.ts**: Action execution on notes
- **useAudioRecording.jsx**: MediaRecorder API wrapper
- **useAuth.ts**: Authentication state management
- **useClipboard.ts**: Clipboard operations
- **useDebouncedCallback.ts**: Debounced callback utility
- **useDialogs.ts**: Electron dialog integration
- **useFolderManagement.ts**: Note folder CRUD
- **useHotkey.js**: Hotkey state management
- **useHotkeyRegistration.ts**: Hotkey registration with fallback handling
- **useLocalModels.ts**: Local GGUF model management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **useMeetingTranscription.ts**: Meeting transcription streaming + local fallback
- **useModelDownload.ts**: Model download progress tracking
- **useNoteDragAndDrop.ts**: Drag-and-drop for notes
- **useNoteRecording.ts**: Note-specific audio recording
- **useNotesOnboarding.ts**: Notes feature onboarding
- **usePermissions.ts**: System permission checks
- **useScreenRecordingPermission.ts**: Screen recording permission (macOS)
- **useSettings.ts**: Settings type definitions and interfaces
- **useTheme.ts**: Theme management (light/dark/auto)
- **useUpcomingEvents.ts**: Calendar upcoming events
- **useUpdater.ts**: Auto-update management
- **useUsage.ts**: Usage tracking and limits
- **useWhisper.ts**: Whisper binary availability check
- **useWindowDrag.js**: Window drag behavior

### Zustand Stores (src/stores/)

- **settingsStore.ts**: All application settings (see Settings section below)
- **noteStore.ts**: Notes state management
- **actionStore.ts**: Actions (note processing templates) state
- **transcriptionStore.ts**: Transcription history state

### Services (src/services/)

- **ReasoningService.ts**: AI text correction and agent-addressed commands
- **BaseReasoningService.ts**: Base class for reasoning providers
- **LocalReasoningService.ts**: Local llama.cpp reasoning
- **NotesService.ts**: Note operations service
- **localReasoningBridge.js**: Bridge between renderer and local reasoning

### Build Scripts (scripts/)

- **download-whisper-cpp.js**: Downloads whisper.cpp binaries from GitHub releases
- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-sherpa-onnx.js**: Downloads sherpa-onnx binaries for Parakeet
- **download-nircmd.js**: Downloads nircmd.exe for Windows clipboard operations
- **download-windows-fast-paste.js**: Downloads Windows fast-paste binary
- **download-windows-key-listener.js**: Downloads Windows key listener binary
- **download-windows-mic-listener.js**: Downloads Windows mic listener binary
- **download-text-monitor.js**: Downloads text monitor binaries
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift
- **build-macos-fast-paste.js**: Compiles macOS fast-paste from Swift
- **build-macos-mic-listener.js**: Compiles macOS mic listener from Swift
- **build-macos-text-monitor.js**: Compiles macOS text monitor from Swift
- **build-macos-calendar-sync.js**: Compiles macOS calendar sync from Swift
- **build-media-remote.js**: Compiles macOS media remote from Swift
- **build-text-monitor.js**: Meta-script for all text monitor builds
- **build-windows-key-listener.js**: Compiles Windows key listener
- **build-windows-fast-paste.js**: Compiles Windows fast-paste
- **build-windows-text-monitor.js**: Compiles Windows text monitor
- **build-linux-fast-paste.js**: Compiles Linux fast-paste
- **build-linux-text-monitor.js**: Compiles Linux text monitor
- **check-i18n.js**: Verify translation key coverage
- **run-electron.js**: Development script to launch Electron
- **complete-uninstall.sh**: Full uninstall script
- **lib/**: Shared download utilities (`download-utils.js`)

## Key Implementation Details

### 1. Window Configurations

Defined in `src/helpers/windowConfig.js`:

```
WINDOW_SIZES:
  BASE:       96 x 96     (idle dictation pill)
  RECORDING:  340 x 96    (recording state with waveform)
  WITH_MENU:  240 x 280   (context menu open)
  WITH_TOAST: 400 x 500   (toast notification visible)
  EXPANDED:   400 x 500   (expanded state)

MAIN_WINDOW_CONFIG:    focusable:false, transparent, alwaysOnTop, type:"panel" (macOS)
CONTROL_PANEL_CONFIG:  900x700, resizable, frameless with hiddenInset titlebar (macOS)
AGENT_OVERLAY_CONFIG:  420x300, focusable:true, transparent, alwaysOnTop, resizable:false
NOTIFICATION_WINDOW_CONFIG: 380x88, focusable:false, transparent, alwaysOnTop
```

### 2. Database Schema

Tables in `src/helpers/database.js`:

- **transcriptions**: id, text, timestamp, created_at + audio retention columns (audio_file_path, audio_size_bytes, audio_duration_seconds, audio_mime_type, raw_text)
- **custom_dictionary**: id, word (UNIQUE), created_at
- **notes**: id, title, content, note_type, source_file, audio_duration_seconds, created_at, updated_at + folder_id, cloud_id, meeting_prompt, calendar_event_id columns
- **folders**: id, name (UNIQUE), is_default, sort_order, created_at
- **actions**: id, name, description, prompt, icon, is_builtin, sort_order, created_at, updated_at
- **agent_conversations**: id, title, created_at, updated_at
- **agent_messages**: id, conversation_id (FK), role (user/assistant/system), content, created_at
- **google_calendar_tokens**: id, google_email (UNIQUE), access_token, refresh_token, expires_at, scope, timestamps
- **google_calendars**: id (PK), summary, description, background_color, is_selected, sync_token, account_email, timestamps
- **apple_calendars**: id (PK), title, color, is_selected, created_at
- **calendar_events**: id (PK), calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link + additional meeting metadata
- **settings**: key (PK), value

### 3. Settings (settingsStore.ts)

**Transcription settings**:
- `useLocalWhisper` (bool): Local vs cloud mode
- `whisperModel` (string): Selected whisper model (tiny/base/small/medium/large/turbo)
- `localTranscriptionProvider`: `"whisper"` or `"nvidia"`
- `parakeetModel` (string): Selected Parakeet model
- `preferredLanguage` (string): Language code or `"auto"`
- `cloudTranscriptionProvider` (string): `"openai"`, `"groq"`, or `"mistral"`
- `cloudTranscriptionModel` (string): e.g. `"gpt-4o-mini-transcribe"`
- `cloudTranscriptionMode`: `"byok"` or `"customwhispr"`
- `cloudTranscriptionBaseUrl` (string): Custom endpoint URL
- `allowOpenAIFallback` (bool): Fall back to cloud on local failure
- `allowLocalFallback` (bool): Fall back to local on cloud failure
- `fallbackWhisperModel` (string): Model for fallback
- `customDictionary` (string[]): Words for improved transcription
- `assemblyAiStreaming` (bool): Enable AssemblyAI streaming

**Reasoning settings**:
- `useReasoningModel` (bool): Enable AI text correction
- `reasoningModel` (string): Selected model ID
- `reasoningProvider` (string): `"openai"`, `"anthropic"`, `"gemini"`, `"groq"`, `"local"`
- `cloudReasoningMode`: `"byok"` or `"customwhispr"`
- `cloudReasoningBaseUrl` (string): Custom endpoint URL

**Agent settings**:
- `agentEnabled` (bool): Enable agent mode
- `agentModel` (string): e.g. `"openai/gpt-oss-120b"`
- `agentProvider` (string): e.g. `"groq"`
- `agentKey` (string): Agent hotkey
- `agentSystemPrompt` (string): Custom system prompt
- `cloudAgentMode`: `"byok"` or `"customwhispr"`

**API keys**: `openaiApiKey`, `anthropicApiKey`, `geminiApiKey`, `groqApiKey`, `mistralApiKey`, `customTranscriptionApiKey`, `customReasoningApiKey`

**Hotkey settings**: `dictationKey`, `activationMode` (`"tap"` | `"push"`)

**Microphone**: `preferBuiltInMic` (bool), `selectedMicDeviceId` (string)

**UI/UX**: `theme` (`"light"` | `"dark"` | `"auto"`), `uiLanguage`, `audioCuesEnabled`, `pauseMediaOnDictation`, `floatingIconAutoHide`, `startMinimized`, `panelStartPosition` (`"bottom-right"` | `"center"` | `"bottom-left"`), `keepTranscriptionInClipboard`

**Privacy**: `cloudBackupEnabled`, `telemetryEnabled`, `audioRetentionDays` (number, default 30)

**Calendar**: `gcalAccounts` (array), `gcalConnected`, `gcalEmail`, `appleCalendarConnected`, `meetingProcessDetection`, `meetingAudioDetection`

**App Profiles**: `appProfiles` (Record<bundleId, AppProfile>), `activeAppBundleId`
- `AppProfile`: `{ name, correctionEnabled: bool|null, customPrompt: string|null }`
- `null` values mean "use global default"

**Export**: `exportDirectory`, `defaultExportFormat` (`"txt"` | `"md"`)

**Auth**: `isSignedIn` (bool)

### 4. AI Model Registry (src/models/modelRegistryData.json)

**Cloud Reasoning Providers**:
- **OpenAI**: GPT-5.2, GPT-5 Mini, GPT-5 Nano, GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano
- **Anthropic**: Claude Sonnet 4.6, Claude Haiku 4.5, Claude Opus 4.6
- **Google Gemini**: Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Flash Lite
- **Groq** (9 models): Qwen3 32B, GPT-OSS 120B, GPT-OSS 20B, LLaMA 3.3 70B, LLaMA 3.1 8B, Llama 4 Scout, Compound, Compound Mini, Kimi K2

**Cloud Transcription Providers**:
- **OpenAI**: GPT-4o Mini Transcribe, GPT-4o Transcribe, Whisper-1
- **Groq**: Whisper Large v3, Whisper Large v3 Turbo
- **Mistral**: Voxtral Mini

**Local Reasoning Models (GGUF via llama.cpp)**:
- **Qwen**: Qwen3 (0.6B, 1.7B, 4B, 8B, 32B), Qwen2.5 (0.5B, 1.5B, 3B, 7B)
- **Mistral AI**: Mistral 7B Instruct v0.3
- **Meta Llama**: Llama 3.2 (1B, 3B), Llama 3.1 8B
- **OpenAI OSS**: GPT-OSS 20B (mxfp4)
- **Gemma (Google)**: Gemma 3 4B, Gemma 3 1B

**Local Transcription Models**:
- **Whisper (GGML)**: tiny (75MB), base (142MB), small (466MB), medium (1.5GB), large (3GB), turbo (1.6GB)
- **NVIDIA Parakeet**: parakeet-tdt-0.6b-v3 (680MB, 25 languages)

**customWhispr Cloud Models** (for signed-in users):
- **Fast tier** (Groq): Llama 3.3 70B, Llama 3.1 8B
- **Balanced tier** (OpenRouter): Claude Sonnet 4, Gemini 2.5 Flash
- **Quality tier** (OpenRouter): Claude Opus 4, GPT-4.1

### 5. Streaming Transcription

Three streaming providers, all managed in main process with IPC events:

- **AssemblyAI** (`assemblyAiStreaming.js`): WebSocket streaming, partial + final transcripts, endpoint forcing
- **Deepgram** (`deepgramStreaming.js`): WebSocket streaming, partial + final transcripts, finalize command
- **OpenAI Realtime** (`openaiRealtimeStreaming.js`): OpenAI Realtime API for dictation streaming

Each exposes: warmup, start, send (audio chunks), stop, status + event listeners for partial/final/error/session-end.

### 6. Meeting Transcription

- **Streaming**: `meetingTranscriptionPrepare`, `meetingTranscriptionStart`, `meetingTranscriptionSend`, `meetingTranscriptionStop`
- **Local fallback**: `meetingTranscribeLocal` (for offline/no-cloud scenarios)
- **Chain transcription**: `meetingTranscribeChain` (BaseTen)
- Events: `meeting-transcription-partial`, `meeting-transcription-final`, `meeting-transcription-error`
- Auto-stop: `meeting-auto-stop-suggested`, `meeting-auto-stop-execute`, `meetingAutoStopCancel`

### 7. Per-App Dictation Profiles

- Frontmost app detected via `get-frontmost-app` IPC
- App icons fetched via `get-app-icon` IPC
- Profiles stored in `appProfiles` (localStorage + Zustand), keyed by bundle ID
- Each profile overrides: `correctionEnabled` (bool|null), `customPrompt` (string|null)
- `getEffectiveCorrectionEnabled()` and `getActiveAppCustomPrompt()` resolve profile -> global fallback
- Icons cached in memory-only `appIconCache` Map (not serialized)

### 8. Agent Mode

- Separate hotkey (`agentKey`) triggers agent recording
- Agent overlay window shows conversational chat (AgentOverlay.tsx -> AgentChat, AgentInput, AgentMessage)
- Conversations persisted in SQLite: `agent_conversations` + `agent_messages` tables
- Cloud streaming via `cloud-agent-stream` IPC with `agent-stream-chunk` / `agent-stream-done` events
- Recording lock system: `acquireRecordingLock` / `releaseRecordingLock` to prevent dictation + agent recording simultaneously
- Agent window: repositionable, `getAgentWindowBounds` / `setAgentWindowBounds`

### 9. Notes System

- **Notes**: Title, content, note_type (`"personal"`, `"meeting"`), optional source audio file, folder organization
- **Folders**: Named folders with sort order, default folder support
- **Actions**: Reusable AI processing templates (name, description, prompt, icon). Built-in + custom actions.
- Notes CRUD: `saveNote`, `getNote`, `getNotes`, `updateNote`, `deleteNote`, `searchNotes`
- Folder CRUD: `getFolders`, `createFolder`, `deleteFolder`, `renameFolder`, `getFolderNoteCounts`
- Action CRUD: `getActions`, `getAction`, `createAction`, `updateAction`, `deleteAction`
- Cross-window sync via IPC events: `note-added`, `note-updated`, `note-deleted`, `action-created`, `action-updated`, `action-deleted`
- Cloud sync: `cloud_id` column, `updateNoteCloudId`
- Audio file upload/transcription: `selectAudioFile`, `transcribeAudioFile`, `transcribeAudioFileCloud`, `transcribeAudioFileByok`

### 10. Authentication & Cloud

- Neon Auth for sign-in (`@neondatabase/auth`)
- `isSignedIn` state in settingsStore
- `authClearSession` IPC to log out
- Cloud APIs: `cloudTranscribe`, `cloudReason`, `cloudAgentStream`
- Usage tracking: `cloudUsage`, `cloudStreamingUsage`
- Billing: `cloudCheckout`, `cloudBillingPortal`
- STT config: `getSttConfig` (server-side transcription configuration)

### 11. Referral System

- `getReferralStats`: Current referral statistics
- `sendReferralInvite`: Send email invite
- `getReferralInvites`: List sent invites
- UI: ReferralDashboard, ReferralModal components

### 12. Audio Storage & Export

- Audio files stored locally with configurable retention (`audioRetentionDays`, default 30)
- `saveTranscriptionAudio`, `getAudioPath`, `getAudioBuffer`, `showAudioInFolder`, `deleteTranscriptionAudio`
- `getAudioStorageUsage`, `deleteAllAudio`
- Export: `exportTranscription`, `exportAllTranscriptions`, `exportNote` (txt/md formats)
- `selectExportDirectory`, `saveTranscriptToFile`

### 13. Text Edit Monitoring / Auto-Learning

- Native binaries monitor text edits in target applications
- `textEditMonitor.js` manages the monitor lifecycle
- `setAutoLearnEnabled` IPC to enable/disable
- `corrections-learned` event notifies renderer of learned corrections
- `undoLearnedCorrections` to remove incorrectly learned words
- macOS: AXEnhancedUserInterface management with proper reset

### 14. Calendar Integration

**Google Calendar**:
- OAuth flow: `gcalStartOAuth`, `gcalDisconnect`, `gcalGetConnectionStatus`
- Calendar selection: `gcalGetCalendars`, `gcalSetCalendarSelection`
- Event sync: `gcalSyncEvents`, `gcalGetUpcomingEvents`
- Multi-account support via `gcalAccounts` array
- Events: `gcal-meeting-starting`, `gcal-meeting-ended`, `gcal-start-recording`, `gcal-connection-changed`, `gcal-events-synced`
- Resilience: 10s socket timeout, exponential backoff (2min -> 4min -> 8min -> 30min cap)

**Apple Calendar** (macOS):
- Native Swift binary (`macos-calendar-sync`)
- `acalConnect`, `acalDisconnect`, `acalGetStatus`, `acalGetCalendars`, `acalSetCalendarSelected`
- Events: `acal-connection-changed`, `acal-meeting-starting`, `acal-meeting-ended`, `acal-start-recording`, `acal-events-synced`

### 15. Meeting Detection (Event-Driven)

Detects meetings via three independent sources, orchestrated by `MeetingDetectionEngine`:

**Process Detection** (Zoom, Teams, Webex, FaceTime):
- macOS: `systemPreferences.subscribeWorkspaceNotification` (zero CPU)
- Windows/Linux: `processListCache` shared polling (30s interval)

**Microphone Detection** (unscheduled/browser meetings like Google Meet):
- macOS: `macos-mic-listener` binary (CoreAudio property listeners)
- Windows: `windows-mic-listener.exe` (WASAPI sessions, self-PID exclusion)
- Linux: `pactl subscribe` (PulseAudio source-output events)
- All: graceful fallback to polling

**UX Rules**:
- During recording: ALL notifications suppressed
- After recording: 2.5s cooldown before showing queued notifications
- Multiple signals coalesced: process > audio priority
- Calendar-aware: notification shows event name if imminent
- Auto-stop: suggests/executes meeting stop when meeting app closes

### 16. Language Support

**Transcription languages**: 58 languages (see `src/utils/languages.ts`), "auto" for automatic detection.

**UI languages** (i18n): en, es, fr, de, pt, it, ru, zh-CN, zh-TW, ja (10 languages)

i18n: react-i18next v15 with i18next v25. Translation files in `src/locales/{lang}/translation.json`.

### 17. Custom Dictionary

- User adds words via Settings or DictionaryView
- Stored in both localStorage (`customDictionary` key) and SQLite (`custom_dictionary` table)
- Bidirectional sync on startup
- Passed as `prompt` parameter to Whisper for improved recognition
- Auto-learn from text edit monitoring

### 18. Debug Mode

Enable with `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug` (can be set in `.env`):
- `getDebugState`, `setDebugLogging`, `openLogsFolder` IPC channels
- Logs saved to platform-specific app data directory

### 19. GPU Acceleration

**CUDA (whisper.cpp)**:
- `detectGpu`, `getCudaWhisperStatus`, `downloadCudaWhisperBinary`, `deleteCudaWhisperBinary`
- Progress events: `cuda-download-progress`, `cuda-fallback-notification`

**Vulkan (llama.cpp)**:
- `detectVulkanGpu`, `getLlamaVulkanStatus`, `downloadLlamaVulkanBinary`, `deleteLlamaVulkanBinary`
- Progress events: `llama-vulkan-download-progress`

### 20. Windows Push-to-Talk

- `resources/windows-key-listener.c`: Native C program using `SetWindowsHookEx`
- `src/helpers/windowsKeyManager.js`: Node.js wrapper for the native binary
- Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
- Binary outputs `KEY_DOWN` / `KEY_UP` to stdout
- IPC events: `windows-key-listener:key-down`, `windows-key-listener:key-up`
- Prebuilt binary downloaded from GitHub releases; falls back to tap mode if unavailable

### 21. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API does not work. customWhispr uses native GNOME shortcuts:
- D-Bus service at `com.openwhispr.App`
- Shortcuts registered via `gsettings`
- GNOME triggers `dbus-send` which calls the D-Bus `Toggle()` method
- Forces tap-to-talk mode (push-to-talk not supported)
- `dbus-next` npm package for D-Bus communication

## Development Guidelines

### Internationalization (i18n) -- REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**How to use**:
```tsx
import { useTranslation } from "react-i18next";
const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "Whisper" })
```

**Rules**:
1. Every new UI string must have a translation key in `en/translation.json` and all other language files
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (customWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), AI system prompts
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Adding New Features

1. **New IPC Channel**: Add to both `ipcHandlers.js` and `preload.js`
2. **New Setting**: Add to `settingsStore.ts` (state + setter + localStorage persistence)
3. **New UI Component**: Follow shadcn/ui patterns in `src/components/ui`
4. **New Manager**: Create in `src/helpers/`, initialize in `main.js`
5. **New UI Strings**: Add translation keys to all 10 language files
6. **New Database Table**: Add CREATE TABLE in `database.js` init, add IPC handlers
7. **New Zustand Store**: Create in `src/stores/`, follow existing patterns

### Common Issues and Solutions

1. **No Audio Detected**: Check FFmpeg path, verify mic permissions, check audio levels in debug logs

2. **Transcription Fails**: Ensure whisper.cpp binary is available, check model is downloaded, verify temp file creation

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for native paste)
   - Windows: PowerShell SendKeys or native `windows-fast-paste.exe`
   - Linux: Native `linux-fast-paste` binary (XTest), xdotool, wtype, ydotool fallbacks

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds
   - Always use Node 22 for `npm install`
   - `compile:native` runs automatically via predev/prebuild hooks

5. **Focus stealing from Claude Desktop**: Caused by "Pause media on dictation" setting sending media key events. Fix: disable that setting.

6. **AXEnhancedUserInterface side effect**: `textEditMonitor._enableAccessibility()` sets AXEnhancedUserInterface=true on target apps. Mitigated by `_resetAccessibility()` in `stopMonitoring()` and `captureTargetPid()`.

7. **Meeting Detection Not Working**: Check debug logs for "event-driven" vs "polling" mode. Verify native binaries exist in `resources/bin/`.

### Platform-Specific Notes

**macOS**:
- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission
- Native Swift binaries: globe-listener, mic-listener, fast-paste, text-monitor, media-remote, calendar-sync
- Main window: NSPanel type, `focusable: false`
- Control panel: `titleBarStyle: "hiddenInset"` with traffic light position
- System settings via `x-apple.systempreferences:` URL scheme

**Windows**:
- No special accessibility permissions needed
- Native C binaries: key-listener, mic-listener, fast-paste, text-monitor
- Push-to-Talk via low-level keyboard hook
- NSIS installer

**Linux**:
- Native C binaries: fast-paste, text-monitor
- GNOME Wayland: D-Bus global shortcuts via `gnomeShortcut.js`
- `pactl subscribe` for mic detection
- AppImage for distribution
- No standardized URL scheme for system settings

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully
- State management: Zustand stores, not raw localStorage
- IPC: All renderer-to-main communication through `preload.js` bridge

## Performance Considerations

- Whisper model size vs speed tradeoff
- Audio blob size limits for IPC (10MB)
- Temporary file cleanup
- Memory usage with large models
- Process timeout protection (5 minutes)
- Meeting detection uses event-driven OS APIs (near-zero CPU) with polling fallback
- Process list cache shared between detectors
- Google Calendar sync uses exponential backoff
- App icon cache in memory only (not serialized to localStorage)
- Streaming transcription reduces perceived latency vs batch mode

## Security Considerations

- API keys stored in localStorage + `.env` file, synced on startup
- Context isolation enabled on all windows
- `sandbox: true` on main/notification windows, `sandbox: false` on control panel/agent (needed for IPC bridge)
- `webSecurity: false` on control panel/agent (needed for cross-origin API calls)
- No remote code execution
- Sanitized file paths
- Limited IPC surface area
- Neon Auth for cloud authentication
