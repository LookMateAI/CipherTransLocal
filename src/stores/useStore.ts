import { create } from 'zustand'
import { Device, ChatMessage } from '../types'

interface AppState {
  devices: Device[]
  currentDevice: Device | null
  currentView: 'devices' | 'history' | 'settings'
  messages: Record<string, ChatMessage[]>
  settings: {
    device_name: string
    download_path: string
  }
  
  setDevices: (devices: Device[]) => void
  setCurrentDevice: (device: Device | null) => void
  setCurrentView: (view: 'devices' | 'history' | 'settings') => void
  addMessage: (device_id: string, message: ChatMessage) => void
  updateMessage: (device_id: string, message_id: string, updates: Partial<ChatMessage>) => void
  setSettings: (settings: Partial<AppState['settings']>) => void
}

export const useStore = create<AppState>((set) => ({
  devices: [],
  currentDevice: null,
  currentView: 'devices',
  messages: {},
  settings: {
    device_name: 'My Device',
    download_path: '',
  },
  
  setDevices: (devices) => set({ devices }),
  
  setCurrentDevice: (device) => set({ currentDevice: device }),
  
  setCurrentView: (view) => set({ currentView: view }),
  
  addMessage: (device_id, message) => set((state) => ({
    messages: {
      ...state.messages,
      [device_id]: [...(state.messages[device_id] || []), message],
    },
  })),
  
  updateMessage: (device_id, message_id, updates) => set((state) => {
    const deviceMessages = state.messages[device_id] || []
    return {
      messages: {
        ...state.messages,
        [device_id]: deviceMessages.map((msg) =>
          msg.message_id === message_id ? { ...msg, ...updates } : msg
        ),
      },
    }
  }),
  
  setSettings: (settings) => set((state) => ({
    settings: { ...state.settings, ...settings },
  })),
}))