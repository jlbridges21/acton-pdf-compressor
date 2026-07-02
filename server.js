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

// 20 MB — email-friendly ceiling; /screen is only used if /ebook exceeds this
const MAX_EMAIL_SIZE_BYTES = 20 * 1024 * 1024;
// 200 MB upload limit
const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024;

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

/** Run Ghostscript with the given quality preset (/ebook or /screen). */
async function compressPdf(inputPath, outputPath, preset) {
  await execFileAsync(
    "gs",
    [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=${preset}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      `-sOutputFile=${outputPath}`,
      inputPath,
    ],
    { timeout: 5 * 60 * 1000 } // 5-minute timeout for large presentations
  );
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
 * Compress with /ebook first. If the result is still over 20 MB, retry with /screen.
 * Returns { outputPath, preset, originalSize, compressedSize }.
 */
async function compressWithFallback(inputPath, workDir) {
  const originalSize = await getFileSizeBytes(inputPath);

  const ebookOutput = path.join(workDir, `ebook-${crypto.randomBytes(6).toString("hex")}.pdf`);
  await compressPdf(inputPath, ebookOutput, "/ebook");
  const ebookSize = await getFileSizeBytes(ebookOutput);

  if (ebookSize <= MAX_EMAIL_SIZE_BYTES) {
    return {
      outputPath: ebookOutput,
      preset: "ebook",
      originalSize,
      compressedSize: ebookSize,
      alternateOutput: null,
    };
  }

  // /ebook still too large — fall back to /screen
  const screenOutput = path.join(workDir, `screen-${crypto.randomBytes(6).toString("hex")}.pdf`);
  await compressPdf(inputPath, screenOutput, "/screen");
  const screenSize = await getFileSizeBytes(screenOutput);

  // Remove the oversized ebook attempt
  await cleanupFiles(ebookOutput);

  return {
    outputPath: screenOutput,
    preset: "screen",
    originalSize,
    compressedSize: screenSize,
    alternateOutput: null,
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
      const result = await compressWithFallback(inputPath, os.tmpdir());
      outputPath = result.outputPath;

      const pdfBuffer = await fs.readFile(outputPath);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${OUTPUT_FILENAME}"`,
        "X-Original-Size-MB": bytesToMb(result.originalSize),
        "X-Compressed-Size-MB": bytesToMb(result.compressedSize),
        "X-Compression-Preset": result.preset,
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
