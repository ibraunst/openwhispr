import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/Toast";
import { WaveformDots } from "./components/ui/WaveformDots";
import { useHotkey } from "./hooks/useHotkey";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore, setAppIcon } from "./stores/settingsStore";


// Voice Wave Animation Component (for processing state)
const VoiceWaveIndicator = ({ isListening }) => {
  return (
    <div className="flex items-center justify-center gap-0.5">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={`w-0.5 bg-white rounded-full transition-[height] duration-150 ${
            isListening ? "animate-pulse h-4" : "h-2"
          }`}
          style={{
            animationDelay: isListening ? `${i * 0.1}s` : "0s",
            animationDuration: isListening ? `${0.6 + i * 0.1}s` : "0s",
          }}
        />
      ))}
    </div>
  );
};


export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const { toast, dismiss, toastCount } = useToast();
  const { t } = useTranslation();
  useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);
  const [activeApp, setActiveApp] = useState(null); // { name, bundleId, icon }

  // Activation mode (tap vs push/hold)
  const activationMode = useSettingsStore((s) => s.activationMode);
  const setActivationMode = useSettingsStore((s) => s.setActivationMode);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const prevAutoHideRef = useRef(floatingIconAutoHide);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: data.message,
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const unsubscribeAccessibility = window.electronAPI?.onAccessibilityMissing?.(() => {
      toast({
        title: t("app.toasts.accessibilityMissing.title"),
        description: t("app.toasts.accessibilityMissing.description"),
        duration: 12000,
      });
    });

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `\u201c${w}\u201d`).join(", ");
        let toastId;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          variant: "success",
          duration: 6000,
          action: (
            <button
              onClick={async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) {
                    dismiss(toastId);
                  }
                } catch {
                  // silently fail — word stays in dictionary
                }
              }}
              className="text-[10px] font-medium px-2.5 py-1 rounded-sm whitespace-nowrap
                text-emerald-100/90 hover:text-white
                bg-emerald-500/15 hover:bg-emerald-500/25
                border border-emerald-400/20 hover:border-emerald-400/35
                transition-all duration-150"
            >
              {t("app.toasts.undo")}
            </button>
          ),
        });
      }
    });

    const unsubscribePermissions = window.electronAPI?.onPermissionsNeedReauth?.((revoked) => {
      if (!revoked || revoked.length === 0) return;
      toast({
        title: t("app.toasts.permissionsRevoked.title"),
        description: t("app.toasts.permissionsRevoked.description"),
        duration: Infinity,
        action: (
          <button
            onClick={() => window.electronAPI?.showControlPanel?.()}
            className="text-[10px] font-medium px-2.5 py-1 rounded-sm whitespace-nowrap
              text-amber-100/90 hover:text-white
              bg-amber-500/15 hover:bg-amber-500/25
              border border-amber-400/20 hover:border-amber-400/35
              transition-all duration-150"
          >
            {t("app.toasts.permissionsRevoked.action")}
          </button>
        ),
      });
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeAccessibility?.();
      unsubscribeCorrections?.();
      unsubscribePermissions?.();
    };
  }, [toast, dismiss, t]);

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, setWindowInteractivity]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const { isRecording, isProcessing, toggleListening, cancelRecording, cancelProcessing, getVolume } =
    useAudioRecording(toast, {
      onToggle: handleDictationToggle,
    });

  // Listen for frontmost app info pushed from the main process when dictation starts
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFrontmostAppDetected?.((app) => {
      if (app && app.bundleId && app.name) {
        setActiveApp(app);
        useSettingsStore.getState().setActiveApp(app.bundleId, app.name);
        // Fetch icon asynchronously
        window.electronAPI?.getAppIcon?.(app.bundleId).then((icon) => {
          if (icon) {
            setActiveApp((prev) => (prev ? { ...prev, icon } : prev));
            setAppIcon(app.bundleId, icon);
          }
        });
      }
    });
    return () => unsubscribe?.();
  }, []);

  // Clear active app when recording and processing both stop
  useEffect(() => {
    if (!isRecording && !isProcessing) {
      setActiveApp(null);
      useSettingsStore.getState().setActiveApp(null);
    }
  }, [isRecording, isProcessing]);

  useEffect(() => {
    const resizeWindow = () => {
      if (isCommandMenuOpen && toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("EXPANDED");
      } else if (isCommandMenuOpen) {
        window.electronAPI?.resizeMainWindow?.("WITH_MENU");
      } else if (toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("WITH_TOAST");
      } else if (isRecording || isProcessing) {
        window.electronAPI?.resizeMainWindow?.("RECORDING");
      } else {
        window.electronAPI?.resizeMainWindow?.("BASE");
      }
    };
    resizeWindow();
  }, [isCommandMenuOpen, toastCount, isRecording, isProcessing]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (floatingIconAutoHide && !isRecording && !isProcessing && toastCount === 0) {
      // Hide immediately to prevent the idle icon from flashing on screen
      // after the recording/processing cycle ends.
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 50);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [isRecording, isProcessing, floatingIconAutoHide, toastCount]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        setIsCommandMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen]);

  // Determine current mic state
  const showPill = isRecording || isProcessing;

  return (
    <div className="dictation-window">
      {/* Recording pill overlay */}
      {showPill && (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-stretch"
          onMouseEnter={() => {
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            setWindowInteractivity(false);
          }}
        >
          <div
            className="flex flex-col items-start rounded-[18px] backdrop-blur-2xl cursor-pointer w-full"
            style={{
              background: "rgba(40, 40, 40, 0.75)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4), inset 0 0.5px 0 rgba(255,255,255,0.08)",
              padding: "7px 14px 5px",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
            onClick={() => {
              if (!hasDragged) toggleListening();
            }}
            onMouseDown={(e) => {
              setDragStartPos({ x: e.clientX, y: e.clientY });
              setHasDragged(false);
              handleMouseDown(e);
            }}
            onMouseMove={(e) => {
              if (dragStartPos && !hasDragged) {
                const distance = Math.sqrt(
                  Math.pow(e.clientX - dragStartPos.x, 2) +
                    Math.pow(e.clientY - dragStartPos.y, 2)
                );
                if (distance > 5) setHasDragged(true);
              }
            }}
            onMouseUp={(e) => {
              handleMouseUp(e);
              setDragStartPos(null);
            }}
          >
            {/* Top: active app icon + name + activation mode dot */}
            <div className="flex items-center gap-2 mb-1 w-full">
              {activeApp?.name && (
                <>
                  {activeApp?.icon ? (
                    <img
                      src={activeApp.icon}
                      alt=""
                      className="rounded-md"
                      style={{ width: 20, height: 20 }}
                      draggable={false}
                    />
                  ) : (
                    <div className="rounded-md bg-white/15" style={{ width: 20, height: 20 }} />
                  )}
                  <span
                    className="text-white font-medium flex-1 min-w-0 truncate"
                    style={{ fontSize: 13, letterSpacing: "-0.01em" }}
                  >
                    {activeApp.name}
                  </span>
                </>
              )}
              {!activeApp?.name && <div className="flex-1" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const next = activationMode === "push" ? "tap" : "push";
                  setActivationMode(next);
                }}
                title={activationMode === "push" ? t("app.holdMode") : t("app.tapMode")}
                className="flex-shrink-0 flex items-center justify-center"
                style={{ width: 20, height: 20 }}
              >
                <div
                  className="rounded-full transition-all duration-200"
                  style={{
                    width: 7,
                    height: 7,
                    background: activationMode === "push"
                      ? "rgba(255, 255, 255, 0.85)"
                      : "rgba(255, 255, 255, 0.15)",
                    boxShadow: activationMode === "push"
                      ? "0 0 6px rgba(255, 255, 255, 0.5)"
                      : "none",
                  }}
                />
              </button>
            </div>

            {/* Bottom: animated dashed waveform */}
            <WaveformDots isActive={isRecording} getVolume={getVolume} />
          </div>
        </div>
      )}

      {/* Idle state - invisible but keeps window alive for hotkey activation */}
      {!showPill && <div className="fixed inset-0" />}
    </div>
  );
}
