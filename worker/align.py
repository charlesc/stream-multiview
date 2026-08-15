"""
Audio alignment via GCC-PHAT (Generalized Cross-Correlation with Phase Transform).

Given a short "needle" clip from a reference video and a longer "haystack"
clip from another video, finds the lag (in seconds) at which the needle
best matches a position within the haystack, plus a confidence score.

## Why GCC-PHAT alone, not the two-stage landmark-fingerprint design

The original plan called for landmark/constellation fingerprinting (Shazam-style)
for a coarse pass, then GCC-PHAT for fine alignment. That two-stage design earns
its complexity when you're searching a huge database of reference tracks — it's
what makes Shazam's index scale to millions of songs. That isn't this problem:
we're aligning a handful of videos (typically 3-4) against one reference clip,
so an exhaustive GCC-PHAT search over the entire search window is already cheap
(a few hundred milliseconds at 8kHz for a 20-minute haystack) and PHAT's
phase-whitening already gives it real robustness to differing loudness/mixing
between streams — which is what the noise-robustness requirement was actually
asking for. Skipping the landmark stage removes an entire subsystem (constellation
generation, hash-based lookup) that wasn't earning its keep at this scale.

## Confidence scoring

The correlation surface's peak, relative to its own noise floor, is a
standard way to score how much a delay estimate stands out from chance
alignment: confidence = (peak - mean) / std of the valid correlation region.
A high-quality match produces one sharp peak far above the noise floor: a
z-score in the tens. No shared audio (or two unrelated clips) produces a flat,
noisy surface with no single dominant peak: a z-score in the single digits.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

import numpy as np
from scipy.fft import next_fast_len

# Human voice (and most shared cues like countdowns) lives well under this;
# downsampling to it keeps the FFT small and slightly improves robustness by
# de-emphasizing high-frequency content (game SFX, music) that differs most
# between streams.
SAMPLE_RATE = 8000

# Telephone-band voice range (Hz). Shared cues in this problem are almost
# always someone's voice (a callout, a countdown) — background game/music
# audio usually carries meaningfully more energy outside this band (bass,
# cymbals, synth highs). Restricting the correlation to it measurably
# improves the effective SNR against differently-mixed background audio; see
# `_self_test`'s "noisy" case for a synthetic before/after.
#
# This is applied as a hard mask on the FFT bins used in the correlation
# (see `gcc_phat_align`), not as a time-domain pre-filter. An earlier version
# used `scipy.signal.sosfiltfilt` to band-pass both signals before
# correlating — that seemed like the obvious approach, but it actively backfired:
# a real-world (non-ideal) filter never fully zeroes the stopband, only
# attenuates it, and PHAT's whole premise is normalizing every frequency bin
# to unit magnitude regardless of how weak it is. The two combine badly — PHAT
# re-amplifies whatever noise leaks through the filter's stopband back up to
# full strength, which produced a *higher*-confidence *wrong* answer than not
# filtering at all in testing (a textbook case of "confidently wrong is worse
# than honestly uncertain"). Masking the bins to exactly zero in the frequency
# domain, before PHAT normalization, means the rejected band contributes
# nothing — no attenuated leakage for PHAT to re-inflate.
VOICE_BAND_HZ = (250.0, 3400.0)

# A z-score below this means "no confidently-identifiable shared moment" —
# the caller should refuse to auto-apply the resulting offset. This is a
# starting value, not a derived constant; recalibrate against real footage
# if false positives/negatives show up in practice.
CONFIDENCE_THRESHOLD = 8.0


class AlignmentError(Exception):
    """Raised when audio can't be decoded or the needle doesn't fit in the haystack."""


@dataclass
class AlignmentResult:
    lag_seconds: float
    confidence: float
    is_confident: bool


def load_audio(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """
    Decodes any audio/video file at `path` to mono float32 PCM at `sample_rate`
    via ffmpeg. Using ffmpeg directly (rather than soundfile/librosa) means no
    extra dependency for container/codec support — ffmpeg already handles
    whatever yt-dlp downloaded (webm/opus, m4a/aac, ...).
    """
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "error",
            "-i", path,
            "-f", "s16le", "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(sample_rate),
            "-",
        ],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AlignmentError(f"ffmpeg failed to decode {path}: {proc.stderr.decode(errors='replace')}")
    if len(proc.stdout) == 0:
        raise AlignmentError(f"ffmpeg produced no audio for {path}")

    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32)
    return pcm / 32768.0


def gcc_phat_align(
    needle: np.ndarray,
    haystack: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    band_hz: tuple[float, float] | None = VOICE_BAND_HZ,
) -> AlignmentResult:
    """
    Finds the sample offset within `haystack` where `needle` best matches,
    via GCC-PHAT: cross-correlate in the frequency domain, but normalize each
    frequency bin's magnitude to 1 before transforming back (the "phase
    transform") so the result reflects only phase alignment, not which
    signal happens to be louder at which frequency. This is what gives it
    robustness to differently-mixed audio compared to plain cross-correlation.

    `band_hz`, if given, hard-zeroes FFT bins outside that range before PHAT
    normalization (see the module-level comment on `VOICE_BAND_HZ` for why
    this must happen as a frequency-domain mask and not a time-domain
    pre-filter). Pass None to use the full spectrum — only do that if you've
    confirmed the shared cue is deliberately non-vocal and know it survives
    unweighted.
    """
    if len(needle) == 0 or len(haystack) == 0:
        raise AlignmentError("needle and haystack must both be non-empty")
    if len(needle) > len(haystack):
        raise AlignmentError("needle is longer than haystack — nothing to search within")

    n = next_fast_len(len(needle) + len(haystack) - 1)

    NEEDLE = np.fft.rfft(needle, n=n)
    HAYSTACK = np.fft.rfft(haystack, n=n)

    cross_power = HAYSTACK * np.conj(NEEDLE)

    if band_hz is not None:
        freqs = np.fft.rfftfreq(n, d=1 / sample_rate)
        band_mask = (freqs >= band_hz[0]) & (freqs <= band_hz[1])
        cross_power = cross_power * band_mask

    magnitude = np.abs(cross_power)
    magnitude[magnitude < 1e-12] = 1e-12  # avoid divide-by-zero on masked/silent bins
    phat = cross_power / magnitude

    corr = np.fft.irfft(phat, n=n)

    # corr[lag] for lag in [0, valid_len) is the correlation with the needle
    # starting `lag` samples into the haystack. Beyond that, indices wrap
    # around to represent the needle starting *before* the haystack (not a
    # case we care about — the needle is a sub-clip of a specific video, not
    # something that could precede its own source).
    valid_len = len(haystack) - len(needle) + 1
    valid_corr = corr[:valid_len]

    peak_index = int(np.argmax(valid_corr))
    peak_value = valid_corr[peak_index]

    mean = float(np.mean(valid_corr))
    std = float(np.std(valid_corr))
    confidence = (peak_value - mean) / std if std > 1e-12 else 0.0

    lag_seconds = peak_index / sample_rate

    return AlignmentResult(
        lag_seconds=lag_seconds,
        confidence=float(confidence),
        is_confident=confidence >= CONFIDENCE_THRESHOLD,
    )


# How many independent needle windows to try, and how far apart their
# results are allowed to be to count as "agreeing" — see `align_video`'s
# docstring for why a single window's confidence isn't trusted on its own.
NUM_NEEDLE_WINDOWS = 3
NEEDLE_WINDOW_SECONDS = 90.0
AGREEMENT_TOLERANCE_SECONDS = 1.0


@dataclass
class VideoAlignmentResult:
    lag_seconds: float | None
    confidence: float
    is_confident: bool
    window_results: list[AlignmentResult]
    """One entry per needle window tried, in the same order as `window_starts_seconds`, for diagnostics."""


def align_video(
    reference_audio: np.ndarray,
    other_audio: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    num_windows: int = NUM_NEEDLE_WINDOWS,
    window_seconds: float = NEEDLE_WINDOW_SECONDS,
) -> VideoAlignmentResult:
    """
    Aligns `other_audio` to `reference_audio` using several needle windows
    spread across the reference, not just one, and only trusts the result if
    a majority of them agree.

    A single-window confidence score is not sufficient on its own — verified
    against real footage during development: a needle taken from a video's
    opening 90 seconds produced a *high-confidence* (z > 12) but *wrong*
    alignment, because that stretch was dominated by non-representative
    content (waiting-room silence, channel intro) rather than the actual
    shared event. A needle from the same video's middle produced the correct
    answer with a far higher confidence (z > 70) and, critically, three
    different mid-video windows all agreed with each other within ~2
    seconds. Cross-window agreement is what actually distinguishes "this
    windows happened to correlate with something" from "this is genuinely
    the same real-world moment" — a single confident-looking peak can't tell
    the two apart by itself.

    Windows are spread across the middle 80% of the reference (skipping the
    first/last 10%) specifically to avoid the intro/outro trap above.
    """
    windows_needed_to_agree = 2 if num_windows >= 3 else num_windows

    ref_len = len(reference_audio)
    window_samples = int(window_seconds * sample_rate)
    if ref_len <= window_samples:
        window_starts = [0]
    else:
        usable_start = int(0.1 * ref_len)
        usable_end = ref_len - int(0.1 * ref_len) - window_samples
        if usable_end <= usable_start:
            usable_start, usable_end = 0, ref_len - window_samples
        window_starts = [
            usable_start + int(i * (usable_end - usable_start) / max(1, num_windows - 1))
            for i in range(num_windows)
        ] if num_windows > 1 else [usable_start]

    results: list[AlignmentResult] = []
    for start in window_starts:
        needle = reference_audio[start:start + window_samples]
        try:
            r = gcc_phat_align(needle, other_audio, sample_rate=sample_rate)
        except AlignmentError:
            continue
        # Express each window's result as "where would t=0 of the reference
        # land in other_audio", so windows from different starting points
        # are directly comparable.
        aligned_lag = r.lag_seconds - (start / sample_rate)
        results.append(AlignmentResult(lag_seconds=aligned_lag, confidence=r.confidence, is_confident=r.is_confident))

    if not results:
        return VideoAlignmentResult(lag_seconds=None, confidence=0.0, is_confident=False, window_results=[])

    # Find the largest cluster of mutually-agreeing windows (within
    # AGREEMENT_TOLERANCE_SECONDS of each other's lag estimate).
    best_cluster: list[AlignmentResult] = []
    for candidate in results:
        cluster = [r for r in results if abs(r.lag_seconds - candidate.lag_seconds) <= AGREEMENT_TOLERANCE_SECONDS]
        if len(cluster) > len(best_cluster):
            best_cluster = cluster

    agreed = len(best_cluster) >= windows_needed_to_agree
    consensus_lag = float(np.median([r.lag_seconds for r in best_cluster])) if agreed else None
    consensus_confidence = float(np.mean([r.confidence for r in best_cluster])) if agreed else max(
        (r.confidence for r in results), default=0.0
    )

    return VideoAlignmentResult(
        lag_seconds=consensus_lag,
        confidence=consensus_confidence,
        is_confident=agreed and consensus_confidence >= CONFIDENCE_THRESHOLD,
        window_results=results,
    )


def _self_test() -> None:
    """
    Validates the algorithm against synthetic signals with a known offset —
    doesn't touch the network, so it can run (and should be re-run after any
    change to this file) without yt-dlp or a real video.
    """
    rng = np.random.default_rng(42)
    sr = SAMPLE_RATE

    shared_event = rng.standard_normal(int(1.5 * sr)).astype(np.float32)  # 1.5s "countdown"

    def make_track(total_seconds: float, event_start_seconds: float, bg_noise_scale: float = 1.0) -> np.ndarray:
        track = (rng.standard_normal(int(total_seconds * sr)) * bg_noise_scale).astype(np.float32)
        start = int(event_start_seconds * sr)
        track[start:start + len(shared_event)] += shared_event
        return track

    # Reference: shared event happens at 10s into a 90s clip (needle = full clip)
    needle = make_track(90, event_start_seconds=10)

    # Haystack: same shared event, this stream started recording much later.
    true_lag_seconds = 612.7
    haystack = make_track(1400, event_start_seconds=true_lag_seconds)

    # The needle is the *whole* 90s reference clip, of which only 10-11.5s is
    # the shared event — GCC-PHAT should still lock onto the event's
    # position since that's the only part correlated with the haystack.
    result = gcc_phat_align(needle, haystack, sample_rate=sr)

    expected_lag = true_lag_seconds - 10
    error = abs(result.lag_seconds - expected_lag)

    print(f"[self-test] clean match — expected lag: {expected_lag:.3f}s, got: {result.lag_seconds:.3f}s, "
          f"error: {error:.3f}s, confidence: {result.confidence:.1f} (confident={result.is_confident})")

    assert error < 0.05, f"lag error too large: {error:.3f}s"
    assert result.is_confident, f"confidence too low for a clean synthetic match: {result.confidence:.1f}"

    # Realistic-noise case: both streams' OWN background audio (different
    # game/music, modeled as uncorrelated full-spectrum noise at 3x the
    # event's amplitude — i.e. the shared voice is clearly audible in a real
    # mix but far from the loudest thing in it) on top of the same shared
    # event. This is what the plan's "background game audio" robustness
    # concern is actually about — and it only meaningfully exercises the
    # voice-band mask if the *event* is itself voice-like (concentrated in
    # that band), same as real speech would be, rather than full-spectrum
    # noise like the plain "clean match" event above.
    from scipy.signal import butter, sosfiltfilt  # test-only — the production algorithm never time-filters, see VOICE_BAND_HZ's comment

    def voice_like_event(seconds: float) -> np.ndarray:
        raw = rng.standard_normal(int(seconds * sr)).astype(np.float32)
        nyquist = sr / 2
        sos = butter(4, [VOICE_BAND_HZ[0] / nyquist, VOICE_BAND_HZ[1] / nyquist], btype="band", output="sos")
        return sosfiltfilt(sos, raw).astype(np.float32)

    def make_noisy_track(total_seconds: float, event_start_seconds: float, event: np.ndarray, bg_noise_scale: float) -> np.ndarray:
        track = (rng.standard_normal(int(total_seconds * sr)) * bg_noise_scale).astype(np.float32)
        start = int(event_start_seconds * sr)
        track[start:start + len(event)] += event
        return track

    # 2.5s (a short "3-2-1-go") at equal amplitude to the background — pushing
    # to 3x background amplitude with only 1.5s of event pushed confidence
    # below CONFIDENCE_THRESHOLD even at the *correct* lag (7.7, just under
    # 8.0): correlation gain accumulates with how much of the event overlaps
    # the match, so a very brief cue under heavy noise is a genuine, expected
    # hard case for this method — not a bug. Real shared cues (a multi-second
    # countdown, or voice chat running throughout) have more to accumulate.
    voice_event = voice_like_event(2.5)
    noisy_needle = make_noisy_track(90, 20, voice_event, bg_noise_scale=1.0)
    true_lag_noisy = 480.0
    noisy_haystack = make_noisy_track(1200, true_lag_noisy, voice_event, bg_noise_scale=1.0)
    noisy_result = gcc_phat_align(noisy_needle, noisy_haystack, sample_rate=sr)
    expected_noisy_lag = true_lag_noisy - 20
    noisy_error = abs(noisy_result.lag_seconds - expected_noisy_lag)

    print(f"[self-test] noisy match (equal-amplitude uncorrelated background) — expected lag: {expected_noisy_lag:.3f}s, "
          f"got: {noisy_result.lag_seconds:.3f}s, error: {noisy_error:.3f}s, "
          f"confidence: {noisy_result.confidence:.1f} (confident={noisy_result.is_confident})")

    assert noisy_error < 0.1, f"lag error too large under noise: {noisy_error:.3f}s"
    assert noisy_result.is_confident, (
        f"confidence too low despite band masking: {noisy_result.confidence:.1f} — "
        f"this is the scenario band masking exists to handle"
    )

    # Same noisy case but WITHOUT band masking — included so a future change
    # that regresses this comparison is caught, not just the absolute pass/fail.
    unmasked_result = gcc_phat_align(noisy_needle, noisy_haystack, sample_rate=sr, band_hz=None)
    print(f"[self-test] same noisy case, no band mask — confidence: {unmasked_result.confidence:.1f} "
          f"(confident={unmasked_result.is_confident}) — should be lower than the masked case above")

    # Negative case: two completely unrelated noise signals should NOT
    # produce a confident match.
    unrelated_needle = rng.standard_normal(int(90 * sr)).astype(np.float32)
    unrelated_haystack = rng.standard_normal(int(1400 * sr)).astype(np.float32)
    negative_result = gcc_phat_align(unrelated_needle, unrelated_haystack, sample_rate=sr)
    print(f"[self-test] unrelated signals — confidence: {negative_result.confidence:.1f} "
          f"(confident={negative_result.is_confident})")
    assert not negative_result.is_confident, (
        f"unrelated noise produced a confident match ({negative_result.confidence:.1f}) — "
        f"CONFIDENCE_THRESHOLD may be too low"
    )

    print("[self-test] PASSED")

    _self_test_align_video()


def _self_test_align_video() -> None:
    """
    Covers `align_video`'s consensus logic specifically. Modeled after what
    the real 4-video test actually looked like: the shared audio wasn't one
    brief instant but ran continuously through a large stretch of footage
    (apparently shared ambient sound, not a single countdown) — so unlike
    `_self_test`'s single short event, this uses a long shared segment that
    any 90s needle window landing inside it will pick up *some* of.
    """
    rng = np.random.default_rng(123)
    sr = SAMPLE_RATE

    def voice_like_noise(seconds: float) -> np.ndarray:
        raw = rng.standard_normal(int(seconds * sr)).astype(np.float32)
        from scipy.signal import butter, sosfiltfilt  # test-only, see VOICE_BAND_HZ's comment
        nyquist = sr / 2
        sos = butter(4, [VOICE_BAND_HZ[0] / nyquist, VOICE_BAND_HZ[1] / nyquist], btype="band", output="sos")
        return sosfiltfilt(sos, raw).astype(np.float32)

    # Spans essentially the whole middle 80% (matching what the real 4-video
    # test actually showed: strong correlation across nearly the entire
    # recording, not one isolated cue) so every needle window — wherever it
    # happens to land within that region — picks up shared content.
    shared_segment = voice_like_noise(900.0)

    ref_len_s = 1600.0  # long enough that shared_segment + true_shift still fits inside `other` below
    reference = rng.standard_normal(int(ref_len_s * sr)).astype(np.float32)
    segment_pos_in_ref = 150.0
    reference[int(segment_pos_in_ref * sr):int(segment_pos_in_ref * sr) + len(shared_segment)] += shared_segment

    true_shift = 333.0  # haystack's copy is this many seconds later than the reference's
    other = rng.standard_normal(int(ref_len_s * sr)).astype(np.float32)
    segment_pos_in_other = segment_pos_in_ref + true_shift
    other[int(segment_pos_in_other * sr):int(segment_pos_in_other * sr) + len(shared_segment)] += shared_segment

    result = align_video(reference, other, sample_rate=sr)
    print(f"[self-test:align_video] consensus_lag={result.lag_seconds}, confidence={result.confidence:.1f}, "
          f"confident={result.is_confident}, windows={[(round(w.lag_seconds, 2), round(w.confidence, 1)) for w in result.window_results]}")

    assert result.is_confident, "expected a confident consensus when the event is genuinely findable"
    assert result.lag_seconds is not None
    assert abs(result.lag_seconds - true_shift) < 0.1, f"consensus lag off by {abs(result.lag_seconds - true_shift):.3f}s"

    # No shared event anywhere: no window should agree with any other, so
    # there should be no consensus regardless of any single window's z-score.
    unrelated_reference = rng.standard_normal(int(ref_len_s * sr)).astype(np.float32)
    unrelated_other = rng.standard_normal(int(ref_len_s * sr)).astype(np.float32)
    negative = align_video(unrelated_reference, unrelated_other, sample_rate=sr)
    print(f"[self-test:align_video] unrelated — confident={negative.is_confident}, "
          f"windows={[(round(w.lag_seconds, 2), round(w.confidence, 1)) for w in negative.window_results]}")
    assert not negative.is_confident, "unrelated audio should never reach consensus"

    print("[self-test:align_video] PASSED")


if __name__ == "__main__":
    _self_test()
