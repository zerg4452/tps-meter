import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-panel',
  component: 'Pane',
  requestId: 'subagent-panel',
  props: {
    title: '에이전트 현황',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'subagent-panel',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 5,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const COMPANION = 'node "$(ls -d ~/.claude/x/ | tail -1)scripts/codex-companion.mjs"'

test('서브에이전트 실행이 종류·모델·분류와 함께 표시된다', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.agent.spawn({
    prompt: '로그인 화면 마크업 수정',
    description: '로그인 화면 수정',
    subagentType: 'worker',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^\[진행\]/ }))?.text).toBe('[진행] ')
    expect(await ui.find({ type: 'Text', text: /worker/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /\[프런트\]/ }))?.text).toBe('[프런트]')
    expect((await ui.find({ type: 'Text', text: /sonnet-5-5/ }))?.text).toBe(
      'sonnet-5-5 · 추론 확인 중',
    )
    await ui.unmount()
  }
})

test('Codex 보안 검토 명령이 모델·추론 등급과 함께 기록된다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: { stdout: 'ok', stderr: '', interrupted: false },
  }))

  await $.tool.call({
    tool: 'Bash',
    command:
      'node "/x/scripts/codex-companion.mjs" task --model gpt-6-astra --effort high --fresh "읽기 전용 보안 검토"',
    description: 'Codex 보안 검토',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^\[완료\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /codex task/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[보안검토\]/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /gpt-6-astra/ }))?.text).toMatch(
    /^gpt-6-astra · 추론 high/,
  )
  await ui.unmount()
})

test('Codex가 아닌 Bash 명령은 기록하지 않는다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))

  await $.tool.call({ tool: 'Bash', command: 'ls -al' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /아직 실행된 항목이 없습니다/ })).toBeDefined()
  await ui.unmount()
})

test('작업 목록 호출이 입력창 위 요약에 반영되고 패널에는 나오지 않는다', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: '범위분석', status: 'in_progress' },
      { content: '역할분배', status: 'pending' },
      { content: '작업진행', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const summary = await band.find({ type: 'Text', text: /에이전트 진행/ })

    expect(summary?.text).toContain('완료 1/3 · 역할분배')
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })

    expect(await pane.find({ type: 'Text', text: /범위분석|역할분배/ })).toBeUndefined()
    await pane.unmount()
  }

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: '끝' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const summary = await band.find({ type: 'Text', text: /에이전트 진행/ })

  expect(summary?.text).toContain('완료 2/3')
  expect(summary?.text).not.toContain('역할분배')
  await band.unmount()
})

test('echo로 출력만 한 명령과 프롬프트 속 옵션은 실행 정보로 보지 않는다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))

  await $.tool.call({
    tool: 'Bash',
    command: 'echo "node codex-companion.mjs task --model pretend"',
  })
  await $.tool.call({
    tool: 'Bash',
    command: `cd /x && ${COMPANION} task --fresh "example: --model wrong --write" --model actual`,
    description: 'Codex 리뷰',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rows = await ui.findAll({ type: 'Text', text: /^\[(완료|진행)\]/ })

  expect(rows).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /pretend/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^actual/ }))?.text).toMatch(/^actual · 추론 기본값/)
  expect(await ui.find({ type: 'Text', text: /\[리뷰\]/ })).toBeDefined()
  await ui.unmount()
})

test('백그라운드 Codex는 자기 작업 id의 완료 알림으로만 끝난다', async ($, on) => {
  mock.clock(on)
  let next = 0
  on('tool.call', () => ({
    result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: `b${++next}`,
    },
  }))
  on('session.receive', (_, e) => ({ text: e.text }))

  for (const label of ['A', 'B']) {
    await $.tool.call({
      tool: 'Bash',
      command: `${COMPANION} adversarial-review --wait "리뷰 ${label}"`,
      description: `Codex 리뷰 ${label}`,
      run_in_background: true,
    })
  }

  // A의 알림 본문에 B의 id가 언급되어도 B는 그대로 진행이어야 한다.
  await $.session.receive({
    origin: { kind: 'task-notification' },
    text: '<task-notification><task-id>b1</task-id><status>completed</status><summary>b2 참고</summary></task-notification>',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.findAll({ type: 'Text', text: /^\[완료\]/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^\[진행\]/ })).toHaveLength(1)
  await ui.unmount()
})

test('항목 기록보다 먼저 온 완료 알림도 반영된다', async ($, on) => {
  mock.clock(on)
  on('session.receive', (_, e) => ({ text: e.text }))
  on('tool.call', async () => {
    // 명령이 끝나기 전에 완료 알림이 먼저 도착하는 순서를 만든다.
    await $.session.receive({
      origin: { kind: 'task-notification' },
      text: '<task-id>b9</task-id><status>failed</status>',
    })

    return {
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b9' },
    }
  })

  await $.tool.call({
    tool: 'Bash',
    command: `${COMPANION} review --wait`,
    run_in_background: true,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^\[중단\]/ })).toBeDefined()
  await ui.unmount()
})

test('호출한 쪽 응답과 함께 끝나는 백그라운드 실행은 종료로 표시된다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: 'b5',
      backgroundEndsWithFinalResponse: true,
    },
  }))
  on('turn.complete', () => ({ text: '끝' }))

  await $.tool.call({
    tool: 'Bash',
    command: `${COMPANION} review`,
    run_in_background: true,
    agentId: 'a7',
  })

  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await before.find({ type: 'Text', text: /^\[진행\]/ })).toBeDefined()
  await before.unmount()

  await $.turn.complete({
    turnId: 't1',
    answer: '끝',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
    agentId: 'a7',
  })

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /^\[종료\]/ })).toBeDefined()
  await after.unmount()
})

test('입력창 위 버튼으로 패널을 열고 닫는다', async ($, on) => {
  let isUp = true
  on('ui.panes', () => ({
    value: isUp
      ? [{ id: 'subagent-panel', title: '에이전트 현황', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.close', () => {
    isUp = false

    return { value: undefined }
  })
  on('ui.open', () => {
    isUp = true

    return { value: { isPlaced: true } }
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('패널 닫기')
    await ui.press({ key: 'toggle-panel' })
    expect(isUp).toBe(false)
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('패널 열기')
    await ui.press({ key: 'toggle-panel' })
    expect(isUp).toBe(true)
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('패널 닫기')
    await ui.unmount()
  }
})

test('화면에 붙지 못하고 대기 중인 패널은 버튼이 닫지 않고 다시 연다', async ($, on) => {
  let isPlaced = false
  let opens = 0
  let closes = 0
  on('ui.panes', () => ({
    value: [{ id: 'subagent-panel', title: '에이전트 현황', isShown: isPlaced, isFocused: false, isPlaced }],
  }))
  on('ui.close', () => {
    closes += 1

    return { value: undefined }
  })
  on('ui.open', () => {
    opens += 1
    isPlaced = true

    return { value: { isPlaced: true } }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('패널 열기')
  await ui.press({ key: 'toggle-panel' })
  expect(closes).toBe(0)
  expect(opens).toBe(1)
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('패널 닫기')
  await ui.unmount()
})

test('입력창 위 요약은 순서 번호 없이 완료 개수와 진행 중 단계를 보인다', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: '범위분석', status: 'completed' },
      { content: '역할분배', status: 'pending' },
      { content: '작업진행', status: 'in_progress' },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const summary = await ui.find({ type: 'Text', text: /에이전트 진행/ })

  expect(summary?.text).toContain('완료 1/3 · 작업진행')
  expect(summary?.text).not.toContain('step')
  await ui.unmount()
})

test('서브에이전트별 도구 사용량과 수정 파일을 아코디언으로 보인다', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'w1' }))
  on('tool.call', () => ({ result: {} }))

  await $.agent.spawn({
    prompt: '로그인 기능 구현',
    description: '로그인 기능 구현',
    subagentType: 'worker',
  })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'w1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts', agentId: 'w1' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/main/web/login.jsp',
    old_string: 'a',
    new_string: 'b',
    agentId: 'w1',
  })
  // 메인 루프의 도구 호출은 서브에이전트 사용량에 들어가지 않는다.
  await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^토큰/ }))?.text).toBe(
      '토큰 입력 0 · 출력 0 · 도구 3회 (Read 2 · Edit 1)',
    )
    expect((await ui.find({ type: 'Button', key: 'files:w1' }))?.props.label).toBe(
      '▸ 수정 파일 1개',
    )
    expect(await ui.find({ type: 'Text', text: /login\.jsp/ })).toBeUndefined()

    await ui.press({ key: 'files:w1' })
    expect((await ui.find({ type: 'Button', key: 'files:w1' }))?.props.label).toBe(
      '▾ 수정 파일 1개',
    )
    expect((await ui.find({ type: 'Text', text: /login\.jsp/ }))?.text).toBe(
      '  …/main/web/login.jsp',
    )

    await ui.press({ key: 'files:w1' })
    expect(await ui.find({ type: 'Text', text: /login\.jsp/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('Codex 사용 한도 오류를 감지해 재개 시각과 함께 보인다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: {
      stdout:
        '[codex] Codex error: You’ve hit your usage limit. Upgrade to Pro or try again at 9:00 PM.\n[codex] Turn failed.',
      stderr: '',
      interrupted: false,
    },
  }))

  await $.tool.call({ tool: 'Bash', command: `${COMPANION} task --fresh "리뷰"` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /사용 한도/ }))?.text).toBe(
    '사용 한도 초과 · 9:00 PM 이후 가능 → Claude 자체 검토로 대체',
  )
  await ui.unmount()
})

test('리뷰 본문에 rate limit이 나와도 정상 실행이면 사용 가능으로 본다', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({
    result: {
      stdout: '- [medium] api.ts:10 - rate limit 헤더를 검사하지 않습니다.',
      stderr: '',
      interrupted: false,
    },
  }))

  await $.tool.call({ tool: 'Bash', command: `${COMPANION} adversarial-review --wait` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /사용 가능/ }))?.text).toBe(
    '사용 가능 (마지막 실행 정상)',
  )
  await ui.unmount()
})
