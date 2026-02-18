require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

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

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });
});