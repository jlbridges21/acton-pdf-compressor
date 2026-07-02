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
- `X-Compression-Preset` (`printer`, `ebook-225`, `ebook-150`, or `screen`)
- `X-Compression-DPI` (e.g. `300`, `225`, `150`, or `default`)
- `X-Compression-Warning` (only if the file could not be brought under 20 MB)

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

Compression **prioritizes image quality first**. The API does not blindly shrink files as small as possible.

**Target:** around **12 MB** when possible (roughly 10–14 MB). **12 MB is a goal, not a guaranteed exact size.** Anything under **20 MB** is acceptable if quality is better.

**Strategy** — try these Ghostscript settings in order, stopping at the **least aggressive** preset that produces a file under 20 MB:

| Step | Preset    | DPI   | When used                                      |
|------|-----------|-------|------------------------------------------------|
| 1    | `/printer` | 300   | High quality — use if result is under 20 MB    |
| 2    | `/ebook`   | 225   | Medium-high — only if step 1 is still over 20 MB |
| 3    | `/ebook`   | 150   | Medium — only if steps 1–2 are still over 20 MB |
| 4    | `/screen`  | default | Aggressive fallback — only if all above are still over 20 MB |

**Selection rules:**

- Prefer a **larger** file under 20 MB over a tiny file with worse quality.
- Avoid results below **8 MB** unless the source is already small or there is no better option.
- If every candidate is still over 20 MB, return the smallest result and set `X-Compression-Warning`.

Server logs show the original size, each preset/DPI attempt, candidate sizes, and which version was selected.

Upload limit: **200 MB**.
