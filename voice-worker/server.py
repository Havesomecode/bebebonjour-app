"""Bébé Bonjour voice worker: speaks one phrase per request with VoxCPM2 on CPU.

POST /speak  {"voice": "pere"|"mere", "language": "fr"|"ar", "text": "<one phrase>", "seed"?: int}
  Authorization: Bearer $VOICE_WORKER_TOKEN
  -> 200 audio/mpeg (MPEG-1 Layer III, 48 kHz mono CBR, no ID3/Xing frame)
GET /health -> 200 once the model is loaded.

Each voice is a stored synthetic reference clip (data/voices) plus its delivery
prompt, generated exactly like the samples the owner chose: reference WAV +
"(delivery)text", cfg 2.0, 10 timesteps, fixed seed per phrase. One phrase is
generated at a time, always on the same thread: concurrent requests queue.
"""
import ctypes
import gc
import hmac
import json
import os
import re
import resource
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from voxcpm import VoxCPM

VOICES_DIR = os.environ.get("VOICES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voices"))
MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "/models/VoxCPM2")
TOKEN = os.environ.get("VOICE_WORKER_TOKEN", "")
MAX_TEXT = 600
DEVICE = os.environ.get("VOICE_DEVICE", "cpu")
if DEVICE not in ("cpu", "cuda"):
    raise ValueError("VOICE_DEVICE must be cpu or cuda")
IDLE_UNLOAD_S = float(os.environ.get("VOICE_IDLE_UNLOAD_S", "300"))
READY_SAMPLES = max(1, int(os.environ.get("VOICE_READY_SAMPLES", "3")))
READY_MAX_UTIL = float(os.environ.get("VOICE_READY_MAX_UTIL", "30"))
READY_MIN_FREE_MB = float(os.environ.get("VOICE_READY_MIN_FREE_MB", "6000"))

settings = json.load(open(os.path.join(VOICES_DIR, "voices.json"), encoding="utf-8"))
ENGINE = settings["engine"]
# One inference thread: glibc gives each new thread its own malloc arena, and torch
# buffers left in per-request arenas pushed an 8 GB service out of memory.
inference = ThreadPoolExecutor(max_workers=1)
libc = ctypes.CDLL("libc.so.6")
model = None
sample_rate = None
state_lock = threading.Lock()
pending = 0
last_speak = time.monotonic()


def sample_gpu():
    output = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.free,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True, timeout=5).stdout
    values = output.splitlines()[0].split(",")
    return tuple(float(value.strip()) for value in values)


def readiness():
    with state_lock:
        busy = pending > 0
        loaded = model is not None
    result = dict(ready=True, reason="ok", device=DEVICE, loaded=loaded, busy=busy, free_mb=None, total_mb=None, util_percent=None)
    if DEVICE == "cpu":
        return result
    if busy:
        result["reason"] = "busy_with_narration"
        return result
    try:
        samples = []
        for i in range(READY_SAMPLES):
            if i:
                time.sleep(1)
            samples.append(sample_gpu())
        util = max(s[0] for s in samples)
        free = min(s[1] for s in samples)
        total = min(s[2] for s in samples)
        with state_lock:
            busy = pending > 0
            loaded = model is not None
            reserved = torch.cuda.memory_reserved() / 2**20 if loaded else 0
        result.update(busy=busy, loaded=loaded, free_mb=round(free + reserved), total_mb=round(total), util_percent=util)
        if busy:
            result["reason"] = "busy_with_narration"
        elif util > READY_MAX_UTIL:
            result.update(ready=False, reason="gpu_busy")
        elif free + reserved < READY_MIN_FREE_MB:
            result.update(ready=False, reason="gpu_memory_low")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, RuntimeError):
        result.update(ready=False, reason="gpu_unavailable")
    return result


def unload_if_idle():
    global model, sample_rate
    with state_lock:
        if pending or model is None or time.monotonic() - last_speak < IDLE_UNLOAD_S:
            return
        model = None
        sample_rate = None
        gc.collect()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
    log(event="unloaded")


def idle_monitor():
    while True:
        time.sleep(min(IDLE_UNLOAD_S, 10))
        inference.submit(unload_if_idle)


def queued_speak(request):
    global pending, last_speak
    try:
        if model is None:
            load()
        return speak(*request)
    finally:
        with state_lock:
            pending -= 1
            last_speak = time.monotonic()


def log(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def peak_rss_mb():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


def cgroup_mb():
    """Memory the container is charged for (anon + page cache), as the platform's limit sees it."""
    try:
        return round(int(open("/sys/fs/cgroup/memory.current").read()) / 2**20)
    except (OSError, ValueError):
        return None


class PeakAnon:
    """Samples anonymous memory while a phrase is generated: the per-phrase peak is what can hit the limit."""

    def __enter__(self):
        self.peak, self.stop = anon_rss_mb() or 0, threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)
        self.thread.start()
        return self

    def watch(self):
        while not self.stop.wait(0.1):
            self.peak = max(self.peak, anon_rss_mb() or 0)

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join()


def anon_rss_mb():
    """Anonymous memory: what the service's memory limit really charges (the weights file itself is mmapped)."""
    try:
        return round(next(int(line.split()[1]) for line in open("/proc/self/status") if line.startswith("RssAnon")) / 1024)
    except (OSError, StopIteration):
        return None


def model_dir():
    """The checkpoint runs in bfloat16, which is fast only on CPUs with native bf16
    (avx512_bf16/AMX). VOXCPM_DTYPE=float32 loads the same weights in float32 through
    an overlay directory with a patched config."""
    dtype = os.environ.get("VOXCPM_DTYPE", "").strip()
    if not dtype:
        return MODEL_DIR
    overlay = "/tmp/voxcpm-model-" + dtype
    os.makedirs(overlay, exist_ok=True)
    for name in os.listdir(MODEL_DIR):
        target = os.path.join(overlay, name)
        if name != "config.json" and not os.path.lexists(target):
            os.symlink(os.path.join(MODEL_DIR, name), target)
    config = json.load(open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8"))
    config["dtype"] = dtype
    json.dump(config, open(os.path.join(overlay, "config.json"), "w", encoding="utf-8"))
    return overlay


def cpu_features():
    try:
        flags = next(line for line in open("/proc/cpuinfo") if line.startswith("flags")).split()
        model_name = next(line for line in open("/proc/cpuinfo") if line.startswith("model name")).split(":", 1)[1].strip()
    except (OSError, StopIteration):
        return {}
    return {"cpu": model_name, "avx512_bf16": "avx512_bf16" in flags, "amx_bf16": "amx_bf16" in flags, "os_cpus": os.cpu_count()}


def load():
    global model, sample_rate
    torch.set_num_threads(int(os.environ.get("VOICE_THREADS", "8")))
    started = time.time()
    # voxcpm builds the model in float32 (~9 GB) before casting it to the checkpoint
    # dtype, which overflows an 8 GB service. Building it directly in that dtype gives
    # the same weights (they are loaded afterwards) with half the peak memory.
    default_dtype = torch.get_default_dtype()
    torch.set_default_dtype(getattr(torch, os.environ.get("VOXCPM_DTYPE") or "bfloat16"))
    try:
        model = VoxCPM.from_pretrained(model_dir(), load_denoiser=False, optimize=False, device=DEVICE, local_files_only=True)
    finally:
        torch.set_default_dtype(default_dtype)
    sample_rate = model.tts_model.sample_rate
    log(event="loaded", seconds=round(time.time() - started, 1), sample_rate=sample_rate, threads=torch.get_num_threads(),
        dtype=os.environ.get("VOXCPM_DTYPE") or "bfloat16", peak_rss_mb=peak_rss_mb(), anon_rss_mb=anon_rss_mb(), **(cpu_features() if DEVICE == "cpu" else {"gpu_reserved_mb": round(torch.cuda.memory_reserved() / 2**20)}))


def encode_mp3(wav, gain_db):
    pcm = np.clip(np.asarray(wav, dtype=np.float32).squeeze(), -1.0, 1.0).tobytes()
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
         "-af", f"volume={gain_db}dB,alimiter=limit=0.89:level=disabled",
         "-codec:a", "libmp3lame", "-b:a", "128k", "-ar", "48000", "-ac", "1",
         "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1", "-f", "mp3", "pipe:1"],
        input=pcm, capture_output=True, check=True)
    return result.stdout


def trim_phrase(wav, rate, threshold_db=-50.0, lead_s=0.15, gap_s=1.0):
    """Return (wav, longest_internal_silence_s).

    The delivery loop switches screens at each phrase start, so a phrase must start on
    its voice: continuation mode (bare names) can open on ~1 s of low noise. The lead
    kept (150 ms) covers the soft start of a name; 50 ms clipped "Youssef" to "Be safe".
    The longest silence inside the speech lets the caller spot a missed stop token.
    """
    frame = max(1, int(rate * 0.01))
    usable = len(wav) // frame * frame
    if not usable:
        return wav, 0.0
    loud = np.sqrt(np.mean(np.square(wav[:usable].reshape(-1, frame)), axis=1)) > 10 ** (threshold_db / 20)
    spoken = np.nonzero(loud)[0]
    if not len(spoken):
        return wav, 0.0
    longest = quiet = 0
    for index in range(spoken[0], spoken[-1] + 1):
        quiet = 0 if loud[index] else quiet + 1
        longest = max(longest, quiet)
    return wav[max(0, spoken[0] * frame - int(lead_s * rate)):], round(longest * frame / rate, 2)


def speak(voice, language, text, seed=None):
    entry = settings["voices"][voice][language]
    seed = entry["seed"] if seed is None else seed
    reference = os.path.join(VOICES_DIR, entry["reference"])
    # Each generation step is 0.16 s of audio. A phrase that runs to max_len never
    # produced its stop token: it is babbling past the text. Cap it close to the text
    # length (a runaway also overflowed the 8 GB service) and re-roll the seed.
    # A silence of 1 s or more inside a phrase is the other sign of a missed stop
    # token (pause, then babble; natural pauses measured <= 0.7 s): re-roll too, and
    # if every attempt has one, keep the attempt with the shortest. Words are never cut.
    max_len = 20 + int(1.5 * len(text))
    short = len(text.split()) <= 2
    started = time.time()
    if DEVICE == "cuda":
        torch.cuda.reset_peak_memory_stats()
    memory = PeakAnon().__enter__()
    best = None
    for attempt in range(3):
        torch.manual_seed(seed + attempt)
        np.random.seed(seed + attempt)
        with torch.inference_mode():
            wav = model.generate(
                text=text if short else f"({entry['delivery']}){text}",
                # Spoken alone, a bare name comes out garbled; continuing from the
                # voice's own reference clip says it cleanly in the same voice.
                **({"prompt_wav_path": reference, "prompt_text": entry["reference_text"]} if short else {}),
                cfg_value=ENGINE["cfg_value"],
                inference_timesteps=ENGINE["inference_timesteps"],
                max_len=max_len,
                retry_badcase=False,
                retry_badcase_max_times=1,
                reference_wav_path=reference,
            )
        wav = np.asarray(wav, dtype=np.float32).squeeze()
        if len(wav) / sample_rate >= (max_len - 1) * 0.16:
            log(event="runaway", voice=voice, language=language, seed=seed + attempt, chars=len(text))
            continue
        wav, gap = trim_phrase(wav, sample_rate)
        if best is None or gap < best[1]:
            best = (wav, gap, attempt)
        if gap < 1.0:
            break
        log(event="long_pause", voice=voice, language=language, seed=seed + attempt, seconds=gap)
    if best is None:
        best = (trim_phrase(wav, sample_rate)[0], 0.0, attempt)
    wav, _, attempt = best
    seconds = time.time() - started
    memory.__exit__()
    audio_seconds = len(wav) / sample_rate
    gc.collect()
    libc.malloc_trim(0)
    log(event="spoke", voice=voice, language=language, seed=seed + attempt, attempts=attempt + 1, chars=len(text), generation_s=round(seconds, 2),
        audio_s=round(audio_seconds, 2), rtf=round(seconds / max(audio_seconds, 0.01), 2), phrase_peak_anon_mb=memory.peak, cgroup_mb=cgroup_mb(), **({"gpu_peak_mb": round(torch.cuda.max_memory_allocated() / 2**20), "gpu_reserved_mb": round(torch.cuda.max_memory_reserved() / 2**20)} if DEVICE == "cuda" else {}))
    return encode_mp3(wav, entry["gain_db"]), seconds, audio_seconds


def parse(body):
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    voice, language, text = data.get("voice"), data.get("language"), data.get("text")
    if voice not in settings["voices"] or language not in ("fr", "ar") or not isinstance(text, str):
        return None
    # A leading "(...)" is VoxCPM's control syntax: spoken text never carries parentheses.
    text = " ".join(re.sub(r"[()]", " ", text).split())
    seed = data.get("seed")
    if not text or len(text) > MAX_TEXT or (seed is not None and (type(seed) is not int or not 0 <= seed < 2**31)):
        return None
    return voice, language, text, seed


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, code):
        self.reply(status, json.dumps({"error": code}).encode())

    def authorized(self):
        supplied = self.headers.get("authorization", "")
        return len(TOKEN) >= 32 and hmac.compare_digest(supplied.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, json.dumps({"ok": True, "loaded": model is not None, "model": f"{ENGINE['model']}@{ENGINE['revision']}", "peak_rss_mb": peak_rss_mb()}).encode())
        if self.path == "/ready":
            if not self.authorized():
                return self.error(401, "unauthorized")
            return self.reply(200, json.dumps(readiness()).encode())
        self.error(404, "not_found")

    def do_POST(self):
        if self.path != "/speak":
            return self.error(404, "not_found")
        if not self.authorized():
            return self.error(401, "unauthorized")
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > 8192:
            return self.error(400, "invalid_request")
        request = parse(self.rfile.read(length))
        if not request:
            return self.error(400, "invalid_request")
        global pending, last_speak
        with state_lock:
            pending += 1
            last_speak = time.monotonic()
        try:
            audio, seconds, audio_seconds = inference.submit(queued_speak, request).result()
        except Exception as exc:  # noqa: BLE001 - report a stable code, log the detail
            log(event="failed", error=type(exc).__name__, detail=str(exc)[:300])
            return self.error(500, "synthesis_failed")
        self.reply(200, audio, "audio/mpeg", {"x-generation-seconds": f"{seconds:.2f}", "x-audio-seconds": f"{audio_seconds:.2f}", "x-peak-rss-mb": str(peak_rss_mb()), "x-anon-rss-mb": str(anon_rss_mb())})


class Server(ThreadingHTTPServer):
    address_family = __import__("socket").AF_INET6
    daemon_threads = True

    def server_bind(self):
        import socket
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == "__main__":
    if len(TOKEN) < 32:
        sys.exit("VOICE_WORKER_TOKEN must be at least 32 characters")
    if IDLE_UNLOAD_S > 0:
        threading.Thread(target=idle_monitor, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    log(event="listening", port=port)
    Server(("::", port), Handler).serve_forever()
