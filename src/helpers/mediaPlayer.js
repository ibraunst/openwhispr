const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class MediaPlayer {
  constructor() {
    this._linuxBinaryChecked = false;
    this._linuxBinaryPath = null;
    this._nircmdChecked = false;
    this._nircmdPath = null;
    this._macBinaryChecked = false;
    this._macBinaryPath = null;
    this._pausedPlayers = []; // MPRIS players we paused (Linux)
    this._didPause = false; // Whether we sent a pause via toggle fallback
  }

  _resolveLinuxFastPaste() {
    if (this._linuxBinaryChecked) return this._linuxBinaryPath;
    this._linuxBinaryChecked = true;

    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", "linux-fast-paste"),
      path.join(__dirname, "..", "..", "resources", "linux-fast-paste"),
    ];

    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", "linux-fast-paste"));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this._linuxBinaryPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  _resolveNircmd() {
    if (this._nircmdChecked) return this._nircmdPath;
    this._nircmdChecked = true;

    const candidates = [
      path.join(process.resourcesPath || "", "bin", "nircmd.exe"),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          this._nircmdPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  _resolveMacMediaRemote() {
    if (this._macBinaryChecked) return this._macBinaryPath;
    this._macBinaryChecked = true;

    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", "macos-media-remote"),
      path.join(__dirname, "..", "..", "resources", "macos-media-remote"),
    ];

    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", "macos-media-remote"));
      candidates.push(path.join(process.resourcesPath, "resources", "bin", "macos-media-remote"));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this._macBinaryPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  pauseMedia() {
    try {
      if (process.platform === "linux") {
        return this._pauseLinux();
      } else if (process.platform === "darwin") {
        return this._pauseMacOS();
      } else if (process.platform === "win32") {
        return this._pauseWindows();
      }
    } catch (err) {
      debugLogger.warn("Media pause failed", { error: err.message }, "media");
    }
    return false;
  }

  resumeMedia() {
    try {
      if (process.platform === "linux") {
        return this._resumeLinux();
      } else if (process.platform === "darwin") {
        return this._resumeMacOS();
      } else if (process.platform === "win32") {
        return this._resumeWindows();
      }
    } catch (err) {
      debugLogger.warn("Media resume failed", { error: err.message }, "media");
    }
    return false;
  }

  toggleMedia() {
    try {
      if (process.platform === "linux") {
        return this._toggleLinux();
      } else if (process.platform === "darwin") {
        return this._toggleMacOS();
      } else if (process.platform === "win32") {
        return this._toggleWindows();
      }
    } catch (err) {
      debugLogger.warn("Media toggle failed", { error: err.message }, "media");
    }
    return false;
  }

  // --- Linux: MPRIS-aware pause/resume ---

  _pauseLinux() {
    this._pausedPlayers = [];
    if (this._pauseMpris()) return true;

    // Fallback: playerctl pause (not play-pause)
    const result = spawnSync("playerctl", ["pause"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (result.status === 0) {
      debugLogger.debug("Media paused via playerctl", {}, "media");
      this._pausedPlayers = ["playerctl"];
      return true;
    }

    return false;
  }

  _resumeLinux() {
    if (this._pausedPlayers.length === 0) return false;

    // If we used playerctl fallback
    if (this._pausedPlayers.length === 1 && this._pausedPlayers[0] === "playerctl") {
      this._pausedPlayers = [];
      const result = spawnSync("playerctl", ["play"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media resumed via playerctl", {}, "media");
        return true;
      }
      return false;
    }

    const resumed = this._resumeMpris();
    this._pausedPlayers = [];
    return resumed;
  }

  _pauseMpris() {
    const players = this._listMprisPlayers();
    if (!players || players.length === 0) return false;

    for (const dest of players) {
      const status = this._getMprisPlaybackStatus(dest);
      if (status !== "Playing") continue;

      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.Pause",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media paused via MPRIS", { player: dest }, "media");
        this._pausedPlayers.push(dest);
      }
    }
    return this._pausedPlayers.length > 0;
  }

  _resumeMpris() {
    let resumed = false;
    for (const dest of this._pausedPlayers) {
      if (dest === "playerctl") continue;
      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.Play",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media resumed via MPRIS", { player: dest }, "media");
        resumed = true;
      }
    }
    return resumed;
  }

  _getMprisPlaybackStatus(dest) {
    const result = spawnSync(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        `--dest=${dest}`,
        "/org/mpris/MediaPlayer2",
        "org.freedesktop.DBus.Properties.Get",
        "string:org.mpris.MediaPlayer2.Player",
        "string:PlaybackStatus",
      ],
      { stdio: "pipe", timeout: 2000 }
    );

    if (result.status !== 0) return null;

    const output = result.stdout?.toString() || "";
    const match = output.match(/string "([A-Za-z]+)"/);
    return match ? match[1] : null;
  }

  _listMprisPlayers() {
    const listResult = spawnSync(
      "dbus-send",
      [
        "--session",
        "--dest=org.freedesktop.DBus",
        "--type=method_call",
        "--print-reply",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.ListNames",
      ],
      { stdio: "pipe", timeout: 2000 }
    );

    if (listResult.status !== 0) return [];

    const output = listResult.stdout?.toString() || "";
    const matches = output.match(/string "org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.\-]+"/g);
    if (!matches || matches.length === 0) return [];

    return matches.map((m) => m.replace(/^string "/, "").replace(/"$/, ""));
  }

  // --- Linux toggle (legacy, used by toggleMedia) ---

  _toggleLinux() {
    if (this._toggleMpris()) return true;

    const binary = this._resolveLinuxFastPaste();
    if (binary) {
      const result = spawnSync(binary, ["--media-play-pause"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media toggled via linux-fast-paste", {}, "media");
        return true;
      }
    }

    const result = spawnSync("playerctl", ["play-pause"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (result.status === 0) {
      debugLogger.debug("Media toggled via playerctl", {}, "media");
      return true;
    }

    debugLogger.warn("No media control method available on Linux", {}, "media");
    return false;
  }

  _toggleMpris() {
    const players = this._listMprisPlayers();
    if (!players || players.length === 0) return false;

    let toggled = false;
    for (const dest of players) {
      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.PlayPause",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media toggled via MPRIS", { player: dest }, "media");
        toggled = true;
      }
    }
    return toggled;
  }

  // --- macOS: MediaRemote-aware pause/resume ---

  _runAppleScript(script) {
    const result = spawnSync("osascript", ["-"], {
      input: script,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const stdout = (result.stdout?.toString() || "").trim();
    const stderr = (result.stderr?.toString() || "").trim();
    return { status: result.status, stdout, stderr };
  }

  _isPodcastsPlaying() {
    // Check if Podcasts is running and playing by inspecting the Controls menu.
    // If first menu item is "Pause", a podcast is playing.
    const script = `
      tell application "System Events"
        if not (exists process "Podcasts") then return false
        try
          set menuName to name of menu item 1 of menu 1 of menu bar item "Controls" of menu bar 1 of process "Podcasts"
          return menuName is "Pause"
        on error
          return false
        end try
      end tell
    `;
    const { status, stdout } = this._runAppleScript(script);
    return status === 0 && stdout.trim().toLowerCase() === "true";
  }

  _clickPodcastsPlayPause() {
    // Click the first item in the Controls menu (Play or Pause toggle)
    const script = `
      tell application "System Events"
        if not (exists process "Podcasts") then return
        try
          click menu item 1 of menu 1 of menu bar item "Controls" of menu bar 1 of process "Podcasts"
        end try
      end tell
    `;
    this._runAppleScript(script);
  }

  _isMusicAppRunning() {
    const script = `tell application "System Events" to return (exists process "Music")`;
    const { status, stdout } = this._runAppleScript(script);
    return status === 0 && stdout.trim().toLowerCase() === "true";
  }

  _isSpotifyPlaying() {
    const script = `
      tell application "System Events"
        if not (exists process "Spotify") then return false
      end tell
      try
        tell application "Spotify" to return (player state is playing)
      on error
        return false
      end try
    `;
    const { status, stdout } = this._runAppleScript(script);
    return status === 0 && stdout.trim().toLowerCase() === "true";
  }

  _isMusicAppPlaying() {
    // Check if Apple Music is currently playing (not paused/stopped).
    // Only checks if Music.app is already running — won't launch it.
    const script = `
      tell application "System Events"
        if not (exists process "Music") then return false
      end tell
      try
        tell application "Music" to return (player state is playing)
      on error
        return false
      end try
    `;
    const { status, stdout } = this._runAppleScript(script);
    return status === 0 && stdout.trim().toLowerCase() === "true";
  }

  _isMacMediaPlayingViaAppleScript() {
    // Check if any media app is actively playing via AppleScript.
    // Uses "System Events" to check process existence first (avoids launching apps).
    // Then queries each running player for its state.
    const script = `
      set isPlaying to false
      tell application "System Events"
        set runningApps to name of every process
      end tell

      -- Apple Music
      if runningApps contains "Music" then
        try
          tell application "Music"
            if player state is playing then set isPlaying to true
          end tell
        end try
      end if

      -- Spotify
      if not isPlaying and runningApps contains "Spotify" then
        try
          tell application "Spotify"
            if player state is playing then set isPlaying to true
          end tell
        end try
      end if

      -- Apple Podcasts (no direct AppleScript, check via Media key response)
      -- Chrome, Safari, etc. respond to media keys but can't be queried via AppleScript

      return isPlaying
    `;

    const { status, stdout } = this._runAppleScript(script);
    if (status === 0) {
      const result = stdout.trim().toLowerCase();
      if (result === "true") return true;
    }

    // Fallback: check MediaRemote binary
    const mrPlaying = this._isMacMediaPlaying();
    if (mrPlaying === true) return true;

    return false;
  }

  _isMacMediaPlaying() {
    const binary = this._resolveMacMediaRemote();
    if (!binary) return null;

    const result = spawnSync(binary, ["--is-playing"], {
      stdio: "pipe",
      timeout: 2000,
    });

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      return output === "PLAYING";
    }
    return null;
  }

  _isMacAudioDeviceActive() {
    const binary = this._resolveMacMediaRemote();
    if (!binary) return null;

    const result = spawnSync(binary, ["--is-device-active"], {
      stdio: "pipe",
      timeout: 2000,
    });

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      return output === "ACTIVE";
    }
    return null;
  }

  _pauseMacOS() {
    this._didPause = false;
    this._pausedMacApps = [];

    // Pause each known media app directly via AppleScript.
    // No media key — it always auto-starts Music.app and can't be prevented.

    // Apple Music
    if (this._isMusicAppPlaying()) {
      this._runAppleScript('tell application "Music" to pause');
      this._pausedMacApps.push("Music");
      debugLogger.debug("Paused Music.app via AppleScript", {}, "media");
    }

    // Spotify
    if (this._isSpotifyPlaying()) {
      this._runAppleScript('tell application "Spotify" to pause');
      this._pausedMacApps.push("Spotify");
      debugLogger.debug("Paused Spotify via AppleScript", {}, "media");
    }

    // Apple Podcasts (uses UI scripting — Controls > Pause menu item)
    if (this._isPodcastsPlaying()) {
      this._clickPodcastsPlayPause();
      this._pausedMacApps.push("Podcasts");
      debugLogger.debug("Paused Podcasts via UI scripting", {}, "media");
    }

    if (this._pausedMacApps.length > 0) {
      this._didPause = true;
      return true;
    }

    return false;
  }

  _resumeMacOS() {
    if (!this._didPause) return false;
    this._didPause = false;

    const apps = this._pausedMacApps || [];
    this._pausedMacApps = [];

    for (const app of apps) {
      if (app === "Music") {
        this._runAppleScript('tell application "Music" to play');
        debugLogger.debug("Resumed Music.app via AppleScript", {}, "media");
      } else if (app === "Spotify") {
        this._runAppleScript('tell application "Spotify" to play');
        debugLogger.debug("Resumed Spotify via AppleScript", {}, "media");
      } else if (app === "Podcasts") {
        this._clickPodcastsPlayPause();
        debugLogger.debug("Resumed Podcasts via UI scripting", {}, "media");
      }
    }

    return apps.length > 0;
  }

  _sendMacMediaCommand(command) {
    const binary = this._resolveMacMediaRemote();
    if (binary) {
      const result = spawnSync(binary, [command], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        const output = (result.stdout?.toString() || "").trim();
        return output === "OK";
      }
    }
    return false;
  }

  _sendMacMediaKey() {
    // Use the precompiled binary which sends NX_KEYTYPE_PLAY via CGEvent.
    // This pauses/resumes ANY now-playing source (Music, Podcasts, Spotify,
    // Chrome, Safari, etc.) without stealing focus.
    const binary = this._resolveMacMediaRemote();
    if (binary) {
      const result = spawnSync(binary, ["--toggle"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media key sent via CGEvent binary", {}, "media");
        return true;
      }
    }

    // Fallback to osascript (may steal focus)
    const result = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 100'],
      { stdio: "pipe", timeout: 3000 }
    );
    if (result.status === 0) {
      debugLogger.debug("Media key sent via osascript fallback", {}, "media");
      return true;
    }
    return false;
  }

  _toggleMacOS() {
    const result = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 100'],
      {
        stdio: "pipe",
        timeout: 3000,
      }
    );
    if (result.status === 0) {
      debugLogger.debug("Media toggled via osascript", {}, "media");
      return true;
    }
    return false;
  }

  // --- Windows: GSMTC-aware pause/resume ---

  _gsmtcPauseScript() {
    return `
try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
  $paused = @()
  foreach ($s in $m.GetSessions()) {
    $pi = $s.GetPlaybackInfo()
    if ($pi.PlaybackStatus -eq 4) {
      $null = $s.TryPauseAsync().GetAwaiter().GetResult()
      $paused += $s.SourceAppUserModelId
    }
  }
  $paused -join '|'
} catch {
  Write-Output 'GSMTC_FAIL'
}`.trim();
  }

  _gsmtcResumeScript(appIds) {
    const idList = appIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    return `
try {
  $ids = @(${idList})
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
  foreach ($s in $m.GetSessions()) {
    if ($ids -contains $s.SourceAppUserModelId) {
      $null = $s.TryPlayAsync().GetAwaiter().GetResult()
    }
  }
  Write-Output 'OK'
} catch {
  Write-Output 'GSMTC_FAIL'
}`.trim();
  }

  _isWindowsAudioPlaying() {
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class AudioPeakMeter {
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
        int GetPeakValue(out float peak);
    }

    public static float GetPeak() {
        var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(type);
        IntPtr devicePtr;
        enumerator.GetDefaultAudioEndpoint(0, 1, out devicePtr);
        var device = (IMMDevice)Marshal.GetObjectForIUnknown(devicePtr);
        Marshal.Release(devicePtr);
        object activated;
        device.Activate(new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), 1, IntPtr.Zero, out activated);
        var meter = (IAudioMeterInformation)activated;
        float peak;
        meter.GetPeakValue(out peak);
        return peak;
    }
}
'@
try {
    $peak = [AudioPeakMeter]::GetPeak()
    if ($peak -gt 0) { Write-Output 'PLAYING' } else { Write-Output 'SILENT' }
} catch {
    Write-Output 'UNKNOWN'
}`.trim();

    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "pipe",
      timeout: 5000,
    });

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      if (output === "PLAYING") return true;
      if (output === "SILENT") return false;
    }
    return null; // unknown
  }

  _sendWindowsMediaKey() {
    const nircmd = this._resolveNircmd();
    if (nircmd) {
      const result = spawnSync(nircmd, ["sendkeypress", "0xB3"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) return true;
    }

    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class KB { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [KB]::keybd_event(0xB3, 0, 1, 0); [KB]::keybd_event(0xB3, 0, 3, 0)",
      ],
      {
        stdio: "pipe",
        timeout: 5000,
      }
    );
    return result.status === 0;
  }

  _pauseWindows() {
    this._pausedWinApps = [];

    // Try GSMTC first (Windows 10 1809+)
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcPauseScript()],
      { stdio: "pipe", timeout: 5000 }
    );

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      if (output && output !== "GSMTC_FAIL") {
        this._pausedWinApps = output.split("|").filter(Boolean);
        if (this._pausedWinApps.length > 0) {
          debugLogger.debug("Media paused via GSMTC", { apps: this._pausedWinApps }, "media");
          return true;
        }
        // GSMTC worked but nothing was playing
        return false;
      }
    }

    // Fallback: check if audio is actually playing before sending toggle key
    debugLogger.debug("GSMTC unavailable, checking audio peak meter", {}, "media");
    this._didPause = false;
    const isPlaying = this._isWindowsAudioPlaying();
    if (isPlaying === false) {
      debugLogger.debug(
        "No audio playing, skipping media key to avoid starting playback",
        {},
        "media"
      );
      return false;
    }
    if (isPlaying === null) {
      debugLogger.debug("Could not detect audio state, skipping media key to be safe", {}, "media");
      return false;
    }
    if (this._sendWindowsMediaKey()) {
      debugLogger.debug("Media paused via Windows media key", {}, "media");
      this._didPause = true;
      return true;
    }
    return false;
  }

  _resumeWindows() {
    // Resume via GSMTC if we paused that way
    if (this._pausedWinApps && this._pausedWinApps.length > 0) {
      const apps = this._pausedWinApps;
      this._pausedWinApps = [];

      const result = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcResumeScript(apps)],
        { stdio: "pipe", timeout: 5000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media resumed via GSMTC", { apps }, "media");
        return true;
      }
      return false;
    }

    // Fallback: only toggle back if we toggled on pause
    if (!this._didPause) return false;
    this._didPause = false;
    if (this._sendWindowsMediaKey()) {
      debugLogger.debug("Media resumed via Windows media key", {}, "media");
      return true;
    }
    return false;
  }

  _toggleWindows() {
    if (this._sendWindowsMediaKey()) {
      debugLogger.debug("Media toggled via Windows media key", {}, "media");
      return true;
    }
    return false;
  }
}

module.exports = new MediaPlayer();
