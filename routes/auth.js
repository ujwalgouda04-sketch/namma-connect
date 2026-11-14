const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");

// In-memory fallback user store when MongoDB is not connected
const memoryUsers = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function generateToken(userId) {
  return crypto.randomBytes(32).toString("hex");
}

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, phone, email, area, password, role } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Full name is required." });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, message: "Valid phone number is required." });
    }

    const cleanPhone = phone.replace(/[^0-9+]/g, "").trim();
    if (cleanPhone.length < 8) {
      return res.status(400).json({ success: false, message: "Please provide a valid 10-digit phone number." });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    const userRole = role === "provider" ? "provider" : "citizen";
    const userArea = (area || "").trim();
    const userEmail = (email || "").trim().toLowerCase();

    // Check MongoDB if connected
    if (isDbConnected()) {
      const existingUser = await User.findOne({ phone: cleanPhone });
      if (existingUser) {
        return res.status(400).json({ success: false, message: "An account with this phone number already exists. Please log in." });
      }

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
        message: "Account registered successfully!",
        token,
        user: {
          id: newUser._id,
          name: newUser.name,
          phone: newUser.phone,
          email: newUser.email,
          area: newUser.area,
          role: newUser.role
        }
      });
    }

    // In-memory fallback store
    if (memoryUsers.has(cleanPhone)) {
      return res.status(400).json({ success: false, message: "An account with this phone number already exists. Please log in." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const id = "mem_" + Date.now();

    const memUser = {
      id,
      name: name.trim(),
      phone: cleanPhone,
      email: userEmail,
      area: userArea,
      role: userRole,
      salt,
      passwordHash
    };

    memoryUsers.set(cleanPhone, memUser);
    const token = generateToken(id);

    return res.status(201).json({
      success: true,
      message: "Account registered successfully!",
      token,
      user: {
        id: memUser.id,
        name: memUser.name,
        phone: memUser.phone,
        email: memUser.email,
        area: memUser.area,
        role: memUser.role
      }
    });

  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Server error during registration. " + error.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your phone number or email." });
    }

    if (!password) {
      return res.status(400).json({ success: false, message: "Please enter your password." });
    }

    const cleanInput = identifier.trim();
    const cleanPhone = cleanInput.replace(/[^0-9+]/g, "");

    // MongoDB lookup if connected
    if (isDbConnected()) {
      const user = await User.findOne({
        $or: [
          { phone: cleanPhone },
          { email: cleanInput.toLowerCase() }
        ]
      });

      if (!user) {
        return res.status(401).json({ success: false, message: "No account found with this phone number or email." });
      }

      if (!user.validatePassword(password)) {
        return res.status(401).json({ success: false, message: "Incorrect password. Please try again." });
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
          role: user.role
        }
      });
    }

    // In-memory fallback lookup
    let memUser = memoryUsers.get(cleanPhone);
    if (!memUser) {
      for (const u of memoryUsers.values()) {
        if (u.email && u.email === cleanInput.toLowerCase()) {
          memUser = u;
          break;
        }
      }
    }

    if (!memUser) {
      return res.status(401).json({ success: false, message: "No account found with this phone number or email." });
    }

    const calculatedHash = hashPassword(password, memUser.salt);
    if (calculatedHash !== memUser.passwordHash) {
      return res.status(401).json({ success: false, message: "Incorrect password. Please try again." });
    }

    const token = generateToken(memUser.id);

    return res.json({
      success: true,
      message: "Welcome back, " + memUser.name + "!",
      token,
      user: {
        id: memUser.id,
        name: memUser.name,
        phone: memUser.phone,
        email: memUser.email,
        area: memUser.area,
        role: memUser.role
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error during login. " + error.message });
  }
});

// GET /api/auth/me
router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ success: false, message: "Unauthorized. Token missing." });
  }
  res.json({ success: true, message: "Token is active." });
});

module.exports = router;
