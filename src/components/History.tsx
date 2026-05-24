import { ReactNode, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChatMessage } from '../types'
import { transferFriendlyError } from '../utils/errors'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
  Check,
  Clock,
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
import type { LucideIcon } from 'lucide-react'

interface HistoryProps {
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

export function History({ deviceNames = {} }: HistoryProps) {
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/30">
      <div className="shrink-0 border-b border-slate-200/60 bg-white/90 px-5 py-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-md shadow-blue-500/20">
            <Clock className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">传输历史</h2>
            <p className="text-xs text-slate-500">查看所有文字和文件传输记录</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <StatCard title="总数" value={stats.total} icon={TrendingUp} />
          <StatCard title="发送" value={stats.sent} icon={Send} />
          <StatCard title="接收" value={stats.received} icon={ArrowDownToLine} />
          <StatCard title="总流量" value={formatSize(stats.totalSize)} icon={HardDrive} />
        </div>
      </div>

      <div className="shrink-0 border-b border-slate-200/60 bg-white/80 p-4 backdrop-blur-sm">
        <div className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void search()}
                placeholder="搜索文件名或文字内容"
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 text-sm text-slate-900 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <button
              type="button"
              onClick={() => void search()}
              className="h-11 rounded-xl border border-slate-200 bg-slate-100 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200"
            >
              搜索
            </button>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {error && (
              <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
                {error}
              </div>
            )}
            <SegmentedControl items={directionFilters} value={directionFilter} onChange={setDirectionFilter} />
            <div className="flex min-w-0 items-center gap-1 rounded-xl bg-slate-100 p-1">
              <div className="flex h-8 items-center gap-1.5 px-2 text-xs font-semibold text-slate-500">
                <CalendarDays className="h-3.5 w-3.5" />
                日期
              </div>
              {dateFilters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setDateFilter(item.key)}
                  className={`h-8 rounded-lg px-3 text-xs font-semibold transition-all ${
                    dateFilter === item.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {confirmClear ? (
              <div className="flex items-center gap-1 rounded-xl border border-red-100 bg-red-50 p-1">
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white"
                  aria-label="取消清空"
                >
                  <X className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void clearHistory()}
                  disabled={messages.length === 0 || clearing || hasDeleteLockedMessages}
                  className="h-8 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:bg-slate-300"
                >
                  确认清空
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={messages.length === 0 || clearing || hasDeleteLockedMessages}
                title={hasDeleteLockedMessages ? '传输中不能清空，请先取消或等待完成' : undefined}
                className="flex h-10 items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                <Trash2 className="h-4 w-4" />
                清空历史
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
        {loading ? (
          <CenteredState title="加载历史中..." />
        ) : Object.keys(grouped).length > 0 ? (
          <div className="mx-auto max-w-4xl space-y-6">
            {Object.entries(grouped).map(([date, items]) => (
              <div key={date}>
                <div className="mb-3 flex items-center gap-3">
                  <span className="text-sm font-semibold text-slate-600">{date}</span>
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-xs text-slate-400">{items.length} 条</span>
                </div>

                <div className="space-y-2">
                  {items.map((message) => (
                    <HistoryRow key={message.message_id} message={message} peerName={deviceNames[message.device_id] || shortDeviceId(message.device_id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <CenteredState title="暂无传输记录" subtitle="完成一次文字或文件传输后会显示在这里" />
        )}
      </div>
    </div>
  )
}

function HistoryRow({ message, peerName }: { message: ChatMessage; peerName: string }) {
  const Icon = getFileIcon(message.file_type)
  const isText = message.file_type === 'text'

  return (
    <article className="rounded-xl border border-slate-200/60 bg-white p-4 shadow-sm transition-all hover:border-slate-300/60 hover:shadow">
      <div className="flex items-start gap-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${message.direction === 'send' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>
          {message.direction === 'send' ? <ArrowUpFromLine className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <Icon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {isText ? (
              <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-sm font-medium text-slate-900">{message.file_name}</p>
            ) : (
              <h3 className="break-all text-sm font-medium leading-5 text-slate-900">{message.file_name}</h3>
            )}
            <Badge tone={message.direction === 'send' ? 'blue' : 'emerald'}>{message.direction === 'send' ? '发送' : '接收'}</Badge>
            <Badge tone={statusTone(message.status)}>{statusLabel(message.status)}</Badge>
            {isText && <CopyButton text={message.file_name} />}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-medium text-slate-600">设备：{peerName}</span>
            {!isText && <span>{formatSize(message.file_size)}</span>}
            <span>{formatTime(message.timestamp)}</span>
          </div>
          {message.error && <p className="mt-1 truncate text-xs text-red-600">{transferFriendlyError(message.error)}</p>}
        </div>
      </div>
    </article>
  )
}

function SegmentedControl({
  items,
  value,
  onChange
}: {
  items: Array<{ key: DirectionFilter; label: string }>
  value: DirectionFilter
  onChange: (value: DirectionFilter) => void
}) {
  return (
    <div className="flex shrink-0 gap-1 rounded-xl bg-slate-100 p-1">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={`h-8 rounded-lg px-3 text-sm font-medium transition-all ${
            value === item.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
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
    <button type="button" onClick={copy} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="复制文字" aria-label="复制文字">
      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Clipboard className="h-4 w-4" />}
    </button>
  )
}

function StatCard({ title, value, icon: Icon }: { title: string; value: number | string; icon: LucideIcon }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
        <span>{title}</span>
      </div>
      <div className="truncate text-lg font-bold text-slate-950">{value}</div>
    </div>
  )
}

function CenteredState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center pb-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <Search className="h-8 w-8 text-slate-300" />
      </div>
      <p className="text-sm font-medium text-slate-500">{title}</p>
      {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
    </div>
  )
}

function Badge({ tone, children }: { tone: 'blue' | 'emerald' | 'slate'; children: ReactNode }) {
  const className =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-700'
      : tone === 'emerald'
        ? 'bg-emerald-50 text-emerald-700'
        : 'bg-slate-100 text-slate-600'
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${className}`}>{children}</span>
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
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
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
      return '已取消'
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
