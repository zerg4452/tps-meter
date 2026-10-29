# kims-mods

Claude Code mods, published as one marketplace (`kims-mods`). Install only the ones you want.

| Mod | What it does |
|---|---|
| `tps-meter` | Live generation speed and total elapsed time in the status line |
| `subagent-panel` | Subagent and Codex runs (model, effort, usage, edited files) and Codex availability in a side pane |
| `prompt-notes` | Sticky notes for prompts in a side pane, put into the prompt box with one click |

## tps-meter

Shows live generation speed and total elapsed time in the status line under the prompt.

- While the model streams: `⚡ ~NN t/s · ⏱ 12.3s` (t/s is estimated from characters, ~4 chars per token)
- After the turn: `⚡ 52.3 t/s · ⏱ 총 1m 24s` (t/s from the API's real output token count of the last model request; total time runs from your prompt to turn completion, tool time included)

## subagent-panel

Opens a pane (`에이전트 현황`) beside the transcript. The top shows what is running now; the bottom keeps a history of recent work, one entry per prompt, newest first.

```
Codex 사용 한도 초과 · 9:00 PM 이후 가능 → Claude 자체 검토로 대체

실행 중 (1)
[진행] worker [구현]
sonnet-5-5 · 추론 medium
로그인 기능 구현
토큰 입력 45.2k · 출력 3.1k · 도구 18회 (Read 9 · Edit 5 · Bash 4)
▸ 수정 파일 2개

작업 이력
▾ 18:24  일단 푸시까지 해줘
  완료 4/4 · 정상 종료 · 2분 13초
    ✓ 저장소에 복사
    ✓ marketplace.json·README 갱신
    ✓ 검증·테스트
    ✓ 커밋·push
    백그라운드 작업
    ✓ dev 서버 실행 · 완료 · 41초
    서브에이전트 · Codex
    ✓ codex task [보안검토] · gpt-6-astra · 추론 high · 3분 12초
      Codex 보안 검토
    결과: main으로 push했습니다.
▸ 18:12  텍스트 박스 영역이 너무 좁아졌어
  완료 1/2 · 중단됨 · 41초 · 도구 오류·거부 1회
                                           [ 이력 지우기 ]
```

- **실행 중**: subagents and Codex runs that have not finished.
- **작업 이력**: each prompt you send starts an entry; turns that a background task's completion notice starts are added to the same entry. Folded, it shows the time, the prompt's first line, steps done, how the turn ended (정상 종료, 중단됨, 오류) and how long it took, plus failed or denied tool calls. Unfolded, it lists the steps from the desktop app's task list (✓ done, ▶ in progress, · not started; steps left when the entry ended are marked 미완료), the background Bash commands it started, the subagents and Codex runs it started, and the closing recap. The last 20 entries are kept for the session. The task list has no failed state, so a step shows only whether it was completed; the entry's ending and tool errors tell whether things went wrong.

- **Codex availability**: read from the last Codex run's output. A `Codex error:` line about a usage limit, rate limit or quota shows as 사용 한도 초과, with the time it can run again when the error names one.
- **Subagents**: type, the model and effort of their first model request, and a category taken from the agent type, or from words in the task description (보안, 리뷰, 화면/UI, 테스트, 조사). Tokens are summed over the subagent's model requests (input includes cache reads and writes). Tool calls are counted per tool, top three shown. Files it changed with `Edit`, `Write` or `NotebookEdit` are listed under a toggle (▸ / ▾).
- **Codex runs**: Bash commands that run `node <...>codex-companion.mjs adversarial-review | review | task`, with `--model` and `--effort` read from the command. Background runs finish when their completion notice arrives.

A band above the prompt shows a summary, including the desktop app's task list progress, and a button that opens or closes the pane:

```
에이전트 진행 1 · 끝남 2 · 완료 1/3 · 역할분배     [ 패널 닫기 ]
```

`/agents-panel` does the same as the button.

## prompt-notes

Opens a pane (`프롬프트 메모`) for prompts you want to keep at hand.

```
                                      [ + 새 메모 ]
▾ /ez-task 로그인 화면 버그 고쳐줘
  최종 수정일 : 2026-10-29 18:05:08
  ┌──────────────────────────────────┐
  │ /ez-task 로그인 화면 버그 고쳐줘 │
  └──────────────────────────────────┘
                           [ 넣기 ] [ 삭제 ]

▸ 적대적 리뷰 돌려줘
  최종 수정일 : 2026-10-29 16:10:33
```

- Add as many notes as you need (up to 30). Each folds open or closed; its first line is the title.
- Text is saved as you type, and kept across sessions on this machine. A session that is already open picks up changes from another session when you reopen the pane.
- 최종 수정일 is the last time the note's text changed. It updates when you press Enter or another button, not on every keystroke, so the cursor stays where you type.
- `넣기` replaces the prompt box's text with the note. You send it yourself.
- `삭제` asks once more (`삭제 확인`) before it deletes.
- A slash command runs only when it is at the very start of the message, so begin the note with it (`/ez-task ...`).

`/notes` opens or closes the pane.

## Install

Requires the `claude` CLI. Add the marketplace once:

```bash
claude plugin marketplace add zerg4452/tps-meter
```

Then install the ones you want:

```bash
claude plugin install tps-meter@kims-mods --scope user
```

```bash
claude plugin install subagent-panel@kims-mods --scope user
```

```bash
claude plugin install prompt-notes@kims-mods --scope user
```

They then load in every new session, including local sessions in the desktop app's Code tab.

## Update

```bash
claude plugin marketplace update kims-mods
```

```bash
claude plugin update tps-meter
```

```bash
claude plugin update subagent-panel
```

```bash
claude plugin update prompt-notes
```

Then run `/reload-plugins` in an open session, or start a new one.

## Uninstall

```bash
claude plugin uninstall tps-meter
```

```bash
claude plugin uninstall subagent-panel
```

```bash
claude plugin uninstall prompt-notes
```
