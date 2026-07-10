import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";

type SystemAudioMode = "native" | "loopback";

/**
 * Permission state for meeting system-audio capture.
 *
 * On macOS 14.2+ with the macos-audio-tap binary available, the relevant
 * grant is "System Audio Recording Only" (learned from the tap binary's own
 * probe — there is no OS API to query it). On older macOS or when the tap is
 * unavailable, capture falls back to getDisplayMedia loopback, which needs
 * the classic Screen Recording grant — so this hook mirrors that fallback.
 */
export function useSystemAudioPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [granted, setGranted] = useState(!isMacOS);
  const [mode, setMode] = useState<SystemAudioMode>("native");
  const modeRef = useRef<SystemAudioMode>("native");
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (!isMacOS || checkingRef.current) return;
    checkingRef.current = true;
    try {
      const access = await window.electronAPI?.checkSystemAudioAccess?.().catch(() => null);
      if (access?.supported) {
        modeRef.current = "native";
        setMode("native");
        setGranted(access.granted);
        return;
      }
      // Tap unsupported/unavailable — capture will use loopback, gated by
      // the Screen Recording permission.
      modeRef.current = "loopback";
      setMode("loopback");
      const result = await window.electronAPI?.checkScreenRecordingAccess?.();
      setGranted(result?.granted ?? false);
    } finally {
      checkingRef.current = false;
    }
  }, [isMacOS]);

  // Check on mount
  useEffect(() => {
    check();
  }, [check]);

  // Re-check when the window regains focus (user may have just toggled it in System Settings)
  useEffect(() => {
    if (!isMacOS) return;
    const handleFocus = () => check();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isMacOS, check]);

  const openSettings = useCallback(async () => {
    // macOS hosts "Screen & System Audio Recording" in the same privacy pane;
    // there is no dedicated deep link for system audio.
    await window.electronAPI?.openScreenRecordingSettings?.();
  }, []);

  // Trigger the native consent prompt (used in onboarding/settings).
  const request = useCallback(async (): Promise<boolean> => {
    if (!isMacOS) return true;
    if (modeRef.current === "native") {
      // The probe run of the tap binary triggers the macOS consent dialog and
      // waits for the user's answer.
      const result = await window.electronAPI?.requestSystemAudioAccess?.().catch(() => null);
      const ok = result?.granted ?? false;
      setGranted(ok);
      return ok;
    }
    // Loopback fallback: getDisplayMedia forces the Screen Recording prompt.
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      setGranted(true);
      return true;
    } catch {
      return false;
    }
  }, [isMacOS]);

  return { granted, request, openSettings, check, isMacOS, mode };
}
