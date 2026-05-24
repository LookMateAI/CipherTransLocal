import { useEffect, useRef, useState } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import { useLayoutEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChatMessage, Device } from '../types'
import { getDeviceDisplayName } from '../utils/device'
import { FileItem } from './FileItem'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Edit2,
  FileUp,
  FolderOpen,
  Image,
  Loader2,
  Monitor,
  MoreVertical,
  Paperclip,
  Send,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react'

type PickMode = 'file' | 'image'
type AndroidKeyboardBridge = Window & {
  CipherTransLocalAndroid?: {
    showKeyboard?: () => void
  }
}

interface ChatWindowProps {
  messages: ChatMessage[]
  device: Device
  onSelectFiles: (mode?: PickMode) => void
  onSendFiles: (filePaths: string[]) => void
  onSendText: (text: string) => Promise<boolean> | boolean
  onTransferAction: (action: 'pause' | 'resume' | 'cancel' | 'retry', messageId: string) => void
  onOpenFileLocation?: (message: ChatMessage) => void
  onClearHistory?: () => Promise<void> | void
  sending: boolean
  sendingText?: boolean
  preparingFileCount?: number
  isLoadingMessages?: boolean
}

export function ChatWindow({
  messages,
  device,
  onSelectFiles,
  onSendFiles,
  onSendText,
  onTransferAction,
  onOpenFileLocation,
  onClearHistory,
  sending,
  sendingText = false,
  preparingFileCount = 0,
  isLoadingMessages = false
}: ChatWindowProps) {
  const [showMenu, setShowMenu] = useState(false)
  const [showAliasInput, setShowAliasInput] = useState(false)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [confirmClearHistory, setConfirmClearHistory] = useState(false)
  const [mobileInputFocused, setMobileInputFocused] = useState(false)
  const [alias, setAlias] = useState(device.alias || '')
  const [isDragging, setIsDragging] = useState(false)
  const [text, setText] = useState('')
  const [contextMenu, setContextMenu] = useState<{ message: ChatMessage; x: number; y: number; alignRight: boolean } | null>(null)
  const chatWindowRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  const inputBarRef = useRef<HTMLDivElement>(null)
  const headerMenuRef = useRef<HTMLDivElement>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const autoScrollingUntilRef = useRef(0)
  const previousDeviceIdRef = useRef(device.device_id)
  const previousMessageCountRef = useRef(0)
  const justOpenedDeviceRef = useRef(true)
  const visualViewportBaseHeightRef = useRef<number | null>(null)
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp)
  const lastMessage = sortedMessages[sortedMessages.length - 1]
  const lastMessageId = lastMessage?.message_id || ''
  const isPreparingFiles = preparingFileCount > 0
  const isBusy = sending || sendingText || isPreparingFiles
  const inputDisabled = !device.is_online || sending || isPreparingFiles

  useLayoutEffect(() => {
    const deviceChanged = previousDeviceIdRef.current !== device.device_id
    const messageCountChanged = previousMessageCountRef.current !== sortedMessages.length

    previousDeviceIdRef.current = device.device_id
    previousMessageCountRef.current = sortedMessages.length

    if (deviceChanged) {
      shouldStickToBottomRef.current = true
      justOpenedDeviceRef.current = true
    }
    const mobileLayout = window.matchMedia('(max-width: 767px)').matches
    if (messageCountChanged && mobileLayout) {
      shouldStickToBottomRef.current = true
    }
    if (!shouldStickToBottomRef.current) return

    const behavior: ScrollBehavior = mobileLayout || justOpenedDeviceRef.current || deviceChanged || !messageCountChanged ? 'auto' : 'smooth'
    if (sortedMessages.length > 0) {
      justOpenedDeviceRef.current = false
    }
    scrollToBottom(behavior)
  }, [device.device_id, lastMessageId, sortedMessages.length])

  useEffect(() => {
    setAlias(device.alias || '')
    setConfirmClearHistory(false)
  }, [device.alias])

  useEffect(() => {
    if (!isPreparingFiles) return
    shouldStickToBottomRef.current = true
    setShowAttachMenu(false)
    scrollToBottom('smooth')
  }, [isPreparingFiles, preparingFileCount])

  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && !contextMenuRef.current?.contains(target)) setContextMenu(null)
      if (target && !headerMenuRef.current?.contains(target)) {
        setShowMenu(false)
        setConfirmClearHistory(false)
      }
      if (target && !attachMenuRef.current?.contains(target)) setShowAttachMenu(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
    }
  }, [])

  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return

    const root = chatWindowRef.current
    const inputBar = inputBarRef.current
    if (!root || !inputBar) return

    let settleTimers: number[] = []
    const setInputHeight = () => {
      root.style.setProperty('--mobile-input-height', `${Math.ceil(inputBar.getBoundingClientRect().height)}px`)
    }
    const setKeyboardOffset = () => {
      const viewport = window.visualViewport
      if (!viewport) {
        root.style.setProperty('--mobile-keyboard-offset', '0px')
        return
      }

      const baseHeight = Math.max(visualViewportBaseHeightRef.current || 0, window.innerHeight, viewport.height)
      visualViewportBaseHeightRef.current = baseHeight
      const keyboardOffset = Math.max(0, Math.round(baseHeight - viewport.height - viewport.offsetTop))
      root.style.setProperty('--mobile-keyboard-offset', `${keyboardOffset}px`)
    }
    const keepLatestMessageVisible = () => {
      if (!mobileInputFocused) return
      shouldStickToBottomRef.current = true
      requestAnimationFrame(() => scrollToBottom('auto'))
      settleTimers.forEach((timer) => window.clearTimeout(timer))
      settleTimers = [32, 80, 160, 280].map((delay) => window.setTimeout(() => scrollToBottom('auto'), delay))
    }
    const handleViewportChanged = () => {
      setInputHeight()
      setKeyboardOffset()
      keepLatestMessageVisible()
    }
    const resizeObserver = new ResizeObserver(setInputHeight)

    setInputHeight()
    setKeyboardOffset()
    keepLatestMessageVisible()
    resizeObserver.observe(inputBar)
    window.addEventListener('resize', handleViewportChanged)
    window.visualViewport?.addEventListener('resize', handleViewportChanged)
    window.visualViewport?.addEventListener('scroll', handleViewportChanged)
    return () => {
      settleTimers.forEach((timer) => window.clearTimeout(timer))
      resizeObserver.disconnect()
      root.style.removeProperty('--mobile-input-height')
      root.style.removeProperty('--mobile-keyboard-offset')
      window.removeEventListener('resize', handleViewportChanged)
      window.visualViewport?.removeEventListener('resize', handleViewportChanged)
      window.visualViewport?.removeEventListener('scroll', handleViewportChanged)
    }
  }, [mobileInputFocused])

  useEffect(() => {
    if (!mobileInputFocused || !window.matchMedia('(max-width: 767px)').matches) return
    shouldStickToBottomRef.current = true
    scrollToBottom('auto')
  }, [lastMessageId, mobileInputFocused, sortedMessages.length])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path))

    if (paths.length > 0) handleSendFilesSmoothly(paths)
  }

  const handleSendFilesSmoothly = (filePaths: string[]) => {
    if (filePaths.length === 0) return
    shouldStickToBottomRef.current = true
    setShowAttachMenu(false)
    requestAnimationFrame(() => onSendFiles(filePaths))
  }

  const handleSaveAlias = async () => {
    if (alias.trim() && alias !== device.alias) {
      await invoke('update_device_alias', { deviceId: device.device_id, alias: alias.trim() })
    }
    setShowAliasInput(false)
    setShowMenu(false)
  }

  const handleSubmitText = async () => {
    const content = text.trim()
    if (!content || !device.is_online || isBusy) return
    shouldStickToBottomRef.current = true
    const wasFocused = document.activeElement === textInputRef.current
    setText('')
    if (wasFocused) {
      requestAnimationFrame(() => {
        textInputRef.current?.focus({ preventScroll: true })
        ;(window as AndroidKeyboardBridge).CipherTransLocalAndroid?.showKeyboard?.()
      })
    }
    const sent = await Promise.resolve(onSendText(content))
    if (sent) {
      scrollToBottom('auto')
      if (document.activeElement !== textInputRef.current) {
        window.setTimeout(() => {
          textInputRef.current?.focus({ preventScroll: true })
          ;(window as AndroidKeyboardBridge).CipherTransLocalAndroid?.showKeyboard?.()
        }, 0)
      }
    } else {
      setText((currentText) => (currentText.trim() ? currentText : content))
    }
  }

  const handlePick = (mode: PickMode) => {
    setShowAttachMenu(false)
    onSelectFiles(mode)
  }

  const handleMessageContextMenu = (event: MouseEvent<HTMLDivElement>, message: ChatMessage) => {
    event.preventDefault()
    if (!onOpenFileLocation || message.file_type === 'text' || !message.file_path) return

    const menuWidth = 200
    const alignRight = event.clientX + menuWidth > window.innerWidth - 12
    setContextMenu({
      message,
      x: alignRight ? Math.max(12, window.innerWidth - menuWidth - 12) : event.clientX,
      y: Math.min(event.clientY, window.innerHeight - 72),
      alignRight
    })
  }

  const handleMessageScroll = () => {
    if (Date.now() < autoScrollingUntilRef.current) return
    const container = scrollContainerRef.current
    if (!container) return
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const mobileLayout = window.matchMedia('(max-width: 767px)').matches
    shouldStickToBottomRef.current = distanceToBottom < (mobileLayout ? 180 : 96)
  }

  const scrollToBottom = (behavior: ScrollBehavior) => {
    autoScrollingUntilRef.current = Date.now() + (behavior === 'smooth' ? 360 : 120)
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      if (!container) return

      container.scrollTo({ top: container.scrollHeight, behavior })

      if (behavior === 'auto') {
        requestAnimationFrame(() => {
          if (shouldStickToBottomRef.current) {
            container.scrollTop = container.scrollHeight
          }
        })
      } else {
        window.setTimeout(() => {
          const latestContainer = scrollContainerRef.current
          if (latestContainer && shouldStickToBottomRef.current) {
            latestContainer.scrollTo({ top: latestContainer.scrollHeight, behavior: 'auto' })
          }
        }, 120)
      }
    })
  }

  const keepInputFocusOnMobile = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      event.preventDefault()
      textInputRef.current?.focus({ preventScroll: true })
      ;(window as AndroidKeyboardBridge).CipherTransLocalAndroid?.showKeyboard?.()
    }
  }

  const handleDeleteMessage = async (message: ChatMessage) => {
    if (isDeleteLocked(message)) return

    try {
      await invoke('delete_message', { messageId: message.message_id })
    } catch (err) {
      console.error('Failed to delete message:', err)
    }
  }

  const handleClearDeviceHistory = async () => {
    if (!onClearHistory || hasDeleteLockedMessages) return
    await Promise.resolve(onClearHistory())
    setShowMenu(false)
    setConfirmClearHistory(false)
  }

  const Icon = device.device_type === 'android' ? Smartphone : Monitor
  const pendingCount = messages.filter((message) => message.status === 'pending').length
  const transferringCount = messages.filter((message) => message.status === 'transferring').length
  const hasDeleteLockedMessages = messages.some(isDeleteLocked)
  const displayName = getDeviceDisplayName(device)

  return (
    <div
      ref={chatWindowRef}
      className={`mobile-chat-window relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/30 ${mobileInputFocused ? 'mobile-keyboard-focused' : ''}`}
      onDrop={handleDrop}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(false)
      }}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 backdrop-blur-sm animate-fade-in">
          <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-blue-500 bg-white p-8 shadow-2xl">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-lg shadow-blue-500/25">
              <FileUp className="h-8 w-8 text-white" />
            </div>
            <p className="text-lg font-semibold text-slate-900">释放文件开始传输</p>
            <p className="text-sm text-slate-500">文件将发送到 {displayName}</p>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[90] min-w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y, width: contextMenu.alignRight ? 200 : undefined }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onOpenFileLocation?.(contextMenu.message)
              setContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <FolderOpen className="h-4 w-4 text-slate-500" />
            打开文件所在位置
          </button>
        </div>
      )}

      <div className="mobile-hidden shrink-0 overflow-visible border-b border-slate-200/60 bg-white/90 p-4 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className={`relative rounded-xl p-3 ${device.is_online ? 'bg-emerald-50' : 'bg-slate-100'}`}>
              <Icon className={`h-6 w-6 ${device.is_online ? 'text-emerald-600' : 'text-slate-400'}`} />
              {device.is_online && <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500 shadow-sm" />}
            </div>

            <div className="min-w-0 flex-1">
              {showAliasInput ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                    placeholder="输入设备别名"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                    autoFocus
                  />
                  <button onClick={handleSaveAlias} className="rounded-lg bg-blue-500 p-1.5 text-white hover:bg-blue-600" aria-label="保存别名">
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      setShowAliasInput(false)
                      setAlias(device.alias || '')
                    }}
                    className="rounded-lg bg-slate-100 p-1.5 text-slate-600 hover:bg-slate-200"
                    aria-label="取消修改"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="truncate text-lg font-semibold text-slate-900">{displayName}</h2>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                    {device.is_online ? (
                      <>
                        <Wifi className="h-4 w-4 text-emerald-500" />
                        <span className="font-medium text-emerald-600">在线</span>
                        <span>{device.ip}</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-4 w-4 text-slate-400" />
                        <span>离线，暂时无法发送</span>
                      </>
                    )}
                    {(pendingCount > 0 || transferringCount > 0) && (
                      <span className="font-medium text-blue-600">
                        {transferringCount > 0 && `${transferringCount} 个传输中`}
                        {transferringCount > 0 && pendingCount > 0 && '，'}
                        {pendingCount > 0 && `${pendingCount} 个等待中`}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div ref={headerMenuRef} className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="rounded-xl p-2.5 text-slate-500 hover:bg-slate-100/80 hover:text-slate-700"
              aria-label="更多操作"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
            {showMenu && (
              <div className="absolute right-0 top-full z-[95] mt-2 min-w-[188px] rounded-xl border border-slate-200/80 bg-white py-1.5 shadow-lg animate-slide-in">
                <button
                  onClick={() => {
                    setShowAliasInput(true)
                    setShowMenu(false)
                    setConfirmClearHistory(false)
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                >
                  <Edit2 className="h-4 w-4 text-slate-400" />
                  <span>修改别名</span>
                </button>
                {onClearHistory && (
                  <>
                    <div className="my-1 h-px bg-slate-100" />
                    {confirmClearHistory ? (
                      <div className="px-2 py-1">
                        <p className="px-2 pb-2 text-xs leading-5 text-slate-500">只清空当前设备的聊天和传输记录。</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmClearHistory(false)}
                            className="h-8 rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleClearDeviceHistory()}
                            disabled={hasDeleteLockedMessages}
                            className="h-8 rounded-lg bg-red-600 text-xs font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
                          >
                            确认清空
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClearHistory(true)}
                        disabled={hasDeleteLockedMessages}
                        title={hasDeleteLockedMessages ? '传输中不能清空，请先取消或等待完成' : undefined}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 disabled:text-slate-400"
                      >
                        <Trash2 className="h-4 w-4 text-red-400" />
                        <span>清空此设备记录</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleMessageScroll}
        className="mobile-chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"
      >
        {isLoadingMessages && sortedMessages.length === 0 ? (
          <div className="mobile-history-loading flex h-full flex-col justify-end">
            <div className="mx-auto w-full max-w-3xl space-y-4 pb-2">
              <MessageSkeleton align="left" />
              <MessageSkeleton align="right" />
              <MessageSkeleton align="left" compact />
            </div>
          </div>
        ) : sortedMessages.length > 0 ? (
          <div className={`mobile-message-list mx-auto max-w-3xl space-y-4 ${sortedMessages.length === 0 ? 'flex min-h-full flex-col justify-end' : ''}`}>
            {sortedMessages.map((message) => (
              <div key={message.message_id} className={`animate-message-in flex ${message.direction === 'send' ? 'justify-end' : 'justify-start'}`}>
                <div
                  onContextMenu={(event) => handleMessageContextMenu(event, message)}
                  className={`mobile-message-bubble group/message relative w-fit max-w-[70%] ${message.direction === 'send' ? 'order-1' : 'order-2'}`}
                >
                  <div className={`mb-1 flex items-center gap-1.5 ${message.direction === 'send' ? 'justify-end' : 'justify-start'}`}>
                    {message.direction === 'send' ? <ArrowUpFromLine className="h-3 w-3 text-blue-500" /> : <ArrowDownToLine className="h-3 w-3 text-emerald-500" />}
                    <span className="text-[11px] font-medium text-slate-500">{message.direction === 'send' ? '发送' : '接收'}</span>
                    {message.status === 'failed' && <AlertCircle className="h-3 w-3 text-red-500" />}
                  </div>
                  <FileItem message={message} isOwn={message.direction === 'send'} onAction={(action) => onTransferAction(action, message.message_id)} />
                  <div className="mt-1 flex min-h-6 items-center justify-between gap-2 text-xs text-slate-400">
                    {message.direction === 'send' ? (
                      <>
                        <MessageDeleteButton message={message} onClick={() => void handleDeleteMessage(message)} />
                        <span className="min-w-0 flex-1 text-right">{formatTime(message.timestamp)}</span>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 text-left">{formatTime(message.timestamp)}</span>
                        <MessageDeleteButton message={message} onClick={() => void handleDeleteMessage(message)} />
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-slate-400">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200/50">
              <Paperclip className="h-10 w-10 text-slate-300" />
            </div>
            <p className="text-sm font-medium text-slate-500">还没有消息</p>
            <p className="mt-2 text-xs text-slate-400">发送文字、图片或文件开始传输</p>
          </div>
        )}
      </div>

      <div ref={inputBarRef} className="mobile-input-bar shrink-0 border-t border-slate-200/60 bg-white/90 p-4 backdrop-blur-sm">
        <div className="mx-auto max-w-3xl">
          <div className="mobile-input-row flex items-center gap-3">
            <div ref={attachMenuRef} className="relative">
              <button
                onClick={() => setShowAttachMenu((value) => !value)}
                disabled={!device.is_online || isBusy}
                className="mobile-file-button flex items-center gap-2 rounded-xl border border-slate-200/60 bg-slate-100 px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-200/80 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="选择附件"
              >
                <Paperclip className="h-4 w-4" />
                <span className="mobile-file-label text-sm">选择附件</span>
              </button>

              {showAttachMenu && !isBusy && (
                <div className="attach-menu-enter absolute bottom-full left-0 z-50 mb-2 w-40 overflow-hidden rounded-2xl border border-slate-200 bg-white p-1 shadow-xl">
                  <button
                    onClick={() => handlePick('image')}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Image className="h-4 w-4 text-blue-500" />
                    图片
                  </button>
                  <button
                    onClick={() => handlePick('file')}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FolderOpen className="h-4 w-4 text-emerald-500" />
                    文件
                  </button>
                </div>
              )}
            </div>

            <input
              ref={textInputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleSubmitText()
                }
              }}
              disabled={inputDisabled}
              enterKeyHint="send"
              autoComplete="off"
              placeholder={isPreparingFiles ? '正在准备文件...' : sendingText ? '正在发送...' : '输入文字消息'}
              onFocus={() => {
                setMobileInputFocused(true)
                shouldStickToBottomRef.current = true
                requestAnimationFrame(() => scrollToBottom('auto'))
                window.setTimeout(() => scrollToBottom('auto'), 180)
              }}
              onBlur={() => {
                setMobileInputFocused(false)
              }}
              className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50/50 px-4 text-sm text-slate-900 placeholder-slate-400 transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50"
            />

            <button
              type="button"
              onPointerDown={keepInputFocusOnMobile}
              onClick={handleSubmitText}
              disabled={!device.is_online || isBusy || !text.trim()}
              className="mobile-send-button flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-6 py-2.5 font-medium text-white shadow-lg shadow-blue-500/25 hover:from-blue-600 hover:to-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="发送文字"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span className="mobile-send-label text-sm">{isPreparingFiles ? '准备中...' : sending || sendingText ? '发送中...' : '发送'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function isDeleteLocked(message: ChatMessage) {
  return message.file_type !== 'text' && ['pending', 'transferring', 'paused'].includes(message.status)
}

function MessageDeleteButton({ message, onClick }: { message: ChatMessage; onClick: () => void }) {
  const locked = isDeleteLocked(message)

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full opacity-100 transition-all sm:opacity-0 sm:group-hover/message:opacity-100 ${
        locked ? 'cursor-not-allowed text-slate-200' : 'text-slate-300 hover:bg-red-50 hover:text-red-500'
      }`}
      title={locked ? '传输中不能删除，请先取消或等待完成' : '删除消息'}
      aria-label={locked ? '传输中不能删除' : '删除消息'}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

function MessageSkeleton({ align, compact = false }: { align: 'left' | 'right'; compact?: boolean }) {
  return (
    <div className={`flex ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
      <div className={`message-skeleton rounded-2xl border border-slate-200 bg-white/80 p-3 shadow-sm ${compact ? 'w-48' : 'w-64 max-w-[76vw]'}`}>
        <div className="mb-2 h-2.5 w-20 rounded-full bg-slate-200" />
        <div className="h-3 rounded-full bg-slate-100" />
        <div className="mt-2 h-3 w-2/3 rounded-full bg-slate-100" />
      </div>
    </div>
  )
}
