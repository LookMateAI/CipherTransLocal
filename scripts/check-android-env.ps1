$ErrorActionPreference = "Continue"

function Write-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail = ""
  )

  $status = if ($Ok) { "OK" } else { "MISSING" }
  $color = if ($Ok) { "Green" } else { "Yellow" }
  Write-Host ("[{0}] {1} {2}" -f $status, $Name, $Detail) -ForegroundColor $color
}

$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { [Environment]::GetEnvironmentVariable("ANDROID_HOME", "User") }
$androidSdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { [Environment]::GetEnvironmentVariable("ANDROID_SDK_ROOT", "User") }
$ndkHome = if ($env:NDK_HOME) { $env:NDK_HOME } else { [Environment]::GetEnvironmentVariable("NDK_HOME", "User") }

if ($androidHome) {
  $env:ANDROID_HOME = $androidHome
}
if ($androidSdkRoot) {
  $env:ANDROID_SDK_ROOT = $androidSdkRoot
}
if ($ndkHome) {
  $env:NDK_HOME = $ndkHome
}

if ($androidHome -and (Test-Path $androidHome)) {
  $candidatePathEntries = @(
    (Join-Path $androidHome "platform-tools"),
    (Join-Path $androidHome "cmdline-tools\latest\bin"),
    (Join-Path $androidHome "emulator")
  )
  foreach ($entry in $candidatePathEntries) {
    if ((Test-Path $entry) -and (($env:Path -split ";") -notcontains $entry)) {
      $env:Path = "$env:Path;$entry"
    }
  }
}

Write-Check "ANDROID_HOME" (-not [string]::IsNullOrWhiteSpace($androidHome) -and (Test-Path $androidHome)) $androidHome
Write-Check "ANDROID_SDK_ROOT" (-not [string]::IsNullOrWhiteSpace($androidSdkRoot) -and (Test-Path $androidSdkRoot)) $androidSdkRoot
Write-Check "NDK_HOME" (-not [string]::IsNullOrWhiteSpace($ndkHome) -and (Test-Path $ndkHome)) $ndkHome

$adb = Get-Command adb -ErrorAction SilentlyContinue
Write-Check "adb" ($null -ne $adb) ($(if ($adb) { $adb.Source } else { "" }))

$sdkmanager = Get-Command sdkmanager -ErrorAction SilentlyContinue
Write-Check "sdkmanager" ($null -ne $sdkmanager) ($(if ($sdkmanager) { $sdkmanager.Source } else { "" }))

$tauriVersion = npm run tauri -- --version 2>$null
Write-Check "Tauri CLI" ($LASTEXITCODE -eq 0) (($tauriVersion | Select-Object -Last 1) -join " ")

$targets = rustup target list --installed 2>$null
$requiredTargets = @(
  "aarch64-linux-android",
  "armv7-linux-androideabi",
  "i686-linux-android",
  "x86_64-linux-android"
)

foreach ($target in $requiredTargets) {
  Write-Check "Rust target $target" ($targets -contains $target)
}

if ($androidHome -and (Test-Path $androidHome)) {
  $platformTools = Join-Path $androidHome "platform-tools"
  $cmdlineTools = Join-Path $androidHome "cmdline-tools\latest\bin"
  Write-Check "platform-tools dir" (Test-Path $platformTools) $platformTools
  Write-Check "cmdline-tools latest dir" (Test-Path $cmdlineTools) $cmdlineTools
}
