export type Note = {
  id: string
  text: string
  // 메모 내용을 마지막으로 고친 시각(ms)
  updatedAt: number
  // 아코디언이 펼쳐져 있는지
  isOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-notes': {
      notes: Shaped<Note[]>
      // 삭제를 한 번 눌러 확인을 기다리는 메모 id
      confirming: string | null
      // 사람이 패널을 켜 두길 원하는지(직접 닫으면 false)
      isPaneOpen: boolean
    }
  }
}
