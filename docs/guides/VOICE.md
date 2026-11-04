# QQ voice in the standalone engine

The built-in console at http://127.0.0.1:3100/ includes voice settings,
four female voices, speed selection, a text preview player, and explicit sending
to an existing group/private conversation. No separate voice-tool GUI is required.

## Incoming voice

`socialV2.voice.incoming.enabled` defaults to true. SnowLuma's native
`fetch_ptt_text` action transcribes the actual QQ message ID. This uses QQ's
online service, not offline recognition and not a new third-party model key.
QQ may take about 20 seconds; the host stops waiting after 22 seconds by default.
Only that conversation waits. Other conversations and normal text stay independent.

Transcripts retain their real sender, mentions and quoted sources. Recognized
speech cannot execute host slash commands, approve requests or create explicit
durable facts. Failed recognition produces an honest placeholder, not guessed text.
Pause, reset, permission changes and persona changes invalidate old work.

## Text to speech

TTS defaults to disabled with online consent false. In the console's voice section,
enable TTS, explicitly agree to sending the spoken text to Microsoft's online
service, select a voice, then save. This service requires no API key, but network
availability is required and service stability is not guaranteed.

Preview uploads only the text entered for synthesis. It never sends a QQ message
and never auto-plays. Sending is a separate confirmed action. A saved voice enables
the session-bound `qq_speak_text` tool on the next model turn. It uses the operator's
voice settings and accepts only short plain text, not paths, URLs, SSML or commands.
The bot does not automatically read every reply aloud. Its active persona/model
is unchanged.

The component requires Python and FFprobe. Install the pinned package inside the
bridge directory (not globally):

```powershell
python -m pip install --target assets/voice-runtime/vendor -r scripts/requirements-voice.txt
```

The console checks local imports only when reporting component readiness. Health
checks do not synthesize text or contact the TTS provider. Generated MP3s are checked
for duration/size, limited to 300 characters and 90 seconds, and cached with opaque
IDs for 10 minutes. At most two synthesis workers and 20 previews are retained.
Expired generated files are cleaned on the next synthesis; shutdown does not
delete the operator's audio library. Cache paths and worker environments are isolated.

## Sending and verification

AI speech respects session tokens, the current allowlist, pause/silent mode,
persona changes, QQ group send permission, and existing voice limits (default
2 per minute / 10 per hour per conversation). Operator sends also respect the
allowlist, content audit and voice budget. Known credentials/path patterns are
blocked before the text can reach the online service.

`verified=true` requires reading back the sent QQ message with a record segment.
An acknowledgement without verification is not confirmed delivery. Do not retry
an unconfirmed message automatically, since QQ may already have accepted it.
Prepared audio files remain available through the existing voice-library routes.

## Offline regression tests

```powershell
node --test scripts/test-voice-incoming.mjs scripts/test-voice-speech.mjs scripts/test-voice-tools.mjs scripts/test-voice-bridge.mjs
```

These tests inject fake gateway, synthesis and model peers. They never send
real QQ messages or upload private conversation text.
