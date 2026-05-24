import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { ChatMessage } from '../types'
import { transferFriendlyError } from '../utils/errors'
import {
  ArrowDownToLine,
  CalendarDays,
  Check,
  Clock3,
  Clipboard,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  HardDrive,
  MessageSquare,
  Search,
  Send,
  Trash2,
  TrendingUp,
  X
} from 'lucide-react'

interface MobileHistoryProps {
  deviceNames?: Record<string, string>
}

type DirectionFilter = 'all' | 'send' | 'receive'
type DateFilter = 'all' | 'today' | 'week' | 'month'

const directionFilters: Array<{ key: DirectionFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'send', label: '发送' },
  { key: 'receive', label: '接收' }
]

const dateFilters: Array<{ key: DateFilter; label: string }> = [
  { key: 'all', label: '全部日期' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '7 天' },
  { key: 'month', label: '30 天' }
]

export function MobileHistory({ deviceNames = {} }: MobileHistoryProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadHistory()
  }, [])

  const loadHistory = async () => {
    setLoading(true)
    try {
      const result = (await invoke('get_all_history')) as ChatMessage[]
      setMessages(result)
    } finally {
      setLoading(false)
    }
  }

  const search = async () => {
    if (!searchQuery.trim()) {
      await loadHistory()
      return
    }

    setLoading(true)
    try {
      const result = (await invoke('search_history', { query: searchQuery })) as ChatMessage[]
      setMessages(result)
    } finally {
      setLoading(false)
    }
  }

  const clearHistory = async () => {
    if (messages.length === 0 || clearing) return
    setClearing(true)
    setError('')
    try {
      await invoke('clear_all_history')
      setMessages([])
      setConfirmClear(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const visibleMessages = useMemo(() => {
    const cutoff = dateCutoff(dateFilter)
    return messages.filter((message) => {
      const matchDirection = directionFilter === 'all' || message.direction === directionFilter
      const matchDate = cutoff === null || message.timestamp >= cutoff
      return matchDirection && matchDate
    })
  }, [messages, directionFilter, dateFilter])

  const grouped = useMemo(() => {
    return visibleMessages.reduce((groups, message) => {
      const date = formatDate(message.timestamp)
      if (!groups[date]) groups[date] = []
      groups[date].push(message)
      return groups
    }, {} as Record<string, ChatMessage[]>)
  }, [visibleMessages])

  const stats = useMemo(
    () => ({
      total: messages.length,
      sent: messages.filter((message) => message.direction === 'send').length,
      received: messages.filter((message) => message.direction === 'receive').length,
      totalSize: messages.reduce((sum, message) => sum + message.file_size, 0)
    }),
    [messages]
  )
  const hasDeleteLockedMessages = messages.some(isDeleteLocked)

  const hasRows = Object.keys(grouped).length > 0

  return (
    <section className="flex h-full min-h-0 flex-col bg-slate-50">
      <div className="shrink-0 px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
        <div className="mb-3 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-500/20">
            <Clock3 className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-950">传输历史</h1>
            <p className="text-xs font-medium text-slate-500">按时间查看最近记录</p>
          </div>
        </div>

        <div className="mb-2 grid grid-cols-2 gap-1.5">
          <StatCard title="总数" value={stats.total} icon={TrendingUp} />
          <StatCard title="容量" value={formatSize(stats.totalSize)} icon={HardDrive} />
          <StatCard title="发送" value={stats.sent} icon={Send} />
          <StatCard title="接收" value={stats.received} icon={ArrowDownToLine} />
        </div>

        <div className="mb-2 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void search()}
              placeholder="搜索文件或文字"
              className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none focus:border-blue-400"
            />
          </div>
          <button type="button" onClick={() => void search()} className="h-10 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white">
            搜索
          </button>
        </div>

        <div className="mb-2 grid grid-cols-[1fr_auto] items-center gap-2">
          <div className="min-w-0 rounded-2xl bg-white p-1 shadow-sm ring-1 ring-slate-200/80">
            <div className="grid grid-cols-3 gap-1">
              {directionFilters.map((item) => {
                const active = directionFilter === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setDirectionFilter(item.key)}
                    className={`h-9 rounded-xl px-2 text-xs font-bold leading-none transition-colors ${
                      active ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20' : 'text-slate-600'
                    }`}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          </div>
          {confirmClear ? (
            <div className="flex h-11 items-center gap-1 rounded-2xl bg-red-50 p-1 shadow-sm ring-1 ring-red-100">
              <button type="button" onClick={() => setConfirmClear(false)} className="grid h-9 w-9 place-items-center rounded-xl text-slate-500">
                <X className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void clearHistory()}
                disabled={messages.length === 0 || clearing || hasDeleteLockedMessages}
                className="h-9 rounded-xl bg-red-600 px-3 text-xs font-bold text-white disabled:bg-slate-300"
              >
                确认
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={messages.length === 0 || clearing || hasDeleteLockedMessages}
              className="flex h-11 items-center gap-1.5 rounded-2xl bg-white px-3 text-xs font-bold text-red-500 shadow-sm ring-1 ring-red-100 disabled:text-slate-300 disabled:ring-slate-200"
              aria-label="清空历史"
              title="清空历史"
            >
              <Trash2 className="h-4 w-4" />
              清空
            </button>
          )}
        </div>

        {error && (
          <div className="mb-2 rounded-2xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
            {error}
          </div>
        )}

        <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1.5 pt-0.5">
          <div className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-white px-3 text-xs font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200">
            <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
            日期
          </div>
          {dateFilters.map((item) => {
            const active = dateFilter === item.key
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setDateFilter(item.key)}
                className={`h-9 shrink-0 rounded-full px-3 text-xs font-bold transition-colors ${
                  active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200'
                }`}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+96px)]">
        {loading ? (
          <CenteredState icon={Clock3} title="正在读取历史" quiet />
        ) : hasRows ? (
          <div className="space-y-3 pt-1">
            {Object.entries(grouped).map(([date, items]) => (
              <div key={date}>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-500">
                  <span>{date}</span>
                  <span className="h-px flex-1 bg-slate-200" />
                  <span>{items.length} 条</span>
                </div>
                <div className="space-y-1.5">
                  {items.map((message) => (
                    <MobileHistoryRow key={message.message_id} message={message} peerName={deviceNames[message.device_id] || shortDeviceId(message.device_id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <CenteredState icon={Search} title="暂无传输记录" subtitle="完成一次文件或文本传输后会显示在这里" />
        )}
      </div>
    </section>
  )
}

function MobileHistoryRow({ message, peerName }: { message: ChatMessage; peerName: string }) {
  const Icon = getFileIcon(message.file_type)
  const isText = message.file_type === 'text'

  return (
    <article className={`rounded-xl border bg-white px-2.5 py-2 shadow-sm ${message.direction === 'send' ? 'border-blue-100' : 'border-emerald-100'}`}>
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${message.direction === 'send' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            {isText ? (
              <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-sm font-semibold leading-5 text-slate-900">{message.file_name}</p>
            ) : (
              <h3 className="min-w-0 flex-1 break-all text-sm font-semibold leading-5 text-slate-900">{message.file_name}</h3>
            )}
            {isText && <CopyButton text={message.file_name} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-500">
            <Pill tone={message.direction === 'send' ? 'blue' : 'emerald'}>{message.direction === 'send' ? '发送' : '接收'}</Pill>
            <Pill tone={statusTone(message.status)}>{statusLabel(message.status)}</Pill>
            <span className="max-w-full truncate">设备：{peerName}</span>
            {message.file_type !== 'text' && <span>{formatSize(message.file_size)}</span>}
            <span>{formatTime(message.timestamp)}</span>
          </div>
          {message.error && <p className="mt-1 truncate text-xs text-red-600">{transferFriendlyError(message.error)}</p>}
        </div>
      </div>
    </article>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button type="button" onClick={copy} className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-500" aria-label="复制文字">
      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Clipboard className="h-4 w-4" />}
    </button>
  )
}

function CenteredState({ icon: Icon, title, subtitle, quiet = false }: { icon: LucideIcon; title: string; subtitle?: string; quiet?: boolean }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center pb-16 text-center text-slate-400">
      <div className={`mb-3 grid h-16 w-16 place-items-center rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 ${quiet ? 'opacity-80' : ''}`}>
        <Icon className="h-8 w-8 text-slate-300" />
      </div>
      <p className="text-sm font-medium text-slate-500">{title}</p>
      {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
    </div>
  )
}

function StatCard({ title, value, icon: Icon }: { title: string; value: number | string; icon: LucideIcon }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm">
      <div className="mb-0.5 flex min-w-0 items-center gap-1 text-[10px] font-medium text-slate-500">
        <Icon className="h-3 w-3 shrink-0 text-slate-400" />
        <span className="truncate">{title}</span>
      </div>
      <div className="min-w-0 break-words text-sm font-bold leading-4 text-slate-950">{value}</div>
    </div>
  )
}

function Pill({ tone, children }: { tone: 'blue' | 'emerald' | 'slate'; children: ReactNode }) {
  const className =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-700'
      : tone === 'emerald'
        ? 'bg-emerald-50 text-emerald-700'
        : 'bg-slate-100 text-slate-600'
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${className}`}>{children}</span>
}

function dateCutoff(filter: DateFilter) {
  if (filter === 'all') return null
  const now = new Date()
  if (filter === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  const days = filter === 'week' ? 7 : 30
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

function isDeleteLocked(message: ChatMessage) {
  return message.file_type !== 'text' && ['pending', 'transferring', 'paused'].includes(message.status)
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function getFileIcon(type: string): LucideIcon {
  switch (type) {
    case 'image':
      return FileImage
    case 'video':
      return FileVideo
    case 'audio':
      return FileAudio
    case 'document':
      return FileText
    case 'archive':
      return FileArchive
    case 'text':
      return MessageSquare
    default:
      return File
  }
}

function statusLabel(status: ChatMessage['status']) {
  switch (status) {
    case 'pending':
      return '等待'
    case 'transferring':
      return '传输中'
    case 'completed':
      return '完成'
    case 'failed':
      return '失败'
    case 'paused':
      return '暂停'
    case 'canceled':
      return '取消'
    default:
      return status
  }
}

function statusTone(status: ChatMessage['status']): 'blue' | 'emerald' | 'slate' {
  switch (status) {
    case 'completed':
      return 'emerald'
    case 'transferring':
    case 'pending':
      return 'blue'
    default:
      return 'slate'
  }
}

function shortDeviceId(deviceId: string) {
  return deviceId ? `设备 ${deviceId.slice(0, 8)}` : '未知设备'
}
