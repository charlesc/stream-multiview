/**
 * Loads the YouTube IFrame Player API and coordinates multiple YT.Player
 * instances: unified play/pause, a single unmuted audio source, manual
 * per-stream offsets, and periodic drift correction against a reference
 * player.
 */

export type YTPlayerState = -1 | 0 | 1 | 2 | 3 | 5;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): YTPlayerState;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setPlaybackRate(suggestedRate: number): void;
  getPlaybackRate(): number;
  loadVideoById(videoId: string, startSeconds?: number): void;
  destroy(): void;
}

interface YTPlayerOptions {
  events?: {
    onReady?: (event: { target: YTPlayer }) => void;
    onStateChange?: (event: { data: YTPlayerState; target: YTPlayer }) => void;
    onError?: (event: { data: number }) => void;
  };
}

export interface YTNamespace {
  Player: new (elementOrId: HTMLElement | string, options?: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";
const PLAYING_STATE: YTPlayerState = 1;

let apiPromise: Promise<YTNamespace> | null = null;

/**
 * Injects the YouTube IFrame API script (once) and resolves once
 * `window.YT.Player` is available. Safe to call multiple times.
 */
export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("loadYouTubeIframeApi can only run in the browser"));
  }
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      if (window.YT) resolve(window.YT);
    };

    if (!document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
      const script = document.createElement("script");
      script.src = IFRAME_API_SRC;
      document.head.appendChild(script);
    }
  });

  return apiPromise;
}

const DRIFT_CHECK_INTERVAL_MS = 5000;
const DRIFT_THRESHOLD_SECONDS = 1;

interface PlayerEntry {
  player: YTPlayer;
  videoId: string;
  /**
   * The object returned by `new YT.Player(...)` does not have its control
   * methods (mute/play/seek/...) attached until the API finishes its
   * handshake with the iframe — which is asynchronous and NOT complete by
   * the time the constructor returns. Calling e.g. `.mute()` before that
   * throws "player.mute is not a function". Every method below must check
   * this flag (set by the onReady handler in createPlayer) before touching
   * the player.
   */
  ready: boolean;
}

/** Runs `fn`, swallowing and logging any error so one broken player can't take the others down with it. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error("[sync-controller] player call failed:", error);
  }
}

export class SyncController {
  private players = new Map<number, PlayerEntry>();
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private activeAudioIndex: number | null = null;
  /** Applied to every player — new ones on ready, existing ones via setPlaybackRateAll. YouTube only accepts discrete rates (0.25/0.5/0.75/1/1.25/...), not arbitrary values. */
  private playbackRate: number = 1;
  /** Seconds each index's playhead should lead the reference player by. Missing indices default to 0. */
  private offsets: number[] = [];

  /** Replaces the full offsets array. Indices without an entry are treated as 0. */
  setOffsets(offsets: number[]): void {
    this.offsets = offsets;
  }

  private getOffsetSeconds(index: number): number {
    const value = this.offsets[index];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * Creates a YT.Player bound to `element` (typically an existing <iframe>
   * whose src is already a valid embed URL with enablejsapi=1) and registers
   * it under `index`. No-ops if `index` is already registered.
   */
  createPlayer(index: number, YT: YTNamespace, element: HTMLElement, videoId: string): void {
    if (this.players.has(index)) return;

    const player = new YT.Player(element, {
      events: {
        onReady: (event) => {
          const entry = this.players.get(index);
          if (entry) entry.ready = true;
          safely(() => {
            if (this.activeAudioIndex === index) event.target.unMute();
            else event.target.mute();
          });
          safely(() => event.target.setPlaybackRate(this.playbackRate));
        },
      },
    });

    this.players.set(index, { player, videoId, ready: false });
  }

  unregisterPlayer(index: number): void {
    const entry = this.players.get(index);
    if (!entry) return;
    safely(() => entry.player.destroy());
    this.players.delete(index);
  }

  hasPlayer(index: number): boolean {
    return this.players.has(index);
  }

  getVideoId(index: number): string | undefined {
    return this.players.get(index)?.videoId;
  }

  getActiveIndices(): number[] {
    return Array.from(this.players.keys());
  }

  /**
   * Current playhead position and total duration in seconds, or null if the
   * player isn't registered/ready. Combined into one call (rather than
   * separate getCurrentTime/getDuration methods) since callers polling this
   * for a UI readout want both every tick anyway.
   */
  getPlaybackTime(index: number): { current: number; duration: number } | null {
    const entry = this.players.get(index);
    if (!entry?.ready) return null;
    try {
      return { current: entry.player.getCurrentTime(), duration: entry.player.getDuration() };
    } catch (error) {
      console.error("[sync-controller] getPlaybackTime failed:", error);
      return null;
    }
  }

  /** Loads a new video into an already-registered, ready player without recreating it. Returns false if it couldn't (caller should fall back). */
  reloadVideo(index: number, videoId: string): boolean {
    const entry = this.players.get(index);
    if (!entry || !entry.ready) return false;
    safely(() => entry.player.loadVideoById(videoId, 0));
    // loadVideoById resets the player to the default 1x rate — reapply ours
    safely(() => entry.player.setPlaybackRate(this.playbackRate));
    entry.videoId = videoId;
    return true;
  }

  playAll(): void {
    this.players.forEach((entry) => {
      if (entry.ready) safely(() => entry.player.playVideo());
    });
  }

  pauseAll(): void {
    this.players.forEach((entry) => {
      if (entry.ready) safely(() => entry.player.pauseVideo());
    });
  }

  /** Seeks every ready player forward/backward by the same number of seconds. */
  seekAllBy(deltaSeconds: number): void {
    this.players.forEach((entry) => {
      if (!entry.ready) return;
      safely(() => {
        const target = Math.max(0, entry.player.getCurrentTime() + deltaSeconds);
        entry.player.seekTo(target, true);
      });
    });
  }

  /**
   * Sets the playback rate on every ready player and remembers it so a
   * player that becomes ready later (or reloads a video) picks it up too.
   * YouTube only honors values from `player.getAvailablePlaybackRates()`
   * (typically 0.25/0.5/0.75/1/1.25/1.5/1.75/2) — passing anything else is
   * silently ignored by the API, so callers should stick to those.
   */
  setPlaybackRateAll(rate: number): void {
    this.playbackRate = rate;
    this.players.forEach((entry) => {
      if (entry.ready) safely(() => entry.player.setPlaybackRate(rate));
    });
  }

  /**
   * Seeks a single player forward/backward by `deltaSeconds` from its own
   * current position. Used for manual per-stream offset nudges — deliberately
   * independent of whichever player is the drift-correction reference, so
   * clicking "+1s" on a panel always visibly moves that panel, even if it
   * happens to currently be the reference itself.
   */
  nudgePlayer(index: number, deltaSeconds: number): void {
    const entry = this.players.get(index);
    if (!entry?.ready) return;
    safely(() => {
      const target = Math.max(0, entry.player.getCurrentTime() + deltaSeconds);
      entry.player.seekTo(target, true);
    });
  }

  /**
   * Mutes every player except `index`, which is unmuted. Pass null to mute
   * all. Remembered internally so a player that becomes ready later (see
   * createPlayer's onReady) applies the current selection instead of
   * whatever was true when it was constructed.
   */
  setActiveAudio(index: number | null): void {
    this.activeAudioIndex = index;
    this.players.forEach((entry, i) => {
      if (!entry.ready) return;
      safely(() => {
        if (i === index) entry.player.unMute();
        else entry.player.mute();
      });
    });
  }

  /**
   * Every `DRIFT_CHECK_INTERVAL_MS`, compares each playing player's current
   * time against the reference player (adjusted by offset) and hard-seeks
   * only if the drift exceeds `DRIFT_THRESHOLD_SECONDS` — frequent small
   * seeks cause visible rebuffering stutter, so the threshold is deliberately
   * not tighter than one second. This is long-run clock-drift cleanup;
   * intentional manual adjustments go through `nudgePlayer` instead, which
   * seeks immediately with no gating.
   */
  startDriftCorrection(getReferenceIndex: () => number | null): void {
    this.stopDriftCorrection();
    this.driftTimer = setInterval(() => {
      const referenceIndex = getReferenceIndex();
      if (referenceIndex === null) return;
      const reference = this.players.get(referenceIndex);
      if (!reference || !reference.ready) return;

      let referenceTime: number | null = null;
      safely(() => {
        if (reference.player.getPlayerState() === PLAYING_STATE) {
          referenceTime = reference.player.getCurrentTime();
        }
      });
      if (referenceTime === null) return;

      const referenceOffset = this.getOffsetSeconds(referenceIndex);

      this.players.forEach((entry, index) => {
        if (index === referenceIndex || !entry.ready) return;

        safely(() => {
          if (entry.player.getPlayerState() !== PLAYING_STATE) return;

          const target = Math.max(0, referenceTime! + (this.getOffsetSeconds(index) - referenceOffset));
          const diff = entry.player.getCurrentTime() - target;

          if (Math.abs(diff) > DRIFT_THRESHOLD_SECONDS) {
            entry.player.seekTo(target, true);
          }
        });
      });
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  stopDriftCorrection(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
  }

  /** Destroys every registered player and stops drift correction. Call on unmount. */
  destroyAll(): void {
    this.stopDriftCorrection();
    this.players.forEach((entry) => safely(() => entry.player.destroy()));
    this.players.clear();
  }
}
