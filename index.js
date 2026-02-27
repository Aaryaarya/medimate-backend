require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const multer = require("multer");
const upload = multer();


const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let pool;

async function connectDB() {
  try {
    pool = mysql.createPool(process.env.DATABASE_URL);
    console.log("Connected to Railway MySQL ✅");
  } catch (err) {
    console.error("DB Connection Failed ❌", err);
  }
}

app.get("/", (req, res) => {
  res.send("Backend + Railway Connected 🚀");
});

app.get("/test-db", async (req, res) => {
  const [rows] = await pool.query("SELECT 1 + 1 AS result");
  res.json(rows);
});


// ================= USER ROUTES =================

// Register user (store role)
app.post("/register-user", async (req, res) => {
  const { firebase_uid, email, role } = req.body;

  try {
    await pool.query(
      "INSERT INTO users (firebase_uid, email, role) VALUES (?, ?, ?)",
      [firebase_uid, email, role]
    );

    res.status(200).json({ message: "User saved successfully" });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Database error" });
  }
});


// Get role using Firebase UID
app.get("/get-role/:uid", async (req, res) => {
  const uid = req.params.uid;

  try {
    const [rows] = await pool.query(
      "SELECT role FROM users WHERE firebase_uid = ?",
      [uid]
    );

    if (rows.length > 0) {
      res.json({ role: rows[0].role });
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (error) {
    console.error("Get role error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
app.post("/analyze-prescription", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const imageBase64 = req.file.buffer.toString("base64");

    const prompt = `
You are an OCR text extraction system.

Extract ALL visible text from the provided prescription image.

Return ONLY raw text exactly as written.
Do NOT summarize.
Do NOT structure.
Do NOT return JSON.
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: req.file.mimetype,
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "Gemini API error" });
    }

    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    res.json({ raw_text: rawText });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Gemini OCR failed" });
  }
});
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });
});