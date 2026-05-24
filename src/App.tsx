import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, TauriEvent } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { AlertCircle, MonitorSmartphone, Radar, RefreshCw } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { ChatWindow } from './components/ChatWindow'
import { Settings } from './components/Settings'
import { History } from './components/History'
import { MobileShell } from './components/MobileShell'
import { Device, ChatMessage, Settings as SettingsType } from './types'
import { getDeviceDisplayName } from './utils/device'
import { userFriendlyError } from './utils/errors'

declare global {
  interface Window {
    __CIPHERTRANSLOCAL_HANDLE_ANDROID_BACK__?: () => boolean
    CipherTransLocalAndroid?: {
      pickImages: () => void
      pickFiles: () => void
      pickReceiveDirectory: () => void
      publishReceivedFile: (path: string, fileName: string, fileType: string, saveToGallery: boolean, saveToDownloads: boolean) => string
      setTransferPerformanceMode?: (enabled: boolean) => void
      setColorScheme?: (theme: SettingsType['theme']) => void
      showKeyboard?: () => void
    }
  }
}

type View = 'devices' | 'history' | 'settings'
type PickMode = 'file' | 'image'
type PendingFileMeta = { name: string; size: number; type: ChatMessage['file_type'] }
type PreparingSend = { device: Device; count: number; startedAt: number; placeholderIds: string[] }
const STARTUP_DISCOVERY_DURATION_MS = 10_000
const STARTUP_DISCOVERY_INTERVAL_MS = 2_500
const STARTUP_DISCOVERY_SECONDS = STARTUP_DISCOVERY_DURATION_MS / 1000

function applyAppTheme(theme: SettingsType['theme']) {
  if (typeof document === 'undefined') return

  const isDark = theme === 'dark'
  const root = document.documentElement
  root.dataset.theme = theme
  root.classList.toggle('theme-dark', isDark)
  root.classList.toggle('dark', isDark)
  root.style.colorScheme = theme

  document.body.dataset.theme = theme
  document.body.classList.toggle('theme-dark', isDark)
  document.body.style.colorScheme = theme

  window.CipherTransLocalAndroid?.setColorScheme?.(theme)
}

function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [currentDevice, setCurrentDevice] = useState<Device | null>(null)
  const [currentView, setCurrentView] = useState<View>('devices')
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [loadingMessageDeviceIds, setLoadingMessageDeviceIds] = useState<Set<string>>(() => new Set())
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const [settings, setSettings] = useState<SettingsType | null>(null)
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [startupDiscoveryRemaining, setStartupDiscoveryRemaining] = useState(0)
  const [manualDiscoveryRemaining, setManualDiscoveryRemaining] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendingText, setSendingText] = useState(false)
  const [preparingSend, setPreparingSend] = useState<PreparingSend | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.innerWidth < 768)
  const [sidebarWidth, setSidebarWidth] = useState(304)
  const currentDeviceRef = useRef<Device | null>(null)
  const sendingRef = useRef(false)
  const sendingTextRef = useRef(false)
  const preparingSendRef = useRef<PreparingSend | null>(null)
  const discoveryInFlightRef = useRef(0)
  const startupDiscoveryActiveRef = useRef(false)
  const manualDiscoveryActiveRef = useRef(false)
  const startupDiscoveryTimersRef = useRef<{ discoveryIntervalId: number; countdownIntervalId: number; timeoutId: number } | null>(null)
  const manualDiscoveryTimersRef = useRef<{ discoveryIntervalId: number; countdownIntervalId: number; timeoutId: number } | null>(null)
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null)
  const deviceNames = useMemo(
    () =>
      Object.fromEntries(
        devices.map((device) => [device.device_id, getDeviceDisplayName(device)])
      ),
    [devices]
  )
  const hasActiveTransfer = useMemo(
    () =>
      Object.values(messages).some((deviceMessages) =>
        deviceMessages.some((message) => ['pending', 'transferring', 'paused'].includes(message.status))
      ),
    [messages]
  )
  const deleteLockedDeviceIds = useMemo(() => {
    const locked = new Set<string>()
    Object.entries(messages).forEach(([deviceId, deviceMessages]) => {
      if (deviceMessages.some(isDeleteLockedMessage)) locked.add(deviceId)
    })
    return locked
  }, [messages])
  const settingsRef = useRef<SettingsType | null>(null)
  const publishedReceivedFilesRef = useRef<Set<string>>(new Set())
  const knownMessageIdsRef = useRef<Set<string>>(new Set())
  const locallyPausedTransfersRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    currentDeviceRef.current = currentDevice
  }, [currentDevice])

  useEffect(() => {
    sendingRef.current = sending
  }, [sending])

  useEffect(() => {
    sendingTextRef.current = sendingText
  }, [sendingText])

  useEffect(() => {
    preparingSendRef.current = preparingSend
  }, [preparingSend])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    applyAppTheme(settings?.theme ?? 'light')
  }, [settings?.theme])

  useEffect(() => {
    initializeApp()

    let unlistenMessage: (() => void) | null = null
    let unlistenMessageDeleted: (() => void) | null = null
    let unlistenDrop: (() => void) | null = null

    listen<ChatMessage>('chat-message-updated', (event) => {
      const message = event.payload
      const isNewMessage = !knownMessageIdsRef.current.has(message.message_id)
      knownMessageIdsRef.current.add(message.message_id)
      publishReceivedFileIfNeeded(message)
      const activeDeviceId = currentDeviceRef.current?.device_id
      if (isNewMessage && message.direction === 'receive' && activeDeviceId !== message.device_id) {
        setUnreadCounts((prev) => ({
          ...prev,
          [message.device_id]: (prev[message.device_id] || 0) + 1
        }))
      }

      setMessages((prev) =>
        upsertMessage(prev, protectLocallyPausedTransfer(prev, message, locallyPausedTransfersRef.current))
      )
    }).then((unlisten) => {
      unlistenMessage = unlisten
    })

    listen<ChatMessage>('chat-message-deleted', (event) => {
      const message = event.payload
      knownMessageIdsRef.current.delete(message.message_id)
      setMessages((prev) => ({
        ...prev,
        [message.device_id]: (prev[message.device_id] || []).filter((item) => item.message_id !== message.message_id)
      }))
    }).then((unlisten) => {
      unlistenMessageDeleted = unlisten
    })

    listen<{ paths?: string[] }>(TauriEvent.DRAG_DROP, (event) => {
      const paths = event.payload?.paths || []
      const activeDevice = currentDeviceRef.current
      if (paths.length > 0 && activeDevice) {
        void sendFilesToDevice(activeDevice, paths)
      }
    }).then((unlisten) => {
      unlistenDrop = unlisten
    })

    const deviceInterval = window.setInterval(refreshDevices, 3000)
    const handleResize = () => setIsMobileLayout(window.innerWidth < 768)
    const handleVisibilityChange = () => {
      if (!document.hidden) void refreshDevices()
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('focus', refreshDevices)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(deviceInterval)
      stopStartupDiscovery(false)
      stopManualDiscovery(false)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('focus', refreshDevices)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      unlistenMessage?.()
      unlistenMessageDeleted?.()
      unlistenDrop?.()
    }
  }, [])

  useEffect(() => {
    const messageInterval = window.setInterval(() => {
      if (currentDevice) void refreshMessages(currentDevice.device_id)
    }, 1000)

    return () => window.clearInterval(messageInterval)
  }, [currentDevice])

  useEffect(() => {
    if (!currentDevice) return
    const updated = devices.find((device) => device.device_id === currentDevice.device_id)
    if (updated) setCurrentDevice(updated)
  }, [devices, currentDevice?.device_id])

  useEffect(() => {
    window.__CIPHERTRANSLOCAL_HANDLE_ANDROID_BACK__ = () => {
      if (!isMobileLayout) return false

      if (currentView === 'devices' && currentDevice) {
        handleMobileBackToDevices()
        return true
      }

      if (currentView !== 'devices') {
        setCurrentView('devices')
        setCurrentDevice(null)
        setError(null)
        return true
      }

      return false
    }

    return () => {
      delete window.__CIPHERTRANSLOCAL_HANDLE_ANDROID_BACK__
    }
  }, [isMobileLayout, currentView, currentDevice])

  useEffect(() => {
    if (!isMobileLayout) return

    const handlePreparingFiles = (event: Event) => {
      const activeDevice = currentDeviceRef.current
      if (!activeDevice) return

      const customEvent = event as CustomEvent<{ count?: number; files?: PendingFileMeta[] }>
      const files = normalizePendingFileMeta(customEvent.detail?.files || [])
      const rawCount = Number(customEvent.detail?.count || 1)
      const count = files.length > 0 ? files.length : Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1
      const placeholders = createPreparingSendMessages(activeDevice.device_id, files, count)
      if (placeholders.length > 0) {
        setMessages((prev) => ({
          ...prev,
          [activeDevice.device_id]: [...(prev[activeDevice.device_id] || []), ...placeholders]
        }))
      }
      const nextPreparing = { device: activeDevice, count, startedAt: Date.now(), placeholderIds: placeholders.map((message) => message.message_id) }
      preparingSendRef.current = nextPreparing
      setPreparingSend(nextPreparing)
      setError(null)

      if (files.length > 0) {
        void invoke('predeclare_send_files', {
          deviceId: activeDevice.device_id,
          files: placeholders.map((message) => ({
            message_id: message.message_id,
            file_id: message.file_id,
            file_name: message.file_name,
            file_size: message.file_size,
            file_type: message.file_type,
            timestamp: message.timestamp
          }))
        }).catch((err) => {
          console.warn('Failed to predeclare send files:', err)
        })
      }
    }

    const handlePickedFiles = (event: Event) => {
      const customEvent = event as CustomEvent<{ paths?: string[]; error?: string }>
      const preparedTarget = preparingSendRef.current
      preparingSendRef.current = null
      setPreparingSend(null)

      if (customEvent.detail?.error) {
        setError(userFriendlyError('选择文件失败', customEvent.detail.error))
        if (preparedTarget?.placeholderIds.length) {
          const ids = new Set(preparedTarget.placeholderIds)
          setMessages((prev) => ({
            ...prev,
            [preparedTarget.device.device_id]: (prev[preparedTarget.device.device_id] || []).filter((message) => !ids.has(message.message_id))
          }))
        }
        return
      }

      const paths = customEvent.detail?.paths || []
      if (paths.length > 0) {
        const targetDevice = preparedTarget?.device || currentDeviceRef.current
        if (targetDevice) {
          void sendFilesToDevice(targetDevice, paths, preparedTarget?.placeholderIds)
        } else {
          setError('请先选择一台在线设备。')
        }
      } else if (preparedTarget?.placeholderIds.length) {
        const ids = new Set(preparedTarget.placeholderIds)
        setMessages((prev) => ({
          ...prev,
          [preparedTarget.device.device_id]: (prev[preparedTarget.device.device_id] || []).filter((message) => !ids.has(message.message_id))
        }))
      }
    }

    window.addEventListener('ciphertranslocal-android-preparing-files', handlePreparingFiles)
    window.addEventListener('ciphertranslocal-android-picked-files', handlePickedFiles)
    return () => {
      window.removeEventListener('ciphertranslocal-android-preparing-files', handlePreparingFiles)
      window.removeEventListener('ciphertranslocal-android-picked-files', handlePickedFiles)
    }
  }, [isMobileLayout])

  useEffect(() => {
    if (!isMobileLayout || !settings) return

    const handlePickedDirectory = (event: Event) => {
      const customEvent = event as CustomEvent<{ uri?: string; name?: string; error?: string }>
      if (customEvent.detail?.error) {
        setError(userFriendlyError('选择接收目录失败', customEvent.detail.error))
        return
      }

      const uri = customEvent.detail?.uri || ''
      const name = customEvent.detail?.name || '自定义目录'
      if (!uri) return

      void saveSettings({
        ...settings,
        android_storage_mode: 'manual',
        android_custom_directory_uri: uri,
        android_custom_directory_name: name
      })
    }

    window.addEventListener('ciphertranslocal-android-picked-directory', handlePickedDirectory)
    return () => window.removeEventListener('ciphertranslocal-android-picked-directory', handlePickedDirectory)
  }, [isMobileLayout, settings])

  useEffect(() => {
    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<{ release: () => Promise<void> }>
      }
    }).wakeLock

    const releaseWakeLock = async () => {
      const lock = wakeLockRef.current
      wakeLockRef.current = null
      await lock?.release().catch(() => undefined)
    }

    if (!isMobileLayout || !settings?.android_keep_screen_awake || !wakeLockApi) {
      void releaseWakeLock()
      return
    }

    let canceled = false
    wakeLockApi.request('screen')
      .then((lock) => {
        if (canceled) {
          lock.release().catch(() => undefined)
          return
        }
        wakeLockRef.current = lock
      })
      .catch((err) => console.warn('Failed to request wake lock:', err))

    return () => {
      canceled = true
      void releaseWakeLock()
    }
  }, [isMobileLayout, settings?.android_keep_screen_awake])

  useEffect(() => {
    if (!isMobileLayout || !window.CipherTransLocalAndroid?.setTransferPerformanceMode) return
    window.CipherTransLocalAndroid.setTransferPerformanceMode(hasActiveTransfer)
    return () => {
      window.CipherTransLocalAndroid?.setTransferPerformanceMode?.(false)
    }
  }, [isMobileLayout, hasActiveTransfer])

  const initializeApp = async () => {
    setLoading(true)
    try {
      const [settingsResult] = await Promise.all([
        invoke<SettingsType>('get_settings'),
        refreshDevices()
      ])
      setSettings(settingsResult)
    } catch (err) {
      console.error('Failed to initialize:', err)
      setError(userFriendlyError('初始化失败', err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loading) startStartupDiscovery()
  }, [loading])

  const refreshDevices = async () => {
    try {
      const result = await invoke<Device[]>('get_devices')
      setDevices(result)
    } catch (err) {
      console.error('Failed to get devices:', err)
    }
  }

  const triggerDiscovery = async () => {
    if (discoveryInFlightRef.current > 0) return

    discoveryInFlightRef.current += 1
    setDiscovering(true)
    try {
      const result = await invoke<Device[]>('trigger_discovery')
      setDevices(result)
    } catch (err) {
      console.error('Failed to trigger discovery:', err)
      await refreshDevices()
    } finally {
      discoveryInFlightRef.current = Math.max(0, discoveryInFlightRef.current - 1)
      setDiscovering(startupDiscoveryActiveRef.current || manualDiscoveryActiveRef.current || discoveryInFlightRef.current > 0)
    }
  }

  const startManualDiscovery = () => {
    stopManualDiscovery(false)
    manualDiscoveryActiveRef.current = true
    setManualDiscoveryRemaining(STARTUP_DISCOVERY_SECONDS)
    setDiscovering(true)
    void triggerDiscovery()

    const startedAt = Date.now()
    const discoveryIntervalId = window.setInterval(() => {
      void triggerDiscovery()
    }, STARTUP_DISCOVERY_INTERVAL_MS)
    const countdownIntervalId = window.setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      setManualDiscoveryRemaining(Math.max(0, STARTUP_DISCOVERY_SECONDS - elapsedSeconds))
    }, 250)
    const timeoutId = window.setTimeout(() => {
      stopManualDiscovery()
    }, STARTUP_DISCOVERY_DURATION_MS)

    manualDiscoveryTimersRef.current = { discoveryIntervalId, countdownIntervalId, timeoutId }
  }

  const stopManualDiscovery = (updateState = true) => {
    if (manualDiscoveryTimersRef.current) {
      window.clearInterval(manualDiscoveryTimersRef.current.discoveryIntervalId)
      window.clearInterval(manualDiscoveryTimersRef.current.countdownIntervalId)
      window.clearTimeout(manualDiscoveryTimersRef.current.timeoutId)
      manualDiscoveryTimersRef.current = null
    }

    manualDiscoveryActiveRef.current = false
    setManualDiscoveryRemaining(0)
    if (updateState) setDiscovering(startupDiscoveryActiveRef.current || discoveryInFlightRef.current > 0)
  }

  const startStartupDiscovery = () => {
    stopStartupDiscovery(false)
    startupDiscoveryActiveRef.current = true
    setStartupDiscoveryRemaining(STARTUP_DISCOVERY_SECONDS)
    setDiscovering(true)
    void triggerDiscovery()

    const startedAt = Date.now()
    const discoveryIntervalId = window.setInterval(() => {
      void triggerDiscovery()
    }, STARTUP_DISCOVERY_INTERVAL_MS)
    const countdownIntervalId = window.setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      setStartupDiscoveryRemaining(Math.max(0, STARTUP_DISCOVERY_SECONDS - elapsedSeconds))
    }, 250)
    const timeoutId = window.setTimeout(() => {
      stopStartupDiscovery()
    }, STARTUP_DISCOVERY_DURATION_MS)

    startupDiscoveryTimersRef.current = { discoveryIntervalId, countdownIntervalId, timeoutId }
  }

  const stopStartupDiscovery = (updateState = true) => {
    if (startupDiscoveryTimersRef.current) {
      window.clearInterval(startupDiscoveryTimersRef.current.discoveryIntervalId)
      window.clearInterval(startupDiscoveryTimersRef.current.countdownIntervalId)
      window.clearTimeout(startupDiscoveryTimersRef.current.timeoutId)
      startupDiscoveryTimersRef.current = null
    }

    startupDiscoveryActiveRef.current = false
    setStartupDiscoveryRemaining(0)
    if (updateState) setDiscovering(manualDiscoveryActiveRef.current || discoveryInFlightRef.current > 0)
  }

  const refreshMessages = async (deviceId: string) => {
    try {
      const history = await invoke<ChatMessage[]>('get_chat_history', { deviceId })
      history.forEach((message) => knownMessageIdsRef.current.add(message.message_id))
      setMessages((prev) => {
        const protectedHistory = history.map((message) =>
          protectLocallyPausedTransfer(prev, message, locallyPausedTransfersRef.current)
        )
        const activePreparing = preparingSendRef.current
        const localPreparing =
          activePreparing?.device.device_id === deviceId
            ? (prev[deviceId] || []).filter((message) => activePreparing.placeholderIds.includes(message.message_id))
            : []
        const historyIds = new Set(protectedHistory.map((message) => message.message_id))
        const retainedPreparing = localPreparing.filter((message) => !historyIds.has(message.message_id))
        return {
          ...prev,
          [deviceId]: [...protectedHistory, ...retainedPreparing]
        }
      })
    } catch (err) {
      console.error('Failed to refresh messages:', err)
    }
  }

  const publishReceivedFileIfNeeded = (message: ChatMessage) => {
    const currentSettings = settingsRef.current
    if (!isMobileLayout || !window.CipherTransLocalAndroid || !currentSettings) return
    if (message.direction !== 'receive' || message.status !== 'completed' || !message.file_path) return
    if (message.file_type === 'text') return

    const shouldPublishToCustomDir =
      currentSettings.android_storage_mode === 'manual' &&
      Boolean(currentSettings.android_custom_directory_uri)
    const shouldSaveToGallery =
      currentSettings.auto_save_images_to_gallery &&
      message.file_type === 'image'
    const shouldPublishToDownloads =
      currentSettings.android_storage_mode === 'public_downloads' &&
      !shouldSaveToGallery

    if (!shouldPublishToDownloads && !shouldPublishToCustomDir && !shouldSaveToGallery) return
    if (publishedReceivedFilesRef.current.has(message.message_id)) return
    publishedReceivedFilesRef.current.add(message.message_id)

    try {
      const rawResult = window.CipherTransLocalAndroid.publishReceivedFile(
        message.file_path,
        message.file_name,
        message.file_type,
        shouldSaveToGallery,
        shouldPublishToDownloads
      )
      const result = JSON.parse(rawResult) as { ok?: boolean; error?: string }
      if (!result.ok) {
        setError(userFriendlyError('保存接收文件失败', result.error || rawResult))
      }
    } catch (err) {
      setError(userFriendlyError('保存接收文件失败', err))
    }
  }

  const handleSelectDevice = async (device: Device) => {
    setCurrentDevice(device)
    setCurrentView('devices')
    setUnreadCounts((prev) => ({ ...prev, [device.device_id]: 0 }))
    setError(null)
    setLoadingMessageDeviceIds((prev) => {
      const next = new Set(prev)
      next.add(device.device_id)
      return next
    })

    try {
      const history = await invoke<ChatMessage[]>('get_chat_history', { deviceId: device.device_id })
      history.forEach((message) => knownMessageIdsRef.current.add(message.message_id))
      setMessages((prev) => ({
        ...prev,
        [device.device_id]: history.map((message) =>
          protectLocallyPausedTransfer(prev, message, locallyPausedTransfersRef.current)
        )
      }))
    } catch (err) {
      console.error('Failed to load history:', err)
      setError(userFriendlyError('加载历史失败', err))
    } finally {
      setLoadingMessageDeviceIds((prev) => {
        const next = new Set(prev)
        next.delete(device.device_id)
        return next
      })
    }
  }

  const handleSelectView = (view: View) => {
    setCurrentView(view)
    setError(null)
    if (view !== 'devices') setCurrentDevice(null)
  }

  const handleDeleteDevice = async (deviceId: string) => {
    if (deleteLockedDeviceIds.has(deviceId)) {
      setError('传输中的文件不能直接删除，请先取消或等待完成。')
      return
    }

    try {
      await invoke('delete_device', { deviceId })
      setDevices((prev) => prev.filter((device) => device.device_id !== deviceId))
      setMessages((prev) => {
        const next = { ...prev }
        ;(next[deviceId] || []).forEach((message) => knownMessageIdsRef.current.delete(message.message_id))
        delete next[deviceId]
        return next
      })
      setUnreadCounts((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      if (currentDevice?.device_id === deviceId) setCurrentDevice(null)
    } catch (err) {
      setError(userFriendlyError('删除设备失败', err))
    }
  }

  const handleClearDeviceHistory = async (deviceId: string) => {
    if (deleteLockedDeviceIds.has(deviceId)) {
      setError('传输中的文件不能直接删除，请先取消或等待完成。')
      return
    }

    try {
      await invoke('clear_history', { deviceId })
      setMessages((prev) => {
        const next = { ...prev, [deviceId]: [] }
        ;(prev[deviceId] || []).forEach((message) => knownMessageIdsRef.current.delete(message.message_id))
        return next
      })
      setUnreadCounts((prev) => ({ ...prev, [deviceId]: 0 }))
    } catch (err) {
      setError(userFriendlyError('清空设备历史失败', err))
    }
  }

  const handleUpdateAlias = async (deviceId: string, alias: string) => {
    const trimmedAlias = alias.trim()
    if (!trimmedAlias) return

    try {
      await invoke('update_device_alias', { deviceId, alias: trimmedAlias })
      setDevices((prev) =>
        prev.map((device) => (device.device_id === deviceId ? { ...device, alias: trimmedAlias } : device))
      )
      setCurrentDevice((prev) => (prev?.device_id === deviceId ? { ...prev, alias: trimmedAlias } : prev))
      await refreshDevices()
    } catch (err) {
      setError(userFriendlyError('修改设备别名失败', err))
    }
  }

  const handleSelectFiles = async (mode: PickMode = 'file') => {
    if (!currentDevice) {
      setError('请先选择一台在线设备。')
      return
    }

    if (sendingRef.current || preparingSendRef.current) {
      setError('当前已有文件正在准备或传输，请等待完成后再发送。')
      return
    }

    if (isMobileLayout && window.CipherTransLocalAndroid) {
      try {
        if (mode === 'image') {
          window.CipherTransLocalAndroid.pickImages()
        } else {
          window.CipherTransLocalAndroid.pickFiles()
        }
      } catch (err) {
        console.error('Failed to open Android picker:', err)
        preparingSendRef.current = null
        setPreparingSend(null)
        setError(userFriendlyError('打开选择器失败', err))
      }
      return
    }

    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: mode === 'image' ? '选择要发送的图片' : '选择要发送的文件',
        filters:
          mode === 'image'
            ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            : undefined
      })

      if (selected) {
        const filePaths = Array.isArray(selected) ? selected : [selected]
        if (filePaths.length === 0) {
          setError('没有选择任何文件。')
          return
        }
        await handleSendFiles(filePaths as string[])
      }
    } catch (err) {
      console.error('Failed to select files:', err)
      setError(userFriendlyError('选择文件失败', err))
    }
  }

  const sendFilesToDevice = async (device: Device, filePaths: string[], preparedMessageIds?: string[]) => {
    if (sendingRef.current) {
      setError('当前已有传输正在进行，请等待完成后再发送。')
      return false
    }

    if (preparingSendRef.current && !preparedMessageIds?.length) {
      setError('当前已有文件正在准备，请等待完成后再发送。')
      return false
    }

    if (filePaths.length === 0) {
      setError('没有选择任何文件。')
      return false
    }

    const placeholders = preparedMessageIds?.length ? [] : createPendingSendMessages(device.device_id, filePaths)
    if (placeholders.length > 0) {
      setMessages((prev) => ({
        ...prev,
        [device.device_id]: [...(prev[device.device_id] || []), ...placeholders]
      }))
    }

    sendingRef.current = true
    setSending(true)
    setError(null)

    try {
      const result = await invoke<[string, string][]>('send_files', {
        deviceId: device.device_id,
        filePaths,
        preparedMessageIds
      })

      if (result.length > 0) await refreshMessages(device.device_id)
      return true
    } catch (err) {
      console.error('Failed to send files:', err)
      setError(userFriendlyError('发送失败', err))
      if (preparedMessageIds?.length) {
        const ids = new Set(preparedMessageIds)
        setMessages((prev) => ({
          ...prev,
          [device.device_id]: (prev[device.device_id] || []).filter((message) => !ids.has(message.message_id))
        }))
      }
      return false
    } finally {
      if (placeholders.length > 0) {
        setMessages((prev) => ({
          ...prev,
          [device.device_id]: (prev[device.device_id] || []).filter((message) => !message.message_id.startsWith('pending-send-'))
        }))
      }
      sendingRef.current = false
      setSending(false)
    }
  }

  const handleSendFiles = async (filePaths: string[]) => {
    if (!currentDevice) return false
    return sendFilesToDevice(currentDevice, filePaths)
  }

  const handleSendText = async (text: string) => {
    if (!currentDevice || sendingRef.current || sendingTextRef.current || preparingSendRef.current || !text.trim()) return false

    sendingTextRef.current = true
    setSendingText(true)
    setError(null)
    try {
      await invoke<string>('send_text', {
        deviceId: currentDevice.device_id,
        text: text.trim()
      })
      await refreshMessages(currentDevice.device_id)
      return true
    } catch (err) {
      console.error('Failed to send text:', err)
      setError(userFriendlyError('发送文字失败', err))
      return false
    } finally {
      sendingTextRef.current = false
      setSendingText(false)
    }
  }

  const handleTransferAction = async (action: 'pause' | 'resume' | 'cancel' | 'retry', messageId: string) => {
    const commandMap = {
      pause: 'pause_transfer',
      resume: 'resume_transfer',
      cancel: 'cancel_transfer',
      retry: 'retry_transfer'
    } as const

    if (action === 'pause') {
      locallyPausedTransfersRef.current.add(messageId)
    } else if (action === 'resume' || action === 'cancel' || action === 'retry') {
      locallyPausedTransfersRef.current.delete(messageId)
    }

    const optimisticStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'transferring' : action === 'cancel' ? 'canceled' : null
    if (optimisticStatus && currentDevice) {
      setMessages((prev) => updateMessageStatus(prev, currentDevice.device_id, messageId, optimisticStatus))
    }

    try {
      await invoke(commandMap[action], { messageId })
      if (currentDevice) await refreshMessages(currentDevice.device_id)
    } catch (err) {
      console.error(`Failed to ${action} transfer:`, err)
      if (action === 'pause') {
        locallyPausedTransfersRef.current.delete(messageId)
      }
      setError(userFriendlyError(actionLabel(action), err))
      if (currentDevice) await refreshMessages(currentDevice.device_id)
    }
  }

  const handleOpenFileLocation = async (message: ChatMessage) => {
    if (!message.file_path) {
      setError('该文件没有可打开的本地路径。收到的文件会显示保存位置；发送的文件需要保留原文件。')
      return
    }

    try {
      await invoke('open_file_location', { filePath: message.file_path })
    } catch (err) {
      setError(userFriendlyError('打开文件位置失败', err))
    }
  }

  const saveSettings = async (newSettings: SettingsType) => {
    const previousSettings = settings
    setSettings(newSettings)
    applyAppTheme(newSettings.theme)

    try {
      await invoke('update_settings', { settings: newSettings })
      const savedSettings = await invoke<SettingsType>('get_settings')
      setSettings(savedSettings)
      applyAppTheme(savedSettings.theme)
      await refreshDevices()
    } catch (err) {
      if (previousSettings) {
        setSettings(previousSettings)
        applyAppTheme(previousSettings.theme)
      }
      setError(userFriendlyError('保存设置失败', err))
    }
  }

  const handleClearError = () => setError(null)

  const handleMobileBackToDevices = () => {
    setCurrentDevice(null)
    setCurrentView('devices')
    setError(null)
  }

  const currentPreparingFileCount =
    currentDevice && preparingSend?.device.device_id === currentDevice.device_id ? preparingSend.count : 0

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(420, Math.max(260, startWidth + (moveEvent.clientX - startX)))
      setSidebarWidth(nextWidth)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600">
            <RefreshCw className="h-6 w-6 animate-spin text-white" />
          </div>
          <p className="text-sm font-medium text-slate-500">加载中...</p>
        </div>
      </div>
    )
  }

  if (isMobileLayout) {
    return (
      <MobileShell
        devices={devices}
        unreadCounts={unreadCounts}
        currentDevice={currentDevice}
        currentView={currentView}
        messages={messages}
        settings={settings}
        sending={sending}
        sendingText={sendingText}
        preparingFileCount={currentPreparingFileCount}
        loadingMessageDeviceIds={loadingMessageDeviceIds}
        error={error}
        isDiscovering={discovering}
        startupDiscoveryRemaining={startupDiscoveryRemaining || manualDiscoveryRemaining}
        deviceNames={deviceNames}
        deleteLockedDeviceIds={deleteLockedDeviceIds}
        onSelectDevice={handleSelectDevice}
        onSelectView={handleSelectView}
        onBackToDevices={handleMobileBackToDevices}
        onDeleteDevice={handleDeleteDevice}
        onRefresh={startManualDiscovery}
        onClearError={handleClearError}
        onSelectFiles={handleSelectFiles}
        onSendFiles={handleSendFiles}
        onSendText={handleSendText}
        onTransferAction={handleTransferAction}
        onUpdateAlias={handleUpdateAlias}
        onClearDeviceHistory={handleClearDeviceHistory}
        onSaveSettings={saveSettings}
      />
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar
        devices={devices}
        unreadCounts={unreadCounts}
        currentDevice={currentDevice}
        currentView={currentView}
        width={sidebarWidth}
        isDiscovering={discovering}
        startupDiscoveryRemaining={startupDiscoveryRemaining || manualDiscoveryRemaining}
        deleteLockedDeviceIds={deleteLockedDeviceIds}
        onSelectDevice={handleSelectDevice}
        onSelectView={handleSelectView}
        onDeleteDevice={handleDeleteDevice}
        onRefresh={startManualDiscovery}
      />

      <div
        onPointerDown={startResize}
        className="group relative z-20 w-1 cursor-col-resize bg-transparent"
        aria-label="调整侧边栏宽度"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 transition-colors group-hover:bg-blue-400" />
      </div>

      {error && (
        <div className="fixed right-4 top-4 z-50 animate-slide-in">
          <div className="flex max-w-md items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 shadow-lg">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100">
              <AlertCircle className="h-4 w-4 text-red-600" />
            </div>
            <span className="text-sm font-medium text-red-700">{error}</span>
            <button onClick={handleClearError} className="shrink-0 text-xs text-red-500 hover:text-red-700">
              关闭
            </button>
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {currentView === 'devices' && currentDevice ? (
          <div className="h-full min-w-0 overflow-hidden">
            <ChatWindow
              messages={messages[currentDevice.device_id] || []}
              device={currentDevice}
              onSelectFiles={handleSelectFiles}
              onSendFiles={handleSendFiles}
              onSendText={handleSendText}
              onTransferAction={handleTransferAction}
              onOpenFileLocation={handleOpenFileLocation}
              onClearHistory={() => handleClearDeviceHistory(currentDevice.device_id)}
              sending={sending}
              sendingText={sendingText}
              preparingFileCount={currentPreparingFileCount}
              isLoadingMessages={loadingMessageDeviceIds.has(currentDevice.device_id)}
            />
          </div>
        ) : currentView === 'devices' ? (
          <div className="flex h-full min-w-0 flex-col items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_20%,rgba(56,189,248,0.10),transparent_34%),#F8FAFC] px-6">
            <div className="w-full max-w-md text-center">
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm">
                {discovering ? (
                  <Radar className="h-10 w-10 animate-pulse text-blue-500" />
                ) : (
                  <MonitorSmartphone className="h-10 w-10 text-slate-300" />
                )}
              </div>
              <p className="mb-2 text-xl font-bold text-slate-800">
                {discovering ? '正在搜索局域网设备' : '等待手动刷新'}
              </p>
              <p className="mx-auto text-sm leading-6 text-slate-500">
                {discovering
                  ? `启动自动搜索会完整持续 10 秒，剩余 ${startupDiscoveryRemaining || STARTUP_DISCOVERY_SECONDS} 秒。`
                  : '自动搜索已结束，之后不会反复重试。需要重新查找设备时，请使用左侧设备栏的刷新按钮。'}
              </p>
              {!discovering && (
                <div className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-500 shadow-sm">
                  <RefreshCw className="h-3.5 w-3.5" />
                  左侧刷新设备
                </div>
              )}
            </div>
          </div>
        ) : currentView === 'history' ? (
          <div className="h-full min-w-0 overflow-hidden">
            <History deviceNames={deviceNames} />
          </div>
        ) : currentView === 'settings' ? (
          <div className="h-full min-w-0 overflow-hidden">
            <Settings settings={settings} onSave={saveSettings} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function upsertMessage(prev: Record<string, ChatMessage[]>, message: ChatMessage) {
  const deviceMessages = prev[message.device_id] || []
  const withoutPlaceholders =
    message.direction === 'send' && !message.message_id.startsWith('pending-send-')
      ? deviceMessages.filter((item) => !item.message_id.startsWith('pending-send-'))
      : deviceMessages
  const nextMessages = withoutPlaceholders.some((item) => item.message_id === message.message_id)
    ? withoutPlaceholders.map((item) => (item.message_id === message.message_id ? message : item))
    : [...withoutPlaceholders, message]

  return {
    ...prev,
    [message.device_id]: nextMessages
  }
}

function protectLocallyPausedTransfer(
  prev: Record<string, ChatMessage[]>,
  incoming: ChatMessage,
  locallyPausedTransfers: Set<string>
): ChatMessage {
  if (!locallyPausedTransfers.has(incoming.message_id)) return incoming
  if (incoming.status !== 'transferring' && incoming.status !== 'pending') {
    if (incoming.status === 'completed' || incoming.status === 'failed' || incoming.status === 'canceled') {
      locallyPausedTransfers.delete(incoming.message_id)
    }
    return incoming
  }

  const existing = (prev[incoming.device_id] || []).find((message) => message.message_id === incoming.message_id)
  return {
    ...incoming,
    status: 'paused',
    progress: existing?.progress ?? incoming.progress,
    speed: undefined,
    error: existing?.error ?? incoming.error
  }
}

function isDeleteLockedMessage(message: ChatMessage) {
  return message.file_type !== 'text' && ['pending', 'transferring', 'paused'].includes(message.status)
}

function updateMessageStatus(
  prev: Record<string, ChatMessage[]>,
  deviceId: string,
  messageId: string,
  status: ChatMessage['status']
) {
  const deviceMessages = prev[deviceId] || []
  if (!deviceMessages.some((message) => message.message_id === messageId)) return prev

  return {
    ...prev,
    [deviceId]: deviceMessages.map((message) =>
      message.message_id === messageId
        ? {
            ...message,
            status,
            speed: undefined,
            error: status === 'transferring' || status === 'paused' ? undefined : message.error
          }
        : message
    )
  }
}

function createPendingSendMessages(deviceId: string, filePaths: string[]): ChatMessage[] {
  const now = Date.now()
  return filePaths.map((filePath, index) => ({
    message_id: `pending-send-${now}-${index}`,
    device_id: deviceId,
    file_id: `pending-send-${now}-${index}`,
    file_name: filePath.split(/[\\/]/).pop() || filePath,
    file_size: 0,
    file_type: inferFileType(filePath),
    direction: 'send',
    status: 'pending',
    timestamp: now + index,
    thumbnail: undefined,
    progress: 0,
    speed: undefined,
    error: undefined,
    file_path: filePath
  }))
}

function createPreparingSendMessages(deviceId: string, files: PendingFileMeta[], count: number): ChatMessage[] {
  const now = Date.now()
  const normalizedFiles =
    files.length > 0
      ? files
      : Array.from({ length: count }, (_, index) => ({
          name: count > 1 ? `待发送文件 ${index + 1}` : '待发送文件',
          size: 0,
          type: 'other' as ChatMessage['file_type']
        }))

  return normalizedFiles.map((file, index) => {
    const id = `pending-send-${now}-${index}`
    return {
      message_id: id,
      device_id: deviceId,
      file_id: id,
      file_name: file.name,
      file_size: file.size,
      file_type: file.type,
      direction: 'send',
      status: 'pending',
      timestamp: now + index,
      thumbnail: undefined,
      progress: 0,
      speed: undefined,
      error: undefined,
      file_path: undefined
    }
  })
}

function normalizePendingFileMeta(files: PendingFileMeta[]): PendingFileMeta[] {
  return files
    .map((file) => ({
      name: String(file.name || '').trim(),
      size: Number(file.size || 0),
      type: normalizeFileType(file.type)
    }))
    .filter((file) => file.name)
    .map((file) => ({
      ...file,
      size: Number.isFinite(file.size) && file.size > 0 ? file.size : 0
    }))
}

function normalizeFileType(value: unknown): ChatMessage['file_type'] {
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'document' || value === 'archive' || value === 'text' || value === 'other') {
    return value
  }
  return 'other'
}

function inferFileType(filePath: string): ChatMessage['file_type'] {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'image'
  if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'audio'
  if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return 'document'
  if (['zip', 'rar', '7z'].includes(ext)) return 'archive'
  return 'other'
}

function actionLabel(action: 'pause' | 'resume' | 'cancel' | 'retry') {
  switch (action) {
    case 'pause':
      return '暂停传输失败'
    case 'resume':
      return '继续传输失败'
    case 'cancel':
      return '取消传输失败'
    case 'retry':
      return '重新发送失败'
  }
}

export default App
