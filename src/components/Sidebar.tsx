import { useState } from 'react'
import { Device } from '../types'
import { formatLastSeen, getDeviceDisplayName, sortDevicesStable } from '../utils/device'
import { BrandLogo } from './BrandLogo'
import {
  Clock,
  History,
  MessageSquare,
  Monitor,
  RefreshCw,
  Settings as SettingsIcon,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff
} from 'lucide-react'

interface SidebarProps {
  devices: Device[]
  unreadCounts: Record<string, number>
  currentDevice: Device | null
  currentView: 'devices' | 'history' | 'settings'
  width?: number
  isDiscovering?: boolean
  startupDiscoveryRemaining?: number
  deleteLockedDeviceIds?: Set<string>
  onSelectDevice: (device: Device) => void
  onSelectView: (view: 'devices' | 'history' | 'settings') => void
  onDeleteDevice: (deviceId: string) => void
  onRefresh: () => void
}

export function Sidebar({
  devices,
  unreadCounts,
  currentDevice,
  currentView,
  width = 304,
  isDiscovering = false,
  startupDiscoveryRemaining = 0,
  deleteLockedDeviceIds = new Set(),
  onSelectDevice,
  onSelectView,
  onDeleteDevice,
  onRefresh
}: SidebarProps) {
  const [loading, setLoading] = useState(false)
  const [confirmingDeleteDeviceId, setConfirmingDeleteDeviceId] = useState<string | null>(null)
  const onlineCount = devices.filter((device) => device.is_online).length
  const isSearching = loading || isDiscovering

  const sortedDevices = sortDevicesStable(devices)

  const handleRefresh = async () => {
    setLoading(true)
    try {
      await Promise.resolve(onRefresh())
    } finally {
      window.setTimeout(() => setLoading(false), 500)
    }
  }

  return (
    <div className="flex h-full shrink-0 flex-col border-r border-slate-200/60 bg-white/95 shadow-sm backdrop-blur-sm" style={{ width }}>
      <div className="border-b border-slate-200/60 p-5">
        <div className="flex items-center gap-3">
          <BrandLogo className="h-9 w-9 shrink-0 drop-shadow-md" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-slate-900">CipherTransLocal</h1>
            <p className="truncate text-xs text-slate-500">局域网消息与文件传输</p>
          </div>
        </div>
      </div>

      <div className="flex gap-1.5 border-b border-slate-200/60 p-3">
        <TabButton active={currentView === 'devices'} icon={MessageSquare} label="设备" onClick={() => onSelectView('devices')} />
        <TabButton active={currentView === 'history'} icon={History} label="历史" onClick={() => onSelectView('history')} />
      </div>

      {currentView === 'devices' && (
        <>
          <div className="border-b border-slate-100 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-slate-500">
                {isSearching
                  ? startupDiscoveryRemaining > 0
                    ? `正在搜索局域网设备，剩余 ${startupDiscoveryRemaining} 秒`
                    : '正在搜索局域网设备'
                  : devices.length === 0
                    ? '暂无已发现设备'
                    : `${onlineCount} 台在线，${devices.length - onlineCount} 台离线`}
              </span>
          <button
            onClick={handleRefresh}
            disabled={isSearching}
            className="rounded-lg p-2 text-slate-500 transition-all duration-200 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
                aria-label="刷新设备"
              >
                <RefreshCw className={`h-4 w-4 ${isSearching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {sortedDevices.length > 0 ? (
              <div className="space-y-1.5">
                {sortedDevices.map((device) => {
                  const Icon = device.device_type === 'android' ? Smartphone : Monitor
                  const isSelected = currentDevice?.device_id === device.device_id
                  const unread = unreadCounts[device.device_id] || 0
                  const deleteLocked = deleteLockedDeviceIds.has(device.device_id)

                  return (
                    <div
                      key={device.device_id}
                      onClick={() => onSelectDevice(device)}
                      className={`group flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all duration-200 ${
                        isSelected ? 'border-blue-200/60 bg-blue-50/80 shadow-sm' : 'border-transparent hover:bg-slate-50/80'
                      }`}
                    >
                      <div className={`relative shrink-0 rounded-xl p-2.5 ${device.is_online ? 'bg-emerald-50' : 'bg-slate-100/80'}`}>
                        <Icon className={`h-5 w-5 ${device.is_online ? 'text-emerald-600' : 'text-slate-400'}`} />
                        <div className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${device.is_online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm font-medium ${device.is_online ? 'text-slate-900' : 'text-slate-600'}`}>
                            {getDeviceDisplayName(device)}
                          </span>
                          {unread > 0 && (
                            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-400">
                          {device.is_online ? (
                            <>
                              <Wifi className="h-3 w-3 shrink-0 text-emerald-500" />
                              <span className="truncate text-emerald-600/80">{device.ip}</span>
                            </>
                          ) : (
                            <>
                              <WifiOff className="h-3 w-3 shrink-0" />
                              <span className="shrink-0">离线</span>
                              <span className="min-w-0 truncate">{formatLastSeen(device.last_seen)}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {confirmingDeleteDeviceId === device.device_id && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setConfirmingDeleteDeviceId(null)
                          }}
                          className="rounded-lg p-2 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600"
                          aria-label="取消删除设备"
                        >
                          <span className="px-1 text-xs font-bold">取消</span>
                        </button>
                      )}

                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          if (deleteLocked) return
                          if (confirmingDeleteDeviceId === device.device_id) {
                            onDeleteDevice(device.device_id)
                            setConfirmingDeleteDeviceId(null)
                          } else {
                            setConfirmingDeleteDeviceId(device.device_id)
                          }
                        }}
                        disabled={deleteLocked}
                        title={deleteLocked ? '传输中不能删除，请先取消或等待完成' : undefined}
                        className={`rounded-lg p-2 text-slate-400 opacity-100 transition-all hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-300 sm:opacity-0 sm:group-hover:opacity-100 ${
                          confirmingDeleteDeviceId === device.device_id ? 'bg-red-50 text-red-600 sm:opacity-100' : ''
                        }`}
                        aria-label={confirmingDeleteDeviceId === device.device_id ? '确认删除设备' : '删除设备'}
                      >
                        {confirmingDeleteDeviceId === device.device_id ? (
                          <span className="px-1 text-xs font-bold">确认</span>
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-slate-400">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200/50">
                  {isSearching ? (
                    <RefreshCw className="h-8 w-8 animate-spin text-blue-500" />
                  ) : (
                    <Monitor className="h-8 w-8 text-slate-300" />
                  )}
                </div>
                <p className="text-center text-sm font-medium text-slate-500">{isSearching ? '正在搜索设备' : '暂无设备'}</p>
                <p className="mt-1 text-center text-xs text-slate-400">
                  {isSearching
                    ? startupDiscoveryRemaining > 0
                      ? `启动搜索剩余 ${startupDiscoveryRemaining} 秒`
                      : '正在扫描同一局域网内的设备'
                    : '点击刷新搜索局域网设备，或确认双方在同一 Wi-Fi。'}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {currentView === 'history' && (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-slate-400">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200/50">
            <Clock className="h-8 w-8 text-slate-300" />
          </div>
          <p className="text-center text-sm font-medium text-slate-500">传输历史</p>
          <p className="mt-1 text-center text-xs text-slate-400">可在主区域查看全部记录</p>
        </div>
      )}

      <div className="border-t border-slate-200/60 p-3">
        <button
          onClick={() => onSelectView('settings')}
          className={`flex w-full items-center gap-3 rounded-xl border p-3 transition-all duration-200 ${
            currentView === 'settings'
              ? 'border-blue-200/60 bg-blue-50/80 text-blue-700 shadow-sm'
              : 'border-transparent text-slate-600 hover:bg-slate-50/80 hover:text-slate-900'
          }`}
        >
          <SettingsIcon className={`h-5 w-5 ${currentView === 'settings' ? 'text-blue-600' : 'text-slate-400'}`} />
          <span className="text-sm font-medium">设置</span>
        </button>
      </div>
    </div>
  )
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean
  icon: typeof MessageSquare
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
        active ? 'bg-blue-50/80 text-blue-700 shadow-sm' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-blue-600' : ''}`} />
      <span>{label}</span>
    </button>
  )
}
