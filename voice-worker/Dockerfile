# Bébé Bonjour voice worker, built from the repo root.
# CPU (default):  docker build -f voice-worker/Dockerfile .
# NVIDIA GPU:     docker build -f voice-worker/Dockerfile --build-arg TORCH_BACKEND=cu130 .  (run with VOICE_DEVICE=cuda)
FROM python:3.12-slim-bookworm
ARG TORCH_BACKEND=cpu
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.14
WORKDIR /app
COPY voice-worker/requirements.lock voice-worker/requirements.lock
# The lock pins CPU wheels. A CUDA build takes the same torch release from that backend
# (cu130 publishes torchaudio 2.11.0, not 2.11.1).
RUN lock=voice-worker/requirements.lock; \
    if [ "$TORCH_BACKEND" != cpu ]; then \
      sed -E -e 's/^(torch|torchcodec)==([0-9.]+)\+cpu$/\1==\2/' -e 's/^torchaudio==.*$/torchaudio==2.11.0/' $lock > /tmp/requirements.lock; lock=/tmp/requirements.lock; \
    fi; \
    uv pip install --system --no-cache --torch-backend "$TORCH_BACKEND" -r $lock
# openbmb/VoxCPM2, Apache-2.0, pinned revision baked into the image.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('openbmb/VoxCPM2', revision='7936080b41163874f38610f46f438e2c0757f9fd', local_dir='/models/VoxCPM2')"
COPY data/voices data/voices
COPY voice-worker/server.py voice-worker/server.py
ENV VOXCPM_MODEL_DIR=/models/VoxCPM2 HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 MALLOC_ARENA_MAX=2
CMD ["python", "-I", "-X", "faulthandler", "voice-worker/server.py"]
