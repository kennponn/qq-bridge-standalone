# Direct provider engine

This optional engine calls an OpenAI-compatible chat/completions provider directly.
It is only used in `reserved2`. DSH remains the control plane for bridge session
creation and mode/configuration; this is not a standalone replacement for DSH.

## Configuration

Keep `dsh.directEngine` false until a provider key has been configured.

Set the key in the environment of the process that starts the bridge:

```powershell
$env:QQ_DIRECT_API_KEY = '<new provider key>'
```

Configure `dsh.directLLM.baseUrl` with the provider API base (normally ending in
`/v1`, not `/chat/completions`). Alternatively set `QQ_DIRECT_BASE_URL`.
An explicit `dsh.directLLM.apiKeyEnv` selects a different environment variable.
Do not put API keys in config.json or source code.

Without an explicit base URL, `deepseek-official` uses
`https://api.deepseek.com/v1` and `DEEPSEEK_API_KEY`; `openai-ultrarouter` uses
`https://ultrarouter.org/v1` and `ULTRAROUTER_API_KEY`. `QQ_DIRECT_API_KEY` overrides
the key variable. Unknown providers require an explicit base URL. The model
defaults to `dsh.model`; `dsh.directLLM.model` can override it.

Optional settings in `dsh.directLLM`:

- `requestTimeoutMs`: 90000 by default.
- `turnTimeoutMs`: 900000, including tool waits.
- `maxRounds`: 16. Exhaustion is an error, not a successful reply.
- `maxRetries`: 2. Only transient model HTTP/network failures are retried.
- `vision`: true. Set false for text-only models.
- `webSearch`: true. Uses the existing safe, read-only search MCP server.

## Runtime invariants

- Text output is private. Sending always requires an explicit safe QQ tool.
- Silent/background turns have no QQ sending tools.
- Tools reuse the existing MCP schemas and bridge authorization/audit checks.
- The host binds session keys and tokens; models cannot change the target.
- Displayed snapshot data authorizes read cursors. New arrivals are not
  automatically acknowledged after a send.
- Models follow the existing observation gate before closing or sleeping.
- Each turn has bounded execution, resource cleanup and stale-session checks.
- Pending wakes are replayed after the direct prompt queue releases its lock.
- Provider token usage is recorded separately from DSH session baselines.
- Only tool names/statuses are logged, not prompts, tokens or full tool results.

Run `npm run test:direct` for offline regressions, or `npm run test:audit` for the
full offline suite. These tests do not send real QQ messages or call real models.
