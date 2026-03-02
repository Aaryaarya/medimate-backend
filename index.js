require("dotenv").config();
const crypto = require("crypto");
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

    // STEP 1 — Generate SHA256 hash
    const imageHash = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");

    // STEP 2 — Check if already processed
    const [rows] = await pool.query(
      "SELECT raw_text, structured_json FROM prescriptions WHERE image_hash = ?",
      [imageHash]
    );

    if (rows.length > 0) {
      console.log("Image already processed. Returning stored result.");
      return res.json({
        raw_text: rows[0].raw_text,
        structured_json: rows[0].structured_json,
        from_cache: true
      });
    }

    // STEP 3 — If not processed → Call Gemini OCR

    const imageBase64 = req.file.buffer.toString("base64");

    let mimeType = req.file.mimetype;
    if (mimeType === "application/octet-stream") {
      mimeType = "image/jpeg";
    }

    const prompt = `
You are an OCR text extraction system.
Extract ALL visible text exactly as written.
Return plain text only.
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
        }),
        generationConfig: {
          temperature: 0
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "Gemini OCR failed" });
    }

    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // STEP 4 — Structure text (call your existing structure logic)
    // We call your /structure-text internally

    const structureResponse = await fetch(
      `https://medimate-backend-wzk0.onrender.com/structure-text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: rawText }),
      }
    );

    const structuredData = await structureResponse.json();

    // STEP 5 — Save everything including hash
    await pool.query(
      "INSERT INTO prescriptions (firebase_uid, raw_text, structured_json, image_hash) VALUES (?, ?, ?, ?)",
      [
        req.body.firebase_uid || "unknown",
        rawText,
        JSON.stringify(structuredData),
        imageHash,
      ]
    );

    return res.json({
      raw_text: rawText,
      structured_json: structuredData,
      from_cache: false
    });

  } catch (error) {
    console.error("Analyze error:", error);
    res.status(500).json({ error: "Processing failed" });
  }
});
app.post("/structure-text", async (req, res) => {
  try {
    const { raw_text } = req.body;

    if (!raw_text) {
      return res.status(400).json({ error: "No raw text provided" });
    }

    const prompt = `
You are a prescription structuring system.

Convert the prescription text into STRICT JSON in this format:

{
  "medications": [
    {
      "name": "",
      "dosesPerDay": "",
      "dosageDetails": "",
      "remarks": ""
    }
  ]
}

Rules:
- Decode frequencies (BD, TDS, 1-0-1, etc.) into readable form.
- Combine duration and quantity inside "dosageDetails".
- Mention food instruction inside "remarks".
- No markdown.
- No explanation.
- Return valid JSON only.

Prescription Text:
${raw_text}
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
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "Gemini structuring failed" });
    }

    let structured =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Clean markdown if Gemini adds it
    structured = structured
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(structured);
    } catch (err) {
      console.error("Invalid JSON from Gemini:", structured);
      return res.status(500).json({ error: "Invalid JSON from Gemini" });
    }

    res.json(parsed);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Structure processing failed" });
  }
});
app.post("/save-prescription", async (req, res) => {
  try {
    const { firebase_uid, raw_text, structured_json } = req.body;

    await pool.query(
      "INSERT INTO prescriptions (firebase_uid, raw_text, structured_json) VALUES (?, ?, ?)",
      [firebase_uid, raw_text, JSON.stringify(structured_json)]
    );

    res.json({ message: "Prescription saved successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save prescription" });
  }
});
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });
});