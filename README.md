# tps-meter

Claude Code mod that shows live generation speed and total elapsed time in the status line under the prompt.

- While the model streams: `⚡ ~NN t/s · ⏱ 12.3s` (t/s is estimated from characters, ~4 chars per token)
- After the turn: `⚡ 52.3 t/s · ⏱ 총 1m 24s` (t/s from the API's real output token count of the last model request; total time runs from your prompt to turn completion, tool time included)

## Install

Requires the `claude` CLI. Run these two commands in a terminal:

```bash
claude plugin marketplace add zerg4452/tps-meter
```

```bash
claude plugin install tps-meter@kims-mods --scope user
```

It then loads in every new session, including local sessions in the desktop app's Code tab.

## Update

```bash
claude plugin update tps-meter
```

Then run `/reload-plugins` in an open session, or start a new one.

## Uninstall

```bash
claude plugin uninstall tps-meter
```
