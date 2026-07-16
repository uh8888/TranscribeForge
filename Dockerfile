FROM node:20-alpine

# ffmpeg + Python venv for yt-dlp (musl-safe approach)
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --quiet yt-dlp bgutil-ytdlp-pot-provider

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
