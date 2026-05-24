export interface Device {
  device_id: string
  device_name: string
  device_type: 'windows' | 'android'
  ip: string
  port: number
  last_seen: number
  is_online: boolean
  alias?: string
  is_favorite: boolean
}

export interface ChatMessage {
  message_id: string
  device_id: string
  file_id: string
  file_name: string
  file_size: number
  file_type: FileType
  direction: 'send' | 'receive'
  status: MessageStatus
  timestamp: number
  thumbnail?: string
  progress?: number
  speed?: number
  error?: string
  file_path?: string
}

export interface Settings {
  device_id: string
  device_name: string
  download_path: string
  speed_limit: number
  auto_start: boolean
  notification: boolean
  theme: 'light' | 'dark'
  android_storage_mode: 'public_downloads' | 'manual'
  auto_save_images_to_gallery: boolean
  android_custom_directory_uri: string
  android_custom_directory_name: string
  android_keep_screen_awake: boolean
  android_haptics: boolean
  android_wifi_only: boolean
}

export type FileType = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'text' | 'other'

export type MessageStatus = 
  | 'pending' 
  | 'transferring' 
  | 'completed' 
  | 'failed' 
  | 'paused'
  | 'canceled'
