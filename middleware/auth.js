const jwt = require("jsonwebtoken");
const User = require("../models/User");

const DEV_FALLBACK_SECRET = "namma_connect_dev_jwt_secret_change_in_production";

function getJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) {
    return process.env.JWT_SECRET.trim();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable must be set in production.");
  }
  return DEV_FALLBACK_SECRET;
}

function signUserToken(userId) {
  return jwt.sign(
    { sub: String(userId), type: "user" },
    getJwtSecret(),
    { expiresIn: "30d" }
  );
}

function signDonorOwnerToken(donorId, normalizedPhone) {
  return jwt.sign(
    { sub: String(donorId), phone: normalizedPhone, type: "donor_owner" },
    getJwtSecret(),
    { expiresIn: "30d" }
  );
}

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (_) {
    return null;
  }
}

function extractBearer(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/**
 * Attaches req.user (if valid Namma Connect user JWT) and/or req.donorOwner (if valid donor owner JWT).
 * Does not reject unauthenticated requests.
 */
async function optionalAuth(req, res, next) {
  req.user = null;
  req.donorOwner = null;

  try {
    const bearer = extractBearer(req);
    if (bearer) {
      const payload = verifyToken(bearer);
      if (payload && payload.type === "user" && payload.sub) {
        const user = await User.findById(payload.sub).select("-passwordHash -salt");
        if (user) {
          req.user = user;
        }
      } else if (payload && payload.type === "donor_owner" && payload.sub) {
        req.donorOwner = { donorId: payload.sub, phone: payload.phone };
      }
    }

    const donorHeader = req.headers["x-donor-token"];
    if (donorHeader && !req.donorOwner) {
      const payload = verifyToken(String(donorHeader).trim());
      if (payload && payload.type === "donor_owner" && payload.sub) {
        req.donorOwner = { donorId: payload.sub, phone: payload.phone };
      }
    }
  } catch (err) {
    console.warn("optionalAuth warning:", err.message);
  }

  next();
}

/**
 * Requires either a verified Namma Connect user session or a verified donor owner token.
 */
async function requireDonorAuth(req, res, next) {
  await optionalAuth(req, res, () => {
    if (!req.user && !req.donorOwner) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please sign in or verify your donor mobile number."
      });
    }
    next();
  });
}

module.exports = {
  signUserToken,
  signDonorOwnerToken,
  verifyToken,
  optionalAuth,
  requireDonorAuth
};
