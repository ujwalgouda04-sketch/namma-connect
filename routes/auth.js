const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");

function generateToken(userId) {
  return crypto.randomBytes(32).toString("hex");
}

function checkDbConnection(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      success: false,
      message: "MongoDB database is not connected. Please check your MongoDB server connection."
    });
    return false;
  }
  return true;
}

// POST /api/auth/register - Strictly register in MongoDB
router.post("/register", async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { name, phone, email, area, password, role } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Full name is required." });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, message: "Valid phone number is required." });
    }

    const cleanPhone = phone.replace(/[^0-9+]/g, "").trim();
    if (cleanPhone.length < 8) {
      return res.status(400).json({ success: false, message: "Please provide a valid 10-digit mobile number." });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    const userRole = role === "provider" ? "provider" : "citizen";
    const userArea = (area || "").trim();
    const userEmail = (email || "").trim().toLowerCase();

    // Check if phone number already exists in MongoDB
    const existingUser = await User.findOne({ phone: cleanPhone });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "An account with this phone number already exists in MongoDB. Please sign in."
      });
    }

    // Create and save new user strictly in MongoDB
    const newUser = new User({
      name: name.trim(),
      phone: cleanPhone,
      email: userEmail,
      area: userArea,
      role: userRole
    });

    newUser.setPassword(password);
    await newUser.save();

    const token = generateToken(newUser._id);

    return res.status(201).json({
      success: true,
      message: "Account registered successfully in MongoDB!",
      token,
      user: {
        id: newUser._id,
        name: newUser.name,
        phone: newUser.phone,
        email: newUser.email,
        area: newUser.area,
        role: newUser.role,
        createdAt: newUser.createdAt
      }
    });

  } catch (error) {
    console.error("MongoDB Register Error:", error);
    return res.status(500).json({
      success: false,
      message: "MongoDB registration failed: " + error.message
    });
  }
});

// POST /api/auth/login - Strictly authenticate from MongoDB
router.post("/login", async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { identifier, password } = req.body;

    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your mobile phone number or email." });
    }

    if (!password) {
      return res.status(400).json({ success: false, message: "Please enter your password." });
    }

    const cleanInput = identifier.trim();
    const cleanPhone = cleanInput.replace(/[^0-9+]/g, "");

    // Query user directly from MongoDB
    const user = await User.findOne({
      $or: [
        { phone: cleanPhone },
        { email: cleanInput.toLowerCase() }
      ]
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "No account found in MongoDB with this phone number or email. Please register."
      });
    }

    // Verify password hash against MongoDB
    const isValid = user.validatePassword(password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password. Please try again."
      });
    }

    const token = generateToken(user._id);

    return res.json({
      success: true,
      message: "Welcome back, " + user.name + "!",
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        area: user.area,
        role: user.role,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error("MongoDB Login Error:", error);
    return res.status(500).json({
      success: false,
      message: "MongoDB login failed: " + error.message
    });
  }
});

// GET /api/auth/me - Fetch authenticated user profile from MongoDB
router.get("/me", async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const userId = req.query.id;
    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required." });
    }

    const user = await User.findById(userId).select("-passwordHash -salt");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found in MongoDB." });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
