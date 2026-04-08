FROM rust:slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libasound2-dev libssl-dev build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install librespot --features "alsa-backend" --locked

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 libssl3 alsa-utils curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY entrypoint.sh api.py relay.py ./
RUN chmod +x entrypoint.sh
RUN mkdir -p /tmp/audio /data/tokens
EXPOSE 5050
ENTRYPOINT ["/app/entrypoint.sh"]
