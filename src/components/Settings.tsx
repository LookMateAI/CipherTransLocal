import { ReactNode, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Settings as SettingsType } from '../types'
import { APP_VERSION } from '../version'
import {
  Bell,
  BellOff,
  FolderOpen,
  Gauge,
  HardDrive,
  Info,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Sparkles,
  Sun,
  Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface SettingsProps {
  settings: SettingsType | null
  onSave: (settings: SettingsType) => Promise<void>
}

const fallbackSettings: SettingsType = {
  device_id: '',
  device_name: '',
  download_path: '',
  speed_limit: 0,
  auto_start: false,
  notification: true,
  theme: 'light',
  android_storage_mode: 'public_downloads',
  auto_save_images_to_gallery: false,
  android_custom_directory_uri: '',
  android_custom_directory_name: '',
  android_keep_screen_awake: true,
  android_haptics: true,
  android_wifi_only: true
}

export function Settings({ settings, onSave }: SettingsProps) {
  const [localSettings, setLocalSettings] = useState<SettingsType>(settings || fallbackSettings)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (settings) setLocalSettings(settings)
  }, [settings])

  const updateLocal = <K extends keyof SettingsType>(key: K, value: SettingsType[K]) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }))
  }

  const commit = async (nextSettings = localSettings) => {
    if (!settings || JSON.stringify(nextSettings) === JSON.stringify(settings)) return
    setSaving(true)
    try {
      await onSave(nextSettings)
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  const updateAndCommit = <K extends keyof SettingsType>(key: K, value: SettingsType[K]) => {
    const next = { ...localSettings, [key]: value }
    setLocalSettings(next)
    void commit(next)
  }

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择下载目录'
      })
      if (selected) updateAndCommit('download_path', selected as string)
    } catch (error) {
      console.error('Failed to select folder:', error)
    }
  }

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600">
            <RefreshCw className="h-6 w-6 animate-spin text-white" />
          </div>
          <p className="text-sm text-slate-500">加载设置中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/30">
      <div className="mx-auto w-full max-w-3xl px-5 pb-14 pt-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-md shadow-blue-500/20">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">设置</h2>
              <p className="text-xs text-slate-500">修改后自动保存，输入框在失焦时保存</p>
            </div>
          </div>
          <div className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200">
            {saving ? '保存中...' : savedAt ? '已保存' : '自动保存'}
          </div>
        </div>

        <div className="space-y-3">
          <Panel title="设备" icon={Monitor}>
            <Field label="设备名称" hint="其他设备会看到这个名称，默认使用当前电脑真实名称。">
              <input
                type="text"
                value={localSettings.device_name}
                onChange={(event) => updateLocal('device_name', event.target.value)}
                onBlur={() => void commit()}
                className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 text-sm text-slate-900 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/10"
                placeholder="输入设备名称"
              />
            </Field>
          </Panel>

          <Panel title="关于" icon={Info}>
            <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50/80 px-3 py-2.5">
              <div>
                <div className="text-xs font-semibold text-slate-500">应用版本</div>
                <div className="mt-0.5 text-xs text-slate-400">桌面端与安卓端保持一致</div>
              </div>
              <div className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 shadow-sm ring-1 ring-slate-200">
                v{APP_VERSION}
              </div>
            </div>
          </Panel>

          <Panel title="存储" icon={HardDrive}>
            <Field label="下载路径" hint="接收的文件会自动保存到这个目录。">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={localSettings.download_path}
                  onChange={(event) => updateLocal('download_path', event.target.value)}
                  onBlur={() => void commit()}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50/60 px-3 text-sm text-slate-900 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/10"
                  placeholder="选择下载路径"
                />
                <button
                  type="button"
                  onClick={handleSelectFolder}
                  className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <FolderOpen className="h-4 w-4" />
                  选择
                </button>
              </div>
            </Field>
          </Panel>

          <Panel title="传输" icon={Gauge}>
            <Field label="速度限制" hint="设置为 0 表示不限制传输速度。">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={localSettings.speed_limit}
                  onChange={(event) => updateLocal('speed_limit', parseInt(event.target.value, 10) || 0)}
                  onBlur={() => void commit()}
                  className="h-10 w-28 rounded-xl border border-slate-200 bg-slate-50/60 px-3 text-center text-sm text-slate-900 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/10"
                  min="0"
                />
                <span className="text-sm font-medium text-slate-600">MB/s</span>
              </div>
            </Field>
            <ToggleRow
              icon={Zap}
              title="自动启动"
              description="开机时自动启动应用"
              checked={localSettings.auto_start}
              onToggle={() => updateAndCommit('auto_start', !localSettings.auto_start)}
            />
          </Panel>

          <Panel title="通知" icon={localSettings.notification ? Bell : BellOff}>
            <ToggleRow
              icon={Bell}
              title="传输通知"
              description="传输完成或失败时发送系统通知"
              checked={localSettings.notification}
              onToggle={() => updateAndCommit('notification', !localSettings.notification)}
            />
          </Panel>

          <Panel title="外观" icon={Palette}>
            <div className="grid grid-cols-2 gap-2">
              <ThemeButton active={localSettings.theme === 'light'} icon={Sun} label="浅色模式" onClick={() => updateAndCommit('theme', 'light')} />
              <ThemeButton active={localSettings.theme === 'dark'} icon={Moon} label="深色模式" onClick={() => updateAndCommit('theme', 'dark')} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-lg bg-blue-50 p-1.5">
          <Icon className="h-4 w-4 text-blue-600" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold text-slate-600">{label}</div>
      {children}
      <p className="mt-1.5 text-xs leading-5 text-slate-500">{hint}</p>
    </label>
  )
}

function ToggleRow({
  icon: Icon,
  title,
  description,
  checked,
  onToggle
}: {
  icon: LucideIcon
  title: string
  description: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-slate-50/70 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className={`h-4 w-4 shrink-0 ${checked ? 'text-blue-500' : 'text-slate-400'}`} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-700">{title}</div>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-all duration-200 ${checked ? 'bg-blue-500' : 'bg-slate-200'}`}
        aria-label={title}
      >
        <div className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200 ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </div>
  )
}

function ThemeButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-12 items-center justify-center gap-2 rounded-xl border transition-all duration-200 ${
        active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      <Icon className="h-4 w-4" />
      <span className="text-sm font-medium">{label}</span>
    </button>
  )
}
