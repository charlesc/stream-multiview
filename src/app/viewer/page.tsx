"use client";

import { useStreams } from "@/lib/stream-context";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { extractVideoId, decodeStreamData, encodeStreamData, StreamData } from "@/lib/share-utils";
import { SyncController, loadYouTubeIframeApi } from "@/lib/sync-controller";

type LayoutType = "grid" | "stage";

// "0:36" / "1:04:12" — mm:ss, or h:mm:ss past the first hour. Used for the
// custom playback-time readout that replaces YouTube's own (see getEmbedUrl).
function formatClockTime(seconds: number): string {
  const safeSeconds = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  const paddedMins = hrs > 0 ? mins.toString().padStart(2, "0") : mins.toString();
  return `${hrs > 0 ? `${hrs}:` : ""}${paddedMins}:${secs.toString().padStart(2, "0")}`;
}

// Parse shared data from URL on first render (avoids useSearchParams issues)
// Always returns valid StreamData with defaults
function parseSharedDataFromUrl(): StreamData {
  if (typeof window === "undefined") {
    return { videoIds: [], colSizes: [], rowSizes: [], offsets: [], layout: "grid", stageIndex: 0 };
  }
  const params = new URLSearchParams(window.location.search);
  const encodedData = params.get("data") || "";
  return decodeStreamData(encodedData);
}

export default function Viewer() {
  const { streamCount, streamUrls, setStreamUrls, setStreamCount } = useStreams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const iframeRefs = useRef<(HTMLIFrameElement | null)[]>([]);
  // Replaces YouTube's own (now-hidden, see getEmbedUrl) time readout — written
  // to directly on a timer rather than through React state, same reasoning as
  // the drag-resize code below: a per-panel value ticking multiple times a
  // second has no business going through a re-render.
  const timeDisplayRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const hasRestored = useRef(false);
  const rafId = useRef<number | null>(null);
  const pendingMouseEvent = useRef<MouseEvent | null>(null);

  const sharedData = useMemo(() => parseSharedDataFromUrl(), []);

  const [colSizes, setColSizes] = useState<number[]>(() =>
    sharedData.colSizes.length > 0 ? [...sharedData.colSizes] : []
  );
  const [rowSizes, setRowSizes] = useState<number[]>(() =>
    sharedData.rowSizes.length > 0 ? [...sharedData.rowSizes] : []
  );
  // Manual per-stream alignment offset in seconds, indexed by original stream index (not display position)
  const [offsets, setOffsets] = useState<number[]>(() =>
    sharedData.offsets.length > 0 ? [...sharedData.offsets] : []
  );
  const [layout, setLayout] = useState<LayoutType>(() =>
    sharedData.layout === "stage" ? "stage" : "grid"
  );
  const [stageIndex, setStageIndex] = useState<number>(() =>
    typeof sharedData.stageIndex === "number" && !isNaN(sharedData.stageIndex)
      ? Math.max(0, sharedData.stageIndex)
      : 0
  );
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [showPlaybackMenu, setShowPlaybackMenu] = useState(false);
  const [copied, setCopied] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Restore streams from shared data once on mount
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (hasRestored.current) return;

    const hasSharedData = sharedData.videoIds.length > 0;

    if (hasSharedData) {
      const restoredUrls = sharedData.videoIds.map(
        (id: string) => `https://youtube.com/embed/${id}`
      );
      setStreamUrls(restoredUrls);
      setStreamCount(restoredUrls.length);
      setLayout(sharedData.layout);
      setStageIndex(sharedData.stageIndex);
      if (sharedData.colSizes.length > 0) setColSizes(sharedData.colSizes);
      if (sharedData.rowSizes.length > 0) setRowSizes(sharedData.rowSizes);
      if (sharedData.offsets.length > 0) setOffsets(sharedData.offsets);
    }

    hasRestored.current = true;
  }, [sharedData, setStreamUrls, setStreamCount, setColSizes, setRowSizes, setOffsets]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Redirect if no streams configured and no shared data
  useEffect(() => {
    const hasSharedData = typeof window !== "undefined" && 
      new URLSearchParams(window.location.search).has("data");
    if (mounted && streamUrls.every((url) => url === "") && !hasSharedData) {
      router.push("/");
    }
  }, [mounted, streamUrls, router]);

  // Calculate number of active streams
  const activeUrls = streamUrls.filter((url) => typeof url === "string" && url.trim() !== "");
  const activeCount = Math.max(activeUrls.length, streamCount || 0);

  // --- Sync controller: unified play/pause, single audio source, drift correction ---
  const syncControllerRef = useRef<SyncController | null>(null);
  if (syncControllerRef.current === null) {
    syncControllerRef.current = new SyncController();
  }
  const [apiReady, setApiReady] = useState(false);
  const [activeAudioIndex, setActiveAudioIndex] = useState<number | null>(null);
  const [isPlayingAll, setIsPlayingAll] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Video ID per original stream index, independent of stage display order
  const videoIdsByIndex = useMemo(() => {
    const safeCount = Math.max(0, activeCount || 0);
    return Array.from({ length: safeCount }, (_, i) => extractVideoId(streamUrls[i] || ""));
  }, [streamUrls, activeCount]);

  // Manual offset per original stream index, padded/trimmed to match the
  // active stream count — a shared link missing or short on offsets (e.g.
  // one made before this feature existed) just means everyone defaults to 0
  const effectiveOffsets = useMemo(() => {
    const safeCount = Math.max(0, activeCount || 0);
    const safeOffsets = Array.isArray(offsets) ? offsets : [];
    const validOffsets = safeOffsets.filter((o) => typeof o === "number" && Number.isFinite(o));

    if (validOffsets.length >= safeCount) return validOffsets.slice(0, safeCount);
    return [...validOffsets, ...Array(safeCount - validOffsets.length).fill(0)];
  }, [offsets, activeCount]);

  useEffect(() => {
    let cancelled = false;
    loadYouTubeIframeApi().then(() => {
      if (!cancelled) setApiReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create/reload/destroy YT.Player instances to match the active video IDs.
  // Binds directly to the existing <iframe> DOM nodes tracked in iframeRefs,
  // so no extra ids or document.getElementById lookups are needed.
  useEffect(() => {
    if (!apiReady) return;
    const controller = syncControllerRef.current;
    const YT = window.YT;
    if (!controller || !YT) return;

    videoIdsByIndex.forEach((videoId, index) => {
      if (!videoId) return;

      if (controller.hasPlayer(index)) {
        if (controller.getVideoId(index) !== videoId) {
          controller.reloadVideo(index, videoId);
        }
        return;
      }

      const iframeEl = iframeRefs.current[index];
      if (!iframeEl) return;

      controller.createPlayer(index, YT, iframeEl, videoId);
    });

    controller.getActiveIndices().forEach((index) => {
      if (!videoIdsByIndex[index]) {
        controller.unregisterPlayer(index);
      }
    });
  }, [apiReady, videoIdsByIndex]);

  // Selected audio index, clamped to null if that stream is no longer active
  // (derived instead of corrected via an effect — avoids a spurious extra render)
  const effectiveActiveAudioIndex = useMemo(() => {
    return activeAudioIndex !== null && videoIdsByIndex[activeAudioIndex] ? activeAudioIndex : null;
  }, [activeAudioIndex, videoIdsByIndex]);

  // Keep exactly one player unmuted whenever the selection or player set changes
  useEffect(() => {
    if (!apiReady) return;
    syncControllerRef.current?.setActiveAudio(effectiveActiveAudioIndex);
  }, [apiReady, effectiveActiveAudioIndex, videoIdsByIndex]);

  // Keep the controller's offsets in sync with state. adjustOffset/
  // handleUseAsBaseline below also push directly to the controller before
  // this effect runs, so a manual edit's resync doesn't use stale offsets —
  // this effect is the fallback that covers every other case (restore from
  // a shared link, stream count changes, etc.).
  useEffect(() => {
    syncControllerRef.current?.setOffsets(effectiveOffsets);
  }, [effectiveOffsets]);

  // Reference for drift correction: the current audio source, falling back
  // to the first registered player so correction still runs before a
  // selection is made
  const getDriftReferenceIndex = useCallback((): number | null => {
    const controller = syncControllerRef.current;
    if (!controller) return null;
    if (effectiveActiveAudioIndex !== null && controller.hasPlayer(effectiveActiveAudioIndex)) {
      return effectiveActiveAudioIndex;
    }
    const indices = controller.getActiveIndices();
    return indices.length > 0 ? Math.min(...indices) : null;
  }, [effectiveActiveAudioIndex]);

  useEffect(() => {
    if (!apiReady) return;
    const controller = syncControllerRef.current;
    if (!controller) return;
    controller.startDriftCorrection(getDriftReferenceIndex);
    return () => controller.stopDriftCorrection();
  }, [apiReady, getDriftReferenceIndex]);

  // Tear down every player on unmount
  useEffect(() => {
    return () => {
      syncControllerRef.current?.destroyAll();
    };
  }, []);

  // Drives the custom time readout that replaces YouTube's own hidden one
  // (see getEmbedUrl). Writes straight to the DOM via timeDisplayRefs — with
  // up to 12 panels ticking multiple times a second, running this through
  // React state would mean 12 re-renders a tick for a value nothing else in
  // the component needs, the same reasoning the drag-resize code below uses.
  useEffect(() => {
    if (!apiReady) return;
    const controller = syncControllerRef.current;
    if (!controller) return;

    const tick = () => {
      videoIdsByIndex.forEach((videoId, index) => {
        if (!videoId) return;
        const el = timeDisplayRefs.current[index];
        if (!el) return;
        const time = controller.getPlaybackTime(index);
        el.textContent = time ? `${formatClockTime(time.current)} / ${formatClockTime(time.duration)}` : "";
      });
    };

    tick();
    const intervalId = setInterval(tick, 500);
    return () => clearInterval(intervalId);
  }, [apiReady, videoIdsByIndex]);

  const toggleAudioSource = (index: number) => {
    setActiveAudioIndex((prev) => (prev === index ? null : index));
  };

  // Nudge one stream's alignment offset by delta seconds (±0.1s / ±1s
  // buttons) and seek that stream immediately by the same delta — rounded to
  // 2 decimals so repeated 0.1 clicks don't accumulate floating-point noise
  // like 0.30000000000000004.
  const adjustOffset = (index: number, deltaSeconds: number) => {
    const controller = syncControllerRef.current;
    const current = effectiveOffsets[index] ?? 0;
    const newOffsets = [...effectiveOffsets];
    newOffsets[index] = Math.round((current + deltaSeconds) * 100) / 100;

    controller?.setOffsets(newOffsets);
    controller?.nudgePlayer(index, deltaSeconds);
    setOffsets(newOffsets);
  };

  // "Use this as baseline": rebase every offset relative to this stream's
  // current offset, so this one reads 0. This does NOT move any playhead —
  // it only renames the zero point, so the alignment on screen is untouched.
  const handleUseAsBaseline = (index: number) => {
    const base = effectiveOffsets[index] ?? 0;
    if (base === 0) return;
    const newOffsets = effectiveOffsets.map((o) => Math.round((o - base) * 100) / 100);

    syncControllerRef.current?.setOffsets(newOffsets);
    setOffsets(newOffsets);
  };

  const handleTogglePlayAll = () => {
    const controller = syncControllerRef.current;
    if (!controller) return;
    if (isPlayingAll) {
      controller.pauseAll();
    } else {
      controller.playAll();
    }
    setIsPlayingAll((prev) => !prev);
  };

  // Seek every stream by the same delta (±1s / ±5s "skip" buttons)
  const handleSeekAll = (deltaSeconds: number) => {
    syncControllerRef.current?.seekAllBy(deltaSeconds);
  };

  // Set playback speed on every stream (0.5x / 0.75x / 1x)
  const handleSetPlaybackRate = (rate: number) => {
    syncControllerRef.current?.setPlaybackRateAll(rate);
    setPlaybackRate(rate);
  };

  // Calculate optimal grid dimensions based on count (for bottom row in stage mode)
  const getBottomGridDimensions = (count: number): { cols: number; rows: number } => {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    if (count <= 9) return { cols: 3, rows: 3 };
    return { cols: 4, rows: 3 };
  };

  const getGridDimensions = (count: number): { cols: number; rows: number } => {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    if (count <= 9) return { cols: 3, rows: 3 };
    return { cols: 4, rows: 3 };
  };

  const { cols: gridCols, rows: gridRows } = useMemo(() => {
    if (layout === "stage") {
      const bottomCount = activeCount - 1;
      if (bottomCount <= 0) return { cols: 1, rows: 1 };
      const dims = getBottomGridDimensions(bottomCount);
      return { cols: dims.cols, rows: 1 + dims.rows }; // +1 for stage row
    }
    return getGridDimensions(activeCount);
  }, [activeCount, layout]);

  // Get effective sizes (padded with 1s if needed)
  // Always returns valid arrays with positive numbers
  const effectiveColSizes = useMemo(() => {
    const safeGridCols = Math.max(1, gridCols || 1);
    const safeColSizes = Array.isArray(colSizes) ? colSizes : [];
    const validSizes = safeColSizes.filter(s => typeof s === "number" && !isNaN(s) && s > 0);
    
    if (validSizes.length >= safeGridCols) {
      return validSizes.slice(0, safeGridCols);
    }
    return [...validSizes, ...Array(safeGridCols - validSizes.length).fill(1)];
  }, [colSizes, gridCols]);

  const effectiveRowSizes = useMemo(() => {
    const safeGridRows = Math.max(1, gridRows || 1);
    const safeRowSizes = Array.isArray(rowSizes) ? rowSizes : [];
    const validSizes = safeRowSizes.filter(s => typeof s === "number" && !isNaN(s) && s > 0);
    
    if (layout === "stage") {
      // For stage layout: first row is stage (2x), bottom rows are equal
      const bottomRowCount = safeGridRows - 1;
      if (bottomRowCount <= 0) return [3];
      const bottomSize = validSizes.length > 1 ? validSizes.slice(1) : Array(bottomRowCount).fill(1);
      const stageSize = validSizes.length > 0 ? validSizes[0] : 2;
      return [stageSize, ...bottomSize].slice(0, safeGridRows);
    }
    
    if (validSizes.length >= safeGridRows) {
      return validSizes.slice(0, safeGridRows);
    }
    return [...validSizes, ...Array(safeGridRows - validSizes.length).fill(1)];
  }, [rowSizes, gridRows, layout]);

  // Drag state - minimal React state, mostly refs for performance
  const [isDragging, setIsDragging] = useState(false);
  const dragInfo = useRef<{
    type: "col" | "row";
    index: number;
    startSizes: number[];
    currentSizes: number[];
    gridRect: DOMRect;
    startClientPos: number;
  } | null>(null);

  // Refs to DOM elements for direct manipulation
  const colHandleRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rowHandleRefs = useRef<(HTMLDivElement | null)[]>([]);

  const getEmbedUrl = (videoId: string): string => {
    const origin = typeof window !== "undefined" ? `&origin=${encodeURIComponent(window.location.origin)}` : "";
    // controls=0 hides YouTube's own play/pause, scrubber, "more videos",
    // share, and save buttons entirely — this app has its own play/pause
    // (header), seek (offset row), and refresh controls, so the native ones
    // are pure misclick risk with no upside. disablekb=1 closes the same
    // gap for keyboard shortcuts landing on a focused iframe. The playback
    // time readout that controls=0 also removes is rebuilt separately (see
    // the per-panel time display below), since that's the one piece of
    // information worth keeping.
    return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&rel=0&controls=0&disablekb=1${origin}`;
  };

  const handleBack = () => {
    router.push("/");
  };

  const handleRefresh = () => {
    // Prefer reloading through the Player API (keeps the player instance and
    // its sync/audio state intact) — only fall back to resetting the raw
    // iframe src for slots whose player hasn't been created yet.
    const controller = syncControllerRef.current;
    streamUrls.forEach((url, index) => {
      if (typeof url !== "string" || !url.trim()) return;
      const videoId = extractVideoId(url);
      if (!videoId) return;

      const reloaded = controller?.reloadVideo(index, videoId) ?? false;
      if (!reloaded) {
        const iframe = iframeRefs.current[index];
        if (iframe) {
          iframe.src = getEmbedUrl(videoId);
        }
      }
    });
  };

  const switchLayout = (newLayout: LayoutType) => {
    setLayout(newLayout);
    setShowLayoutMenu(false);

    const newGridDims = newLayout === "stage"
      ? (() => {
          const bottomCount = activeCount - 1;
          if (bottomCount <= 0) return { cols: 1, rows: 1 };
          const dims = getBottomGridDimensions(bottomCount);
          return { cols: dims.cols, rows: 1 + dims.rows };
        })()
      : getGridDimensions(activeCount);

    setColSizes(Array(newGridDims.cols).fill(1));
    setRowSizes(
      newLayout === "stage" && newGridDims.rows > 1
        ? [2, ...Array(newGridDims.rows - 1).fill(1)]
        : Array(newGridDims.rows).fill(1)
    );
  };

  const moveToStage = (index: number) => {
    setStageIndex(index);
  };

  const syncUrlToState = useCallback(() => {
    const safeStreamUrls = Array.isArray(streamUrls) ? streamUrls : [];
    const videoIds = safeStreamUrls
      .map(url => extractVideoId(url))
      .filter(id => id.length > 0);

    if (videoIds.length === 0) return;

    const streamData: StreamData = {
      videoIds,
      colSizes: colSizes.filter((s): s is number => typeof s === "number" && !isNaN(s) && s > 0),
      rowSizes: rowSizes.filter((s): s is number => typeof s === "number" && !isNaN(s) && s > 0),
      offsets: offsets.filter((o): o is number => typeof o === "number" && Number.isFinite(o)),
      layout,
      stageIndex,
    };

    window.history.replaceState(null, "", `/viewer?data=${encodeStreamData(streamData)}`);
  }, [streamUrls, colSizes, rowSizes, offsets, layout, stageIndex]);

  // Sync URL to state whenever layout, sizes, or streams change
  useEffect(() => {
    if (!mounted || !hasRestored.current) return;
    syncUrlToState();
  }, [mounted, syncUrlToState]);

  // Calculate divider position as percentage
  // sizes array is guaranteed to have valid positive numbers
  const getDividerPosition = useCallback((sizes: number[], index: number): number => {
    const safeSizes = Array.isArray(sizes) ? sizes : [1];
    const safeIndex = Math.max(0, Math.min(index, safeSizes.length - 1));
    
    const cumulativeFraction = safeSizes.slice(0, safeIndex + 1).reduce((a, b) => a + (b || 1), 0);
    const totalFraction = safeSizes.reduce((a, b) => a + (b || 1), 0);
    
    if (totalFraction <= 0) return 50;
    return (cumulativeFraction / totalFraction) * 100;
  }, []);

  // Update a divider's visual position directly via DOM
  const updateDividerPosition = useCallback((type: "col" | "row", index: number, percent: number) => {
    const refs = type === "col" ? colHandleRefs : rowHandleRefs;
    const handle = refs.current[index];
    if (handle) {
      if (type === "col") {
        handle.style.left = `${percent}%`;
      } else {
        handle.style.top = `${percent}%`;
      }
    }
  }, []);

  // Update all divider positions based on current sizes
  const updateAllDividerPositions = useCallback(() => {
    for (let i = 0; i < gridCols - 1; i++) {
      const pos = getDividerPosition(effectiveColSizes, i);
      updateDividerPosition("col", i, pos);
    }
    for (let i = 0; i < gridRows - 1; i++) {
      const pos = getDividerPosition(effectiveRowSizes, i);
      updateDividerPosition("row", i, pos);
    }
  }, [gridCols, gridRows, effectiveColSizes, effectiveRowSizes, getDividerPosition, updateDividerPosition]);

  // Update grid styles directly on DOM for smooth resizing
  const updateGridStyles = useCallback((sizes: number[], type: "col" | "row") => {
    if (!gridRef.current) return;
    const template = sizes.map(s => `${s}fr`).join(" ");
    if (type === "col") {
      gridRef.current.style.gridTemplateColumns = template;
    } else {
      gridRef.current.style.gridTemplateRows = template;
    }
  }, []);

  // Handle resize start
  const handleResizeStart = useCallback((type: "col" | "row", index: number, e: React.MouseEvent | React.KeyboardEvent) => {
    if ("preventDefault" in e) e.preventDefault();
    e.stopPropagation();
    if (!gridRef.current) return;

    const rect = gridRef.current.getBoundingClientRect();
    const sizes = type === "col" ? effectiveColSizes : effectiveRowSizes;

    const isKeyboardEvent = "key" in e;
    let syntheticClientPos: number;

    if (isKeyboardEvent) {
      const cumulative = sizes.slice(0, index + 1).reduce((a, b) => a + b, 0);
      const total = sizes.reduce((a, b) => a + b, 0);
      const percent = (cumulative / total) * 100;
      const totalPixels = type === "col" ? rect.width : rect.height;
      syntheticClientPos = (type === "col" ? rect.left : rect.top) + (percent / 100) * totalPixels;
    } else {
      syntheticClientPos = type === "col" ? (e as React.MouseEvent).clientX : (e as React.MouseEvent).clientY;
    }

    dragInfo.current = {
      type,
      index,
      startSizes: [...sizes],
      currentSizes: [...sizes],
      gridRect: rect,
      startClientPos: syntheticClientPos,
    };

    setIsDragging(true);

    const refs = type === "col" ? colHandleRefs : rowHandleRefs;
    const handle = refs.current[index];
    if (handle) {
      const line = handle.querySelector(".divider-line") as HTMLElement;
      if (line) {
        line.classList.add("bg-red-500");
        line.classList.remove("bg-neutral-600/40", "group-hover:bg-red-500/70");
      }
    }
  }, [effectiveColSizes, effectiveRowSizes]);

  const handleResizeKeyDown = useCallback((type: "col" | "row", index: number, e: React.KeyboardEvent) => {
    if (!(e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();

    const sizes = type === "col" ? effectiveColSizes : effectiveRowSizes;
    const total = sizes.reduce((a, b) => a + b, 0);
    const step = 0.05 * total;
    const delta = (e.key === "ArrowLeft" || e.key === "ArrowUp") ? -step : step;

    const newSizes = [...sizes];
    const minSize = 0.1 * total;
    let newLeft = newSizes[index] + delta;
    let newRight = newSizes[index + 1] - delta;

    if (newLeft < minSize) { newLeft = minSize; newRight = (newSizes[index] + newSizes[index + 1]) - minSize; }
    if (newRight < minSize) { newRight = minSize; newLeft = (newSizes[index] + newSizes[index + 1]) - minSize; }

    newSizes[index] = newLeft;
    newSizes[index + 1] = newRight;

    if (type === "col") setColSizes(newSizes);
    else setRowSizes(newSizes);
  }, [effectiveColSizes, effectiveRowSizes, setColSizes, setRowSizes]);


  // Mouse move handler - uses RAF for smooth 60fps updates
  const processMouseMove = useCallback(() => {
    rafId.current = null;
    const e = pendingMouseEvent.current;
    if (!e || !dragInfo.current || !gridRef.current) return;
    
    const { type, index, startSizes, gridRect } = dragInfo.current;
    const clientPos = type === "col" ? e.clientX : e.clientY;
    const totalSize = type === "col" ? gridRect.width : gridRect.height;
    
    // Calculate position as percentage of total grid size
    const relativePos = clientPos - (type === "col" ? gridRect.left : gridRect.top);
    const percentPos = Math.max(0, Math.min(100, (relativePos / totalSize) * 100));
    
    // Calculate cumulative percentage up to this divider
    const sizesBefore = startSizes.slice(0, index);
    const totalBeforeFrac = sizesBefore.reduce((a, b) => a + b, 0);
    const totalFraction = startSizes.reduce((a, b) => a + b, 0);
    const percentBefore = (totalBeforeFrac / totalFraction) * 100;
    
    // Calculate size for current and next cells based on divider position
    const sizesAfter = startSizes.slice(index + 2);
    const totalAfterFrac = sizesAfter.reduce((a, b) => a + b, 0);
    const percentAfter = (totalAfterFrac / totalFraction) * 100;
    
    // Available space for these two cells
    const availablePercent = 100 - percentBefore - percentAfter;
    
    // Calculate new sizes proportional to the divider position
    const currentPercent = percentPos - percentBefore;
    const nextPercent = availablePercent - currentPercent;
    
    // Convert back to fractions
    const newCurrent = (currentPercent / availablePercent) * (startSizes[index] + startSizes[index + 1]);
    const newNext = (nextPercent / availablePercent) * (startSizes[index] + startSizes[index + 1]);
    
    // Apply minimum constraint (10% each)
    const minFraction = 0.1 * totalFraction;
    let finalCurrent = newCurrent;
    let finalNext = newNext;
    
    if (finalCurrent < minFraction) {
      finalCurrent = minFraction;
      finalNext = (startSizes[index] + startSizes[index + 1]) - minFraction;
    }
    if (finalNext < minFraction) {
      finalNext = minFraction;
      finalCurrent = (startSizes[index] + startSizes[index + 1]) - minFraction;
    }

    const newSizes = [...startSizes];
    newSizes[index] = finalCurrent;
    newSizes[index + 1] = finalNext;

    // Apply immediately to DOM
    updateGridStyles(newSizes, type);

    // Update divider visual position to follow mouse exactly
    updateDividerPosition(type, index, percentPos);
    
    // Store current sizes for next frame
    dragInfo.current.currentSizes = newSizes;
  }, [updateGridStyles, updateDividerPosition]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    pendingMouseEvent.current = e;
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(processMouseMove);
    }
  }, [processMouseMove]);

  const handleMouseUp = useCallback(() => {
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    pendingMouseEvent.current = null;

    if (!dragInfo.current) return;

    const { type, index, currentSizes } = dragInfo.current;

    if (type === "col") {
      setColSizes([...currentSizes]);
    } else {
      setRowSizes([...currentSizes]);
    }

    const refs = type === "col" ? colHandleRefs : rowHandleRefs;
    const handle = refs.current[index];
    if (handle) {
      const line = handle.querySelector(".divider-line") as HTMLElement;
      if (line) {
        line.classList.remove("bg-red-500");
        line.classList.add("bg-neutral-600/40", "group-hover:bg-red-500/70");
      }
    }

    dragInfo.current = null;
    setIsDragging(false);
  }, []);

  // Setup global mouse events
  useEffect(() => {
    if (!isDragging) return;

    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Cancel any pending RAF on cleanup
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const resetSizes = () => {
    if (layout === "stage") {
      const bottomRowCount = gridRows - 1;
      setColSizes(Array(gridCols).fill(1));
      setRowSizes(bottomRowCount > 0 ? [2, ...Array(bottomRowCount).fill(1)] : [3]);
    } else {
      setColSizes(Array(gridCols).fill(1));
      setRowSizes(Array(gridRows).fill(1));
    }
  };

  // Generate grid template strings
  const gridTemplateColumns = effectiveColSizes.map(s => `${s}fr`).join(" ");
  const gridTemplateRows = effectiveRowSizes.map(s => `${s}fr`).join(" ");

  // Get displayed streams based on layout
  // Always returns array with valid stream items
  const getDisplayedStreams = (): Array<{ url: string; index: number }> => {
    const safeStreamUrls = Array.isArray(streamUrls) ? streamUrls : [];
    const safeActiveCount = Math.max(0, activeCount || 0);
    const safeStageIndex = Math.max(0, Math.min(stageIndex, safeActiveCount - 1));
    
    if (layout === "grid") {
      return safeStreamUrls
        .slice(0, safeActiveCount)
        .map((url, index) => ({ url: url || "", index }));
    }
    
    // Stage layout: stage stream first, then remaining streams
    const allStreams = safeStreamUrls
      .slice(0, safeActiveCount)
      .map((url, index) => ({ url: url || "", index }));
    
    if (allStreams.length === 0) return [];
    
    const stageStream = allStreams[safeStageIndex] || allStreams[0];
    const otherStreams = allStreams.filter((_, i) => i !== safeStageIndex);
    return [stageStream, ...otherStreams];
  };

  // Check if an index is the stage position
  const isStagePosition = (displayIndex: number) => {
    return layout === "stage" && displayIndex === 0;
  };

  // Get original index from display position
  const getOriginalIndex = (displayIndex: number): number => {
    const safeDisplayIndex = Math.max(0, displayIndex);
    const safeActiveCount = Math.max(0, activeCount || 0);
    const safeStageIndex = Math.max(0, Math.min(stageIndex, safeActiveCount - 1));
    
    if (layout === "grid") return safeDisplayIndex;
    if (safeDisplayIndex === 0) return safeStageIndex;
    
    // Map display index back to original index
    const allIndices = Array.from({ length: safeActiveCount }, (_, i) => i);
    const otherIndices = allIndices.filter(i => i !== safeStageIndex);
    const resultIndex = otherIndices[safeDisplayIndex - 1];
    
    return typeof resultIndex === "number" ? resultIndex : safeDisplayIndex;
  };

  // "+0.30s" / "-1.00s" / "0.00s" — always 2 decimals with an explicit sign so the readout doesn't jump width as it changes
  const formatOffset = (seconds: number): string => {
    const safeSeconds = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
    const rounded = Math.round(safeSeconds * 100) / 100;
    if (rounded === 0) return "0.00s";
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}s`;
  };

  if (!mounted) {
    return (
      <main className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="text-neutral-400">Loading...</div>
      </main>
    );
  }

  const displayedStreams = getDisplayedStreams();

  return (
    <main className="h-screen w-screen bg-black flex flex-col overflow-hidden">
      {/* Minimal Header */}
      <header className="bg-neutral-900/90 border-b border-neutral-800 px-4 py-2 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-white">Stream MultiView</h1>
          <span className="text-xs text-neutral-500">
            {activeCount} stream{activeCount !== 1 ? "s" : ""}
          </span>
          {layout === "stage" && (
            <span className="text-xs px-2 py-0.5 bg-purple-600/30 text-purple-400 rounded">
              Stage Mode
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Layout Selector */}
          <div className="relative">
            <button
              onClick={() => setShowLayoutMenu(!showLayoutMenu)}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-medium rounded transition-colors flex items-center gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
              Layout
            </button>
            {showLayoutMenu && (
              <div className="absolute right-0 top-full mt-2 w-48 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 p-2">
                <button
                  onClick={() => switchLayout("grid")}
                  className={`w-full px-3 py-2 text-left text-xs rounded transition-colors flex items-center gap-2 ${
                    layout === "grid" ? "bg-neutral-700 text-white" : "text-neutral-300 hover:bg-neutral-700"
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                  </svg>
                  Grid (Equal)
                </button>
                <button
                  onClick={() => switchLayout("stage")}
                  className={`w-full px-3 py-2 text-left text-xs rounded transition-colors flex items-center gap-2 mt-1 ${
                    layout === "stage" ? "bg-purple-600/30 text-purple-400" : "text-neutral-300 hover:bg-neutral-700"
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="10"></rect>
                    <rect x="3" y="16" width="5" height="5"></rect>
                    <rect x="9.5" y="16" width="5" height="5"></rect>
                    <rect x="16" y="16" width="5" height="5"></rect>
                  </svg>
                  Stage + Grid
                </button>
              </div>
            )}
          </div>

          {(colSizes.length > 0 || rowSizes.length > 0) && (
            <button
              onClick={resetSizes}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-medium rounded transition-colors"
            >
              Reset Layout
            </button>
          )}
          <button
            onClick={handleTogglePlayAll}
            disabled={!apiReady}
            className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 disabled:opacity-40 disabled:cursor-not-allowed text-indigo-400 text-xs font-medium rounded transition-colors border border-indigo-600/30 flex items-center gap-1.5"
            title={apiReady ? undefined : "Waiting for YouTube player to load…"}
          >
            {isPlayingAll ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            )}
            {isPlayingAll ? "Pause All" : "Play All"}
          </button>
          {/* Global Seek + Speed */}
          <div className="relative">
            <button
              onClick={() => setShowPlaybackMenu(!showPlaybackMenu)}
              disabled={!apiReady}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors flex items-center gap-1.5"
              title={apiReady ? undefined : "Waiting for YouTube player to load…"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <polyline points="12 7 12 12 15 15"></polyline>
              </svg>
              {playbackRate === 1 ? "Speed" : `${playbackRate}x`}
            </button>
            {showPlaybackMenu && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 p-3">
                <div className="text-[10px] font-medium text-neutral-400 uppercase tracking-wide mb-1.5">
                  Seek all streams
                </div>
                <div className="grid grid-cols-4 gap-1.5 mb-3">
                  <button
                    onClick={() => handleSeekAll(-5)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors"
                    title="Rewind all streams 5 seconds"
                  >
                    −5s
                  </button>
                  <button
                    onClick={() => handleSeekAll(-1)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors"
                    title="Rewind all streams 1 second"
                  >
                    −1s
                  </button>
                  <button
                    onClick={() => handleSeekAll(1)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors"
                    title="Fast-forward all streams 1 second"
                  >
                    +1s
                  </button>
                  <button
                    onClick={() => handleSeekAll(5)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors"
                    title="Fast-forward all streams 5 seconds"
                  >
                    +5s
                  </button>
                </div>
                <div className="text-[10px] font-medium text-neutral-400 uppercase tracking-wide mb-1.5">
                  Playback speed
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[0.5, 0.75, 1, 1.5].map((rate) => (
                    <button
                      key={rate}
                      onClick={() => handleSetPlaybackRate(rate)}
                      className={`px-2 py-1.5 text-xs rounded transition-colors ${
                        playbackRate === rate
                          ? "bg-indigo-600/30 text-indigo-300 border border-indigo-600/50"
                          : "bg-neutral-700 hover:bg-neutral-600 text-white"
                      }`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={handleRefresh}
            className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs font-medium rounded transition-colors border border-blue-600/30 flex items-center gap-1.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            Refresh
          </button>
          <div className="relative">
            <button
              onClick={() => setShowShareDialog(!showShareDialog)}
              className="px-3 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 text-xs font-medium rounded transition-colors border border-green-600/30 flex items-center gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
              Share
            </button>
            {showShareDialog && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-white">Share this layout</span>
                  <button
                    onClick={() => setShowShareDialog(false)}
                    className="text-neutral-400 hover:text-white"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={typeof window !== "undefined" ? window.location.href : ""}
                    readOnly
                    className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-300 truncate"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(window.location.href);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="px-2 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 rounded transition-colors"
                    title="Copy to clipboard"
                  >
                    {copied ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    )}
                  </button>
                </div>
                <p className="text-[10px] text-neutral-500 mt-2">
                  Anyone with this link can view these streams with your exact layout.
                </p>
              </div>
            )}
          </div>
          <button
            onClick={handleBack}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-medium rounded transition-colors"
          >
            Edit
          </button>
        </div>
      </header>

      {/* Stream Grid Container */}
      <div className="flex-1 relative">
        {/* Vertical Resize Handles */}
        {gridCols > 1 && (
          <div className="absolute inset-0 pointer-events-none z-20">
            {Array.from({ length: gridCols - 1 }, (_, i) => {
              const leftPercent = getDividerPosition(effectiveColSizes, i);
              
              // In stage mode, vertical dividers should only span the bottom grid area
              const isStageMode = layout === "stage";
              const firstRowHeightPercent = isStageMode && effectiveRowSizes.length > 0
                ? (effectiveRowSizes[0] / effectiveRowSizes.reduce((a, b) => a + b, 0)) * 100
                : 0;
              
              return (
                <div
                  key={`v-${i}`}
                  ref={el => { colHandleRefs.current[i] = el; }}
                  className="absolute bottom-0 w-6 -ml-3 cursor-col-resize pointer-events-auto group z-30 transition-none"
                  style={{ 
                    left: `${leftPercent}%`,
                    top: isStageMode ? `${firstRowHeightPercent}%` : '0%',
                  }}
                  onMouseDown={(e) => handleResizeStart("col", i, e)}
                  onKeyDown={(e) => handleResizeKeyDown("col", i, e)}
                  tabIndex={0}
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(leftPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  title="Drag to resize. Use arrow keys to adjust."
                >
                  <div className="divider-line absolute inset-y-4 left-1/2 -translate-x-1/2 w-1.5 rounded-full bg-neutral-600/40 group-hover:bg-red-500/70 transition-colors" />
                </div>
              );
            })}
          </div>
        )}

        {/* Horizontal Resize Handles */}
        {gridRows > 1 && (
          <div className="absolute inset-0 pointer-events-none z-20">
            {Array.from({ length: gridRows - 1 }, (_, i) => {
              const topPercent = getDividerPosition(effectiveRowSizes, i);
              
              return (
                <div
                  key={`h-${i}`}
                  ref={el => { rowHandleRefs.current[i] = el; }}
                  className="absolute left-0 right-0 h-6 -mt-3 cursor-row-resize pointer-events-auto group z-30 transition-none"
                  style={{ top: `${topPercent}%` }}
                  onMouseDown={(e) => handleResizeStart("row", i, e)}
                  onKeyDown={(e) => handleResizeKeyDown("row", i, e)}
                  tabIndex={0}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-valuenow={Math.round(topPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  title="Drag to resize. Use arrow keys to adjust."
                >
                  <div className="divider-line absolute inset-x-4 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-neutral-600/40 group-hover:bg-red-500/70 transition-colors" />
                </div>
              );
            })}
          </div>
        )}

        {/* Stream Grid */}
        <div 
          ref={gridRef}
          className="w-full h-full grid gap-1"
          style={{
            gridTemplateColumns,
            gridTemplateRows,
          }}
        >
          {displayedStreams.map((streamItem, displayIndex) => {
            const originalIndex = getOriginalIndex(displayIndex);
            const url = streamItem?.url || "";
            const videoId = extractVideoId(url);
            const isActive = url.trim() !== "" && videoId.length > 0;
            const isStage = isStagePosition(displayIndex);

            return (
              <div
                key={originalIndex}
                className={`relative bg-neutral-900 overflow-hidden ${
                  isStage ? "col-span-full" : ""
                }`}
                style={{
                  gridColumn: isStage ? `1 / -1` : undefined,
                }}
              >
                {isActive ? (
                  <iframe
                    ref={el => {
                      if (originalIndex >= 0) {
                        iframeRefs.current[originalIndex] = el;
                      }
                    }}
                    src={getEmbedUrl(videoId)}
                    title={`Stream ${originalIndex + 1}`}
                    className="w-full h-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    style={{ border: "none" }}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-neutral-600">
                    <div className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center mb-2">
                      <span className="text-lg font-bold text-neutral-500">
                        {originalIndex + 1}
                      </span>
                    </div>
                    <span className="text-xs">No stream</span>
                  </div>
                )}

                {/* Stream Label */}
                <div className="absolute top-2 left-2 px-2 py-1 flex items-center gap-2">
                  <span className="text-xs font-medium text-white drop-shadow-lg">
                    {originalIndex + 1}
                    {isActive && (
                      <span className="ml-1.5 w-1.5 h-1.5 bg-red-500 rounded-full inline-block animate-pulse" />
                    )}
                  </span>
                  {layout === "stage" && !isStage && isActive && (
                    <button
                      onClick={() => moveToStage(originalIndex)}
                      className="text-[10px] px-1.5 py-0.5 text-purple-300 hover:text-white transition-all opacity-[0.625] hover:opacity-100 drop-shadow-lg"
                      title="Move to stage"
                    >
                      → Stage
                    </button>
                  )}
                  {layout === "stage" && isStage && (
                    <span className="text-[10px] px-1.5 py-0.5 text-purple-400 drop-shadow-lg">
                      Stage
                    </span>
                  )}
                </div>

                {/* Audio source selector — exactly one stream may be unmuted at a time */}
                {isActive && (
                  <button
                    onClick={() => toggleAudioSource(originalIndex)}
                    disabled={!apiReady}
                    className={`absolute top-2 right-2 text-xs px-1.5 py-1 rounded transition-all drop-shadow-lg disabled:cursor-not-allowed ${
                      effectiveActiveAudioIndex === originalIndex
                        ? "text-green-400 opacity-100"
                        : "text-neutral-300 opacity-50 hover:opacity-100"
                    }`}
                    title={
                      effectiveActiveAudioIndex === originalIndex
                        ? "Mute this stream"
                        : "Make this the audio source"
                    }
                  >
                    {effectiveActiveAudioIndex === originalIndex ? "🔊" : "🔇"}
                  </button>
                )}

                {/* Custom playback-time readout — YouTube's own is hidden (controls=0 in getEmbedUrl) to remove misclick-prone controls */}
                {isActive && (
                  <span
                    ref={(el) => { timeDisplayRefs.current[originalIndex] = el; }}
                    className="absolute bottom-2 right-2 text-xs text-neutral-300 tabular-nums drop-shadow-lg pointer-events-none"
                  />
                )}

                {/* Manual alignment offset — nudge this stream's playhead relative to the sync reference */}
                {isActive && (
                  <div className="absolute bottom-2 left-2 flex items-center gap-1 text-neutral-300 opacity-60 hover:opacity-100 transition-opacity drop-shadow-lg">
                    <button
                      onClick={() => adjustOffset(originalIndex, -1)}
                      className="px-2.5 py-1.5 text-xs bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 1 second earlier"
                    >
                      −1s
                    </button>
                    <button
                      onClick={() => adjustOffset(originalIndex, -0.1)}
                      className="px-2.5 py-1.5 text-xs bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 0.1 second earlier"
                    >
                      −.1
                    </button>
                    <button
                      onClick={() => adjustOffset(originalIndex, -0.01)}
                      className="px-1 py-1 text-[10px] bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 0.01 second earlier"
                    >
                      −.01
                    </button>
                    <span className="px-1 min-w-[3.5em] text-center text-[10px] tabular-nums">
                      {formatOffset(effectiveOffsets[originalIndex] ?? 0)}
                    </span>
                    <button
                      onClick={() => adjustOffset(originalIndex, 0.01)}
                      className="px-1 py-1 text-[10px] bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 0.01 second later"
                    >
                      +.01
                    </button>
                    <button
                      onClick={() => adjustOffset(originalIndex, 0.1)}
                      className="px-2.5 py-1.5 text-xs bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 0.1 second later"
                    >
                      +.1
                    </button>
                    <button
                      onClick={() => adjustOffset(originalIndex, 1)}
                      className="px-2.5 py-1.5 text-xs bg-black/50 hover:bg-black/70 rounded"
                      title="Shift 1 second later"
                    >
                      +1s
                    </button>
                    <button
                      onClick={() => handleUseAsBaseline(originalIndex)}
                      disabled={(effectiveOffsets[originalIndex] ?? 0) === 0}
                      className="px-1.5 py-1.5 text-[10px] bg-purple-900/50 hover:bg-purple-700/70 disabled:opacity-40 disabled:cursor-not-allowed text-purple-300 rounded"
                      title="Use this stream's current position as the baseline (rebases every offset — doesn't move any playback)"
                    >
                      Base
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Global cursor style during drag */}
      {isDragging && (
        <style jsx global>{`
          body {
            cursor: col-resize !important;
            user-select: none !important;
          }
        `}</style>
      )}

    </main>
  );
}
