"""Fixed plain-text Edge TTS worker. No provider URL, SSML or shell commands."""
import asyncio
import json
import os
import sys

VOICES = {
    "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural",
    "zh-TW-HsiaoChenNeural", "zh-HK-HiuGaaiNeural",
}


async def main():
    import edge_tts
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"ok": True}))
        return
    if sys.argv[1:]:
        raise ValueError("Unexpected arguments")
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("Input too large")
    data = json.loads(raw.decode("utf-8"))
    text, voice, rate, output = data["text"], data["voice"], data["rate"], data["output"]
    if not isinstance(text, str) or not 1 <= len(text) <= 300:
        raise ValueError("Invalid text")
    if voice not in VOICES or type(rate) is not int or not -50 <= rate <= 50:
        raise ValueError("Invalid voice or rate")
    if not isinstance(output, str) or not os.path.isabs(output) or not output.endswith(".mp3"):
        raise ValueError("Invalid output")
    if os.path.lexists(output):
        raise ValueError("Output already exists")
    communicator = edge_tts.Communicate(text, voice, rate=f"{rate:+d}%", connect_timeout=10, receive_timeout=20)
    await asyncio.wait_for(communicator.save(output), timeout=40)
    print(json.dumps({"ok": True}))


try:
    asyncio.run(main())
except Exception:
    # Provider errors may contain the spoken text or credentials: never print them.
    print(json.dumps({"ok": False}))
    sys.exit(1)
