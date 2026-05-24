import type { Device } from '../types'

export function getDeviceDisplayName(device: Device) {
  const primary = device.alias?.trim() || device.device_name?.trim()
  if (primary && primary.toLowerCase() !== 'localhost') {
    return primary
  }

  if (device.device_type === 'android') return 'Android 设备'
  if (device.device_type === 'windows') return 'Windows 电脑'

  return '桌面设备'
}

export function sortDevicesStable(devices: Device[]) {
  return [...devices].sort((a, b) => {
    if (a.is_online && !b.is_online) return -1
    if (!a.is_online && b.is_online) return 1

    const nameCompare = getDeviceDisplayName(a).localeCompare(getDeviceDisplayName(b), 'zh-CN', {
      numeric: true,
      sensitivity: 'base'
    })
    if (nameCompare !== 0) return nameCompare

    return a.device_id.localeCompare(b.device_id)
  })
}

export function formatLastSeen(timestamp: number) {
  const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000
  const diff = Date.now() - millis
  const minutes = Math.max(0, Math.floor(diff / 60000))

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  return new Date(millis).toLocaleDateString('zh-CN')
}
