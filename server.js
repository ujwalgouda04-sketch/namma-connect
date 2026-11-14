
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const connectDB = require("./config/db");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Frontend
app.use(express.static(path.join(__dirname, "public")));

// Live Nearby Facilities API
app.use("/api/nearby", require("./routes/nearby"));

// User Authentication API (Login & Register)
app.use("/api/auth", require("./routes/auth"));

// Test API
app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "NammaConnect backend is running!"
    });
});

// Start server after database connects
const startServer = async () => {
    try {
        await connectDB();
    } catch (error) {
        console.warn("MongoDB connection deferred (running in resilient mode):", error.message);
    }

    app.listen(PORT, () => {
        console.log(`NammaConnect running at http://localhost:${PORT}`);
    });
};

startServer();
