
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const multer = require("multer");
const { fromBuffer } = require("pdf2pic");
const fs = require("fs");
const fetch = require("node-fetch"); // ✅ ADD THIS
const upload = multer();
const admin = require("./firebase-admin");

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


// =====================================================
// 🧑‍⚕️ CARETAKER ROUTES  ← ✅ ADD RIGHT HERE
// =====================================================

// ➕ Add new patient
app.post("/add-patient", async (req, res) => {
  const { caretaker_uid, name, age, gender, notes } = req.body;

  const patientId =
    "PAT_" + Math.random().toString(36).substring(2, 8).toUpperCase();

  try {
    await pool.query(
      "INSERT INTO patients (id, caretaker_uid, name, age, gender, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [patientId, caretaker_uid, name, age, gender, notes]
    );

    res.json({ message: "Patient added", patient_id: patientId });
  } catch (error) {
    console.error("Add patient error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 📋 Get all patients of a caretaker
app.get("/caretaker-patients/:uid", async (req, res) => {
  const { uid } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT * FROM patients WHERE caretaker_uid = ? ORDER BY created_at DESC",
      [uid]
    );

    res.json(rows);
  } catch (error) {
    console.error("Fetch patients error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
app.post("/analyze-prescription", upload.single("image"), async (req, res) => {
   const { firebase_uid, patient_id } = req.body;
   if (!firebase_uid && !patient_id) {
    return res.status(400).json({
      error: "Missing firebase_uid or patient_id"
    });
  }
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
    // STEP 2 — Check if already processed BY SAME USER
const ownerField = req.body.patient_id ? "patient_id" : "firebase_uid";
const ownerValue = req.body.patient_id || req.body.firebase_uid;

const [rows] = await pool.query(
  `SELECT raw_text, structured_json 
   FROM prescriptions 
   WHERE image_hash = ? AND ${ownerField} = ?`,
  [imageHash, ownerValue]
);

if (rows.length > 0) {
  console.log("Image already processed by this user. Returning stored result.");

  return res.json({
    raw_text: rows[0].raw_text,
    structured_json:
      typeof rows[0].structured_json === "string"
        ? JSON.parse(rows[0].structured_json)
        : rows[0].structured_json,
    from_cache: true
  });
}

    // STEP 3 — If not processed → Call Gemini OCR

    let imageBuffer = req.file.buffer;
let mimeType = req.file.mimetype;

// If user uploaded PDF → convert first page to image
if (mimeType === "application/pdf") {

  console.log("PDF uploaded, converting to image...");

  const convert = fromBuffer(req.file.buffer, {
    density: 300,
    format: "png",
    width: 2000,
    height: 2000
  });

  const page = await convert(1);

  imageBuffer = fs.readFileSync(page.path);
  mimeType = "image/png";
}

// Convert to base64 for Gemini
const imageBase64 = imageBuffer.toString("base64");

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
    // STEP 5 — Save everything including image binary

console.log("firebase_uid:", req.body.firebase_uid);
console.log("patient_id:", req.body.patient_id);
await pool.query(
  "INSERT INTO prescriptions (firebase_uid, patient_id, raw_text, structured_json, image_hash, image_data, image_mime) VALUES (?, ?, ?, ?, ?, ?, ?)",
  [
    req.body.firebase_uid || null,   // for normal users
    req.body.patient_id || null,    // for caretaker patients
    rawText,
    JSON.stringify(structuredData),
    imageHash,
    req.file.buffer,
    req.file.mimetype
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

    const prompt = `You are a prescription structuring system.

Convert the prescription text into STRICT JSON in this format:

{
"medications": [
{
"name": "",
"quantity": "",
"dosage": "",
"durationDays": "",
"remarks": ""
}
]
}

Rules:

* Extract ONLY the medicine name into "name". Remove strength, quantity, frequency, and duration from the name.
* Extract strength (e.g., 500 mg, 625 mg) or syrup quantity (e.g., 5 ml, 10 ml) into "quantity". If not mentioned, return "-".
* Convert frequency into a 3-digit format (Morning-Afternoon-Night):

  * 1-0-1 → "1-0-1"
  * 1-1-1 → "1-1-1"
  * 0-0-1 → "0-0-1"
  * BD → "1-0-1"
  * TDS → "1-1-1"
  * OD → "1-0-0"
  * If only "after food" is mentioned without numbers → "111"
  * SOS or PRN → "As Needed"
* "dosage" must contain ONLY the standardized dosage value 
(e.g., "1-0-1", "1-1-1", "1-0-0", or "As Needed").
* Extract duration in days into "durationDays" as a number only (e.g., 5).
* If a global duration (e.g., "for 5 days") is mentioned for the whole prescription, apply it to all medicines unless a specific medicine has its own duration.
* If duration is not mentioned anywhere, return "NS".
* Put additional instructions such as "before food", "after food", "after meals", "before meals", "orally", "at bedtime", etc. inside the "remarks" field.
* If no extra instruction is mentioned, return "-" in "remarks".
* Do not include dosage numbers or duration inside "remarks".
*If the uploaded image is not a medical prescription or if no medicine names are detected, do NOT generate a medicine table. Instead return the message: "No medicines found. This image may not be a valid prescription".
* Do not add extra keys.
* No markdown.
* No explanation.
* Return valid JSON only.

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
});app.get("/past-prescriptions/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;

    const [rows] = await pool.query(
      "SELECT id, structured_json, created_at, image_data, image_mime FROM prescriptions WHERE firebase_uid = ? ORDER BY created_at DESC",
      [uid]
    );

    const formatted = rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      structured_json:
        typeof row.structured_json === "string"
          ? JSON.parse(row.structured_json)
          : row.structured_json,
      image_base64: row.image_data
        ? row.image_data.toString("base64")
        : null,
      image_mime: row.image_mime
    }));

    res.json(formatted);

  } catch (error) {
    console.error("Fetch history error:", error);
    res.status(500).json({ error: "Failed to fetch prescriptions" });
  }
});
// 📜 Get prescriptions for caretaker patient
app.get("/patient-prescriptions/:patientId", async (req, res) => {
  try {
    const patientId = req.params.patientId;

    const [rows] = await pool.query(
      "SELECT id, structured_json, created_at, image_data, image_mime FROM prescriptions WHERE patient_id = ? ORDER BY created_at DESC",
      [patientId]
    );

    const formatted = rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      structured_json:
        typeof row.structured_json === "string"
          ? JSON.parse(row.structured_json)
          : row.structured_json,
      image_base64: row.image_data
        ? row.image_data.toString("base64")
        : null,
      image_mime: row.image_mime
    }));

    res.json(formatted);

  } catch (error) {
    console.error("Fetch patient history error:", error);
    res.status(500).json({ error: "Failed to fetch prescriptions" });
  }
});
app.post("/save-token", async (req, res) => {
  try {
    const { firebase_uid, fcm_token } = req.body;

    await pool.query(
      "UPDATE users SET fcm_token = ? WHERE firebase_uid = ?",
      [fcm_token, firebase_uid]
    );

    res.json({ message: "Token saved successfully" });
  } catch (error) {
    console.error("Save token error:", error);
    res.status(500).json({ error: "Failed to save token" });
  }
});
app.post("/generate-reminders", async (req, res) => {
  try {
    const { firebase_uid, prescription_id, medications, meal_times } = req.body;
    await pool.query(
      "DELETE FROM reminders WHERE prescription_id = ?",
      [prescription_id]
    );
    for (const med of medications) {

      if (!med.dosage || med.dosage === "As Needed") continue;

      const duration = parseInt(med.durationDays);
      if (!duration || duration <= 0) continue;

      // remove dash from dosage (1-0-1 -> 101)
      const dosage = med.dosage.replace(/-/g, "");

      for (let day = 0; day < duration; day++) {

        const baseDate = new Date();
        baseDate.setDate(baseDate.getDate() + day);

        const meals = ["breakfast", "lunch", "dinner"];

        for (let i = 0; i < 3; i++) {

          if (dosage[i] === "1") {

  const mealTime = meal_times[meals[i]];
  if (!mealTime) continue;

  const [hour, minute] = mealTime.split(":");

  let reminderTime = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    parseInt(hour),
    parseInt(minute)
  );


            const beforeFood =
              med.remarks &&
              med.remarks.toLowerCase().includes("before");

            if (beforeFood) {
              reminderTime.setMinutes(reminderTime.getMinutes() - 30);
            } else {
              reminderTime.setMinutes(reminderTime.getMinutes() + 30);
            }

            await pool.query(
              `INSERT INTO reminders 
(firebase_uid, prescription_id, medicine_name, reminder_time, active, sent)
VALUES (?, ?, ?, ?, TRUE, FALSE)`,
              [firebase_uid, prescription_id, med.name, reminderTime]
            );
          }
        }
      }
    }

    res.json({ message: "Reminders generated successfully" });

  } catch (error) {
    console.error("Generate reminder error:", error);
    res.status(500).json({ error: "Failed to generate reminders" });
  }
});
const cron = require("node-cron");


cron.schedule("* * * * *", async () => {
  try {
    console.log("Checking reminders...");

    const [rows] = await pool.query(
      `SELECT * FROM reminders 
       WHERE reminder_time <= NOW() 
       AND reminder_time >= NOW() - INTERVAL 1 MINUTE
       AND sent = FALSE`
    );

    for (const reminder of rows) {

      const [user] = await pool.query(
        "SELECT fcm_token FROM users WHERE firebase_uid = ?",
        [reminder.firebase_uid]
      );

      if (!user.length || !user[0].fcm_token) continue;

      await admin.messaging().send({
        token: user[0].fcm_token,
        notification: {
          title: "MediMate Reminder",
          body: `Time to take ${reminder.medicine_name}`,
        },
      });

      await pool.query(
        "UPDATE reminders SET sent = TRUE WHERE id = ?",
        [reminder.id]
      );
    }

  } catch (error) {
    console.error("Cron error:", error);
  }
});
// ❌ Delete patient + their data
app.delete("/delete-patient/:id", async (req, res) => {
  const patientId = req.params.id;

  try {
    // Delete reminders linked to prescriptions of this patient
    await pool.query(`
      DELETE r FROM reminders r
      JOIN prescriptions p ON r.prescription_id = p.id
      WHERE p.patient_id = ?
    `, [patientId]);

    // Delete prescriptions of patient
    await pool.query(
      "DELETE FROM prescriptions WHERE patient_id = ?",
      [patientId]
    );

    // Delete patient
    await pool.query(
      "DELETE FROM patients WHERE id = ?",
      [patientId]
    );

    res.json({ message: "Patient and related data deleted" });
  } catch (error) {
    console.error("Delete patient error:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });
});