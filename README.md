# Acton PDF Compressor

Standalone **fallback** PDF compression API for the [Acton BR Library](https://acton-br-library.vercel.app) app.

The frontend optimizes PDFs locally first when the user selects **Compress PDF**. This API is called **only when the locally optimized file is still too large** (over ~20 MB). It preserves image quality as much as possible while getting under the email size limit — it is **not** an aggressive file crusher.

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
- `X-Compression-Preset` (`prepress-300`, `printer-300`, `printer-250`, etc.)
- `X-Compression-DPI` (e.g. `300`, `250`, `225`, or `default`)
- `X-All-Candidates` (summary of every attempt; `*` marks the selected file)
- `X-Compression-Warning` (only if the result is under 10 MB or over 20 MB)

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

This API is a **quality-preserving fallback compressor**. It generates multiple candidate PDFs and returns the **largest / highest-quality version under 20 MB** — never the smallest.

**Role in the app:**

1. User clicks **Compress PDF** in Acton BR Library.
2. The browser compresses the PDF locally first.
3. If the result is still over ~20 MB, the app sends it here for a second pass.
4. This API picks the best-quality output that fits under 20 MB.

**Targets:**

- Preferred range: **10–18 MB**
- Hard max: **under 20 MB**
- Avoid outputs under **10 MB** unless no better candidate exists

**Candidates** (always runs 1–7; runs `/screen` only if none of 1–7 are under 20 MB):

| Step | Preset      | DPI     | Mode          |
|------|-------------|---------|---------------|
| 1    | `/prepress` | 300     | High quality  |
| 2    | `/printer`  | 300     | High quality  |
| 3    | `/printer`  | 250     | High quality  |
| 4    | `/printer`  | 200     | High quality  |
| 5    | `/ebook`    | 225     | High quality  |
| 6    | `/ebook`    | 200     | High quality  |
| 7    | `/ebook`    | 150     | More aggressive |
| 8    | `/screen`   | default | Last resort only |

**Selection rules:**

1. Collect every candidate’s file size.
2. Prefer the **largest** file in the **10–18 MB** range.
3. If none in that range, pick the **largest file under 20 MB**.
4. Never pick `/screen` if any other candidate is under 20 MB.
5. If all candidates are below 10 MB, pick the largest and set `X-Compression-Warning`.
6. If every candidate is over 20 MB, return the smallest and set `X-Compression-Warning`.

High-quality candidates use bicubic downsampling and only reduce images above the target DPI. Fallback presets use more aggressive downsampling.

**Response headers:**

- `X-All-Candidates` — compact summary of every preset/DPI/size (`*` = selected)
- `X-Compression-Warning` — set when the result is under 10 MB or over 20 MB

Server logs show original size, each candidate, the selected file, and any warning.

> **Note:** Multiple Ghostscript passes can take several minutes for large PDFs. This is expected for a fallback path used only when local compression was insufficient.

Upload limit: **200 MB**.
