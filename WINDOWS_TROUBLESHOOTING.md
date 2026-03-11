# Windows Troubleshooting

## Quick Fixes

### No Window Appears

**Symptoms:** customWhispr runs in Task Manager but no window shows

**Solutions:**
1. Check system tray (click ^ caret) for customWhispr icon
2. Run with debug: `customWhispr.exe --log-level=debug`
3. Try disabling GPU: `customWhispr.exe --disable-gpu`

### No Transcriptions

**Symptoms:** Recording works but no text appears

**Solutions:**
1. Check microphone permissions: Settings → Privacy → Microphone
2. Verify mic is selected: Sound settings → Input
3. Test recording in Windows Voice Recorder first

### whisper.cpp Not Working

**Symptoms:** Local transcription fails

**Solutions:**
1. whisper.cpp is bundled with the app - try reinstalling
2. If running from source, run `npm run download:whisper-cpp` and confirm `resources\\bin\\whisper-cpp-win32-x64.exe` exists
3. Check antivirus isn't blocking the whisper-cpp executable
4. Clear model cache: delete `%USERPROFILE%\.cache\customwhispr\whisper-models`
5. Try cloud mode as fallback

### FFmpeg Issues

**Symptoms:** Transcription fails silently

**Solutions:**
1. Reinstall customWhispr (FFmpeg is bundled)
2. Check antivirus isn't quarantining FFmpeg
3. Install system FFmpeg and add to PATH if needed

## Debug Mode

```batch
# Run with debug logging
customWhispr.exe --log-level=debug

# Or set in .env file at %APPDATA%\customWhispr\.env
CUSTOMWHISPR_LOG_LEVEL=debug
```

Logs saved to: `%APPDATA%\customWhispr\logs\`

## Common Errors

| Error | Meaning | Fix |
|-------|---------|-----|
| Audio buffer empty | Mic not capturing | Check permissions, try different mic |
| whisper.cpp not found | Binary not accessible | Reinstall app, check antivirus |
| FFmpeg not found | Can't find FFmpeg | Reinstall app, check antivirus |
| Model download failed | Can't download GGML model | Check internet; try cloud mode |

## Windows-Specific Tips

### Windows Defender
Add customWhispr to exclusions if blocked:
Settings → Virus & threat protection → Exclusions

### Firewall (Cloud Mode)
Allow customWhispr through firewall for cloud transcription

### Permission Errors
Right-click → Run as administrator (or set in Properties → Compatibility)

## Complete Reset

```batch
# Uninstall customWhispr first, then:
rd /s /q "%APPDATA%\customWhispr"
rd /s /q "%LOCALAPPDATA%\customWhispr"
```

Then reinstall.

## Getting Help

Report issues at https://github.com/customWhispr/customwhispr/issues with:
- Windows version (`winver`)
- customWhispr version
- Debug log contents
- Steps to reproduce
