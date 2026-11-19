# Voice worker

Speaks one announcement phrase per call with VoxCPM2 (`openbmb/VoxCPM2` @ `7936080b`, `voxcpm==2.0.3`) on CPU. It runs as the Railway `voice` service; the delivery loop reaches it at `BEBEBONJOUR_VOICE_WORKER_URL` with `BEBEBONJOUR_VOICE_WORKER_TOKEN` and calls it one phrase at a time.

```
POST /speak   {"voice": "pere"|"mere", "language": "fr"|"ar", "text": "<one phrase>", "seed"?: int}
              Authorization: Bearer <VOICE_WORKER_TOKEN>   ->  audio/mpeg (48 kHz mono, no ID3/Xing)
GET  /health
```

## Voices

`data/voices/voices.json` holds the owner's choice ("Père, chaleureux", "Mère, douce") in French and Arabic: a synthetic reference clip designed from a text description (nobody is cloned), its transcript, a delivery prompt and a seed.

- **Sentences** are spoken as `(delivery)text` with the reference clip as the voice.
- **One- or two-word phrases** (the name reveal) are spoken in continuation mode: the model carries on from the voice's own reference clip. Spoken alone, the père voice garbled names ("Bayane" heard as "Ariane").
- **Loudness**: `gain_db` brings every voice to about -21 dB mean with a limiter, so the whispered père voice is as audible as the mère voice.
- A phrase that runs to its length cap never stopped by itself; it is re-rolled with the next seed, up to three tries.

## Railway sizing

8 vCPU / 8 GB. Measured on staging (AMD EPYC, bf16): load 11 s, about 5.9 GB anonymous memory while speaking, 2.9× real time, so a 35–40 s narration takes about 100–120 s per language. `MALLOC_ARENA_MAX=2`, a single inference thread and `malloc_trim` after each phrase keep memory flat; without them the service hit its 8 GB limit.

Deploy: `railway up -s voice` from a folder holding `voice-worker/` and `data/voices/` (`RAILWAY_DOCKERFILE_PATH=voice-worker/Dockerfile`). The image bakes in the model weights.
