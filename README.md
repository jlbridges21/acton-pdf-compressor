# Acton PDF Compressor

Standalone backend API that compresses large PDF presentations (e.g. from the Acton BR Library app) into email-friendly sizes using Ghostscript.

**Production URL pattern:** `https://YOUR-RENDER-SERVICE-NAME.onrender.com`

---

## Endpoints

| Method | Path            | Description                    |
|--------|-----------------|--------------------------------|
| GET    | `/health`       | Health check                   |
| POST   | `/compress-pdf` | Upload and compress a PDF      |

---

## Run locally

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Ghostscript](https://www.ghostscript.com/) installed on your machine

**Install Ghostscript:**

```bash
# macOS
brew install ghostscript

# Ubuntu / Debian
sudo apt-get install ghostscript
```

### Start the server

```bash
npm install
npm run dev
```

The API listens on `http://localhost:3000` (or `PORT` if set).

---

## Test `/health`

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok", "service": "Acton PDF Compressor" }
```

---

## Test `/compress-pdf` with curl

```bash
curl -X POST http://localhost:3000/compress-pdf \
  -F "file=@/path/to/your/presentation.pdf" \
  -o Acton-BR-Presentation-Email-Ready.pdf \
  -D -
```

The `-D -` flag prints response headers so you can see:

- `X-Original-Size-MB`
- `X-Compressed-Size-MB`
- `X-Compression-Preset` (`ebook` or `screen`)

If `COMPRESS_API_SECRET` is set, add the header:

```bash
curl -X POST http://localhost:3000/compress-pdf \
  -H "x-compress-api-secret: YOUR_SECRET" \
  -F "file=@/path/to/your/presentation.pdf" \
  -o Acton-BR-Presentation-Email-Ready.pdf
```

---

## Deploy to Render

1. Push this repository to GitHub.
2. In [Render](https://render.com), create a **New Web Service**.
3. Connect your GitHub repo.
4. Set **Environment** to **Docker** (Render will use the included `Dockerfile`, which installs Ghostscript automatically).
5. Configure environment variables (see below).
6. Deploy.

After deploy, your service will be available at:

- Health: `https://YOUR-RENDER-SERVICE-NAME.onrender.com/health`
- Compress: `https://YOUR-RENDER-SERVICE-NAME.onrender.com/compress-pdf`

> **Important:** Use Docker on Render — Ghostscript is installed by the Dockerfile, not by Render's default Node build.

---

## Environment variables

| Variable              | Required | Description |
|-----------------------|----------|-------------|
| `PORT`                | No       | Server port. Render sets this automatically. Defaults to `3000`. |
| `ALLOWED_ORIGINS`     | No       | Comma-separated CORS origins. If unset, all origins are allowed (local dev). Example: `https://acton-br-library.vercel.app` |
| `COMPRESS_API_SECRET` | No       | If set, requests must include header `x-compress-api-secret` with this value. Simple shared-secret protection — not a full auth system. |

**Example production values on Render:**

```
ALLOWED_ORIGINS=https://acton-br-library.vercel.app
COMPRESS_API_SECRET=your-long-random-secret-here
```

---

## Connect to the Acton BR Library frontend

In the Acton BR Library app's environment (e.g. Vercel), set:

```
VITE_COMPRESS_API_URL=https://YOUR-RENDER-SERVICE-NAME.onrender.com/compress-pdf
```

If you use `COMPRESS_API_SECRET`, the frontend must also send the `x-compress-api-secret` header with the same value.

---

## How compression works

1. Upload is saved to a temporary file.
2. Ghostscript compresses with `/ebook` preset at **300 dpi** (good quality, ~12 MB target for large decks).
3. If the result is still over **12 MB**, Ghostscript retries with `/screen` (smaller, lower quality).
4. The compressed PDF is returned as a download.
5. Temporary files are deleted after the response is sent.

Upload limit: **200 MB**.
# acton-pdf-compressor
