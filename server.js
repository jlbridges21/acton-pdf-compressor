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

// Quality-preserving fallback compressor — prefer larger files, not smallest
const MAX_ACCEPTABLE_BYTES = 20 * 1024 * 1024;
const PREFERRED_MIN_BYTES = 10 * 1024 * 1024; // ideal range: 10–18 MB
const PREFERRED_MAX_BYTES = 18 * 1024 * 1024;
const LOW_SIZE_BYTES = 10 * 1024 * 1024; // warn if result falls below this
// 200 MB upload limit
const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Compression candidates, least aggressive first.
 * Steps 1–7 always run. Step 8 (/screen) runs only if none of 1–7 are under 20 MB.
 */
const COMPRESSION_CANDIDATES = [
  { preset: "/prepress", dpi: 300, label: "prepress-300", aggressive: false },
  { preset: "/printer", dpi: 300, label: "printer-300", aggressive: false },
  { preset: "/printer", dpi: 250, label: "printer-250", aggressive: false },
  { preset: "/printer", dpi: 200, label: "printer-200", aggressive: false },
  { preset: "/ebook", dpi: 225, label: "ebook-225", aggressive: false },
  { preset: "/ebook", dpi: 200, label: "ebook-200", aggressive: false },
  { preset: "/ebook", dpi: 150, label: "ebook-150", aggressive: true },
  { preset: "/screen", dpi: null, label: "screen", aggressive: true, lastResort: true },
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

/** Build Ghostscript args with explicit image downsampling controls. */
function buildGsArgs(inputPath, outputPath, preset, dpi, aggressive) {
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
      "-dDownsampleColorImages=true",
      `-dColorImageResolution=${dpi}`,
      "-dDownsampleGrayImages=true",
      `-dGrayImageResolution=${dpi}`,
      "-dDownsampleMonoImages=true",
      `-dMonoImageResolution=${dpi}`
    );

    if (!aggressive) {
      // High-quality: bicubic resampling, only downsample above target DPI
      args.push(
        "-dColorImageDownsampleType=/Bicubic",
        "-dGrayImageDownsampleType=/Bicubic",
        "-dColorImageDownsampleThreshold=1.0",
        "-dGrayImageDownsampleThreshold=1.0",
        "-dMonoImageDownsampleThreshold=1.0"
      );
    }
  }

  args.push(`-sOutputFile=${outputPath}`, inputPath);
  return args;
}

/** Run Ghostscript with the given quality preset, DPI, and quality mode. */
async function compressPdf(inputPath, outputPath, preset, dpi = null, aggressive = false) {
  const args = buildGsArgs(inputPath, outputPath, preset, dpi, aggressive);

  await execFileAsync("gs", args, {
    timeout: 10 * 60 * 1000, // 10-minute timeout per candidate (large decks)
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

function formatCandidatesSummary(candidates, selectedPath) {
  return candidates
    .map((c) => {
      const tag = c.outputPath === selectedPath ? "*" : "";
      const dpi = c.dpi ?? "default";
      return `${c.label}@${dpi}dpi=${bytesToMb(c.size)}MB${tag}`;
    })
    .join("; ");
}

/**
 * Choose the best candidate for a quality-preserving fallback compressor.
 *
 * Strategy (not smallest-file wins):
 * 1. Prefer the largest file in the 10–18 MB sweet spot.
 * 2. Else pick the largest file under 20 MB.
 * 3. Never pick /screen if any other candidate is under 20 MB.
 * 4. If everything is over 20 MB, return the smallest and warn.
 * 5. If everything under 20 MB is below 10 MB, return the largest and warn.
 */
function selectBestCandidate(candidates) {
  let underMax = candidates.filter((c) => c.size <= MAX_ACCEPTABLE_BYTES);

  // Avoid /screen unless it is the only option under 20 MB
  const withoutScreen = underMax.filter((c) => c.label !== "screen");
  if (withoutScreen.length > 0) {
    underMax = withoutScreen;
  }

  if (underMax.length > 0) {
    const inPreferredRange = underMax.filter(
      (c) => c.size >= PREFERRED_MIN_BYTES && c.size <= PREFERRED_MAX_BYTES
    );

    const selected =
      inPreferredRange.length > 0
        ? inPreferredRange.reduce((best, c) => (c.size > best.size ? c : best))
        : underMax.reduce((best, c) => (c.size > best.size ? c : best));

    let warning = null;
    if (underMax.every((c) => c.size < LOW_SIZE_BYTES)) {
      warning =
        `All candidates under 20 MB are below 10 MB; selected largest at ${bytesToMb(selected.size)} MB. PDF may still be over-compressed.`;
    } else if (selected.size < LOW_SIZE_BYTES) {
      warning = `Selected file is ${bytesToMb(selected.size)} MB (under 10 MB); quality may be reduced.`;
    }

    return { selected, warning };
  }

  const selected = candidates.reduce((best, c) => (c.size < best.size ? c : best));
  return {
    selected,
    warning: `Could not compress below 20 MB; returning smallest result at ${bytesToMb(selected.size)} MB.`,
  };
}

async function runCandidate(inputPath, workDir, step) {
  const outputPath = path.join(
    workDir,
    `${step.label}-${crypto.randomBytes(6).toString("hex")}.pdf`
  );
  const dpiLabel = step.dpi ? String(step.dpi) : "default";

  console.log(
    `[compress] Trying ${step.label} (${step.preset}, ${dpiLabel} dpi, aggressive=${step.aggressive})...`
  );

  await compressPdf(inputPath, outputPath, step.preset, step.dpi, step.aggressive);
  const size = await getFileSizeBytes(outputPath);

  console.log(`[compress]   → ${bytesToMb(size)} MB`);

  return { ...step, outputPath, size };
}

/**
 * Fallback quality-preserving compression.
 * Runs multiple Ghostscript presets, then returns the largest acceptable file
 * under 20 MB (preferring 10–18 MB). Used when local frontend compression
 * was not enough — not as an aggressive file crusher.
 */
async function compressWithAdaptiveQuality(inputPath, workDir) {
  const originalSize = await getFileSizeBytes(inputPath);
  console.log(`[compress] Original size: ${bytesToMb(originalSize)} MB`);

  const candidates = [];

  try {
    for (const step of COMPRESSION_CANDIDATES) {
      if (step.lastResort) {
        const hasUnderMax = candidates.some((c) => c.size <= MAX_ACCEPTABLE_BYTES);
        if (hasUnderMax) {
          console.log("[compress] Skipping /screen — a candidate is already under 20 MB");
          break;
        }
      }

      candidates.push(await runCandidate(inputPath, workDir, step));
    }
  } catch (err) {
    await cleanupFiles(...candidates.map((c) => c.outputPath));
    throw err;
  }

  const { selected, warning } = selectBestCandidate(candidates);

  for (const c of candidates) {
    const isSelected = c.outputPath === selected.outputPath;
    console.log(
      `[compress] Candidate: preset=${c.label} dpi=${c.dpi ?? "default"} ` +
        `size=${bytesToMb(c.size)} MB selected=${isSelected}`
    );
  }

  console.log(
    `[compress] Selected: ${selected.label} at ${bytesToMb(selected.size)} MB ` +
      `(${selected.preset}, ${selected.dpi ?? "default"} dpi)`
  );
  if (warning) {
    console.log(`[compress] Warning: ${warning}`);
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
    allCandidatesSummary: formatCandidatesSummary(candidates, selected.outputPath),
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
        "X-All-Candidates": result.allCandidatesSummary,
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
