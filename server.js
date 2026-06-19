/**
 * Course eBook App — server.js
 * A small Express backend that lets you:
 *   - Create/list courses (e.g. IFT 302, CSC 401, ...)
 *   - Upload PDF materials into a course
 *   - List + download materials per course
 *   - Delete materials (admin)
 *
 * Storage: PDFs saved to /uploads, metadata in /data/db.json (a flat JSON file —
 * no real database needed for this scale). Swap data.js for a real DB later if you grow.
 *
 * ADMIN PASSWORD: set below, or via the ADMIN_PASSWORD environment variable.
 */

const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const PORT          = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123"; // ← CHANGE THIS

const DATA_DIR    = path.join(__dirname, "data");
const DB_FILE     = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// ── Ensure folders/files exist ───────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE))     fs.writeFileSync(DB_FILE, JSON.stringify({ courses: [], materials: [] }, null, 2));

// ── Tiny JSON "database" helpers ──────────────────────────────────────────────
function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function newId(prefix) {
  return prefix + "_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
}

// ── Multer setup (PDF uploads only, 50MB cap) ─────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = newId("file") + path.extname(file.originalname).toLowerCase();
    cb(null, safeName);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed."));
    }
    cb(null, true);
  },
});

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Simple admin-password check middleware for protected routes
function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin password." });
  }
  next();
}

// ════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════════

// -- Admin login check --
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: "Incorrect password." });
});

// -- List all courses (with material counts) --
app.get("/api/courses", (req, res) => {
  const db = readDB();
  const courses = db.courses.map(c => ({
    ...c,
    materialCount: db.materials.filter(m => m.courseId === c.id).length,
  }));
  res.json(courses);
});

// -- Create a new course (admin only) --
app.post("/api/courses", requireAdmin, (req, res) => {
  const { code, title, description } = req.body;
  if (!code || !title) {
    return res.status(400).json({ error: "Course code and title are required." });
  }
  const db = readDB();

  if (db.courses.some(c => c.code.toLowerCase() === code.toLowerCase())) {
    return res.status(400).json({ error: "A course with that code already exists." });
  }

  const course = {
    id: newId("course"),
    code: code.trim(),
    title: title.trim(),
    description: (description || "").trim(),
    createdAt: new Date().toISOString(),
  };
  db.courses.push(course);
  writeDB(db);
  res.json(course);
});

// -- Delete a course and all its materials (admin only) --
app.delete("/api/courses/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const course = db.courses.find(c => c.id === req.params.id);
  if (!course) return res.status(404).json({ error: "Course not found." });

  // Remove associated material files from disk
  const materialsToDelete = db.materials.filter(m => m.courseId === course.id);
  materialsToDelete.forEach(m => {
    const filePath = path.join(UPLOADS_DIR, m.storedFileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  db.courses   = db.courses.filter(c => c.id !== course.id);
  db.materials = db.materials.filter(m => m.courseId !== course.id);
  writeDB(db);
  res.json({ ok: true });
});

// -- List materials for a course --
app.get("/api/courses/:id/materials", (req, res) => {
  const db = readDB();
  const materials = db.materials
    .filter(m => m.courseId === req.params.id)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(materials);
});

// -- Upload a material PDF to a course (admin only) --
app.post("/api/courses/:id/materials", requireAdmin, upload.single("file"), (req, res) => {
  const db = readDB();
  const course = db.courses.find(c => c.id === req.params.id);

  if (!course) {
    if (req.file) fs.unlinkSync(req.file.path); // clean up orphaned upload
    return res.status(404).json({ error: "Course not found." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No PDF file was uploaded." });
  }

  const { title, category, week, description } = req.body;

  const material = {
    id: newId("mat"),
    courseId: course.id,
    title: (title || req.file.originalname).trim(),
    category: category || "Other",
    week: (week || "").trim(),
    description: (description || "").trim(),
    originalFileName: req.file.originalname,
    storedFileName: req.file.filename,
    fileSize: req.file.size,
    uploadedAt: new Date().toISOString(),
  };

  db.materials.push(material);
  writeDB(db);
  res.json(material);
});

// -- Download a material PDF --
app.get("/api/materials/:id/download", (req, res) => {
  const db = readDB();
  const material = db.materials.find(m => m.id === req.params.id);
  if (!material) return res.status(404).send("Material not found.");

  const filePath = path.join(UPLOADS_DIR, material.storedFileName);
  if (!fs.existsSync(filePath)) return res.status(404).send("File missing on server.");

  const downloadName = material.title.replace(/[^a-z0-9 _-]/gi, "").trim() + ".pdf";
  res.download(filePath, downloadName);
});

// -- View/preview a material PDF inline --
app.get("/api/materials/:id/view", (req, res) => {
  const db = readDB();
  const material = db.materials.find(m => m.id === req.params.id);
  if (!material) return res.status(404).send("Material not found.");

  const filePath = path.join(UPLOADS_DIR, material.storedFileName);
  if (!fs.existsSync(filePath)) return res.status(404).send("File missing on server.");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  fs.createReadStream(filePath).pipe(res);
});

// -- Delete a material (admin only) --
app.delete("/api/materials/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const material = db.materials.find(m => m.id === req.params.id);
  if (!material) return res.status(404).json({ error: "Material not found." });

  const filePath = path.join(UPLOADS_DIR, material.storedFileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.materials = db.materials.filter(m => m.id !== material.id);
  writeDB(db);
  res.json({ ok: true });
});

// -- Error handler (catches multer errors like "file too large" / wrong type) --
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`\n📚 Course eBook App running at http://localhost:${PORT}`);
  console.log(`   Admin password: ${ADMIN_PASSWORD} (change via ADMIN_PASSWORD env var)\n`);
});