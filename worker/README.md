# Auto-sync worker

A local Python process that finds how far apart your streams' recordings
started, from shared audio (e.g. everyone's mic picking up the same voice
chat, or a shared countdown) — an automated alternative to the app's manual
±offset buttons and "Mark Sync" click-to-align feature.

**This is not deployed anywhere and never will be as part of this repo.**
It downloads audio via `yt-dlp`, decodes it via `ffmpeg`, and does the
alignment math via `numpy`/`scipy` — none of which a Next.js/Vercel
deployment can run, and a single job can take tens of seconds to a few
minutes, well past what a serverless function is built for. You run it
yourself, on your own machine, alongside `bun dev`/`bun start`, only when
you actually want to use auto-detection.

Running it locally (rather than on a VPS) also sidesteps YouTube's
bot-detection, which specifically targets datacenter IPs — see
`download.py`'s module docstring.

## Setup

```bash
cd worker
python3 -m venv .venv        # optional but recommended
source .venv/bin/activate
pip install -r requirements.txt
```

You also need `ffmpeg` and `yt-dlp` on your `PATH`:

```bash
brew install ffmpeg          # macOS
pip install -U yt-dlp        # or: brew install yt-dlp
```

## Running

```bash
python3 server.py
# or: uvicorn server:app --port 8787
```

Leave it running in a terminal while you use the app's "Auto Detect" button
in the viewer header. The frontend talks to `http://localhost:8787` by
default — override with `NEXT_PUBLIC_SYNC_WORKER_URL` if you've changed the
port.

## How it works

1. **Download**: full audio track for every stream (not a clipped section —
   see `download.py`'s docstring for why `--download-sections` was
   deliberately avoided).
2. **Align**: `align.py`'s `align_video()` tries several ~90s windows drawn
   from the reference stream's middle 80% against each other stream's full
   audio, via GCC-PHAT cross-correlation restricted to the voice frequency
   band. A result is only trusted if multiple windows independently agree —
   see `align_video`'s docstring for a real example (from actual test
   footage) of a single window producing a confident-but-wrong answer that
   multi-window agreement caught.
3. **Confidence gating**: any stream whose alignment doesn't clear
   `CONFIDENCE_THRESHOLD` comes back as `null`, not a guess — the frontend
   only auto-applies non-null offsets and leaves the rest for manual
   alignment. A wrong-but-confident answer is worse than an honest failure.

Run `python3 align.py` any time to sanity-check the algorithm itself against
synthetic signals with a known offset — no network access needed.

## Precondition

None of this works if your streams don't actually share a common audio
source (all mic'd into the same voice channel, reacting to the same
external sound, etc.) — if each recording is fully independent audio, there
is nothing here to detect, no matter how the algorithm is tuned. If you're
not sure, listen to two of the recordings side by side before spending time
on this — if you can't pick out a shared sound between them by ear, the
detector won't find one either.

## Known limitations

- **yt-dlp reliability**: real YouTube downloads occasionally fail with a
  transient `HTTP 403` that a retry resolves — `download.py` retries
  automatically. A hard "Sign in to confirm you're not a bot" failure is a
  different, well-known YouTube/yt-dlp issue that a retry won't fix; running
  locally (as intended) makes it far less likely, but if you hit it anyway
  you may need `cookies_from_browser` (see `download_audio`'s docstring) or
  to update yt-dlp.
- **Confidence threshold is a starting value** (`CONFIDENCE_THRESHOLD` in
  `align.py`), not something derived from a large real-world dataset —
  recalibrate it if you see false positives/negatives in practice.
- **Very short, quiet shared cues under heavy background noise are a
  genuine hard case**, not a bug — correlation strength depends on how much
  correlated signal there is to accumulate. A multi-second countdown or
  ongoing shared voice chat works far better than a one-second blip buried
  under loud, unrelated audio.
