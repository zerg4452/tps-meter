import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  BgTask,
  CodexHealth,
  Job,
  JobStatus,
  PlanStep,
  Run,
  RunStats,
  RunStatus,
  StepStatus,
} from '../types'

const PANE = 'subagent-panel'
const TITLE = '에이전트 현황'
// 작업 이력에서 지난 실행을 보여 주므로 넉넉히 남긴다.
const KEEP = 60
const JOB_KEEP = 20
const MAIN = 'main'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

// 저장 형태가 바뀌면 shape 태그를 올린다. 이전 버전이 남긴 값은 버려진다.
const runs = atom({ plugin: 'subagent-panel', key: 'runs' } as const, [], {
  shape: 'runs-2',
})
const steps = atom({ plugin: 'subagent-panel', key: 'steps' } as const, [], {
  shape: 'steps-1',
})
const isPaneOpen = atom(
  { plugin: 'subagent-panel', key: 'isPaneOpen' } as const,
  true,
)
const codex = atom({ plugin: 'subagent-panel', key: 'codex' } as const, null, {
  shape: 'codex-1',
})
// 펼친 항목 id: 수정 파일 목록은 실행 id, 작업 이력은 `job:<id>`
const expanded = atom({ plugin: 'subagent-panel', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const jobs = atom({ plugin: 'subagent-panel', key: 'jobs' } as const, [], {
  shape: 'jobs-1',
})
const currentJob = atom(
  { plugin: 'subagent-panel', key: 'currentJob' } as const,
  null,
)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Codex 출력에서 사용 한도를 알리는 문구. 리뷰 본문에 같은 단어가 나와도 오탐하지 않도록
// Codex 자체 오류 줄이거나 실행이 실패했을 때만 본다.
const CODEX_LIMIT = /usage limit|rate limit|quota/i
const CODEX_ERROR_LINE = /Codex error:[^\n]*/i

const BY_TYPE: Record<string, string> = {
  worker: '구현',
  Explore: '코드 탐색',
  Plan: '설계 자문',
  'general-purpose': '범용 작업',
  'claude-code-guide': '문서 조회',
  'codex:codex-rescue': 'Codex 위임',
  fork: '분기 작업',
}

// 작업 설명에 이 단어가 있으면 에이전트 종류보다 우선한다.
const BY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/보안|취약|security/i, '보안검토'],
  [/리뷰|검토|review/i, '리뷰'],
  [/화면|퍼블|프런트|프론트|front|\bui\b|css|스타일/i, '프런트'],
  [/테스트|검증|test/i, '테스트'],
  [/조사|탐색|분석|search|explore/i, '조사'],
]

const CODEX_SUBS = new Set(['adversarial-review', 'review', 'task'])

const RUN_LABEL: Record<RunStatus, string> = {
  running: '진행',
  done: '완료',
  failed: '중단',
  ended: '종료',
}
const RUN_COLOR: Record<RunStatus, string> = {
  running: 'warning',
  done: 'success',
  failed: 'error',
  ended: 'subtle',
}

const JOB_LABEL: Record<JobStatus, string> = {
  running: '진행 중',
  done: '정상 종료',
  aborted: '중단됨',
  error: '오류',
}
const JOB_COLOR: Record<JobStatus, string> = {
  running: 'warning',
  done: 'success',
  aborted: 'warning',
  error: 'error',
}
const STEP_MARK: Record<StepStatus, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '·',
}
const RUN_MARK: Record<RunStatus, string> = {
  running: '▶',
  done: '✓',
  failed: '✗',
  ended: '–',
}

type Ending = { status: RunStatus; at: number }

type Timed = { status: RunStatus; startedAt: number; endedAt?: number }

type Token = { text: string; isOperator: boolean }

type CodexCall = {
  sub: string
  model?: string
  effort?: string
  isWrite: boolean
  words: string
}

function categorize(type: string, description: string): string {
  for (const [words, label] of BY_WORDS) {
    if (words.test(description)) return label
  }

  return BY_TYPE[type] ?? type
}

// 따옴표 안의 공백·연산자는 한 인자로 묶고, 따옴표 밖의 ; | & 는 명령 경계로 본다.
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let text = ''
  let isOpen = false
  let quote: string | undefined
  const flush = () => {
    if (isOpen) tokens.push({ text, isOperator: false })
    text = ''
    isOpen = false
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
      } else if (ch === '\\' && quote === '"' && /["\\$`]/.test(command[i + 1] ?? '')) {
        text += command[++i]
      } else {
        text += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      isOpen = true
    } else if (ch === '\\') {
      text += command[++i] ?? ''
      isOpen = true
    } else if (/\s/.test(ch)) {
      flush()
    } else if (ch === ';' || ch === '|' || ch === '&') {
      flush()
      let operator = ch
      while (/[|&]/.test(command[i + 1] ?? '')) operator += command[++i]
      tokens.push({ text: operator, isOperator: true })
    } else {
      text += ch
      isOpen = true
    }
  }
  flush()

  return tokens
}

// `node <...>codex-companion.mjs <sub> ...` 형태로 실제 실행되는 명령만 인정한다.
function parseCodex(command: string): CodexCall | undefined {
  const tokens = tokenize(command)

  for (let i = 1; i < tokens.length; i++) {
    const script = tokens[i]
    const node = tokens[i - 1]
    const before = tokens[i - 2]
    const sub = tokens[i + 1]
    if (script === undefined || script.isOperator) continue
    if (!/codex-companion\.mjs$/.test(script.text)) continue
    if (node === undefined || node.isOperator) continue
    if (!/(^|[\\/])node(\.exe)?$/i.test(node.text)) continue
    if (before !== undefined && !before.isOperator) continue
    if (sub === undefined || sub.isOperator || !CODEX_SUBS.has(sub.text)) continue

    const call: CodexCall = { sub: sub.text, isWrite: false, words: '' }
    const words: string[] = []
    for (let j = i + 2; j < tokens.length; j++) {
      const token = tokens[j]
      if (token === undefined || token.isOperator) break
      const [name, inline] = token.text.split(/=(.*)/s)
      if (name === '--model' || name === '--effort') {
        const value = inline ?? tokens[j + 1]?.text
        if (inline === undefined) j++
        if (name === '--model') call.model = value
        else call.effort = value
      } else if (token.text === '--write') {
        call.isWrite = true
      } else {
        words.push(token.text)
      }
    }
    call.words = words.join(' ')

    return call
  }

  return undefined
}

function codexCategory(call: CodexCall): string {
  if (call.sub !== 'task') return '리뷰'
  if (call.isWrite) return '구현'
  if (/보안|security/i.test(call.words)) return '보안검토'

  return '리뷰'
}

// 완료 알림의 <task-id>와 <status> 칸만 읽는다. 둘 중 하나라도 없으면 무시한다.
function parseNotice(text: string): { taskId: string; status: RunStatus } | undefined {
  const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]
  const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1]?.toLowerCase()
  if (taskId === undefined || status === undefined) return undefined
  if (status === 'completed') return { taskId, status: 'done' }
  if (status === 'failed' || status === 'killed' || status === 'stopped') {
    return { taskId, status: 'failed' }
  }

  return undefined
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/\[.*\]$/, '')
}

function duration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))

  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
}

function elapsed(run: Timed): string {
  return run.endedAt === undefined ? '' : ` · ${duration(run.startedAt, run.endedAt)}`
}

function clockTime(ms: number): string {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

// 프롬프트의 첫 번째 내용 있는 줄을 작업 제목으로 쓴다.
function promptTitle(text: string): string {
  const first = text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

  return first === '' ? '(내용 없음)' : clip(first, 40)
}

function jobSummary(job: Job): string {
  const done = job.steps.filter(step => step.status === 'completed').length
  const steps = job.steps.length === 0 ? '단계 없음' : `완료 ${done}/${job.steps.length}`
  const time = job.endedAt === undefined ? '' : ` · ${duration(job.startedAt, job.endedAt)}`

  return `${steps} · ${JOB_LABEL[job.status]}${time}`
}

function jobStatusOf(reason: string): JobStatus {
  if (reason === 'answer') return 'done'
  if (reason === 'aborted') return 'aborted'

  return 'error'
}

function shortTool(name: string): string {
  return name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

function usageText(stats: RunStats): string {
  const counts = Object.entries(stats.tools).sort((a, b) => b[1] - a[1])
  const total = counts.reduce((sum, [, count]) => sum + count, 0)
  const top = counts
    .slice(0, 3)
    .map(([tool, count]) => `${tool} ${count}`)
    .join(' · ')
  const tools = total === 0 ? '도구 0회' : `도구 ${total}회 (${top})`

  return `토큰 입력 ${formatTokens(stats.inputTokens)} · 출력 ${formatTokens(stats.outputTokens)} · ${tools}`
}

function editedPath(args: Record<string, unknown>): string | undefined {
  const path = args.file_path ?? args.notebook_path

  return typeof path === 'string' && path !== '' ? path : undefined
}

function codexHealth(output: string, failed: boolean): CodexHealth {
  const errorLine = CODEX_ERROR_LINE.exec(output)?.[0]
  const limitLine =
    errorLine !== undefined && CODEX_LIMIT.test(errorLine)
      ? errorLine
      : failed && CODEX_LIMIT.test(output)
        ? output
        : undefined
  if (limitLine !== undefined) {
    const until = /try again at ([^.\n]+)/i.exec(limitLine)?.[1]?.trim()

    return until === undefined ? { state: 'limited' } : { state: 'limited', until }
  }

  return failed || errorLine !== undefined ? { state: 'failed' } : { state: 'ok' }
}

function codexText(health: CodexHealth | null): { text: string; color: string } {
  if (health === null) return { text: '아직 실행 기록 없음', color: 'subtle' }
  if (health.state === 'ok') return { text: '사용 가능 (마지막 실행 정상)', color: 'success' }
  if (health.state === 'failed') {
    return { text: '마지막 실행 실패 (사용 한도 외 원인)', color: 'warning' }
  }
  const until = health.until === undefined ? '' : ` · ${health.until} 이후 가능`

  return { text: `사용 한도 초과${until} → Claude 자체 검토로 대체`, color: 'error' }
}

// 이력에 원문으로 남기는 글(요청·결과·명령)의 상한. 화면에서는 자르지 않고 다 보인다.
const MAX_TEXT = 4000

function keep(text: string): string {
  const trimmed = text.trim()

  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function toStep(item: unknown): PlanStep[] {
  if (typeof item !== 'object' || item === null) return []
  const { content, status } = item as { content?: unknown; status?: unknown }
  if (typeof content !== 'string') return []
  const known = status === 'in_progress' || status === 'completed'

  return [{ content, status: known ? status : 'pending' }]
}

// update_plan 호출 인자를 앱의 작업 목록과 같은 규칙으로 반영한다.
function applyPlan(list: PlanStep[], args: Record<string, unknown>): PlanStep[] {
  let out = Array.isArray(args.items) ? args.items.flatMap(toStep) : list

  if (args.advance === true) {
    const at = out.findIndex(step => step.status === 'in_progress')
    const after = out.findIndex(
      (step, i) => i > at && step.status === 'pending',
    )
    out = out.map((step, i) =>
      i === at
        ? { ...step, status: 'completed' }
        : i === after
          ? { ...step, status: 'in_progress' }
          : step,
    )
  }
  if (Array.isArray(args.done)) {
    const done = new Set(args.done.map(n => Number(n) - 1))
    out = out.map((step, i) =>
      done.has(i) ? { ...step, status: 'completed' } : step,
    )
  }
  if (typeof args.start === 'number') {
    const start = args.start - 1
    out = out.map((step, i) =>
      i === start ? { ...step, status: 'in_progress' } : step,
    )
  }

  return out
}

function finishPlan(list: PlanStep[]): PlanStep[] {
  return list.map(step =>
    step.status === 'in_progress' ? { ...step, status: 'completed' } : step,
  )
}

// 시작 전에 기록된 종료(같은 id로 다시 시작된 에이전트의 이전 실행)는 반영하지 않는다.
function endRun<T extends Timed>(run: T, ending: Ending | undefined): T {
  return ending === undefined ||
    run.status !== 'running' ||
    ending.at < run.startedAt
    ? run
    : { ...run, status: ending.status, endedAt: ending.at }
}

// 패널 기록이 실패해도 도구 호출과 에이전트 실행은 그대로 진행되게 한다.
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // 패널 표시만 빠진다
  }
}

// isPaneOpen은 사람이 패널을 켜 두길 원하는지만 기억한다. 실제로 화면에 붙었는지는
// 앱이 정하므로(자리가 없으면 열린 채 대기) 버튼 표시는 매번 isPlaced로 판단한다.
async function isPaneShown($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()

  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

async function openPane($: EngineInterface): Promise<void> {
  await update($, isPaneOpen, () => true)
  await $.ui.open({ id: PANE, title: TITLE })
}

// 대기 중인 패널은 닫지 않고 다시 연다. 화면에 붙어 있을 때만 닫는다.
async function togglePane($: EngineInterface): Promise<void> {
  if (!(await isPaneShown($))) return openPane($)
  await update($, isPaneOpen, () => false)
  await $.ui.close({ id: PANE })
}

// 이벤트가 실행 항목 기록보다 먼저 도착할 수 있어, 도착한 사실을 먼저 보관해 두고
// 항목을 기록하거나 갱신할 때마다 함께 반영한다. 모듈이 다시 로드되면 비워진다.
const seen = new Map<string, { model: string; effort: string }>()
const agentEnds = new Map<string, Ending>()
const taskEnds = new Map<string, Ending>()
const stats = new Map<string, RunStats>()

function copyStats(from: RunStats): RunStats {
  return { ...from, tools: { ...from.tools }, files: [...from.files] }
}

function reconcile(run: Run): Run {
  if (run.kind === 'agent') {
    const counted = stats.get(run.id)
    const merged = counted === undefined ? run : { ...run, stats: copyStats(counted) }

    return endRun({ ...merged, ...seen.get(run.id) }, agentEnds.get(run.id))
  }

  return run.taskId === undefined ? run : endRun(run, taskEnds.get(run.taskId))
}

// 다시 로드된 뒤에는 저장된 값에서 이어 센다.
async function statsFor($: EngineInterface, id: string): Promise<RunStats> {
  const known = stats.get(id)
  if (known !== undefined) return known
  const run = (await read($, runs)).find(one => one.id === id)
  const seeded =
    run?.stats === undefined
      ? { inputTokens: 0, outputTokens: 0, tools: {}, files: [] }
      : copyStats(run.stats)
  const settled = stats.get(id) ?? seeded
  stats.set(id, settled)

  return settled
}

async function addStats(
  $: EngineInterface,
  id: string,
  change: (counted: RunStats) => void,
): Promise<void> {
  change(await statsFor($, id))
  await update($, runs, list =>
    list.map(run => (run.id === id ? reconcile(run) : run)),
  )
}

async function toggleOpen($: EngineInterface, id: string): Promise<void> {
  await update($, expanded, list =>
    list.includes(id) ? list.filter(one => one !== id) : [...list, id],
  )
}

async function setCodex($: EngineInterface, health: CodexHealth): Promise<void> {
  await update($, codex, () => health)
}

async function addRun($: EngineInterface, run: Run): Promise<void> {
  const jobId = run.jobId ?? (await read($, currentJob)) ?? undefined
  await update($, runs, list =>
    [...list.filter(one => one.id !== run.id), reconcile({ ...run, jobId })].slice(-KEEP),
  )
}

async function refresh($: EngineInterface): Promise<void> {
  await update($, runs, list => list.map(reconcile))
}

// 프롬프트를 받으면 다음 메인 턴이 시작될 때 새 작업으로 연다. 로컬 명령처럼
// 턴이 시작되지 않는 입력은 작업이 되지 않는다.
let pendingPrompt: string | undefined

async function startJob($: EngineInterface, prompt: string): Promise<void> {
  const job: Job = {
    id: crypto.randomUUID(),
    prompt: keep(prompt),
    status: 'running',
    startedAt: await $.clock.now(),
    steps: [],
    tasks: [],
    toolErrors: 0,
  }
  await update($, jobs, list => [...list, job].slice(-JOB_KEEP))
  await update($, currentJob, () => job.id)
}

async function changeJob($: EngineInterface, change: (job: Job) => Job): Promise<void> {
  const id = await read($, currentJob)
  if (id === null) return
  await update($, jobs, list => list.map(job => (job.id === id ? change(job) : job)))
}

function reconcileTask(task: BgTask): BgTask {
  return task.taskId === undefined ? task : endRun(task, taskEnds.get(task.taskId))
}

async function changeTasks($: EngineInterface, change: (task: BgTask) => BgTask): Promise<void> {
  await update($, jobs, list =>
    list.map(job => ({ ...job, tasks: job.tasks.map(change) })),
  )
}

// 진행 중인 작업과 실행은 남기고 끝난 것만 지운다.
async function clearHistory($: EngineInterface): Promise<void> {
  await update($, jobs, list => list.filter(job => job.status === 'running'))
  await update($, runs, list => list.filter(run => run.status === 'running'))
}

async function noteTask($: EngineInterface, text: string): Promise<void> {
  const notice = parseNotice(text)
  if (notice === undefined) return
  taskEnds.set(notice.taskId, { status: notice.status, at: await $.clock.now() })
  await refresh($)
  await changeTasks($, reconcileTask)

  // 백그라운드 Codex의 출력은 알림이 가리키는 출력 파일에 있다.
  const list = await read($, runs)
  const isCodex = list.some(run => run.kind === 'codex' && run.taskId === notice.taskId)
  if (!isCodex) return
  const failed = notice.status === 'failed'
  const file = /<output-file>\s*([^<]+?)\s*<\/output-file>/.exec(text)?.[1]
  let output = ''
  if (file !== undefined) {
    try {
      output = await $.fs.read(file)
    } catch {
      // 출력 파일을 못 읽으면 종료 상태로만 판단한다
    }
  }
  await setCodex($, codexHealth(output, failed))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-panel',
      description: '서브에이전트·Codex 실행과 작업 단계 패널을 열거나 닫기',
    })
    if (await read($, isPaneOpen)) void quietly(() => openPane($))

    return next(e)
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await togglePane($)
    const isOpen = await read($, isPaneOpen)

    return { text: isOpen ? '에이전트 현황 패널을 열었습니다.' : '에이전트 현황 패널을 닫았습니다.' }
  })

  // 화면이 나중에 연결되면 대기 중이던 패널이 붙을 수 있어 버튼 표시를 다시 그린다.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (await read($, isPaneOpen)) await quietly(() => openPane($))
    $.ui.invalidate('ui.render')

    return attached
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await quietly(() => update($, isPaneOpen, () => false))

    return closed
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) {
      return started
    }
    await quietly(() =>
      addRun($, {
        id: started.agentId ?? '',
        kind: 'agent',
        type: e.subagentType,
        model: started.model,
        effort: '확인 중',
        category: categorize(e.subagentType, e.description),
        description: e.description,
        isBackground: e.background,
        status: 'running',
        startedAt,
      }),
    )

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined && !seen.has(e.agentId)) {
      seen.set(e.agentId, {
        model: e.model,
        effort: e.effort === undefined ? '없음' : String(e.effort),
      })
      await quietly(() => refresh($))
    }

    const response = yield* next(e)
    const id = e.agentId
    const usage = response.usage
    if (id !== undefined && usage !== null) {
      await quietly(() =>
        addStats($, id, counted => {
          counted.inputTokens +=
            usage.input_tokens +
            usage.cache_read_input_tokens +
            usage.cache_creation_input_tokens
          counted.outputTokens += usage.output_tokens
        }),
      )
    }

    return response
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // 사용자 프롬프트로 시작한 턴은 새 작업, 완료 알림으로 이어진 턴은 같은 작업이다.
    const prompt = pendingPrompt
    pendingPrompt = undefined
    await quietly(() =>
      prompt !== undefined
        ? startJob($, prompt)
        : changeJob($, job => ({ ...job, status: 'running', endedAt: undefined })),
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    const loop = e.agentId ?? MAIN
    const at = await $.clock.now()
    if (e.agentId !== undefined) {
      agentEnds.set(e.agentId, { status: e.reason === 'answer' ? 'done' : 'failed', at })
    }
    const ending: Ending = { status: 'ended', at }
    await quietly(() =>
      update($, runs, list =>
        list.map(run => (run.endsWith === loop ? endRun(run, ending) : reconcile(run))),
      ),
    )
    await quietly(() =>
      changeTasks($, task => (task.endsWith === loop ? endRun(task, ending) : task)),
    )
    if (e.agentId === undefined) {
      const status = jobStatusOf(e.reason)
      await quietly(() => changeJob($, job => ({ ...job, status, endedAt: at })))
    }

    return answered
  })

  on('tool.call', async ($, e, next) => {
    const name: string = e.tool
    const agentId = e.agentId
    const args = e as unknown as Record<string, unknown>

    if (agentId !== undefined) {
      const tool = shortTool(name)
      await quietly(() =>
        addStats($, agentId, counted => {
          counted.tools[tool] = (counted.tools[tool] ?? 0) + 1
        }),
      )
    }

    const id = e.tool_use_id
    const loop = agentId ?? MAIN
    const path = EDIT_TOOLS.has(name) ? editedPath(args) : undefined
    const command = e.tool === 'Bash' ? e.command : undefined
    const description = e.tool === 'Bash' ? e.description : undefined
    const isBackground = e.tool === 'Bash' && e.run_in_background === true
    const call = command === undefined ? undefined : parseCodex(command)
    // Codex는 실행 항목으로, 그 밖의 백그라운드 Bash는 작업 이력의 백그라운드 작업으로 남긴다.
    const isTask = command !== undefined && call === undefined && isBackground
    // 시계는 기록할 실행이 있을 때만 읽는다(모든 도구 호출마다 읽지 않는다).
    const startedAt = call !== undefined || isTask ? await $.clock.now() : 0

    if (call !== undefined) {
      await quietly(() =>
        addRun($, {
          id,
          kind: 'codex',
          type: `codex ${call.sub}`,
          model: call.model ?? '기본 모델',
          effort: call.effort ?? '기본값',
          category: codexCategory(call),
          description: description ?? 'Codex 실행',
          isBackground,
          status: 'running',
          startedAt,
        }),
      )
    }
    if (isTask) {
      const task: BgTask = {
        id,
        description: keep(description ?? command),
        status: 'running',
        startedAt,
      }
      await quietly(() => changeJob($, job => ({ ...job, tasks: [...job.tasks, task] })))
    }

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true

    if (failed) {
      await quietly(() => changeJob($, job => ({ ...job, toolErrors: job.toolErrors + 1 })))
    }

    if (path !== undefined && agentId !== undefined && !failed) {
      await quietly(() =>
        addStats($, agentId, counted => {
          if (!counted.files.includes(path)) counted.files.push(path)
        }),
      )
    }

    if ((name === PLAN_TOOL || name === WRAP_TOOL) && !failed) {
      let planned: PlanStep[] = []
      await quietly(() =>
        update($, steps, list =>
          (planned = name === WRAP_TOOL ? finishPlan(list) : applyPlan(list, args)),
        ),
      )
      const recap = name === WRAP_TOOL && typeof args.recap === 'string' ? args.recap : undefined
      await quietly(() =>
        changeJob($, job => ({
          ...job,
          steps: planned,
          ...(recap === undefined ? {} : { recap: keep(recap) }),
        })),
      )
    }

    if (call !== undefined || isTask) {
      const result = ran.result as
        | {
            stdout?: string
            stderr?: string
            backgroundTaskId?: string
            backgroundEndsWithFinalResponse?: true
          }
        | undefined
      const taskId = ran.isError === true ? undefined : result?.backgroundTaskId
      const endsWith = result?.backgroundEndsWithFinalResponse ? loop : undefined
      const ending: Ending = { status: failed ? 'failed' : 'done', at: await $.clock.now() }
      const settle = <T extends Timed & { id: string; taskId?: string }>(item: T): T =>
        item.id !== id ? item : taskId === undefined ? endRun(item, ending) : { ...item, taskId, endsWith }

      if (call !== undefined) {
        // 포그라운드 실행은 결과에 출력이 있어 바로 판단한다. 거부된 호출은 Codex가 돌지 않았다.
        if (taskId === undefined && ran.deny === undefined) {
          const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}\n${ran.text ?? ''}`
          await quietly(() => setCodex($, codexHealth(output, failed)))
        }
        await quietly(() => update($, runs, list => list.map(run => reconcile(settle(run)))))
      } else {
        await quietly(() => changeTasks($, task => reconcileTask(settle(task))))
      }
    }

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    // 엔진은 늘 origin을 채우지만, 비어 있어도 프롬프트 처리는 막지 않는다.
    if (e.origin?.kind === 'task-notification') {
      await quietly(() => noteTask($, e.text))
    } else if (e.isMeta !== true) {
      pendingPrompt = e.text
    }

    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      await quietly(() => noteTask($, e.text))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const plan = await read($, steps)
    // 버튼을 누르면 isPaneOpen이 바뀌어 이 띠가 다시 그려진다. 읽어 두어야 그 신호를 받는다.
    await read($, isPaneOpen)
    const isOpen = await isPaneShown($)
    const running = list.filter(run => run.status === 'running').length
    // 작업 목록은 순서대로 진행되지 않으므로 몇 번째가 아니라 몇 개 끝났는지를 보인다.
    const done = plan.filter(step => step.status === 'completed').length
    const current = plan.find(step => step.status === 'in_progress')
    const stepText =
      plan.length === 0
        ? ''
        : ` · 완료 ${done}/${plan.length}${current ? ` · ${clip(current.content, 16)}` : ''}`

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          에이전트 진행 {running} · 끝남 {list.length - running}
          {stepText}{' '}
        </Text>
        <Button
          key="toggle-panel"
          label={isOpen ? '패널 닫기' : '패널 열기'}
          onPress={() => togglePane($)}
        />
      </Box>
    )
  })

  // 위쪽은 지금 실행 중인 것, 아래쪽은 프롬프트 단위의 작업 이력(최근 순 아코디언)이다.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const allRuns = await read($, runs)
    const running = [...allRuns].reverse().filter(run => run.status === 'running')
    const history = [...(await read($, jobs))].reverse()
    const health = codexText(await read($, codex))
    const opened = await read($, expanded)
    // 작업 기록 없이 끝난 실행(모드가 다시 로드되기 전 실행 등)은 이력 아래에 따로 모은다.
    const jobIds = new Set(history.map(job => job.id))
    const orphans = [...allRuns]
      .reverse()
      .filter(run => run.status !== 'running' && (run.jobId === undefined || !jobIds.has(run.jobId)))
    const hasEnded = history.some(job => job.status !== 'running') || orphans.length > 0

    // 끝난 실행 한 건을 이력 안에 두 줄로 보인다.
    const finished = (run: Run) => (
      <Box flexDirection="column">
        <Text color={RUN_COLOR[run.status]} wrap="wrap">
          {RUN_MARK[run.status]} {run.type} [{run.category}] · {shortModel(run.model)} · 추론{' '}
          {run.effort}
          {elapsed(run)}
        </Text>
        <Text dimColor wrap="wrap">
          {'  '}
          {run.description}
          {run.stats === undefined ? '' : ` · ${usageText(run.stats)}`}
        </Text>
        {files(run)}
      </Box>
    )

    // 수정 파일 목록 아코디언. 실행 중과 이력 어느 쪽에서나 같은 모양으로 쓴다.
    const files = (run: Run) =>
      run.stats !== undefined &&
      run.stats.files.length > 0 && (
        <Box flexDirection="column">
          <Button
            key={`files:${run.id}`}
            plain
            label={`${opened.includes(run.id) ? '▾' : '▸'} 수정 파일 ${run.stats.files.length}개`}
            onPress={() => toggleOpen($, run.id)}
          />
          {/* 펼쳤을 때는 경로를 줄이지 않고 전체를 줄바꿈해 보인다. */}
          {opened.includes(run.id) &&
            run.stats.files.map(file => (
              <Text dimColor wrap="wrap">
                {'  '}
                {file}
              </Text>
            ))}
        </Box>
      )

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Codex </Text>
          <Text color={health.color} wrap="wrap">
            {health.text}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text bold>실행 중 ({running.length})</Text>
        </Box>
        {running.length === 0 && (
          <Text dimColor>실행 중인 서브에이전트·Codex가 없습니다.</Text>
        )}
        {running.map(run => (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold color={RUN_COLOR[run.status]}>
                [{RUN_LABEL[run.status]}]{' '}
              </Text>
              <Text bold>{run.type} </Text>
              <Text color="suggestion">[{run.category}]</Text>
            </Box>
            <Text>
              {shortModel(run.model)} · 추론 {run.effort}
              {run.isBackground ? ' · 백그라운드' : ''}
            </Text>
            <Text dimColor wrap="wrap">
              {run.description}
            </Text>
            {run.stats !== undefined && (
              <Text dimColor wrap="wrap">
                {usageText(run.stats)}
              </Text>
            )}
            {files(run)}
          </Box>
        ))}

        <Box marginTop={1}>
          <Text bold>작업 이력</Text>
        </Box>
        {history.length === 0 && orphans.length === 0 && (
          <Text dimColor>아직 기록된 작업이 없습니다.</Text>
        )}
        {history.map(job => {
          const key = `job:${job.id}`
          const isOpen = opened.includes(key)
          const jobRuns = allRuns.filter(
            run => run.jobId === job.id && run.status !== 'running',
          )

          return (
            <Box flexDirection="column" marginTop={1}>
              <Box overflow="hidden">
                <Button
                  key={key}
                  plain
                  label={`${isOpen ? '▾' : '▸'} ${clockTime(job.startedAt)}  ${promptTitle(job.prompt)}`}
                  onPress={() => toggleOpen($, key)}
                />
              </Box>
              <Text color={JOB_COLOR[job.status]}>
                {'  '}
                {jobSummary(job)}
                {job.toolErrors > 0 ? ` · 도구 오류·거부 ${job.toolErrors}회` : ''}
              </Text>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2}>
                  {/* 펼치면 제목 줄에서 줄인 요청 원문을 그대로 보인다. */}
                  <Box marginBottom={1}>
                    <Text dimColor wrap="wrap">
                      요청: {job.prompt}
                    </Text>
                  </Box>
                  {job.steps.length === 0 && <Text dimColor>작업 단계 없음</Text>}
                  {job.steps.map(step => (
                    <Text
                      color={step.status === 'completed' ? 'success' : undefined}
                      dimColor={step.status === 'pending'}
                      wrap="wrap"
                    >
                      {STEP_MARK[step.status]} {step.content}
                      {job.status !== 'running' && step.status !== 'completed' ? ' (미완료)' : ''}
                    </Text>
                  ))}
                  {job.tasks.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text bold>백그라운드 작업</Text>
                      {job.tasks.map(task => (
                        <Text color={RUN_COLOR[task.status]} wrap="wrap">
                          {RUN_MARK[task.status]} {task.description} · {RUN_LABEL[task.status]}
                          {elapsed(task)}
                        </Text>
                      ))}
                    </Box>
                  )}
                  {jobRuns.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text bold>서브에이전트 · Codex</Text>
                      {jobRuns.map(finished)}
                    </Box>
                  )}
                  {job.recap !== undefined && (
                    <Box marginTop={1}>
                      <Text wrap="wrap">결과: {job.recap}</Text>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
        {orphans.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>작업에 묶이지 않은 실행</Text>
            {orphans.map(finished)}
          </Box>
        )}
        {hasEnded && (
          <Box marginTop={1} justifyContent="flex-end">
            <Button key="clear" label="이력 지우기" onPress={() => clearHistory($)} />
          </Box>
        )}
      </Box>
    )
  })
}
