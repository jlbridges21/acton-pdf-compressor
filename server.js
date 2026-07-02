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

// Email-friendly max; prefer quality — 12 MB is a target, not a hard ceiling
const MAX_ACCEPTABLE_BYTES = 20 * 1024 * 1024;
// 200 MB upload limit
const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024;

/** Least aggressive first — only run later steps if earlier outputs are still over 20 MB. */
const COMPRESSION_STEPS = [
  { preset: "/printer", dpi: 300, label: "printer" },
  { preset: "/ebook", dpi: 225, label: "ebook-225" },
  { preset: "/ebook", dpi: 150, label: "ebook-150" },
  { preset: "/screen", dpi: null, label: "screen" },
];

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

/** Run Ghostscript with the given quality preset and optional DPI. */
async function compressPdf(inputPath, outputPath, preset, dpi = null) {
  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${preset}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
  ];

  if (dpi) {
    args.push(
      `-dColorImageResolution=${dpi}`,
      `-dGrayImageResolution=${dpi}`,
      `-dMonoImageResolution=${dpi}`
    );
  }

  args.push(`-sOutputFile=${outputPath}`, inputPath);

  await execFileAsync("gs", args, {
    timeout: 5 * 60 * 1000, // 5-minute timeout for large presentations
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
 * Adaptive quality-first compression.
 * Tries presets from highest to lowest quality, stopping at the least aggressive
 * setting that produces a file under 20 MB. Prefers larger files under 20 MB
 * because they retain better image quality.
 */
async function compressWithAdaptiveQuality(inputPath, workDir) {
  const originalSize = await getFileSizeBytes(inputPath);
  console.log(`[compress] Original size: ${bytesToMb(originalSize)} MB`);

  const candidates = [];

  try {
    for (const step of COMPRESSION_STEPS) {
      // Skip stronger steps unless every attempt so far is still over 20 MB
      if (candidates.length > 0) {
        const allOverMax = candidates.every((c) => c.size > MAX_ACCEPTABLE_BYTES);
        if (!allOverMax) {
          break;
        }
      }

      const outputPath = path.join(
        workDir,
        `${step.label}-${crypto.randomBytes(6).toString("hex")}.pdf`
      );
      const dpiLabel = step.dpi ? String(step.dpi) : "default";

      console.log(
        `[compress] Trying ${step.label} (${step.preset}, ${dpiLabel} dpi)...`
      );

      await compressPdf(inputPath, outputPath, step.preset, step.dpi);
      const size = await getFileSizeBytes(outputPath);

      const candidate = { ...step, outputPath, size };
      candidates.push(candidate);

      console.log(
        `[compress]   → candidate ${bytesToMb(size)} MB (${step.label}, ${dpiLabel} dpi)`
      );

      if (size <= MAX_ACCEPTABLE_BYTES) {
        console.log(
          `[compress]   → under 20 MB; stopping (no stronger compression needed)`
        );
        break;
      }

      console.log(`[compress]   → still over 20 MB; will try next preset if available`);
    }
  } catch (err) {
    await cleanupFiles(...candidates.map((c) => c.outputPath));
    throw err;
  }

  const underMax = candidates.filter((c) => c.size <= MAX_ACCEPTABLE_BYTES);

  let selected;
  let warning = null;

  if (underMax.length > 0) {
    // Largest under 20 MB = best quality among acceptable candidates
    selected = underMax.reduce((best, c) => (c.size > best.size ? c : best));
    console.log(
      `[compress] Selected: ${selected.label} at ${bytesToMb(selected.size)} MB ` +
        `(${selected.preset}, ${selected.dpi ?? "default"} dpi) — ` +
        `best quality under 20 MB`
    );
  } else {
    selected = candidates.reduce((best, c) => (c.size < best.size ? c : best));
    warning = "Could not compress below 20 MB; returning smallest result.";
    console.log(
      `[compress] Warning: all candidates over 20 MB. ` +
        `Selected smallest: ${selected.label} at ${bytesToMb(selected.size)} MB`
    );
  }

  const discardPaths = candidates
    .filter((c) => c.outputPath !== selected.outputPath)
    .map((c) => c.outputPath);
  await cleanupFiles(...discardPaths);

  return {
    outputPath: selected.outputPath,
    preset: selected.label,
    dpi: selected.dpi,
    originalSize,
    compressedSize: selected.size,
    warning,
  };
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
      const result = await compressWithAdaptiveQuality(inputPath, os.tmpdir());
      outputPath = result.outputPath;

      const pdfBuffer = await fs.readFile(outputPath);

      const headers = {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${OUTPUT_FILENAME}"`,
        "X-Original-Size-MB": bytesToMb(result.originalSize),
        "X-Compressed-Size-MB": bytesToMb(result.compressedSize),
        "X-Compression-Preset": result.preset,
        "X-Compression-DPI": result.dpi ? String(result.dpi) : "default",
      };
      if (result.warning) {
        headers["X-Compression-Warning"] = result.warning;
      }

      res.set(headers);
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
