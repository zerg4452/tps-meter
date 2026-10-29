# kims-mods

Claude Code mods, published as one marketplace (`kims-mods`). Install only the ones you want.

| Mod | What it does |
|---|---|
| `tps-meter` | Live generation speed and total elapsed time in the status line |
| `subagent-panel` | Subagent and Codex runs (model, effort, usage, edited files) and Codex availability in a side pane |

## tps-meter

Shows live generation speed and total elapsed time in the status line under the prompt.

- While the model streams: `⚡ ~NN t/s · ⏱ 12.3s` (t/s is estimated from characters, ~4 chars per token)
- After the turn: `⚡ 52.3 t/s · ⏱ 총 1m 24s` (t/s from the API's real output token count of the last model request; total time runs from your prompt to turn completion, tool time included)

## subagent-panel

Opens a pane (`에이전트 현황`) beside the transcript.

```
Codex 사용 한도 초과 · 9:00 PM 이후 가능 → Claude 자체 검토로 대체

서브에이전트 · Codex 실행

[진행] worker [구현]
sonnet-5-5 · 추론 medium
로그인 기능 구현
토큰 입력 45.2k · 출력 3.1k · 도구 18회 (Read 9 · Edit 5 · Bash 4)
▾ 수정 파일 2개
  …/src/login/LoginController.java
  …/main/web/login.jsp

[완료] codex task [보안검토]
gpt-6-astra · 추론 high · 백그라운드 · 3분 12초
Codex 보안 검토
```

- **Codex availability**: read from the last Codex run's output. A `Codex error:` line about a usage limit, rate limit or quota shows as 사용 한도 초과, with the time it can run again when the error names one.
- **Subagents**: type, the model and effort of their first model request, and a category taken from the agent type, or from words in the task description (보안, 리뷰, 화면/UI, 테스트, 조사). Tokens are summed over the subagent's model requests (input includes cache reads and writes). Tool calls are counted per tool, top three shown. Files it changed with `Edit`, `Write` or `NotebookEdit` are listed under a toggle (▸ / ▾).
- **Codex runs**: Bash commands that run `node <...>codex-companion.mjs adversarial-review | review | task`, with `--model` and `--effort` read from the command. Background runs finish when their completion notice arrives.

A band above the prompt shows a summary, including the desktop app's task list progress, and a button that opens or closes the pane:

```
에이전트 진행 1 · 끝남 2 · 완료 1/3 · 역할분배     [ 패널 닫기 ]
```

`/agents-panel` does the same as the button.

## Install

Requires the `claude` CLI. Add the marketplace once:

```bash
claude plugin marketplace add zerg4452/tps-meter
```

Then install either mod, or both:

```bash
claude plugin install tps-meter@kims-mods --scope user
```

```bash
claude plugin install subagent-panel@kims-mods --scope user
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

Then run `/reload-plugins` in an open session, or start a new one.

## Uninstall

```bash
claude plugin uninstall tps-meter
```

```bash
claude plugin uninstall subagent-panel
```
