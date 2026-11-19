# Bébé Bonjour voice worker (Railway service "voice", built from the repo root:
# RAILWAY_DOCKERFILE_PATH=voice-worker/Dockerfile).
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.14
WORKDIR /app
COPY voice-worker/requirements.lock voice-worker/requirements.lock
RUN uv pip install --system --no-cache --torch-backend cpu -r voice-worker/requirements.lock
# openbmb/VoxCPM2, Apache-2.0, pinned revision baked into the image.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('openbmb/VoxCPM2', revision='7936080b41163874f38610f46f438e2c0757f9fd', local_dir='/models/VoxCPM2')"
COPY data/voices data/voices
COPY voice-worker/server.py voice-worker/server.py
ENV VOXCPM_MODEL_DIR=/models/VoxCPM2 HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 MALLOC_ARENA_MAX=2
CMD ["python", "-I", "-X", "faulthandler", "voice-worker/server.py"]
