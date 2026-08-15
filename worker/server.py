"""
Local HTTP job queue for automatic audio-sync detection.

Meant to run on your own machine, not a cloud VPS — see download.py's and
align.py's module docstrings for why (yt-dlp bot-detection risk; job runtime
of tens of seconds to a few minutes doesn't fit a serverless function's
execution-time limits or need a persistent disk anyway).

Run with: uvicorn server:app --port 8787
(or `python3 server.py`, which does the same thing.)

The frontend (src/lib/auto-sync-client.ts) POSTs a job, then polls it:

    POST /jobs   {videoIds: string[], referenceIndex: number}
      -> {jobId: string}

    GET /jobs/{jobId}
      -> {status, videoIds, referenceIndex, offsets, confidences, error, progress}

`offsets[i]` is null until the job finishes, and stays null for any stream
whose alignment didn't reach CONFIDENCE_THRESHOLD — the frontend is expected
to only auto-apply non-null offsets and flag the rest for manual alignment,
per the plan's explicit requirement that a confident-but-wrong answer is
worse than an honest failure.
"""

from __future__ import annotations

import shutil
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import align
from download import DownloadError, download_audio

app = FastAPI(title="stream-multiview auto-sync worker")

# This worker only ever runs on localhost for personal use — there's no
# deployment where a browser on some other origin should be allowed to hit
# it, but there's also no sensitive data or state-changing action beyond
# "download some public YouTube audio and run some math on it", so an open
# CORS policy is a reasonable trade against hardcoding a frontend port that
# might change.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

JobStatus = Literal["pending", "downloading", "aligning", "done", "error"]


@dataclass
class JobState:
    video_ids: list[str]
    reference_index: int
    status: JobStatus = "pending"
    progress: str = ""
    offsets: list[float | None] | None = None
    confidences: list[float | None] | None = None
    titles: list[str | None] | None = None
    error: str | None = None


JOBS: dict[str, JobState] = {}
EXECUTOR = ThreadPoolExecutor(max_workers=2)  # a job is mostly I/O (download) then a burst of CPU (align); 2 lets one download while another aligns


class CreateJobRequest(BaseModel):
    videoIds: list[str]
    referenceIndex: int = 0


class CreateJobResponse(BaseModel):
    jobId: str


class JobResponse(BaseModel):
    status: JobStatus
    videoIds: list[str]
    referenceIndex: int
    progress: str
    offsets: list[float | None] | None
    confidences: list[float | None] | None
    titles: list[str | None] | None
    error: str | None


@app.post("/jobs", response_model=CreateJobResponse)
def create_job(req: CreateJobRequest) -> CreateJobResponse:
    if len(req.videoIds) < 2:
        raise HTTPException(400, "need at least 2 videoIds to align")
    if not (0 <= req.referenceIndex < len(req.videoIds)):
        raise HTTPException(400, "referenceIndex out of range")

    job_id = uuid.uuid4().hex
    JOBS[job_id] = JobState(video_ids=req.videoIds, reference_index=req.referenceIndex)
    EXECUTOR.submit(_run_job, job_id)
    return CreateJobResponse(jobId=job_id)


@app.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str) -> JobResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown jobId")
    return JobResponse(
        status=job.status,
        videoIds=job.video_ids,
        referenceIndex=job.reference_index,
        progress=job.progress,
        offsets=job.offsets,
        confidences=job.confidences,
        titles=job.titles,
        error=job.error,
    )


def _run_job(job_id: str) -> None:
    job = JOBS[job_id]
    work_dir = Path(tempfile.mkdtemp(prefix=f"stream-multiview-sync-{job_id}-"))

    try:
        job.status = "downloading"
        titles: list[str | None] = [None] * len(job.video_ids)
        audio: list = [None] * len(job.video_ids)

        for i, video_id in enumerate(job.video_ids):
            job.progress = f"downloading {i + 1}/{len(job.video_ids)} ({video_id})"
            try:
                result = download_audio(video_id, work_dir)
            except DownloadError as e:
                job.status = "error"
                job.error = f"failed to download {video_id}: {e}"
                return
            titles[i] = result.title
            audio[i] = align.load_audio(str(result.path))
            # Free disk as we go — decoded PCM is already in memory, and a
            # 20-minute source file isn't worth keeping around.
            result.path.unlink(missing_ok=True)

        job.titles = titles

        job.status = "aligning"
        reference_audio = audio[job.reference_index]
        offsets: list[float | None] = [None] * len(job.video_ids)
        confidences: list[float | None] = [None] * len(job.video_ids)
        offsets[job.reference_index] = 0.0

        for i, other_audio in enumerate(audio):
            if i == job.reference_index:
                continue
            job.progress = f"aligning {i + 1}/{len(job.video_ids)}"
            result = align.align_video(reference_audio, other_audio, sample_rate=align.SAMPLE_RATE)
            confidences[i] = result.confidence
            if result.is_confident:
                offsets[i] = result.lag_seconds

        job.offsets = offsets
        job.confidences = confidences
        job.status = "done"
        job.progress = "done"

    except Exception as e:  # noqa: BLE001 — a job failure must never crash the worker process or hang the frontend's poll forever
        job.status = "error"
        job.error = f"unexpected error: {e}"

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
