import { useEffect, useMemo, useRef, useState } from 'react'
import { Device, ChatMessage, Settings as SettingsType } from '../types'
import { formatLastSeen, getDeviceDisplayName, sortDevicesStable } from '../utils/device'
import { ChatWindow } from './ChatWindow'
import { MobileHistory } from './MobileHistory'
import { MobileSettings } from './MobileSettings'
import { BrandLogo } from './BrandLogo'
import {
  ArrowLeft,
  Check,
  Clock3,
  Edit2,
  Laptop,
  MessageSquare,
  MoreVertical,
  Radar,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react'

type MobileView = 'devices' | 'history' | 'settings'
type PickMode = 'file' | 'image'

interface MobileShellProps {
  devices: Device[]
  unreadCounts: Record<string, number>
  currentDevice: Device | null
  currentView: MobileView
  messages: Record<string, ChatMessage[]>
  settings: SettingsType | null
  sending: boolean
  sendingText?: boolean
  preparingFileCount?: number
  loadingMessageDeviceIds?: Set<string>
  error: string | null
  isDiscovering?: boolean
  startupDiscoveryRemaining?: number
  deviceNames: Record<string, string>
  deleteLockedDeviceIds?: Set<string>
  onSelectDevice: (device: Device) => void
  onSelectView: (view: MobileView) => void
  onBackToDevices: () => void
  onDeleteDevice: (deviceId: string) => void
  onRefresh: () => void
  onClearError: () => void
  onSelectFiles: (mode?: PickMode) => void
  onSendFiles: (filePaths: string[]) => void
  onSendText: (text: string) => Promise<boolean> | boolean
  onTransferAction: (action: 'pause' | 'resume' | 'cancel' | 'retry', messageId: string) => void
  onUpdateAlias: (deviceId: string, alias: string) => Promise<void> | void
  onClearDeviceHistory: (deviceId: string) => Promise<void> | void
  onSaveSettings: (settings: SettingsType) => Promise<void>
}

export function MobileShell({
  devices,
  unreadCounts,
  currentDevice,
  currentView,
  messages,
  settings,
  sending,
  sendingText = false,
  preparingFileCount = 0,
  loadingMessageDeviceIds = new Set(),
  error,
  isDiscovering = false,
  startupDiscoveryRemaining = 0,
  deviceNames,
  deleteLockedDeviceIds = new Set(),
  onSelectDevice,
  onSelectView,
  onBackToDevices,
  onDeleteDevice,
  onRefresh,
  onClearError,
  onSelectFiles,
  onSendFiles,
  onSendText,
  onTransferAction,
  onUpdateAlias,
  onClearDeviceHistory,
  onSaveSettings
}: MobileShellProps) {
  const showChat = currentView === 'devices' && currentDevice
  const haptics = settings?.android_haptics ?? true
  const [showDeviceMenu, setShowDeviceMenu] = useState(false)
  const [showAliasInput, setShowAliasInput] = useState(false)
  const [confirmClearDeviceHistory, setConfirmClearDeviceHistory] = useState(false)
  const [mobileAlias, setMobileAlias] = useState('')
  const deviceMenuRef = useRef<HTMLDivElement>(null)
  const currentDeviceMessages = currentDevice ? messages[currentDevice.device_id] || [] : []
  const hasDeleteLockedMessages = currentDeviceMessages.some(isDeleteLockedMessage)

  useEffect(() => {
    setMobileAlias(currentDevice?.alias || '')
    setShowAliasInput(false)
    setShowDeviceMenu(false)
    setConfirmClearDeviceHistory(false)
  }, [currentDevice?.device_id, currentDevice?.alias])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && !deviceMenuRef.current?.contains(target)) {
        setShowDeviceMenu(false)
        setConfirmClearDeviceHistory(false)
      }
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  const tap = (action: () => void) => {
    if (haptics && 'vibrate' in navigator) navigator.vibrate(10)
    action()
  }

  const saveMobileAlias = async () => {
    if (!currentDevice) return
    const alias = mobileAlias.trim()
    if (!alias) return
    await Promise.resolve(onUpdateAlias(currentDevice.device_id, alias))
    setShowAliasInput(false)
    setShowDeviceMenu(false)
  }

  return (
    <div className="mobile-shell h-full bg-slate-50 text-slate-950">
      {error && (
        <div className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+12px)] z-[80]">
          <button
            onClick={() => tap(onClearError)}
            className="w-full rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-medium leading-5 text-red-700 shadow-lg"
          >
            {error}
          </button>
        </div>
      )}

      {showChat ? (
        <div className="mobile-chat mobile-chat-enter h-full bg-slate-50">
          <div className="mobile-chat-header z-30 shrink-0 border-b border-slate-200/70 bg-white/95 px-3 pb-3 pt-[calc(env(safe-area-inset-top)+10px)] backdrop-blur">
            <MobileBrandBar subtitle="设备会话" />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => tap(onBackToDevices)}
                className="mobile-back-button grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700 active:scale-95"
                aria-label="返回设备"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                {showAliasInput ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      value={mobileAlias}
                      onChange={(event) => setMobileAlias(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveMobileAlias()
                        if (event.key === 'Escape') setShowAliasInput(false)
                      }}
                      className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none"
                      placeholder="设备别名"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void saveMobileAlias()}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-600 text-white active:scale-95"
                      aria-label="保存别名"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAliasInput(false)}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 active:scale-95"
                      aria-label="取消修改"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="truncate text-base font-semibold">{getDeviceDisplayName(currentDevice)}</div>
                    <OnlineMeta device={currentDevice} />
                  </>
                )}
              </div>
              {!showAliasInput && (
                <div ref={deviceMenuRef} className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowDeviceMenu((value) => !value)}
                    className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700 active:scale-95"
                    aria-label="设备操作"
                  >
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {showDeviceMenu && (
                    <div className="absolute right-0 top-12 z-[90] w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
                      <button
                        type="button"
                        onClick={() => {
                          setMobileAlias(currentDevice.alias || getDeviceDisplayName(currentDevice))
                          setShowAliasInput(true)
                          setShowDeviceMenu(false)
                          setConfirmClearDeviceHistory(false)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-slate-700 active:bg-slate-50"
                      >
                        <Edit2 className="h-4 w-4" />
                        修改别名
                      </button>
                      <div className="my-1 h-px bg-slate-100" />
                      {confirmClearDeviceHistory ? (
                        <div className="px-2 py-1">
                          <p className="px-1 pb-2 text-xs leading-5 text-slate-500">清空当前设备记录，不影响设备本身。</p>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmClearDeviceHistory(false)}
                              className="h-8 rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 active:scale-95"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (hasDeleteLockedMessages) return
                                void Promise.resolve(onClearDeviceHistory(currentDevice.device_id))
                                setShowDeviceMenu(false)
                                setConfirmClearDeviceHistory(false)
                              }}
                              disabled={hasDeleteLockedMessages}
                              className="h-8 rounded-lg bg-red-600 text-xs font-semibold text-white active:scale-95 disabled:bg-slate-300"
                            >
                              确认
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmClearDeviceHistory(true)}
                          disabled={hasDeleteLockedMessages}
                          title={hasDeleteLockedMessages ? '传输中不能清空，请先取消或等待完成' : undefined}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-red-600 active:bg-red-50 disabled:text-slate-400"
                        >
                          <Trash2 className="h-4 w-4" />
                          清空此设备记录
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <ChatWindow
            messages={messages[currentDevice.device_id] || []}
            device={currentDevice}
            onSelectFiles={(mode) => tap(() => onSelectFiles(mode))}
            onSendFiles={onSendFiles}
            onSendText={onSendText}
            onTransferAction={onTransferAction}
            onClearHistory={() => onClearDeviceHistory(currentDevice.device_id)}
            sending={sending}
            sendingText={sendingText}
            preparingFileCount={preparingFileCount}
            isLoadingMessages={loadingMessageDeviceIds.has(currentDevice.device_id)}
          />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <main key={currentView} className={`mobile-view-enter min-h-0 flex-1 ${currentView === 'history' ? 'overflow-hidden' : 'overflow-y-auto'} pb-[calc(env(safe-area-inset-bottom)+84px)]`}>
            {currentView === 'devices' && (
              <MobileDevices
                devices={devices}
                unreadCounts={unreadCounts}
                isDiscovering={isDiscovering}
                startupDiscoveryRemaining={startupDiscoveryRemaining}
                deleteLockedDeviceIds={deleteLockedDeviceIds}
                onSelectDevice={(device) => tap(() => onSelectDevice(device))}
                onDeleteDevice={(deviceId) => tap(() => onDeleteDevice(deviceId))}
                onRefresh={() => tap(onRefresh)}
              />
            )}
            {currentView === 'history' && <MobileHistory deviceNames={deviceNames} />}
            {currentView === 'settings' && settings && <MobileSettings settings={settings} onSave={onSaveSettings} />}
          </main>
          <MobileTabBar currentView={currentView} onSelectView={(view) => tap(() => onSelectView(view))} />
        </div>
      )}
    </div>
  )
}

function MobileDevices({
  devices,
  unreadCounts,
  isDiscovering,
  startupDiscoveryRemaining,
  deleteLockedDeviceIds,
  onSelectDevice,
  onDeleteDevice,
  onRefresh
}: {
  devices: Device[]
  unreadCounts: Record<string, number>
  isDiscovering: boolean
  startupDiscoveryRemaining: number
  deleteLockedDeviceIds: Set<string>
  onSelectDevice: (device: Device) => void
  onDeleteDevice: (deviceId: string) => void
  onRefresh: () => void
}) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showHint, setShowHint] = useState(true)
  const searchToggleRef = useRef<HTMLDivElement>(null)
  const searchPanelRef = useRef<HTMLDivElement>(null)
  const onlineCount = devices.filter((device) => device.is_online).length
  const isSearching = refreshing || isDiscovering
  const statusTitle = isSearching
    ? startupDiscoveryRemaining > 0
      ? `正在搜索，剩余 ${startupDiscoveryRemaining} 秒`
      : '正在搜索局域网设备'
    : devices.length === 0
      ? '等待手动刷新'
      : `${devices.length} 台设备`
  const statusDescription = isSearching
    ? '启动自动搜索会完整持续 10 秒，之后仅手动刷新。'
    : devices.length === 0
      ? '自动搜索已结束，点击刷新重新查找。'
      : onlineCount > 0
        ? `${onlineCount} 台在线，可直接进入会话。`
        : '设备已记录，等待对方重新上线。'

  useEffect(() => {
    const timer = window.setTimeout(() => setShowHint(false), 3600)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (
        target &&
        !searchToggleRef.current?.contains(target) &&
        !searchPanelRef.current?.contains(target)
      ) {
        setSearchOpen(false)
      }
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  const sortedDevices = useMemo(() => {
    return sortDevicesStable(devices).filter((device) => getDeviceDisplayName(device).toLowerCase().includes(query.trim().toLowerCase()))
  }, [devices, query])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await Promise.resolve(onRefresh())
    } finally {
      window.setTimeout(() => setRefreshing(false), 500)
    }
  }

  return (
    <section className="mobile-devices-home min-h-full px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <MobileBrandBar subtitle="局域网快传" />
      <div className="mb-4 mt-5 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-950">设备中心</h1>
          <p className="mt-0.5 truncate text-xs font-medium text-slate-500">
            {isSearching
              ? startupDiscoveryRemaining > 0
                ? `正在搜索局域网设备，剩余 ${startupDiscoveryRemaining} 秒`
                : '正在搜索局域网设备'
              : devices.length === 0
                ? '暂无设备'
                : onlineCount > 0
                  ? `${onlineCount} 台在线`
                  : '暂无在线设备'}
          </p>
        </div>
        <div ref={searchToggleRef} className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen((value) => !value)}
            className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm active:scale-95"
            aria-label="搜索设备"
          >
            {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isSearching}
            className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm active:scale-95"
            aria-label="刷新设备"
          >
            <RefreshCw className={`h-5 w-5 ${isSearching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-2xl border border-slate-200/80 bg-white/95 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
                isSearching ? 'bg-blue-50 text-blue-600' : onlineCount > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {isSearching ? <Radar className="h-5 w-5 animate-pulse" /> : onlineCount > 0 ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{statusTitle}</div>
              <div className="mt-0.5 text-xs leading-5 text-slate-500">{statusDescription}</div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-lg font-black leading-none text-slate-950">{onlineCount}</div>
            <div className="mt-1 text-[11px] font-semibold text-slate-400">在线</div>
          </div>
        </div>
      </div>

      {searchOpen && (
        <div ref={searchPanelRef} className="mb-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设备名称"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none focus:shadow-none"
            />
          </div>
        </div>
      )}

      {showHint && devices.length === 0 && (
        <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50/90 px-4 py-3">
          <div className="text-sm font-semibold text-blue-900">{isSearching ? '正在搜索' : '附近设备'}</div>
          <div className="mt-1 text-xs leading-5 text-blue-700">
            {isSearching ? '正在扫描同一 Wi-Fi 内的设备。' : '保持双方在同一 Wi-Fi，打开 CipherTransLocal 后点击刷新。'}
          </div>
        </div>
      )}

      {sortedDevices.length > 0 ? (
        <div className="space-y-2">
          {sortedDevices.map((device) => (
            <MobileDeviceRow
              key={device.device_id}
              device={device}
              unread={unreadCounts[device.device_id] || 0}
              deleteLocked={deleteLockedDeviceIds.has(device.device_id)}
              onSelectDevice={onSelectDevice}
              onDeleteDevice={onDeleteDevice}
            />
          ))}
        </div>
      ) : (
        <div className="mt-20 flex flex-col items-center text-center">
          <div className="grid h-[72px] w-[72px] place-items-center rounded-3xl bg-white shadow-sm ring-1 ring-slate-200">
            {isSearching ? (
              <RefreshCw className="h-8 w-8 animate-spin text-blue-500" />
            ) : (
              <Wifi className="h-8 w-8 text-slate-300" />
            )}
          </div>
          <p className="mt-5 text-base font-semibold text-slate-700">
            {query ? '没有匹配设备' : isSearching ? '正在搜索设备' : '还没有发现设备'}
          </p>
          <p className="mt-2 max-w-[260px] text-sm leading-6 text-slate-500">
            {query
              ? '换一个关键词试试。'
              : isSearching
                ? startupDiscoveryRemaining > 0
                  ? `正在查找同一局域网内已打开的设备，剩余 ${startupDiscoveryRemaining} 秒。`
                  : '正在查找同一局域网内已打开的设备。'
                : '确认电脑端已经打开，并和手机处在同一个局域网。自动搜索结束后不会反复重试。'}
          </p>
          {!query && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isSearching}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-slate-900 px-5 text-sm font-bold text-white shadow-lg shadow-slate-900/15 active:scale-95 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${isSearching ? 'animate-spin' : ''}`} />
              {isSearching ? '正在搜索' : '刷新设备'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function MobileBrandBar({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <BrandLogo className="h-10 w-10 shrink-0 drop-shadow-md" />
        <div className="min-w-0">
          <div className="truncate text-lg font-black tracking-tight text-slate-950">CipherTransLocal</div>
          <div className="text-xs font-semibold text-slate-500">{subtitle}</div>
        </div>
      </div>
    </div>
  )
}

function isDeleteLockedMessage(message: ChatMessage) {
  return message.file_type !== 'text' && ['pending', 'transferring', 'paused'].includes(message.status)
}

function MobileDeviceRow({
  device,
  unread,
  deleteLocked,
  onSelectDevice,
  onDeleteDevice
}: {
  device: Device
  unread: number
  deleteLocked: boolean
  onSelectDevice: (device: Device) => void
  onDeleteDevice: (deviceId: string) => void
}) {
  const Icon = device.device_type === 'android' ? Smartphone : Laptop
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setConfirmingDelete(false)
  }, [device.device_id])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectDevice(device)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelectDevice(device)
        }
      }}
      className="flex min-h-[72px] w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm active:scale-[0.99]"
    >
      <div className={`relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${device.is_online ? 'bg-emerald-50' : 'bg-slate-100'}`}>
        <Icon className={`h-6 w-6 ${device.is_online ? 'text-emerald-600' : 'text-slate-400'}`} />
        <span className={`absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${device.is_online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{getDeviceDisplayName(device)}</span>
          {unread > 0 && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
        <OnlineMeta device={device} />
      </div>
      <div className={`grid shrink-0 gap-1 ${confirmingDelete ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {confirmingDelete && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setConfirmingDelete(false)
            }}
            className="h-10 rounded-xl bg-slate-100 px-2 text-xs font-bold text-slate-600 active:scale-95"
            aria-label="取消删除设备"
          >
            取消
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            if (deleteLocked) return
            if (confirmingDelete) {
              onDeleteDevice(device.device_id)
              setConfirmingDelete(false)
            } else {
              setConfirmingDelete(true)
            }
          }}
          disabled={deleteLocked}
          title={deleteLocked ? '传输中不能删除，请先取消或等待完成' : undefined}
          className={`grid h-10 shrink-0 place-items-center rounded-xl px-2 text-slate-500 disabled:cursor-not-allowed disabled:text-slate-300 ${
            confirmingDelete ? 'min-w-12 bg-red-50 text-xs font-bold text-red-600 active:scale-95' : 'w-10 bg-slate-50'
          }`}
          aria-label={confirmingDelete ? '确认删除设备' : '删除设备'}
        >
          {confirmingDelete ? '确认' : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function OnlineMeta({ device }: { device: Device }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
      {device.is_online ? (
        <>
          <Wifi className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="shrink-0 font-semibold text-emerald-600">在线</span>
          <span className="min-w-0 truncate">{device.ip}</span>
        </>
      ) : (
        <>
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">离线</span>
          <span className="min-w-0 truncate">{formatLastSeen(device.last_seen)}</span>
        </>
      )}
    </div>
  )
}

function MobileTabBar({
  currentView,
  onSelectView
}: {
  currentView: MobileView
  onSelectView: (view: MobileView) => void
}) {
  const tabs = [
    { view: 'devices' as const, label: '设备', icon: MessageSquare },
    { view: 'history' as const, label: '历史', icon: Clock3 },
    { view: 'settings' as const, label: '设置', icon: SettingsIcon }
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 px-4 pb-[calc(env(safe-area-inset-bottom)+8px)] pt-2 backdrop-blur">
      <div className="grid grid-cols-3 gap-2">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = currentView === tab.view
          return (
            <button
              key={tab.view}
              onClick={() => onSelectView(tab.view)}
              className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-semibold ${
                active ? 'bg-blue-50 text-blue-700' : 'text-slate-500'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
