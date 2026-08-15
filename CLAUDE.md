# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stream MultiView — a Next.js 16 / React 19 app that lets a user watch up to 12 YouTube live streams at once in a security-camera-style grid, with draggable panel resizing and a "Stage" (spotlight + grid) layout mode. There is no backend, database, or API route — everything runs client-side; the only "server" logic is Next.js rendering the two pages.

> A local-only automatic audio-sync feature (downloads stream audio, detects alignment via cross-correlation) exists on branch `feat/auto-audio-sync-worker` and is **intentionally never merged here** — it needs a separate Python process (yt-dlp/ffmpeg/numpy/scipy) that can't run in this app's deployment target, and running it anywhere but the user's own machine defeats the point (see that branch's CLAUDE.md/`worker/README.md` for why). `main` is the actively-developed app; that branch is a standing, occasionally-rebased add-on for local use only.

## Commands

Package manager is **bun** — do not use npm or yarn.

```bash
bun install         # install dependencies
bun build            # production build
bun start            # start production server
bun lint             # ESLint (flat config, extends eslint-config-next)
bun typecheck        # tsc --noEmit
```

There is no test suite in this repo.

**Do not run `bun dev` / `next dev`** — in the sandbox this project is normally developed in, the dev server is started automatically outside of Claude Code's control.

Before considering a change complete, run `bun typecheck && bun lint`.

## Architecture

The whole app is two client-rendered pages sharing state through a React Context — there is no server state.

- `src/app/page.tsx` — setup page (`/`). Lets the user pick a stream count (1–12) and paste YouTube URLs into per-stream inputs, validates/extracts video IDs, then pushes to `/viewer`.
- `src/app/viewer/page.tsx` — the viewer (`/viewer`), a single large client component (~900 lines) that owns almost all app logic: grid dimension calculation, the drag-to-resize system, Stage-layout stream promotion, and shareable-URL sync. Read this file in full before touching viewer behavior — the logic is intentionally centralized here rather than split into subcomponents.
- `src/lib/stream-context.tsx` — `StreamProvider`/`useStreams()`, a React Context (mounted in `layout.tsx` around the whole app) holding `streamCount` and `streamUrls`. This is deliberately soft/in-memory persistence: state survives client-side navigation between `/` and `/viewer` but is wiped on a hard refresh (by design, not a bug).
- `src/lib/share-utils.ts` — `extractVideoId()` parses the several YouTube URL formats (`youtube.com/live/…`, `watch?v=…`, `youtu.be/…`, `youtube.com/embed/…`) into a bare video ID, always returning `""` rather than null/undefined on failure. `encodeStreamData`/`decodeStreamData` serialize a `StreamData` (`videoIds`, `colSizes`, `rowSizes`, `offsets`, `layout`, `stageIndex`) to/from a shareable string: JSON → zlib deflate (`pako`) → URL-safe base64 (`+`/`/`/`=` replaced). Both directions sanitize aggressively so a decoded value is always well-typed — never trust `parsed.*` fields as-is when extending this. `offsets` is the one field that may legitimately be empty even on a well-formed link — it was added after `videoIds`/`colSizes`/etc., so a link shared before it existed decodes to `offsets: []` rather than erroring; callers pad missing per-stream entries with 0 (see `effectiveOffsets` in the viewer).
- `src/lib/sync-controller.ts` — loads the YouTube IFrame Player API (`loadYouTubeIframeApi()`, idempotent script injection) and the `SyncController` class, which owns a registry of `YT.Player` instances keyed by original stream index and provides unified play/pause, single-audio-source muting, manual per-stream offset nudges (`nudgePlayer`), and interval-based drift correction against a reference player (`setOffsets`/internal `getOffsetSeconds` feed both).

### Shareable-URL flow

The viewer's actual source of truth when a link is shared is the URL, not the Context. On mount, `parseSharedDataFromUrl()` reads `?data=` synchronously (avoiding `useSearchParams`), and a one-time effect (guarded by a `hasRestored` ref) pushes the decoded streams/layout/sizes into the Context state. After that, a separate effect calls `syncUrlToState()` on every relevant state change to keep `?data=` (via `history.replaceState`, not a navigation) in sync with the live layout — so the address bar always reflects a reproducible snapshot of the current view.

### Grid + resize model

- Grid dimensions (`cols`/`rows`) are derived from the active stream count via `getGridDimensions`/`getBottomGridDimensions` (1→1×1, 2→2×1, 3–4→2×2, 5–6→3×2, 7–9→3×3, 10+→4×3). In Stage layout, the stage takes its own top row and the remaining streams get the same bottom-grid formula.
- Panel sizes are `fr`-unit arrays (`colSizes`/`rowSizes`) applied to `grid-template-columns/rows`. `effectiveColSizes`/`effectiveRowSizes` always pad/trim these to the current grid shape so state never has to exactly match the active layout.
- Dragging a divider is deliberately kept out of React's render loop for smooth 60fps behavior: `handleResizeStart` captures drag context into a ref, `handleMouseMove` batches into `requestAnimationFrame`, and `processMouseMove` writes new sizes straight to the grid/divider DOM nodes via refs. React state (`colSizes`/`rowSizes`) is only committed once, in `handleMouseUp`. Keyboard resizing (arrow keys on a focused divider) instead goes straight through normal `setColSizes`/`setRowSizes`, since it doesn't need per-frame DOM writes.
- Stage-layout index mapping: `stageIndex` refers to the original stream index promoted to the stage. `getDisplayedStreams()`/`getOriginalIndex()` convert between "display position in the grid" and "original stream index" — keep both in sync when changing how streams are ordered or promoted.

### YouTube player / sync lifecycle (viewer page)

`viewer/page.tsx` binds one `YT.Player` per **original stream index** (not per grid display position) directly onto the existing `<iframe>` DOM nodes already tracked in `iframeRefs` — no extra element ids or `document.getElementById` calls. Because grid panels are keyed by `originalIndex`, a player survives Stage promotion/layout changes without being destroyed and recreated; it only gets torn down when that index's video ID actually goes away (`SyncController.unregisterPlayer`) or on page unmount (`destroyAll`).

Player creation is driven by a `videoIdsByIndex` memo, not by the display-order `getDisplayedStreams()` — keep new logic that touches player lifecycle keyed off `videoIdsByIndex`/original index too, or it will silently create/destroy players on every Stage promotion. `handleRefresh` prefers `SyncController.reloadVideo()` (via `loadVideoById`) over mutating `iframe.src` directly once a player exists, since the Player API owns the iframe's internal postMessage channel at that point.

Audio is single-source by design (`activeAudioIndex` state + `SyncController.setActiveAudio`): every player stays muted except the one the user explicitly picks, mirroring the pre-existing `mute=1` default in `getEmbedUrl()`. Drift correction runs on a 5s interval and only hard-seeks a player when it has drifted more than 1s from the reference (the current audio source, or the lowest-index registered player if none is picked) — don't lower that threshold without checking for seek/rebuffering stutter, per the comment in `sync-controller.ts`.

### Manual per-stream offsets

`offsets` (state in the viewer, padded to the active count via `effectiveOffsets`) records how many seconds each original stream index should lead the drift-correction reference by — used when streams started recording at different real times and need manual alignment. Two distinct operations, easy to conflate:

- **`adjustOffset` (±0.01s/±0.1s/±1s buttons)** updates that index's entry in `offsets` *and* calls `SyncController.nudgePlayer(index, delta)`, which seeks *only that player*, by `delta`, from its own current position — deliberately not relative to whatever the current drift-correction reference is. This is what makes clicking "+1s" on a panel always visibly move that exact panel, even when it happens to currently be the reference itself (seeking a player relative to itself is a no-op, which would silently swallow the click). The ±0.01s buttons are deliberately smaller/lower-emphasis than ±0.1s/±1s in the JSX — they're for occasional fine correction, not the primary click target, which is why only the latter two got sized up for easier clicking.
- **"Base" (`handleUseAsBaseline`)** rebases every stream's offset by subtracting the clicked stream's current offset from all of them, so that one reads `0.00s`. It intentionally seeks nothing — a rebase only renames which stream is "the zero point"; the on-screen alignment before and after is identical. If you're debugging "Base did nothing to the video," that's correct, not a bug.

Both paths call `SyncController.setOffsets(effectiveOffsets)` directly (not just through the `useEffect` that also mirrors `effectiveOffsets` into the controller) so the controller's next drift-correction tick sees the edit immediately rather than one render late.

### Global seek + playback speed

The header's "Speed" dropdown (`showPlaybackMenu`) holds two unrelated-but-grouped controls, both applied to every stream at once via `SyncController`:

- **`handleSeekAll` → `SyncController.seekAllBy(delta)`**: ±1s/±5s, each player seeks from its own current position. Unlike per-panel offset nudges, this doesn't touch `offsets` — it's a temporary joint skip (e.g. "everyone skip the intro"), not a realignment.
- **`handleSetPlaybackRate` → `SyncController.setPlaybackRateAll(rate)`**: 0.5x/0.75x/1x/1.5x. The controller remembers the chosen rate (`private playbackRate`) and reapplies it whenever a player becomes ready (`createPlayer`'s `onReady`) or reloads a video (`reloadVideo`, i.e. the Refresh button) — both operations otherwise silently reset a player back to 1x. If you add another way to (re)create or reload a player, reapply `playbackRate` there too. YouTube only honors values from `player.getAvailablePlaybackRates()` (typically 0.25–2 in fixed steps); passing an arbitrary rate is silently ignored by the API rather than erroring.

### YouTube's native controls are deliberately hidden

`getEmbedUrl()` sets `controls=0&disablekb=1` — every panel's play/pause, scrubber, "more videos", share, and save/collect buttons are gone on purpose, to eliminate misclicks on a grid of up to 12 iframes sitting right next to each other; this app already has its own play/pause (header), seek (offset row/global seek), and refresh. Removing `controls=0` un-hides all of that as a side effect, not just the one button you're trying to bring back — there's no YouTube param for partial control visibility.

The one piece of native UI worth keeping — the current-time/duration readout — is rebuilt separately as plain text (`timeDisplayRefs`, formatted by the module-level `formatClockTime`), driven by a `setInterval` polling `SyncController.getPlaybackTime(index)` every 500ms and writing straight to the DOM, not through React state — with up to 12 panels ticking multiple times a second, routing that through re-renders would cost real performance for a value nothing else in the component reads, the same reasoning `processMouseMove`'s direct DOM writes use during drag-resize.

## Conventions

- Path alias `@/*` → `src/*` (see `tsconfig.json`).
- TypeScript strict mode is on; `share-utils.ts` in particular relies on defensive parsing (arrays/numbers are always filtered/validated before use) rather than assuming decoded or Context data is well-formed — follow that pattern when touching encode/decode or restore logic, since this data can come from an arbitrary shared URL.
- Both pages are `"use client"` — there are currently no Server Components doing real work in this app; keep that in mind before assuming SSR data-fetching patterns apply.
