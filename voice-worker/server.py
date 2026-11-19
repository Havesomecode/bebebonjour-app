"""Bébé Bonjour voice worker: speaks one phrase per request with VoxCPM2 on CPU.

POST /speak  {"voice": "pere"|"mere", "language": "fr"|"ar", "text": "<one phrase>"}
  Authorization: Bearer $VOICE_WORKER_TOKEN
  -> 200 audio/mpeg (MPEG-1 Layer III, 48 kHz mono CBR, no ID3/Xing frame)
GET /health -> 200 once the model is loaded.

Each voice is a stored synthetic reference clip (data/voices) plus its delivery
prompt, generated exactly like the samples the owner chose: reference WAV +
"(delivery)text", cfg 2.0, 10 timesteps, fixed seed per phrase. One phrase is
generated at a time; concurrent requests wait on the lock.
"""
import hmac
import json
import os
import re
import resource
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from voxcpm import VoxCPM

VOICES_DIR = os.environ.get("VOICES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voices"))
MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "/models/VoxCPM2")
TOKEN = os.environ.get("VOICE_WORKER_TOKEN", "")
MAX_TEXT = 600

settings = json.load(open(os.path.join(VOICES_DIR, "voices.json"), encoding="utf-8"))
ENGINE = settings["engine"]
lock = threading.Lock()
model = None
sample_rate = None


def log(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def peak_rss_mb():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


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
        model = VoxCPM.from_pretrained(model_dir(), load_denoiser=False, optimize=False, device="cpu", local_files_only=True)
    finally:
        torch.set_default_dtype(default_dtype)
    sample_rate = model.tts_model.sample_rate
    log(event="loaded", seconds=round(time.time() - started, 1), sample_rate=sample_rate, threads=torch.get_num_threads(),
        dtype=os.environ.get("VOXCPM_DTYPE") or "bfloat16", peak_rss_mb=peak_rss_mb(), anon_rss_mb=anon_rss_mb(), **cpu_features())


def encode_mp3(wav):
    pcm = np.clip(np.asarray(wav, dtype=np.float32).squeeze(), -1.0, 1.0).tobytes()
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
         "-codec:a", "libmp3lame", "-b:a", "128k", "-ar", "48000", "-ac", "1",
         "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1", "-f", "mp3", "pipe:1"],
        input=pcm, capture_output=True, check=True)
    return result.stdout


def speak(voice, language, text):
    entry = settings["voices"][voice][language]
    reference = os.path.join(VOICES_DIR, entry["reference"])
    with lock:
        torch.manual_seed(entry["seed"])
        np.random.seed(entry["seed"])
        started = time.time()
        with torch.inference_mode():
            wav = model.generate(
                text=f"({entry['delivery']}){text}",
                cfg_value=ENGINE["cfg_value"],
                inference_timesteps=ENGINE["inference_timesteps"],
                max_len=min(4096, max(256, len(text) * 6)),
                retry_badcase=False,
                retry_badcase_max_times=1,
                reference_wav_path=reference,
            )
        seconds = time.time() - started
    wav = np.asarray(wav, dtype=np.float32).squeeze()
    audio_seconds = len(wav) / sample_rate
    log(event="spoke", voice=voice, language=language, chars=len(text), generation_s=round(seconds, 2),
        audio_s=round(audio_seconds, 2), rtf=round(seconds / max(audio_seconds, 0.01), 2), peak_rss_mb=peak_rss_mb(), anon_rss_mb=anon_rss_mb())
    return encode_mp3(wav), seconds, audio_seconds


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
    if not text or len(text) > MAX_TEXT:
        return None
    return voice, language, text


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

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, json.dumps({"ok": model is not None, "model": f"{ENGINE['model']}@{ENGINE['revision']}", "peak_rss_mb": peak_rss_mb()}).encode())
        self.error(404, "not_found")

    def do_POST(self):
        if self.path != "/speak":
            return self.error(404, "not_found")
        supplied = self.headers.get("authorization", "")
        if len(TOKEN) < 32 or not hmac.compare_digest(supplied.encode(), f"Bearer {TOKEN}".encode()):
            return self.error(401, "unauthorized")
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > 8192:
            return self.error(400, "invalid_request")
        request = parse(self.rfile.read(length))
        if not request:
            return self.error(400, "invalid_request")
        try:
            audio, seconds, audio_seconds = speak(*request)
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
    load()
    port = int(os.environ.get("PORT", "8080"))
    log(event="listening", port=port)
    Server(("::", port), Handler).serve_forever()
