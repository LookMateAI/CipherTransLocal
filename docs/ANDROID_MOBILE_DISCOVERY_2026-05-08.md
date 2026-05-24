# Android Mobile UI and Discovery Notes

Date: 2026-05-08

## Scope

This pass separates the Android experience from the desktop layout while keeping the same MultiTrans visual language. It also fixes the Android/desktop discovery path on Android 16.

## Mobile UI

- Added `src/components/MobileShell.tsx`.
- Android/mobile now uses a bottom tab layout: Devices, History, Settings.
- The device page is optimized for phone use: top identity area, one-tap refresh, nearby device cards, favorite action, and empty state.
- The chat page uses a mobile top bar with back navigation and a fixed bottom input area.
- `src/index.css` now includes mobile-specific safe-area handling, chat input placement, compact buttons, message bubble widths, and desktop-header hiding.

## Discovery Fixes

- Android 16 requires `android.permission.NEARBY_WIFI_DEVICES`; without it, UDP broadcast can fail with `Operation not permitted`.
- `src-tauri/gen/android/app/src/main/AndroidManifest.xml` now declares `NEARBY_WIFI_DEVICES` with `neverForLocation`.
- `MainActivity.kt` requests the local network permission and acquires a `WifiManager.MulticastLock`.
- `DiscoveryService` now uses separate UDP sockets:
  - receive socket binds to `0.0.0.0:7890`;
  - send socket uses an ephemeral port for broadcast.
- `socket2` is used so the receive socket can set reuse options before bind.
- Broadcast targets are filtered to avoid virtual/cellular interfaces such as `tun`, `rmnet`, and `lo`.
- Peer IP is taken from the UDP packet source address, which avoids bad advertised IP values such as `0.0.0.0`.

## Verification

- Device: RMX5010, Android 16.
- APK installed and launched without crash.
- Android permission state: `NEARBY_WIFI_DEVICES: granted=true`.
- Android process listens on UDP `0.0.0.0:7890`.
- PC network: `10.130.168.99/24`.
- Android network: `10.130.168.225/24`.
- PC temporary UDP listener received Android announces:
  - source: `10.130.168.225:<ephemeral>`;
  - payload field: `"type":"device_announce"`.
- Android received a correctly formatted desktop announce:
  - payload uses `"type":"device_announce"`;
  - Android UI displayed `Desktop Correct` and `10.130.168.99`.

## Artifact

Latest signed APK:

```text
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-signed.apk
```

Observed size:

```text
20,870,543 bytes
```
