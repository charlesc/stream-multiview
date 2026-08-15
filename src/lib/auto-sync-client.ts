/**
 * HTTP client for the local auto-sync worker (worker/server.py) — a
 * separate Python process you run yourself alongside `bun dev`/`bun start`,
 * not a Next.js API route. See worker/README.md for why it has to be a
 * standalone process: yt-dlp + ffmpeg + numpy/scipy aren't things a
 * Next.js/Vercel deployment can run, and a single alignment job can take
 * tens of seconds to a few minutes — well past what a serverless function
 * is built for.
 */

const DEFAULT_WORKER_URL = "http://localhost:8787";

function workerUrl(): string {
  return process.env.NEXT_PUBLIC_SYNC_WORKER_URL || DEFAULT_WORKER_URL;
}

export type JobStatus = "pending" | "downloading" | "aligning" | "done" | "error";

export interface JobState {
  status: JobStatus;
  videoIds: string[];
  referenceIndex: number;
  progress: string;
  /** Seconds each stream should lead the reference by. null = not confident enough to auto-apply (per index; the reference itself is always 0). */
  offsets: (number | null)[] | null;
  /** z-score per index; null for the reference (nothing to score it against). */
  confidences: (number | null)[] | null;
  titles: (string | null)[] | null;
  error: string | null;
}

export class WorkerUnreachableError extends Error {
  constructor() {
    super(
      `Can't reach the auto-sync worker at ${workerUrl()}. It's a separate local process — ` +
      `run \`python3 worker/server.py\` (see worker/README.md) and try again.`
    );
    this.name = "WorkerUnreachableError";
  }
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${workerUrl()}${path}`, init);
  } catch {
    throw new WorkerUnreachableError();
  }
}

export async function createAutoSyncJob(videoIds: string[], referenceIndex: number): Promise<string> {
  const res = await fetchWorker("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoIds, referenceIndex }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to start detection job (${res.status}): ${body || res.statusText}`);
  }
  const data = await res.json();
  return data.jobId as string;
}

export async function getAutoSyncJob(jobId: string): Promise<JobState> {
  const res = await fetchWorker(`/jobs/${jobId}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch job status (${res.status}): ${body || res.statusText}`);
  }
  return (await res.json()) as JobState;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Polls a job until it reaches "done" or "error", calling `onUpdate` after
 * every poll (including the terminal one) so the caller can render progress.
 * Returns the final state. `signal`, if given, stops polling (the promise
 * simply never resolves further; callers should race it against their own
 * abort handling, e.g. by ignoring the eventual resolution after cancel).
 */
export async function pollAutoSyncJob(
  jobId: string,
  onUpdate: (state: JobState) => void,
  signal?: AbortSignal
): Promise<JobState> {
  while (true) {
    const state = await getAutoSyncJob(jobId);
    onUpdate(state);
    if (state.status === "done" || state.status === "error") {
      return state;
    }
    if (signal?.aborted) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
