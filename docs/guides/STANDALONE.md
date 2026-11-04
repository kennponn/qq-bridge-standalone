# Standalone QQ bridge

Standalone mode owns its sessions, policies, queues and model requests. It never creates a DSH API client, follows DSH sessions, polls DSH, reads DSH credentials, or starts the DSH event pump. DSH can remain closed or be uninstalled. QQ and its SnowLuma/OneBot gateway still need to be running.

## Start and configure

1. Install standard Node.js >=22.13.0 and the project's npm dependencies. `start-ui.bat` detects standard Node.js under Program Files before PATH; `QQ_BRIDGE_NODE` selects another installed Node executable. It does not use DSH's bundled runtime.
2. Double-click `start-ui.bat`. The guard launches the bridge and opens its authenticated local console. Only loopback is bound. The existing `start.bat` remains unchanged.
3. In the overview engine panel select standalone and configure your OpenAI-compatible HTTPS endpoint, model and API key.
4. Test the connection, then save. The test reads `GET /models`; it does not call the chat endpoint or send QQ messages. A successful listing with `modelAvailable=false` is a warning, not confirmation that the configured model works.
5. Backend changes require restarting the bridge. Model, stored-key and standalone system-prompt updates apply on the next turn. Restart from the UI is automatic only while a guard is running; a bare `node src/bridge.js` process only exits.

The active runtime backend is displayed separately from the saved backend. `ready` means local model configuration and credentials are valid, not that QQ is connected or that the provider has just been contacted. QQ health and the last connection test have separate indicators.

## Start SnowLuma from the console

The overview includes an operator-only SnowLuma startup button. It uses the configured installation's bundled `node.exe` with the installed version checker, not the bridge's Node or a relative BAT command. Existing QQ windows can stay open. Startup does not close QQ, automatically accept agreements, bypass SnowLuma login, or send messages.

Auto-loading all open QQ instances is OFF by default. With multiple QQ instances, start the gateway, open its local management page, and load the intended QQ process. To explicitly opt in to attaching all open QQ instances, check the option and confirm. Changing this option does not reconfigure an already-running gateway.

Launch receipts, process handles, configured local-port checks and a cooldown prevent duplicate startup. An uncertain or stale startup claim blocks launching without claiming that the gateway is connected. If a claim needs manual repair, first verify that no startup is still in progress; do not delete state blindly. The management link is a validated configured local address, not proof that its server is listening. External launches with environment-overridden ports are outside this launcher's receipt tracking; check those instances separately before starting. A spawned process is distinct from an authenticated OneBot WebSocket connection and from model readiness.

Model API keys come from your chosen model provider, not QQ or SnowLuma. Keep them private and confirm the provider's quota and model permissions.

## Configuration and secrets

```json
{
  "engine": {
    "backend": "standalone",
    "directLLM": {
      "provider": "openai-compatible",
      "baseUrl": "https://your-provider.example/v1",
      "model": "your-model",
      "apiKeyEnv": "QQ_DIRECT_API_KEY",
      "requestTimeoutMs": 90000,
      "turnTimeoutMs": 900000,
      "maxRounds": 16,
      "maxRetries": 2,
      "vision": true,
      "webSearch": true
    }
  }
}
```

The UI materializes `engine.directLLM`; thereafter DSH model settings do not control it. Legacy configs default to DSH and migrate their provider/model only when independent settings are first created. `QQ_BRIDGE_ENGINE` is an optional explicit runtime override; remove it to let the UI backend selection take effect.

Keys are not returned in status, preloaded into forms, logged, or stored in browser storage. A blank password field keeps the current stored key. Clearing requires an explicit checkbox. A stored key is held in a private ACL-restricted `state/direct-engine-secret.json` and scoped to its provider and endpoint. It is not encryption: the current OS account and administrators can read it. Environment keys take precedence over stored keys; clearing a stored key does not clear an environment variable. Changing provider/endpoint does not reuse a differently scoped stored key.

## Sessions and behavior

- Standalone session identities are local UUIDs in `state/sessions-standalone.json`. Legacy DSH mappings remain in `state/sessions.json`, untouched by standalone resets.
- Startup rotates QQ tool tokens to revoke previously running DSH agents. It cannot cancel a task already running inside DSH without contacting DSH; stop/cancel those old tasks separately before changing backend.
- Only the safe second-generation mode (`reserved2` / `simulation`) is supported. First-generation and full local-agent modes require the DSH backend. Command execution and arbitrary local files are never exposed to the independent model.
- Assistant text is private. Sending requires safe QQ tools with host-bound session credentials, target IDs, the existing allowlist and per-tool switches. Silent administrative turns cannot send QQ messages.
- Message snapshots, recent QQ history, role cards, per-conversation background and local memory rebuild context each direct turn; a complete old DSH transcript is not migrated. Changing a role or background is effective on the next independent turn.
- Missing model credentials queue a coalesced wake instead of dropping unread messages. Saving valid settings replays that queue. Provider requests have bounded timeout/retry; sending tools are not automatically replayed.
- Cursor authorization, explicit `throughSeq`, pre-sleep observation, pause, reset and whitelist revocation remain enforced. Expired finite-sleep failures back off rather than immediately spinning.
- Standalone system instructions live in `prompts/standalone-system.txt`. The existing v2 prompt editor edits this local file with local backups, without writing DSH installation files.
- Automatic DSH-based slang extraction/deep research are unavailable in standalone. Manual slang maintenance, model-safe query/submission, memory, images, stickers, search and enabled voice tools remain supported.

## Offline verification

Use a supported Node executable, not an old Node on PATH:

```text
npm run test:standalone
npm run test:engine-settings
npm run test:engine-ui
npm run test:direct
```

Tests use synthetic keys, temporary config/state, a mock OneBot gateway and mock model responses. The full-process test starts without a `dsh/` directory, leaves a simulated DSH server unavailable, asserts ZERO requests to it, and verifies local session creation/reset, safe tool execution, private turns, UI settings and prompt persistence. It never connects to production QQ, DSH or a provider.
