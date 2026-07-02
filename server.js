const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

// Under 20 MB is email-friendly; fallback runs only if primary pass exceeds this
const MAX_ACCEPTABLE_BYTES = 20 * 1024 * 1024;
// 200 MB upload limit
const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024;

const GS_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes per pass

const OUTPUT_FILENAME = "Acton-BR-Presentation-Email-Ready.pdf";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const corsOptions = {
  origin(origin, callback) {
    // No ALLOWED_ORIGINS → allow all (handy for local dev)
    if (!allowedOriginsEnv) {
      return callback(null, true);
    }
    const allowed = allowedOriginsEnv
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    // Non-browser clients (curl, server-to-server) send no Origin header
    if (!origin || allowed.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  },
};
app.use(cors(corsOptions));

// ---------------------------------------------------------------------------
// Optional API secret (simple shared-secret check — not full authentication)
// Set COMPRESS_API_SECRET in production to require the x-compress-api-secret
// header on every request. If unset, the API is open (fine for local testing).
// ---------------------------------------------------------------------------
const apiSecret = process.env.COMPRESS_API_SECRET;

function requireApiSecret(req, res, next) {
  if (!apiSecret) {
    return next();
  }
  const provided = req.headers["x-compress-api-secret"];
  if (!provided || provided !== apiSecret) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid x-compress-api-secret header.",
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Multer — store uploads in the OS temp directory
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename(_req, file, cb) {
      const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
      cb(null, `upload-${unique}${path.extname(file.originalname) || ".pdf"}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return cb(new Error("Only PDF files are accepted."));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build Ghostscript args — preset plus explicit image DPI settings. */
function buildGsArgs(inputPath, outputPath, preset, dpi) {
  return [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${preset}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    "-dDownsampleColorImages=true",
    `-dColorImageResolution=${dpi}`,
    "-dDownsampleGrayImages=true",
    `-dGrayImageResolution=${dpi}`,
    "-dDownsampleMonoImages=true",
    `-dMonoImageResolution=${dpi}`,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];
}

async function compressPdf(inputPath, outputPath, preset, dpi) {
  await execFileAsync("gs", buildGsArgs(inputPath, outputPath, preset, dpi), {
    timeout: GS_TIMEOUT_MS,
  });
}

async function getFileSizeBytes(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

function bytesToMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/** Remove temp files quietly — errors are logged but not thrown. */
async function cleanupFiles(...paths) {
  await Promise.all(
    paths.map(async (p) => {
      if (!p) return;
      try {
        await fs.unlink(p);
      } catch {
        // File may already be gone
      }
    })
  );
}

/**
 * Fast two-pass compression (max 2 Ghostscript runs):
 * 1. Primary: /printer at 200 DPI — good quality, usually fast enough
 * 2. Fallback: /ebook at 175 DPI — only if primary is still over 20 MB
 */
async function compressPdfTwoPass(inputPath, workDir) {
  const start = Date.now();
  const originalSize = await getFileSizeBytes(inputPath);
  console.log(`[compress] Original size: ${bytesToMb(originalSize)} MB`);

  const primaryPath = path.join(workDir, `primary-${crypto.randomBytes(6).toString("hex")}.pdf`);
  let fallbackPath = null;

  try {
    console.log("[compress] Primary pass: /printer at 200 DPI");
    await compressPdf(inputPath, primaryPath, "/printer", 200);
    const primarySize = await getFileSizeBytes(primaryPath);
    console.log(`[compress] Primary output: ${bytesToMb(primarySize)} MB`);

    let outputPath = primaryPath;
    let preset = "printer";
    let dpi = 200;
    let passes = 1;
    let compressedSize = primarySize;
    let fallbackUsed = false;

    if (primarySize > MAX_ACCEPTABLE_BYTES) {
      fallbackUsed = true;
      fallbackPath = path.join(workDir, `fallback-${crypto.randomBytes(6).toString("hex")}.pdf`);
      console.log("[compress] Still over 20 MB — fallback pass: /ebook at 175 DPI");
      await compressPdf(inputPath, fallbackPath, "/ebook", 175);
      compressedSize = await getFileSizeBytes(fallbackPath);
      console.log(`[compress] Fallback output: ${bytesToMb(compressedSize)} MB`);
      await cleanupFiles(primaryPath);
      outputPath = fallbackPath;
      preset = "ebook";
      dpi = 175;
      passes = 2;
    }

    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[compress] Fallback used: ${fallbackUsed}`);
    console.log(`[compress] Final size: ${bytesToMb(compressedSize)} MB`);
    console.log(`[compress] Total time: ${elapsedSec}s`);

    return { outputPath, preset, dpi, originalSize, compressedSize, passes };
  } catch (err) {
    await cleanupFiles(primaryPath, fallbackPath);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "Acton PDF Compressor" });
});

app.post(
  "/compress-pdf",
  requireApiSecret,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            error: "File too large",
            message: `Upload exceeds the ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB limit.`,
          });
        }
        return res.status(400).json({ error: "Upload error", message: err.message });
      }
      if (err) {
        return res.status(400).json({ error: "Invalid file", message: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
        message: 'Send a PDF in the "file" field using multipart/form-data.',
      });
    }

    const inputPath = req.file.path;
    let outputPath = null;

    try {
      const result = await compressPdfTwoPass(inputPath, os.tmpdir());
      outputPath = result.outputPath;

      const pdfBuffer = await fs.readFile(outputPath);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${OUTPUT_FILENAME}"`,
        "X-Original-Size-MB": bytesToMb(result.originalSize),
        "X-Compressed-Size-MB": bytesToMb(result.compressedSize),
        "X-Compression-Preset": result.preset,
        "X-Compression-DPI": String(result.dpi),
        "X-Compression-Passes": String(result.passes),
      });
      res.send(pdfBuffer);
    } catch (err) {
      console.error("Compression failed:", err);
      res.status(500).json({
        error: "Compression failed",
        message:
          err.message ||
          "Ghostscript could not compress this PDF. Ensure the file is a valid PDF.",
      });
    } finally {
      await cleanupFiles(inputPath, outputPath);
    }
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Acton PDF Compressor listening on port ${PORT}`);
});
