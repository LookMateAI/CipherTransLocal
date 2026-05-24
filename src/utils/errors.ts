export function userFriendlyError(prefix: string, err: unknown) {
  const raw = normalizeError(err)
  const lower = raw.toLowerCase()

  if (includesAny(lower, ['device is offline', 'offline'])) {
    return `${prefix}：设备离线。请确认对方应用已打开，并且双方处于同一 Wi-Fi 或局域网。`
  }

  if (includesAny(lower, ['device not found', 'not found'])) {
    return `${prefix}：没有找到该设备。请刷新设备列表，确认对方仍在附近后重试。`
  }

  if (includesAny(lower, ['no files selected', 'no file selected', 'empty file list'])) {
    return `${prefix}：没有选择任何文件。请重新选择图片或文件后发送。`
  }

  if (includesAny(lower, ['all selected files are unavailable', 'no such file', 'file not found'])) {
    return `${prefix}：选择的文件不存在或已被移动。请重新选择文件后发送。`
  }

  if (includesAny(lower, ['permission', 'denied', 'access is denied', '拒绝访问'])) {
    return `${prefix}：权限不足。请检查文件、存储或网络权限后重试。`
  }

  if (includesAny(lower, ['cancel', 'canceled', 'cancelled', '操作已取消'])) {
    return `${prefix}：操作已取消。`
  }

  if (includesAny(lower, ['network', 'connection', 'timeout', 'timed out', 'refused', 'unreachable', 'probe failed', 'chunk upload failed', 'http error'])) {
    return `${prefix}：网络连接异常或对方应用在后台被系统挂起。请让对方回到前台，或允许后台运行后重试。`
  }

  if (includesAny(lower, ['checksum', 'final verification', 'verification'])) {
    return `${prefix}：文件校验失败。可能是网络中断或文件发生变化，请重新发送。`
  }

  if (includesAny(lower, ['transfer not found'])) {
    return `${prefix}：没有找到可继续的传输任务。请重新选择文件发送。`
  }

  if (includesAny(lower, ['gallery directory is unavailable'])) {
    return `${prefix}：无法访问相册目录。请检查存储权限，或关闭自动保存到相册后重试。`
  }

  if (raw.includes('文件已被删除或移动')) {
    return `${prefix}：文件已被删除或移动，无法打开原始位置。`
  }

  if (raw.includes('当前平台不支持')) {
    return `${prefix}：当前平台暂不支持这个操作。`
  }

  return `${prefix}：${raw}`
}

export function transferFriendlyError(err: unknown, prefix = '传输失败') {
  return userFriendlyError(prefix, err)
}

function normalizeError(err: unknown) {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function includesAny(value: string, patterns: string[]) {
  return patterns.some((pattern) => value.includes(pattern))
}
