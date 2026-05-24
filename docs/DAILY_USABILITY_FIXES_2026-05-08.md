# Daily Usability Fixes - 2026-05-08

## Scope

This pass focuses on making the desktop and Android clients comfortable for daily use rather than adding new transfer protocols.

## Required Fixes

1. Chat message usability
   - Text messages must be selectable.
   - Text messages need a one-tap copy action.
   - File/image receive cards should not show a download button because files are already auto-saved.
   - Failed sends need a clearer error and an obvious retry action.
   - Android chat bottom padding must keep the latest message fully visible above the input bar.

2. Desktop device and chat layout
   - Offline device names and last-seen text must not be clipped.
   - Remove favorite buttons/icons from desktop and Android.
   - Add a draggable splitter between the device list and message area.
   - Enforce sidebar width min/max to keep both sides usable.

3. File operations
   - Desktop sent-file cards need a right-click menu entry: open original file location.
   - If the source file no longer exists, show a friendly error.

4. Android picking
   - Image selection must use the Android photo/gallery picker path, not the generic file picker.
   - File selection must use Android's file manager.
   - Both should support multiple selections where the system picker supports it.

5. History
   - Desktop and Android history items should show the peer device name instead of only device id.
   - Android history header/filter area must remain visible and not be covered by long lists.

6. Presence and persistence
   - Keep discovered devices saved whether online or offline.
   - Update online/offline status automatically.
   - Device deletion remains user controlled.

## Verification Plan

- Run `npm run build` after UI changes.
- Run `cargo test` after Rust command changes.
- Build Android only after Kotlin bridge changes.
- Use adb screenshots for Android layout checks.
- Avoid rebuilding after every small UI edit; batch verification at stable points.
