import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { ChevronLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import UpgradePrompt from "./UpgradePrompt";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/Toast";

import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import { useUsage } from "../hooks/useUsage";
import {
  useTranscriptions,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import ControlPanelSidebar, { type ControlPanelView } from "./ControlPanelSidebar";
import WindowControls from "./WindowControls";

import { getCachedPlatform } from "../utils/platform";
import { cn } from "./lib/utils";
import { setActiveNoteId, setActiveFolderId } from "../stores/noteStore";

const platform = getCachedPlatform();

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const ReferralModal = React.lazy(() => import("./ReferralModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const IntegrationsView = React.lazy(() => import("./IntegrationsView"));
const CalendarView = React.lazy(() => import("./CalendarView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

export default function ControlPanel() {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [limitData, setLimitData] = useState<{ wordsUsed: number; limit: number } | null>(null);
  const hasShownUpgradePrompt = useRef(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showReferrals, setShowReferrals] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showCloudMigrationBanner, setShowCloudMigrationBanner] = useState(false);
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMeetingMode, setIsMeetingMode] = useState(false);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number;
    event: any;
  } | null>(null);
  const [gpuAccelAvailable, setGpuAccelAvailable] = useState<{ cuda: boolean; vulkan: boolean }>({
    cuda: false,
    vulkan: false,
  });
  const [gpuBannerDismissed, setGpuBannerDismissed] = useState(
    () => localStorage.getItem("gpuBannerDismissedUnified") === "true"
  );
  const cloudMigrationProcessed = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    useReasoningModel,
    setUseLocalWhisper,
    setCloudTranscriptionMode,
    exportDirectory,
    defaultExportFormat,
  } = useSettings();
  const { isSignedIn, isLoaded: authLoaded, user } = useAuth();
  const usage = useUsage();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    hideConfirmDialog,
    showAlertDialog,
    hideAlertDialog,
  } = useDialogs();

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  useEffect(() => {
    loadTranscriptions();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI?.onLimitReached?.(
      (data: { wordsUsed: number; limit: number }) => {
        if (!hasShownUpgradePrompt.current) {
          hasShownUpgradePrompt.current = true;
          setLimitData(data);
          setShowUpgradePrompt(true);
        } else {
          toast({
            title: t("controlPanel.limit.weeklyTitle"),
            description: t("controlPanel.limit.weeklyDescription"),
            duration: 5000,
          });
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (!usage?.isPastDue || !usage.hasLoaded) return;
    if (sessionStorage.getItem("pastDueNotified")) return;
    sessionStorage.setItem("pastDueNotified", "true");
    toast({
      title: t("controlPanel.billing.pastDueTitle"),
      description: t("controlPanel.billing.pastDueDescription"),
      variant: "destructive",
      duration: 8000,
    });
  }, [usage?.isPastDue, usage?.hasLoaded, toast, t]);

  useEffect(() => {
    if (!authLoaded || !isSignedIn || cloudMigrationProcessed.current) return;
    const isPending = localStorage.getItem("pendingCloudMigration") === "true";
    const alreadyShown = localStorage.getItem("cloudMigrationShown") === "true";
    if (!isPending || alreadyShown) return;

    cloudMigrationProcessed.current = true;
    setUseLocalWhisper(false);
    setCloudTranscriptionMode("customwhispr");
    localStorage.removeItem("pendingCloudMigration");
    setShowCloudMigrationBanner(true);
  }, [authLoaded, isSignedIn, setUseLocalWhisper, setCloudTranscriptionMode]);

  useEffect(() => {
    if (platform === "darwin" || gpuBannerDismissed) return;
    const detect = async () => {
      const results = { cuda: false, vulkan: false };
      if (useLocalWhisper && localTranscriptionProvider === "whisper") {
        try {
          const status = await window.electronAPI?.getCudaWhisperStatus?.();
          if (status?.gpuInfo.hasNvidiaGpu && !status.downloaded) results.cuda = true;
        } catch {}
      }
      if (useReasoningModel) {
        try {
          const [gpu, vulkan] = await Promise.all([
            window.electronAPI?.detectVulkanGpu?.(),
            window.electronAPI?.getLlamaVulkanStatus?.(),
          ]);
          if (gpu?.available && !vulkan?.downloaded) results.vulkan = true;
        } catch {}
      }
      setGpuAccelAvailable(results);
    };
    detect();
  }, [useLocalWhisper, localTranscriptionProvider, useReasoningModel, gpuBannerDismissed]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onNavigateToMeetingNote?.((data) => {
      setActiveFolderId(data.folderId);
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
      setIsMeetingMode(true);
      setMeetingRecordingRequest(data);
    });
    return () => cleanup?.();
  }, []);

  // When accessibility is missing on macOS, open the permissions settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(() => {
      setSettingsSection("privacyData");
      setShowSettings(true);
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);

  const handleMeetingRecordingRequestHandled = useCallback(
    () => setMeetingRecordingRequest(null),
    []
  );

  const handleExitMeetingMode = useCallback(() => {
    setIsMeetingMode(false);
    window.electronAPI?.restoreFromMeetingMode?.();
  }, []);

  const loadTranscriptions = async () => {
    try {
      setIsLoading(true);
      await initializeTranscriptions();
    } catch (error) {
      showAlertDialog({
        title: t("controlPanel.history.couldNotLoadTitle"),
        description: t("controlPanel.history.couldNotLoadDescription"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t("controlPanel.history.clearAllDescription"),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [showConfirmDialog, showAlertDialog, toast, t]);

  const exportTranscription = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.exportTranscription(
          id,
          defaultExportFormat,
          exportDirectory || undefined
        );
        if (result.success) {
          toast({ title: t("controlPanel.history.exportSuccess"), variant: "success", duration: 2000 });
        } else if (result.error) {
          toast({ title: t("controlPanel.history.exportError"), description: result.error, variant: "destructive" });
        }
      } catch (err) {
        toast({ title: t("controlPanel.history.exportError"), variant: "destructive" });
      }
    },
    [defaultExportFormat, exportDirectory, toast, t]
  );

  const exportAllTranscriptions = useCallback(async () => {
    try {
      const result = await window.electronAPI.exportAllTranscriptions(
        defaultExportFormat,
        exportDirectory || undefined
      );
      if (result.success) {
        toast({
          title: t("controlPanel.history.exportAllSuccess", { count: result.count }),
          variant: "success",
          duration: 2000,
        });
      } else if (result.error) {
        toast({ title: t("controlPanel.history.exportError"), description: result.error, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: t("controlPanel.history.exportError"), variant: "destructive" });
    }
  }, [defaultExportFormat, exportDirectory, toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.audioNotFound"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.audioNotFound"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const retryTranscription = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.retryTranscription(id);
        if (result.success && result.transcription) {
          const rawText = result.transcription.text;
          let finalTranscription = result.transcription;

          // Apply AI reasoning if enabled
          if (useReasoningModel) {
            try {
              const [
                { default: ReasoningService },
                { getEffectiveReasoningModel, isCloudReasoningMode },
              ] = await Promise.all([
                import("../services/ReasoningService"),
                import("../stores/settingsStore"),
              ]);
              const model = getEffectiveReasoningModel();
              const isCloud = isCloudReasoningMode();
              if (model || isCloud) {
                const agentName = localStorage.getItem("agentName") || null;
                const reasonedText = await ReasoningService.processText(rawText, model, agentName);
                if (reasonedText && reasonedText !== rawText) {
                  const updated = await window.electronAPI.updateTranscriptionText(
                    id,
                    reasonedText,
                    rawText
                  );
                  if (updated.success && updated.transcription) {
                    finalTranscription = updated.transcription;
                  }
                }
              }
            } catch {
              // Reasoning failed — keep the raw STT result
            }
          }

          updateInStore(finalTranscription);
          toast({ title: t("controlPanel.history.retrySuccess") });
        } else {
          toast({
            title: t("controlPanel.history.retryError"),
            description: result.error,
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.retryError"),
          variant: "destructive",
        });
      }
    },
    [toast, t, useReasoningModel]
  );

  return (
    <div className="h-screen bg-background flex flex-col">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <UpgradePrompt
        open={showUpgradePrompt}
        onOpenChange={setShowUpgradePrompt}
        wordsUsed={limitData?.wordsUsed}
        limit={limitData?.limit}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      {showReferrals && (
        <Suspense fallback={null}>
          <ReferralModal open={showReferrals} onOpenChange={setShowReferrals} />
        </Suspense>
      )}

      {showSearch && (
        <Suspense fallback={null}>
          <CommandSearch
            open={showSearch}
            onOpenChange={setShowSearch}
            transcriptions={history}
            onNoteSelect={(id) => {
              setActiveNoteId(id);
              setActiveView("personal-notes");
            }}
            onTranscriptSelect={() => {
              setActiveView("home");
            }}
          />
        </Suspense>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar overlay */}
        {!isMeetingMode && (
          <>
            {/* Backdrop */}
            <div
              className={cn(
                "absolute inset-0 z-10 bg-black/20 transition-opacity duration-200",
                sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
              )}
              onClick={() => setSidebarOpen(false)}
            />
            <div
              className={cn(
                "absolute top-0 left-0 bottom-0 z-20 transition-transform duration-200 ease-out",
                sidebarOpen ? "translate-x-0" : "-translate-x-full"
              )}
            >
              <ControlPanelSidebar
                activeView={activeView}
                onViewChange={setActiveView}
                onCollapse={() => setSidebarOpen(false)}
                onOpenSearch={() => setShowSearch(true)}
                onOpenSettings={() => {
                  setSettingsSection(undefined);
                  setShowSettings(true);
                }}
                onOpenReferrals={() => setShowReferrals(true)}
                onUpgrade={() => {
                  setSettingsSection("plansBilling");
                  setShowSettings(true);
                }}
                onUpgradeCheckout={() => usage?.openCheckout()}
                isOverLimit={usage?.isOverLimit ?? false}
                userName={user?.name}
                userEmail={user?.email}
                userImage={user?.image}
                isSignedIn={isSignedIn}
                authLoaded={authLoaded}
                isProUser={!!(usage?.isSubscribed || usage?.isTrial)}
                usageLoaded={usage?.hasLoaded ?? false}
              />
            </div>
          </>
        )}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="w-full shrink-0 relative" style={{ height: 40 }}>
            <div
              className="absolute inset-0"
              style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            />
            {isMeetingMode && (
              <div
                className={cn("absolute flex items-center", platform === "darwin" ? "left-[84px] top-[12px]" : "left-2 top-[6px]")}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <Button
                  variant="outline-flat"
                  size="sm"
                  onClick={handleExitMeetingMode}
                  className="h-7 px-2.5 pl-1.5 gap-1"
                >
                  <ChevronLeft size={14} strokeWidth={1.8} />
                  Back to notes
                </Button>
              </div>
            )}
            {platform !== "darwin" && (
              <div className="absolute right-1 top-0 h-full flex items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                <WindowControls />
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto pt-1">
            {activeView === "home" && (
              <Suspense fallback={null}>
                <CalendarView
                  onOpenNote={(noteId) => {
                    setActiveNoteId(noteId);
                    setActiveView("personal-notes");
                  }}
                />
              </Suspense>
            )}
            {activeView === "personal-notes" && (
              <Suspense fallback={null}>
                <PersonalNotesView
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                  meetingRecordingRequest={meetingRecordingRequest}
                  onMeetingRecordingRequestHandled={handleMeetingRecordingRequestHandled}
                  isMeetingMode={isMeetingMode}
                />
              </Suspense>
            )}
            {activeView === "dictionary" && (
              <Suspense fallback={null}>
                <DictionaryView />
              </Suspense>
            )}
            {activeView === "upload" && (
              <Suspense fallback={null}>
                <UploadAudioView
                  onNoteCreated={(noteId, folderId) => {
                    setActiveNoteId(noteId);
                    if (folderId) setActiveFolderId(folderId);
                    setActiveView("personal-notes");
                  }}
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              </Suspense>
            )}
            {activeView === "integrations" && (
              <Suspense fallback={null}>
                <IntegrationsView />
              </Suspense>
            )}
          </div>
        </main>
        {/* Sidebar toggle — rendered after main so it paints above the drag region */}
        {!isMeetingMode && (
          <div
            className={cn(
              "absolute flex items-center z-30",
              platform === "darwin" ? "left-[80px] top-[15px]" : "left-2 top-[6px]"
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={(e) => { e.stopPropagation(); toggleSidebar(); }}
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              className="group flex items-center justify-center w-7 h-7 rounded-md hover:bg-foreground/4 dark:hover:bg-white/4 transition-colors duration-150"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              {sidebarOpen ? (
                <PanelLeftClose
                  size={15}
                  className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
                />
              ) : (
                <PanelLeftOpen
                  size={15}
                  className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
                />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
