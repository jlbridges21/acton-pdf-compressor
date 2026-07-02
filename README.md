# Acton PDF Compressor

Standalone **fallback** PDF compression API for the [Acton BR Library](https://acton-br-library.vercel.app) app.

The frontend optimizes PDFs locally first when the user selects **Compress PDF**. This API is called **only when the locally optimized file is still too large** (over ~20 MB). It uses a fast two-pass Ghostscript strategy — not multi-candidate generation.

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
- `X-Compression-Preset` (`printer` or `ebook`)
- `X-Compression-DPI` (`200` or `175`)
- `X-Compression-Passes` (`1` or `2`)

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

The frontend compresses PDFs locally first. Set this URL as the **fallback** when local compression is not enough:

```
VITE_COMPRESS_API_URL=https://YOUR-RENDER-SERVICE-NAME.onrender.com/compress-pdf
```

If you use `COMPRESS_API_SECRET`, the frontend must also send the `x-compress-api-secret` header with the same value.

---

## How compression works

Fast **two-pass max** strategy — speed and reliability over exact file-size targeting.

**Role in the app:** fallback when the Acton BR Library frontend’s local compression is still over ~20 MB.

| Pass | When | Preset | DPI |
|------|------|--------|-----|
| 1 — Primary | Always | `/printer` | 200 |
| 2 — Fallback | Only if pass 1 is still over 20 MB | `/ebook` | 175 |

**Rules:**

- Maximum **2 Ghostscript passes** per request — no multi-candidate generation
- No `/screen` preset
- Under **20 MB** is acceptable; no exact 12 MB targeting
- `/printer` at 200 DPI balances quality and speed better than aggressive multi-preset runs

**Response headers:** `X-Compression-Passes` shows `1` or `2`.

Server logs show original size, primary output size, whether fallback was used, final size, and total processing time.

Upload limit: **200 MB**.
