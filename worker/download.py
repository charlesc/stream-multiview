"""
Thin wrapper around yt-dlp for grabbing a video's full audio track.

Deliberately downloads the *entire* audio track rather than using
`--download-sections` to cut a specific window. The plan this worker
implements flagged `--download-sections` as a real risk: it's implemented by
passing -ss/-t to ffmpeg, which — without re-encoding — can only cut on
keyframe/cue-point boundaries roughly every ~10s, silently landing you at a
different timestamp than you asked for. A 20-minute opus audio track is only
about 10MB, cheap enough that downloading it in full and doing all cutting
in-memory (in `align.py`, on already-decoded PCM, which has no such
boundary constraint) sidesteps that entire bug class rather than working
around it.
"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

# YouTube's bot-detection sometimes rejects a signed download URL that
# succeeds moments later (observed directly during development: two of four
# real test videos failed on the first attempt and succeeded on retry — and
# during end-to-end testing of this worker, one of those two needed *more*
# than 3 fixed-delay attempts to come back, which is why this backs off
# rather than retrying at a flat interval). This is *not* the same as the
# well-documented "Sign in to confirm you're not a bot" failure — that one
# doesn't fix itself by retrying — but transient signed-URL/CDN failures do.
MAX_ATTEMPTS = 5
RETRY_DELAY_SECONDS = 3  # base delay; actual wait is this * 2^(attempt-1) — 3s, 6s, 12s, 24s

BOT_CHECK_MARKER = "Sign in to confirm you're not a bot"


class DownloadError(Exception):
    """Raised when yt-dlp fails after all retries. `is_bot_check` distinguishes the un-retryable case."""

    def __init__(self, message: str, is_bot_check: bool = False):
        super().__init__(message)
        self.is_bot_check = is_bot_check


@dataclass
class DownloadResult:
    path: Path
    title: str | None


def download_audio(video_id: str, dest_dir: Path, cookies_from_browser: str | None = None) -> DownloadResult:
    """
    Downloads the best available audio-only stream for `video_id` into
    `dest_dir`, returning the path actually written (yt-dlp picks the
    container/extension, so the exact filename isn't known up front).

    `cookies_from_browser` (e.g. "chrome", "firefox") is only needed if
    YouTube starts hard-blocking this machine with the bot-check page — try
    without it first; it's an extra moving part (browser cookies expire and
    need re-exporting) that isn't worth the complexity unless actually hit.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(dest_dir / f"{video_id}.%(ext)s")

    cmd = [
        "yt-dlp",
        "-f", "bestaudio",
        "--no-playlist",
        "--no-warnings",
        "--print", "title",
        "--print", "after_move:filepath",
        "-o", output_template,
    ]
    if cookies_from_browser:
        cmd += ["--cookies-from-browser", cookies_from_browser]
    cmd.append(f"https://www.youtube.com/watch?v={video_id}")

    last_error = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0:
            lines = [line for line in proc.stdout.strip().splitlines() if line]
            # `--print title` fires before `--print after_move:filepath`, so
            # with both requested the title is always the first line and the
            # actual file path is always the last, regardless of how many
            # other yt-dlp status lines land in between.
            title = lines[0] if lines else None
            printed_path = lines[-1] if lines else ""
            path = Path(printed_path) if printed_path else _find_downloaded_file(dest_dir, video_id)
            if path and path.exists():
                return DownloadResult(path=path, title=title)

        last_error = proc.stderr.strip() or proc.stdout.strip()
        if BOT_CHECK_MARKER in last_error:
            raise DownloadError(
                f"YouTube is showing a bot-check page for {video_id}. This is the well-known yt-dlp/YouTube "
                f"issue where datacenter IPs get blocked — since this worker is meant to run on your own "
                f"machine (not a cloud VPS), this is unusual; try again in a few minutes, or pass "
                f"cookies_from_browser.",
                is_bot_check=True,
            )

        if attempt < MAX_ATTEMPTS:
            time.sleep(RETRY_DELAY_SECONDS * (2 ** (attempt - 1)))

    raise DownloadError(f"yt-dlp failed for {video_id} after {MAX_ATTEMPTS} attempts: {last_error}")


def _find_downloaded_file(dest_dir: Path, video_id: str) -> Path | None:
    """Fallback if --print's output couldn't be parsed — yt-dlp names files `{video_id}.{ext}`."""
    matches = list(dest_dir.glob(f"{video_id}.*"))
    return matches[0] if matches else None
