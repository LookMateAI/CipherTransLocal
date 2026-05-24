import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChatMessage } from '../types'
import { transferFriendlyError } from '../utils/errors'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clipboard,
  Clock,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  X
} from 'lucide-react'

interface FileItemProps {
  message: ChatMessage
  isOwn: boolean
  onAction?: (action: 'pause' | 'resume' | 'cancel' | 'retry') => void
}

export function FileItem({ message, isOwn, onAction }: FileItemProps) {
  const [copied, setCopied] = useState(false)
  const [displayProgress, setDisplayProgress] = useState(() => clampProgress(message.progress || 0))
  const lastSampleRef = useRef({
    messageId: message.message_id,
    progress: clampProgress(message.progress || 0),
    sampledAt: performance.now(),
    speed: message.speed || 0
  })
  const Icon = getFileIcon(message.file_type)
  const isText = message.file_type === 'text'
  const progress = message.status === 'completed' ? 100 : displayProgress
  const isPreparing = !isText && message.direction === 'send' && message.status === 'pending' && progress <= 0 && !message.speed
  const isAwaitingReceive = !isText && message.direction === 'receive' && message.status === 'pending' && progress <= 0 && !message.speed
  const showTransferStats = !isText && ['pending', 'transferring', 'paused'].includes(message.status)
  const transferredBytes = Math.round(message.file_size * (progress / 100))
  const canRetry = message.status === 'failed' && !!message.file_path
  const canControl =
    !isText &&
    !!onAction &&
    (['pending', 'transferring', 'paused'].includes(message.status) || canRetry)
  const speedText = message.speed
    ? `${formatSize(message.speed)}/s`
    : isPreparing
      ? '准备文件'
      : isAwaitingReceive
        ? '等待接收'
        : message.status === 'pending'
          ? '等待传输'
          : '等待速度'
  const primaryAction: 'pause' | 'resume' | 'cancel' | 'retry' =
    canRetry ? 'retry' : message.status === 'paused' ? 'resume' : isPreparing ? 'cancel' : 'pause'
  const PrimaryIcon = primaryActionIcon(primaryAction)
  const primaryTitle = primaryActionTitle(primaryAction)

  useEffect(() => {
    const nextProgress = message.status === 'completed' ? 100 : clampProgress(message.progress || 0)
    lastSampleRef.current = {
      messageId: message.message_id,
      progress: nextProgress,
      sampledAt: performance.now(),
      speed: message.speed || 0
    }
    setDisplayProgress(nextProgress)
  }, [message.message_id, message.progress, message.speed, message.status])

  useEffect(() => {
    if (message.file_type === 'text' || message.status !== 'transferring' || !message.speed || message.file_size <= 0) return

    const timer = window.setInterval(() => {
      const sample = lastSampleRef.current
      if (sample.messageId !== message.message_id || sample.speed <= 0) return

      const elapsedSeconds = Math.max(0, (performance.now() - sample.sampledAt) / 1000)
      const estimated = sample.progress + (sample.speed * elapsedSeconds / message.file_size) * 100
      const backendProgress = clampProgress(message.progress || 0)
      const ceiling = Math.min(99.4, backendProgress + 4)
      setDisplayProgress((current) => Math.max(current, Math.min(estimated, ceiling)))
    }, 100)

    return () => window.clearInterval(timer)
  }, [message.file_type, message.file_size, message.message_id, message.progress, message.speed, message.status])

  const copyText = async () => {
    if (!isText) return
    await navigator.clipboard.writeText(message.file_name)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const renderControlButtons = () => {
    if (!canControl || !onAction) return null

    return (
      <div className="file-action-row flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
        <ActionButton title={primaryTitle} onClick={() => onAction(primaryAction)} icon={PrimaryIcon} />
        {primaryAction !== 'cancel' && <ActionButton title="取消" onClick={() => onAction('cancel')} icon={X} />}
      </div>
    )
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border bg-white/90 shadow-sm transition-all duration-200 ${isText ? 'px-3 py-2.5' : 'p-3'} ${borderClass(message.status)} ${
        isPreparing ? 'transfer-prepare-in border-blue-200/80 bg-blue-50/45 shadow-blue-100/80' : ''
      }`}
    >
      {isPreparing && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/75 to-transparent [animation:transferShimmer_900ms_ease-in-out_infinite]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/70 to-transparent" />
        </>
      )}
      {isText ? (
        <div className="relative flex items-start gap-2">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
              isOwn ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-sm leading-5 text-slate-900">
              {message.file_name}
            </p>
            <button
              type="button"
              onClick={copyText}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 opacity-100 transition-all hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100"
              title="复制文字"
              aria-label="复制文字"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Clipboard className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative space-y-2.5">
          <div className="flex items-start gap-2">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                isOwn ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
              }`}
            >
              <Icon className="h-4 w-4" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start gap-2">
                <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-slate-900">{message.file_name}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusPill status={message.status} progress={progress} isPreparing={isPreparing} />
                  {renderControlButtons()}
                </div>
              </div>
              {isPreparing && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-blue-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>正在准备文件</span>
                </div>
              )}
            </div>
          </div>

          <div className="text-xs text-slate-500">
            {showTransferStats ? (
              <div className="space-y-1.5">
                <div className="transfer-meta-row flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg bg-slate-50/80 px-2 py-1 text-[11px] leading-4 text-slate-500 ring-1 ring-slate-100">
                  <span className="font-semibold text-slate-700 tabular-nums">{message.file_size > 0 ? formatSize(transferredBytes) : '--'}</span>
                  <span className="text-slate-300">/</span>
                  <span className="tabular-nums">{message.file_size > 0 ? formatSize(message.file_size) : '--'}</span>
                  <span className="h-1 w-1 rounded-full bg-slate-300" aria-hidden="true" />
                  <span className={`font-semibold tabular-nums ${message.speed ? 'text-blue-600' : 'text-slate-500'}`}>{speedText}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${isPreparing ? 'transfer-indeterminate bg-blue-400' : progressBarClass(message.status)}`}
                    style={isPreparing ? undefined : { width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : (
              <span className="tabular-nums">{message.file_size > 0 ? formatSize(message.file_size) : '--'}</span>
            )}
          </div>

          {message.error && (
            <p className="mt-2 line-clamp-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs leading-5 text-red-600">
              {transferFriendlyError(message.error, isOwn ? '发送失败' : '接收失败')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status, progress, isPreparing }: { status: ChatMessage['status']; progress: number; isPreparing: boolean }) {
  if (isPreparing) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-bold text-blue-700">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>准备</span>
      </span>
    )
  }

  if (status === 'transferring') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="inline-block w-7 text-right tabular-nums">{progress.toFixed(0)}%</span>
      </span>
    )
  }

  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusPillClass(status)}`}>
      <StatusIcon status={status} />
      <span className="inline-block min-w-7 text-center">{statusLabel(status)}</span>
    </span>
  )
}

function ActionButton({
  title,
  onClick,
  icon: Icon
}: {
  title: string
  onClick: () => void
  icon: LucideIcon
}) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg bg-white/80 p-1.5 text-slate-500 transition-all hover:bg-white hover:text-slate-700" title={title}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function StatusIcon({ status }: { status: ChatMessage['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock className="h-3 w-3" />
    case 'transferring':
      return <Loader2 className="h-3 w-3 animate-spin" />
    case 'completed':
      return <CheckCircle2 className="h-3 w-3" />
    case 'failed':
      return <AlertCircle className="h-3 w-3" />
    case 'paused':
      return <Pause className="h-3 w-3" />
    case 'canceled':
      return <X className="h-3 w-3" />
    default:
      return null
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

function statusPillClass(status: ChatMessage['status']) {
  switch (status) {
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    case 'paused':
      return 'bg-amber-50 text-amber-700'
    case 'canceled':
      return 'bg-slate-100 text-slate-600'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
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

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

function borderClass(status: ChatMessage['status']) {
  switch (status) {
    case 'transferring':
      return 'border-blue-200/60'
    case 'completed':
      return 'border-emerald-200/60'
    case 'failed':
      return 'border-red-200/60'
    case 'paused':
      return 'border-amber-200/60'
    default:
      return 'border-slate-200/60'
  }
}

function progressBarClass(status: ChatMessage['status']) {
  switch (status) {
    case 'transferring':
      return 'bg-blue-500'
    case 'paused':
      return 'bg-amber-400'
    case 'failed':
      return 'bg-red-400'
    default:
      return 'bg-slate-300'
  }
}

function primaryActionIcon(action: 'pause' | 'resume' | 'cancel' | 'retry'): LucideIcon {
  switch (action) {
    case 'resume':
      return Play
    case 'cancel':
      return X
    case 'retry':
      return RotateCcw
    default:
      return Pause
  }
}

function primaryActionTitle(action: 'pause' | 'resume' | 'cancel' | 'retry') {
  switch (action) {
    case 'resume':
      return '继续'
    case 'cancel':
      return '取消'
    case 'retry':
      return '重试'
    default:
      return '暂停'
  }
}
