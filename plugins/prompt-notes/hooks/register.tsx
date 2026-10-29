import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note } from '../types'

const PANE = 'prompt-notes'
const TITLE = '프롬프트 메모'
// 세션이 끝나도 남도록 메모는 $.store에 두고, 그리는 쪽은 $.state를 읽는다.
const STORE_KEY = 'notes-v1'
const MAX_NOTES = 30

const notes = atom({ plugin: 'prompt-notes', key: 'notes' } as const, [], {
  shape: 'notes-1',
})
const confirming = atom(
  { plugin: 'prompt-notes', key: 'confirming' } as const,
  null,
)
const isPaneOpen = atom(
  { plugin: 'prompt-notes', key: 'isPaneOpen' } as const,
  true,
)

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTime(ms: number): string {
  const at = new Date(ms)
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

  return `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

// 한글·한자 등 넓은 글자는 두 칸을 차지한다.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

function cellWidth(char: string): number {
  return WIDE.test(char) ? 2 : 1
}

const MIN_TITLE_WIDTH = 8

// 첫 번째 내용 있는 줄을 제목으로 쓰고, 패널 폭에 맞춰 칸 수 기준으로 자른다.
function titleOf(text: string, maxWidth: number): string {
  const first = text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  if (first === '') return '(빈 메모)'
  const chars = [...first]
  if (chars.reduce((sum, char) => sum + cellWidth(char), 0) <= maxWidth) return first
  let width = 1
  let clipped = ''
  for (const char of chars) {
    width += cellWidth(char)
    if (width > maxWidth) break
    clipped += char
  }

  return `${clipped}…`
}

function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false
  const note = value as Record<string, unknown>

  return (
    typeof note.id === 'string' &&
    typeof note.text === 'string' &&
    typeof note.updatedAt === 'number' &&
    typeof note.isOpen === 'boolean'
  )
}

async function loadNotes($: EngineInterface): Promise<Note[]> {
  const saved = await $.store.get(STORE_KEY)

  return Array.isArray(saved) ? saved.filter(isNote) : []
}

// 입력 중인 내용. 글자마다 상태를 바꾸면 패널이 다시 그려지며 커서가 밀리므로,
// 입력은 여기와 $.store에만 적고 버튼을 누르는 등 다른 동작이 있을 때 상태에 합친다.
const drafts = new Map<string, { text: string; at: number }>()

function withDrafts(list: Note[]): Note[] {
  return list.map(note => {
    const draft = drafts.get(note.id)

    return draft === undefined || draft.text === note.text
      ? note
      : { ...note, text: draft.text, updatedAt: draft.at }
  })
}

async function changeNotes(
  $: EngineInterface,
  change: (list: Note[]) => Note[],
): Promise<void> {
  let changed: Note[] = []
  await update($, notes, list => (changed = change(withDrafts(list))))
  // 합친 뒤에 더 입력된 내용은 남겨 둔다.
  for (const note of changed) {
    if (drafts.get(note.id)?.text === note.text) drafts.delete(note.id)
  }
  await $.store.set(STORE_KEY, changed)
}

// 다른 세션에서 고친 내용을 보도록 저장소에서 다시 불러온다.
async function reloadNotes($: EngineInterface): Promise<void> {
  const saved = await loadNotes($)
  drafts.clear()
  await update($, notes, () => saved)
}

// 로드·화면 연결 때 켜 두길 원한 패널을 연다. 열지 못해도 다른 동작은 막지 않는다.
async function restorePane($: EngineInterface): Promise<void> {
  try {
    if (await read($, isPaneOpen)) await $.ui.open({ id: PANE, title: TITLE })
  } catch {
    // 패널만 열리지 않는다
  }
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  const isShown = panes.some(pane => pane.id === PANE && pane.isPlaced)
  if (isShown) {
    await update($, isPaneOpen, () => false)
    await $.ui.close({ id: PANE })

    return false
  }
  await update($, isPaneOpen, () => true)
  await reloadNotes($)
  await $.ui.open({ id: PANE, title: TITLE })

  return true
}

async function addNote($: EngineInterface): Promise<void> {
  const list = await read($, notes)
  if (list.length >= MAX_NOTES) {
    $.ui.toast(`메모는 ${MAX_NOTES}개까지 만들 수 있습니다.`)

    return
  }
  const note: Note = {
    id: crypto.randomUUID(),
    text: '',
    updatedAt: await $.clock.now(),
    isOpen: true,
  }
  await changeNotes($, all => [...all, note])
}

async function toggleNote($: EngineInterface, id: string): Promise<void> {
  await changeNotes($, list =>
    list.map(note => (note.id === id ? { ...note, isOpen: !note.isOpen } : note)),
  )
}

// 글자마다 불린다. 패널을 다시 그리지 않도록 상태는 건드리지 않고 저장소에만 쓴다.
async function draftNote($: EngineInterface, id: string, text: string): Promise<void> {
  const list = withDrafts(await read($, notes))
  if (list.find(note => note.id === id)?.text === text) return
  drafts.set(id, { text, at: await $.clock.now() })
  await $.store.set(STORE_KEY, withDrafts(list))
}

// 저장(Enter)을 누르면 입력 중인 내용을 상태에 합쳐 제목과 최종 수정일을 갱신한다.
async function saveNote($: EngineInterface, id: string, text: string): Promise<void> {
  await draftNote($, id, text)
  await changeNotes($, list => list)
}

async function fillPrompt($: EngineInterface, id: string): Promise<void> {
  const note = withDrafts(await read($, notes)).find(one => one.id === id)
  if (note === undefined || note.text.trim() === '') {
    $.ui.toast('빈 메모는 넣을 수 없습니다.')

    return
  }
  const filled = await $.prompt.fill({ text: note.text, mode: 'replace' })
  if (!filled.isFilled) $.ui.toast('지금은 입력창에 넣을 수 없습니다.')
}

// 실수로 지우지 않도록 두 번 눌러야 지워진다.
async function deleteNote($: EngineInterface, id: string): Promise<void> {
  if ((await read($, confirming)) !== id) {
    await update($, confirming, () => id)

    return
  }
  await update($, confirming, () => null)
  await changeNotes($, list => list.filter(note => note.id !== id))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'notes',
      description: '프롬프트 메모 패널을 열거나 닫기',
    })
    await reloadNotes($)
    // 사람이 직접 닫지 않았으면 로드될 때 바로 연다.
    void restorePane($)

    return next(e)
  })

  // 화면이 나중에 연결되면 켜 두길 원한 패널을 다시 연다.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await restorePane($)

    return attached
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)

    return closed
  })

  on('command.run', { command: 'notes' }, async $ => {
    const isOpen = await togglePane($)

    return { text: isOpen ? '프롬프트 메모를 열었습니다.' : '프롬프트 메모를 닫았습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    // 다시 그려질 때도 입력 중인 내용이 사라지지 않도록 합쳐서 그린다.
    const list = withDrafts(await read($, notes))
    const pending = await read($, confirming)
    // 제목 줄에는 제목만 있으므로 패널 폭에서 ▸/▾와 공백 두 칸만 빼고 쓴다.
    const titleWidth = Math.max(MIN_TITLE_WIDTH, e.props.bodyColumns - 2)

    // 새 메모는 맨 위, 메모별 동작(넣기·삭제)은 펼친 입력칸의 우측 하단에 둔다.
    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end">
          <Button key="add" label="+ 새 메모" onPress={() => addNote($)} />
        </Box>
        {list.length === 0 && (
          <Text dimColor>메모가 없습니다. 위 버튼으로 추가하세요.</Text>
        )}
        {list.map(note => (
          <Box flexDirection="column" marginTop={1}>
            <Box overflow="hidden">
              <Button
                key={`toggle:${note.id}`}
                plain
                label={`${note.isOpen ? '▾' : '▸'} ${titleOf(note.text, titleWidth)}`}
                onPress={() => toggleNote($, note.id)}
              />
            </Box>
            <Text dimColor>
              {'  '}최종 수정일 : {formatTime(note.updatedAt)}
            </Text>
            {note.isOpen && (
              // 입력칸에 포커스가 가면 강조 테두리가 바깥으로 그려지므로, 옆과 아래에
              // 여백을 둬서 버튼이나 패널 끝에 가려지지 않게 한다.
              <Box flexDirection="column" marginTop={1} paddingX={1}>
                {/* 세로 방향이어야 입력칸이 내용 폭이 아니라 패널 폭만큼 늘어난다. */}
                <Box flexDirection="column" alignItems="stretch" paddingBottom={1}>
                  <Input
                    key={`text:${note.id}`}
                    rows={5}
                    value={note.text}
                    placeholder="보낼 프롬프트를 적어 두세요 (입력하는 대로 저장)"
                    onInput={value => draftNote($, note.id, value)}
                    onSubmit={value => saveNote($, note.id, value)}
                  />
                </Box>
                <Box justifyContent="flex-end" columnGap={1}>
                  <Button
                    key={`fill:${note.id}`}
                    variant="primary"
                    label="넣기"
                    onPress={() => fillPrompt($, note.id)}
                  />
                  <Button
                    key={`delete:${note.id}`}
                    label={pending === note.id ? '삭제 확인' : '삭제'}
                    onPress={() => deleteNote($, note.id)}
                  />
                </Box>
              </Box>
            )}
          </Box>
        ))}
        <Box height={1} />
      </Box>
    )
  })
}
