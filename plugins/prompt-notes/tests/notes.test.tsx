import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'prompt-notes',
  component: 'Pane',
  requestId: 'prompt-notes',
  props: {
    title: '프롬프트 메모',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const STAMP = /^ {2}최종 수정일 : \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

test('메모를 추가하고 적은 내용이 제목과 최종 수정일에 반영된다', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 29, 8, 0, 0) })
  mock.store(on)

  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await first.find({ type: 'Text', text: /메모가 없습니다/ })).toBeDefined()
  await first.press({ key: 'add' })
  expect((await first.find({ type: 'Button', text: /빈 메모/ }))?.props.label).toBe('▾ (빈 메모)')
  const before = (await first.find({ type: 'Text', text: /최종 수정일/ }))?.text ?? ''
  expect(before).toMatch(STAMP)

  const input = await first.find({ type: 'Input' })
  await clock.advance(61_000)
  await first.input({ key: input?.key ?? '', text: '\n  적대적 리뷰 돌려줘\n둘째 줄', kind: 'change' })
  await first.unmount()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Button', text: /적대적/ }))?.props.label).toBe(
      '▾ 적대적 리뷰 돌려줘',
    )
    const after = (await ui.find({ type: 'Text', text: /최종 수정일/ }))?.text ?? ''
    expect(after).toMatch(STAMP)
    expect(after).not.toBe(before)
    expect(after.endsWith(':01')).toBe(true)
    await ui.unmount()
  }
})

test('아코디언을 접으면 입력칸과 그 아래 버튼이 함께 숨는다', async ($, on) => {
  mock.clock(on)
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  const toggle = await ui.find({ type: 'Button', text: /빈 메모/ })

  await ui.press({ key: toggle?.key ?? '' })
  expect((await ui.find({ type: 'Button', text: /빈 메모/ }))?.props.label).toBe('▸ (빈 메모)')
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^넣기$/ })).toBeUndefined()

  await ui.press({ key: toggle?.key ?? '' })
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^넣기$/ })).toBeDefined()
  await ui.unmount()
})

test('입력창에 넣기는 메모로 덮어쓰고 이어 붙이기 버튼은 없다', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const fills: { text: string; mode?: string }[] = []
  on('prompt.fill', (_, e) => {
    fills.push({ text: e.text, mode: e.mode })

    return { isFilled: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  const input = await ui.find({ type: 'Input' })
  await ui.input({ key: input?.key ?? '', text: '리팩터링해줘', kind: 'change' })

  const id = (input?.key ?? '').replace('text:', '')
  expect(await ui.find({ type: 'Button', key: `append:${id}` })).toBeUndefined()
  await ui.press({ key: `fill:${id}` })

  expect(fills).toEqual([{ text: '리팩터링해줘', mode: 'replace' }])
  await ui.unmount()
})

test('저장을 누르지 않아도 입력한 내용은 다음 세션에서 보인다', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'notes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  const input = await ui.find({ type: 'Input' })
  await ui.input({ key: input?.key ?? '', text: '저장 안 누른 메모', kind: 'change' })
  await ui.unmount()

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await again.find({ type: 'Input' }))?.props.value).toBe('저장 안 누른 메모')
  expect((await again.find({ type: 'Button', text: /저장 안 누른/ }))?.props.label).toBe(
    '▾ 저장 안 누른 메모',
  )
  await again.unmount()
})

test('삭제는 두 번 눌러야 지워지고 남은 메모는 다음 세션에도 불러온다', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'notes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  await ui.press({ key: 'add' })
  const input = await ui.find({ type: 'Input' })
  const id = (input?.key ?? '').replace('text:', '')

  await ui.press({ key: `delete:${id}` })
  expect((await ui.find({ type: 'Button', key: `delete:${id}` }))?.props.label).toBe('삭제 확인')
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(2)

  await ui.press({ key: `delete:${id}` })
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(1)
  await ui.unmount()

  // 세션이 다시 시작되면 저장소에서 불러온다.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await again.findAll({ type: 'Input' })).toHaveLength(1)
  expect(await again.find({ type: 'Input', key: `text:${id}` })).toBeUndefined()
  await again.unmount()
})

test('세션이 시작되면 저장소의 메모를 불러온다', async ($, on) => {
  mock.store(on, {
    'notes-v1': [
      { id: 'n1', text: '저장된 메모', updatedAt: 0, isOpen: false },
      { id: 'bad', text: 3 },
    ],
  })
  on('command.register', () => ({ value: { command: 'notes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Button', text: /저장된 메모/ }))?.props.label).toBe('▸ 저장된 메모')
  expect(await ui.findAll({ type: 'Button', text: /▸|▾/ })).toHaveLength(1)
  await ui.unmount()
})

test('제목은 패널 폭만큼 쓰고 넘칠 때만 자르며 버튼은 테두리 있는 모양이다', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const long = '이 파일 전체를 리팩터링하되 공개 API는 바꾸지 말고 테스트도 같이 고쳐줘'

  const wide = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
  await wide.press({ key: 'add' })
  const input = await wide.find({ type: 'Input' })
  await wide.input({ key: input?.key ?? '', text: long, kind: 'submit' })
  const id = (input?.key ?? '').replace('text:', '')

  expect((await wide.find({ type: 'Button', key: `toggle:${id}` }))?.props.label).toBe(`▾ ${long}`)
  await wide.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  // 40칸 - ▸/▾와 공백 2칸 = 38칸: "…" 한 칸을 빼고 37칸까지 담는다.
  expect((await ui.find({ type: 'Button', key: `toggle:${id}` }))?.props.label).toBe(
    '▾ 이 파일 전체를 리팩터링하되 공개 API…',
  )

  const fill = await ui.find({ type: 'Button', key: `fill:${id}` })
  expect(fill?.props.plain).toBeUndefined()
  expect(fill?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'add' }))?.props.plain).toBeUndefined()
  await ui.unmount()
})
