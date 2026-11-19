# Voice worker

Speaks one announcement phrase per call with VoxCPM2 (`openbmb/VoxCPM2` @ `7936080b`, `voxcpm==2.0.3`). Production runs on the gamer tower on the LAN, not Railway. The delivery loop reaches it at `BEBEBONJOUR_VOICE_WORKER_URL` with `BEBEBONJOUR_VOICE_WORKER_TOKEN`.

Build GPU image from the repository root: `docker build -f voice-worker/Dockerfile --build-arg TORCH_BACKEND=cu130 -t bebe-voice .`. Run with `--gpus all -e VOICE_DEVICE=cuda -e NVIDIA_DRIVER_CAPABILITIES=compute,utility`, a private `VOICE_WORKER_TOKEN`, and a LAN port mapping. CPU is the default (`VOICE_DEVICE=cpu`). The model loads on the first speak and unloads after `VOICE_IDLE_UNLOAD_S` idle seconds (default 300; 0 disables).

Authenticated `GET /ready` returns JSON `{ready, reason, device, loaded, busy, free_mb, total_mb, util_percent}`. CPU is ready; CUDA uses `nvidia-smi` samples (`VOICE_READY_SAMPLES`, default 3, one second apart), requiring utilization at most `VOICE_READY_MAX_UTIL` (15 percent) and available memory at least `VOICE_READY_MIN_FREE_MB` (6000 MB), including this worker's reserved memory. Reasons are `ok`, `busy_with_narration`, `gpu_busy`, `gpu_memory_low`, or `gpu_unavailable`; unavailable metrics are null. Queued/running narration is considered ready. `/health` is unauthenticated and reports `loaded` without loading the model.

```
POST /speak   {"voice": "pere"|"mere", "language": "fr"|"ar", "text": "<one phrase>", "seed"?: int}
              Authorization: Bearer <VOICE_WORKER_TOKEN>   ->  audio/mpeg (48 kHz mono, no ID3/Xing)
GET  /health
```

## Voices

`data/voices/voices.json` holds the owner's choice ("Père, chaleureux", "Mère, douce") in French and Arabic: a synthetic reference clip designed from a text description (nobody is cloned), its transcript, a delivery prompt and a seed.

- **Sentences** are spoken as `(delivery)text` with the reference clip as the voice.
- **One- or two-word phrases** (the name reveal) are spoken in continuation mode: the model carries on from the voice's own reference clip. Spoken alone, the père voice garbled names ("Bayane" heard as "Ariane").
- **Each phrase starts on its voice**: leading near-silence is trimmed to 150 ms, so screens switch as the words begin (continuation mode opened the name reveal on up to 1.2 s of noise; a 50 ms lead clipped the soft start of "Youssef"). A silence of 1 s or more inside a phrase means a missed stop token (pause, then babble; natural pauses measured ≤ 0.7 s): the phrase is re-rolled with the next seed, up to 3 attempts, keeping the one with the shortest pause (`long_pause` in the log). Words are never cut.
- **Loudness**: `gain_db` brings every voice to about -21 dB mean with a limiter, so the whispered père voice is as audible as the mère voice.
- A phrase that runs to its length cap never stopped by itself; it is re-rolled with the next seed, up to three tries.

## Railway CPU measurement (historical)

8 vCPU / 8 GB. Measured on staging (19/11/2026, bf16, one Bayane announcement, fr + ar, 9 phrases each):

| Voice | Narration audio | Generation time | Peak worker memory (anon) |
| --- | --- | --- | --- |
| Père | 37.9 s fr + 37.0 s ar | 107 s + 103 s (2.8× real time) | 7.1 GB |
| Mère | 41.1 s fr + 42.4 s ar | 112 s + 119 s (2.8× real time) | 7.1 GB |

About 3.5–4 minutes of voice work per announcement. The model takes 5.6 GB at rest; each `spoke` log line carries `generation_s`, `rtf` and `phrase_peak_anon_mb`. `MALLOC_ARENA_MAX=2`, a single inference thread and `malloc_trim` after each phrase keep memory flat; without them the service hit its 8 GB limit.

The image bakes in the model weights. The delivery loop can wake the tower using Wake-on-LAN and waits for readiness before claiming narrated work.
