// ended: 호출한 쪽의 응답과 함께 끝나 완료 알림이 오지 않는 백그라운드 실행
export type RunStatus = 'running' | 'done' | 'failed' | 'ended'

// 서브에이전트 한 번의 실행에서 쌓인 사용량
export type RunStats = {
  inputTokens: number
  outputTokens: number
  tools: Record<string, number>
  files: string[]
}

export type Run = {
  id: string
  kind: 'agent' | 'codex'
  type: string
  model: string
  effort: string
  category: string
  description: string
  isBackground: boolean
  status: RunStatus
  startedAt: number
  endedAt?: number
  // Codex를 백그라운드로 띄웠을 때 완료 알림과 맞춰 볼 작업 id
  taskId?: string
  // 완료 알림 없이 이 루프의 응답과 함께 끝나는 실행이면 그 루프 id (메인은 'main')
  endsWith?: string
  stats?: RunStats
  // 이 실행을 시작한 작업(프롬프트) id
  jobId?: string
}

// 작업 중 백그라운드로 실행한 Bash 명령(Codex 제외. Codex는 Run으로 기록한다)
export type BgTask = {
  id: string
  description: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  taskId?: string
  endsWith?: string
}

export type JobStatus = 'running' | 'done' | 'aborted' | 'error'

// 사용자 프롬프트 하나로 시작한 작업. 완료 알림으로 이어진 턴도 같은 작업에 붙는다.
export type Job = {
  id: string
  prompt: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  steps: PlanStep[]
  tasks: BgTask[]
  toolErrors: number
  recap?: string
}

export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { content: string; status: StepStatus }

// 마지막 Codex 실행으로 판단한 Codex 사용 가능 상태
export type CodexHealth =
  | { state: 'ok' }
  | { state: 'failed' }
  | { state: 'limited'; until?: string }

declare module 'claude-code' {
  interface PluginState {
    'subagent-panel': {
      runs: Shaped<Run[]>
      steps: Shaped<PlanStep[]>
      isPaneOpen: boolean
      codex: Shaped<CodexHealth | null>
      expanded: Shaped<string[]>
      jobs: Shaped<Job[]>
      currentJob: string | null
    }
  }
}
