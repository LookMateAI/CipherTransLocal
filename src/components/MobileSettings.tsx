import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Settings as SettingsType } from '../types'
import { APP_VERSION } from '../version'
import {
  Bell,
  Camera,
  Check,
  Copy,
  HardDrive,
  Image,
  Info,
  Moon,
  Radio,
  ShieldCheck,
  Smartphone,
  Sun,
  Vibrate,
  Wifi,
  Zap
} from 'lucide-react'

interface MobileSettingsProps {
  settings: SettingsType
  onSave: (settings: SettingsType) => Promise<void>
}

const storageOptions = [
  {
    value: 'public_downloads' as const,
    title: '下载目录',
    description: '默认保存到系统下载目录里的 CipherTransLocal，文件管理器可以直接找到。',
    icon: HardDrive
  },
  {
    value: 'manual' as const,
    title: '自定义可见目录',
    description: '使用系统目录授权，把完成的文件同步到你选择的文件夹。',
    icon: HardDrive
  }
]

export function MobileSettings({ settings, onSave }: MobileSettingsProps) {
  const [localSettings, setLocalSettings] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 1500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const updateLocal = <K extends keyof SettingsType>(key: K, value: SettingsType[K]) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }))
  }

  const commit = async (nextSettings = localSettings, message = '设置已保存') => {
    if (JSON.stringify(nextSettings) === JSON.stringify(settings)) return
    setSaving(true)
    try {
      await onSave(nextSettings)
      setToast(message)
    } catch {
      setToast('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const updateAndCommit = <K extends keyof SettingsType>(key: K, value: SettingsType[K]) => {
    const next = { ...localSettings, [key]: value }
    setLocalSettings(next)
    void commit(next)
  }

  const chooseCustomDirectory = () => {
    try {
      window.CipherTransLocalAndroid?.pickReceiveDirectory()
    } catch (error) {
      console.error('Failed to open Android directory picker:', error)
    }
  }

  const copyPath = async () => {
    await navigator.clipboard?.writeText(localSettings.download_path).catch(() => undefined)
    setToast('路径已复制')
  }

  const locationLabel = () => {
    if (localSettings.android_storage_mode === 'manual') {
      return localSettings.android_custom_directory_name || '已授权的自定义目录'
    }
    return '手机存储 / Download / CipherTransLocal'
  }

  return (
    <section className="mobile-settings min-h-full px-4 pb-5 pt-[calc(env(safe-area-inset-top)+16px)]">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-500/20">
            <Smartphone className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-950">安卓设置</h1>
            <p className="text-xs font-medium text-slate-500">修改自动保存，输入框失焦保存</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-3 py-1 text-[11px] font-bold text-slate-500 shadow-sm ring-1 ring-slate-200">
          {saving ? '保存中' : '自动保存'}
        </span>
      </div>

      {toast && (
        <div className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+14px)] z-[90] -translate-x-1/2 rounded-full bg-slate-950/90 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="space-y-4">
        <Panel title="设备" icon={Smartphone}>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">本机名称</label>
          <input
            value={localSettings.device_name}
            onChange={(event) => updateLocal('device_name', event.target.value)}
            onBlur={() => void commit()}
            className="mt-2 h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
            placeholder="输入设备名称"
          />
          <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3">
            <div className="text-xs font-medium text-slate-500">设备 ID</div>
            <div className="mt-1 truncate text-xs text-slate-700">{localSettings.device_id}</div>
          </div>
        </Panel>

        <Panel title="关于" icon={Info}>
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
            <div>
              <div className="text-xs font-medium text-slate-500">应用版本</div>
              <div className="mt-1 text-sm font-bold text-slate-950">v{APP_VERSION}</div>
            </div>
            <span className="shrink-0 rounded-full bg-white px-3 py-1 text-[11px] font-bold text-slate-600 shadow-sm ring-1 ring-slate-200">
              安卓端
            </span>
          </div>
        </Panel>

        <Panel title="接收位置" icon={HardDrive}>
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-blue-700">当前目录位置</div>
                <div className="mt-1 text-sm font-bold leading-5 text-slate-950">{locationLabel()}</div>
              </div>
              <span className="shrink-0 rounded-full bg-blue-600 px-2.5 py-1 text-[11px] font-bold text-white">当前</span>
            </div>
            <div className="mt-3 rounded-xl bg-white/80 px-3 py-2">
              <div className="text-[11px] font-medium text-slate-500">内部写入路径</div>
              <div className="mt-1 break-all text-xs leading-5 text-slate-700">
                {localSettings.download_path || '应用默认目录'}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={copyPath} className="flex h-9 items-center justify-center gap-2 rounded-xl bg-white text-xs font-semibold text-slate-700 shadow-sm">
                <Copy className="h-3.5 w-3.5" />
                复制路径
              </button>
              <button type="button" onClick={chooseCustomDirectory} className="flex h-9 items-center justify-center gap-2 rounded-xl bg-slate-900 text-xs font-semibold text-white shadow-sm">
                <HardDrive className="h-3.5 w-3.5" />
                自定义目录
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {storageOptions.map((option) => {
              const Icon = option.icon
              const active = localSettings.android_storage_mode === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    if (option.value === 'manual' && !localSettings.android_custom_directory_uri) {
                      chooseCustomDirectory()
                      return
                    }
                    updateAndCommit('android_storage_mode', option.value)
                  }}
                  className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left ${
                    active ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900">{option.title}</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-500">{option.description}</div>
                  </div>
                  {active && <Check className="h-5 w-5 shrink-0 text-blue-600" />}
                </button>
              )
            })}
          </div>

          <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-700">
            接收完成后会保存到用户可见目录；图片可按设置额外发布到系统相册。
          </div>
        </Panel>

        <Panel title="相册和媒体" icon={Camera}>
          <SettingSwitch
            icon={Image}
            title="图片自动保存到相册"
            description="接收图片完成后，发布到系统相册的 Pictures/CipherTransLocal。"
            checked={localSettings.auto_save_images_to_gallery}
            onChange={(checked) => updateAndCommit('auto_save_images_to_gallery', checked)}
          />
        </Panel>

        <Panel title="连接" icon={Radio}>
          <SettingSwitch
            icon={Wifi}
            title="仅通过 Wi-Fi 发现"
            description="减少 VPN 或热点网络导致的错误设备。"
            checked={localSettings.android_wifi_only}
            onChange={(checked) => updateAndCommit('android_wifi_only', checked)}
          />
          <SettingSwitch
            icon={Bell}
            title="传输通知"
            description="接收、完成和失败时显示系统通知。"
            checked={localSettings.notification}
            onChange={(checked) => updateAndCommit('notification', checked)}
          />
        </Panel>

        <Panel title="手机体验" icon={Zap}>
          <SettingSwitch
            icon={ShieldCheck}
            title="传输时保持唤醒"
            description="降低大文件传输时被系统暂停的概率。"
            checked={localSettings.android_keep_screen_awake}
            onChange={(checked) => updateAndCommit('android_keep_screen_awake', checked)}
          />
          <SettingSwitch
            icon={Vibrate}
            title="触感反馈"
            description="关键操作和页面切换时轻微振动。"
            checked={localSettings.android_haptics}
            onChange={(checked) => updateAndCommit('android_haptics', checked)}
          />
        </Panel>

        <Panel title="外观" icon={Sun}>
          <div className="grid grid-cols-2 gap-2">
            <ThemeButton active={localSettings.theme === 'light'} icon={Sun} label="浅色" onClick={() => updateAndCommit('theme', 'light')} />
            <ThemeButton active={localSettings.theme === 'dark'} icon={Moon} label="深色" onClick={() => updateAndCommit('theme', 'dark')} />
          </div>
        </Panel>
      </div>
    </section>
  )
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-blue-600" />
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function SettingSwitch({
  icon: Icon,
  title,
  description,
  checked,
  onChange
}: {
  icon: LucideIcon
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3 text-left">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-slate-600 shadow-sm">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-slate-500">{description}</div>
      </div>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </span>
    </button>
  )
}

function ThemeButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-16 items-center justify-center gap-2 rounded-2xl border text-sm font-semibold ${
        active ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
