const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const BloodDonor = require("../models/BloodDonor");
const DonorReport = require("../models/DonorReport");
const { sendOtpSms, getSmsModeInfo } = require("../services/smsService");
const {
  optionalAuth,
  requireDonorAuth,
  signDonorOwnerToken
} = require("../middleware/auth");

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between resends
const OTP_RESEND_WINDOW_MS = 30 * 60 * 1000; // 30-minute window
const OTP_MAX_RESENDS_PER_WINDOW = 3;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

const REPORT_HIDE_THRESHOLD = Math.max(
  2,
  parseInt(process.env.DONOR_REPORT_HIDE_THRESHOLD || "3", 10) || 3
);
const REPORT_WINDOW_DAYS = 30;
const REPORT_HIDE_DURATION_DAYS = 7;

const MEDICAL_SAFETY_NOTICE =
  "Donor information is self-reported. Phone verification does not confirm blood group or medical eligibility. All donations must be screened and approved by a licensed blood bank.";

// Rate limiters for abuse protection
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many OTP requests from this network. Please wait 15 minutes and try again."
  }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many verification attempts. Please try again later."
  }
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many profile reports submitted from this network. Please try again later."
  }
});

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

function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  const trimmed = rawPhone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    return `+91${digits.slice(1)}`;
  }
  return null;
}

function maskPhone(normalizedPhone) {
  if (!normalizedPhone) return "";
  const last4 = normalizedPhone.slice(-4);
  const prefix = normalizedPhone.slice(0, 3);
  return `${prefix} ******${last4}`;
}

function generateSixDigitOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function buildReporterKey(req) {
  const salt = process.env.JWT_SECRET || "namma_connect_report_salt";
  const raw = req.user
    ? `user:${String(req.user._id)}`
    : `ip:${getClientIp(req)}`;
  return crypto.createHmac("sha256", salt).update(raw).digest("hex");
}

function isDonorOwner(donor, req) {
  if (!donor) return false;
  if (req.user) {
    if (donor.ownerUserId && String(donor.ownerUserId) === String(req.user._id)) {
      return true;
    }
    const userPhone = normalizePhone(req.user.phone);
    if (userPhone && userPhone === donor.phone) {
      return true;
    }
  }
  if (req.donorOwner) {
    if (
      String(req.donorOwner.donorId) === String(donor._id) &&
      req.donorOwner.phone === donor.phone
    ) {
      return true;
    }
  }
  return false;
}

function serializeDonor(donor, req, { includeOwnerPhone = false } = {}) {
  const owner = isDonorOwner(donor, req);
  const canRevealPhone = Boolean(donor.consentToShareContact) || (includeOwnerPhone && owner);
  return {
    id: donor._id,
    fullName: donor.fullName,
    bloodGroup: donor.bloodGroup,
    city: donor.city,
    availableToDonate: Boolean(donor.availableToDonate),
    consentToShareContact: Boolean(donor.consentToShareContact),
    isPhoneVerified: Boolean(donor.isPhoneVerified),
    phoneVerifiedAt: donor.phoneVerifiedAt,
    phone: canRevealPhone ? donor.phone : null,
    isOwner: owner,
    isTemporarilyHidden: Boolean(donor.isTemporarilyHidden),
    createdAt: donor.createdAt,
    updatedAt: donor.updatedAt
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GET /api/donors
 * Public Blood Donor Directory listing with blood group & city filters.
 * Only returns active, phone-verified, non-hidden donors.
 * Never exposes phone numbers for donors who did not consent to sharing contact details.
 */
router.get("/", optionalAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { bloodGroup, city, available, search } = req.query;
    const now = new Date();

    const filter = {
      isActive: true,
      isPhoneVerified: true,
      $or: [
        { isTemporarilyHidden: false },
        { isTemporarilyHidden: { $exists: false } },
        { isTemporarilyHidden: true, hiddenUntil: { $lte: now } }
      ]
    };

    if (bloodGroup && BloodDonor.VALID_BLOOD_GROUPS.includes(String(bloodGroup).trim())) {
      filter.bloodGroup = String(bloodGroup).trim();
    }

    if (city && String(city).trim()) {
      filter.city = { $regex: escapeRegex(String(city).trim()), $options: "i" };
    }

    if (available === "true") {
      filter.availableToDonate = true;
    } else if (available === "false") {
      filter.availableToDonate = false;
    }

    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), "i");
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ fullName: rx }, { city: rx }, { bloodGroup: rx }] }
      ];
    }

    const donors = await BloodDonor.find(filter)
      .sort({ availableToDonate: -1, updatedAt: -1 })
      .limit(100);

    const smsInfo = getSmsModeInfo();

    return res.json({
      success: true,
      count: donors.length,
      safetyNotice: MEDICAL_SAFETY_NOTICE,
      verificationMode: smsInfo.verificationMode,
      donors: donors.map((d) => serializeDonor(d, req))
    });
  } catch (error) {
    console.error("GET /api/donors error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load blood donor directory."
    });
  }
});

/**
 * GET /api/donors/mine
 * Returns the authenticated owner's verified donor profile(s) for availability management.
 */
router.get("/mine", requireDonorAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const orClauses = [];
    if (req.user) {
      orClauses.push({ ownerUserId: req.user._id });
      const userPhone = normalizePhone(req.user.phone);
      if (userPhone) {
        orClauses.push({ phone: userPhone });
      }
    }
    if (req.donorOwner) {
      orClauses.push({
        _id: req.donorOwner.donorId,
        phone: req.donorOwner.phone
      });
    }

    if (orClauses.length === 0) {
      return res.json({ success: true, donors: [] });
    }

    const donors = await BloodDonor.find({
      isPhoneVerified: true,
      isActive: true,
      $or: orClauses
    }).sort({ updatedAt: -1 });

    return res.json({
      success: true,
      donors: donors.map((d) => serializeDonor(d, req, { includeOwnerPhone: true }))
    });
  } catch (error) {
    console.error("GET /api/donors/mine error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load your donor profile."
    });
  }
});

/**
 * POST /api/donors/register
 * Step 1: Validate registration fields, save unverified donor record, and send 6-digit OTP.
 */
router.post("/register", otpRequestLimiter, optionalAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const {
      fullName,
      bloodGroup,
      phone,
      city,
      availableToDonate,
      consentToShareContact
    } = req.body || {};

    if (!fullName || String(fullName).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid full name (at least 2 characters)."
      });
    }

    if (!bloodGroup || !BloodDonor.VALID_BLOOD_GROUPS.includes(String(bloodGroup).trim())) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid blood group (A+, A-, B+, B-, AB+, AB-, O+, O-)."
      });
    }

    const normalizedPhone = normalizePhone(String(phone || ""));
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit mobile number (e.g., 9876543210 or +919876543210)."
      });
    }

    if (!city || String(city).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Please enter your city or location."
      });
    }

    const availableBool =
      availableToDonate === true ||
      availableToDonate === "true" ||
      availableToDonate === "yes" ||
      availableToDonate === "Yes";

    const consentBool =
      consentToShareContact === true ||
      consentToShareContact === "true" ||
      consentToShareContact === "on";

    let donor = await BloodDonor.findOne({ phone: normalizedPhone }).select(
      "+otpHash +otpSalt +otpExpiresAt +otpAttempts +otpResendCount +otpLastSentAt +otpWindowStart"
    );

    if (donor && donor.isPhoneVerified && donor.isActive) {
      return res.status(409).json({
        success: false,
        message:
          "A phone-verified donor profile already exists for this mobile number. Sign in to manage your availability."
      });
    }

    const now = Date.now();

    if (donor) {
      // Enforce cooldown & resend limits on pending unverified profile
      if (donor.otpLastSentAt && now - new Date(donor.otpLastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil(
          (OTP_RESEND_COOLDOWN_MS - (now - new Date(donor.otpLastSentAt).getTime())) / 1000
        );
        return res.status(429).json({
          success: false,
          message: `Please wait ${waitSec} seconds before requesting another OTP.`
        });
      }

      const windowStart = donor.otpWindowStart ? new Date(donor.otpWindowStart).getTime() : 0;
      if (windowStart && now - windowStart < OTP_RESEND_WINDOW_MS) {
        if ((donor.otpResendCount || 0) >= OTP_MAX_RESENDS_PER_WINDOW) {
          return res.status(429).json({
            success: false,
            message: "Maximum OTP requests reached for this number. Please try again after 30 minutes."
          });
        }
        donor.otpResendCount = (donor.otpResendCount || 0) + 1;
      } else {
        donor.otpWindowStart = new Date(now);
        donor.otpResendCount = 1;
      }

      donor.fullName = String(fullName).trim();
      donor.bloodGroup = String(bloodGroup).trim();
      donor.city = String(city).trim();
      donor.availableToDonate = availableBool;
      donor.consentToShareContact = consentBool;
      if (req.user) donor.ownerUserId = req.user._id;
    } else {
      donor = new BloodDonor({
        fullName: String(fullName).trim(),
        bloodGroup: String(bloodGroup).trim(),
        phone: normalizedPhone,
        city: String(city).trim(),
        availableToDonate: availableBool,
        consentToShareContact: consentBool,
        isPhoneVerified: false,
        isActive: false,
        ownerUserId: req.user ? req.user._id : null,
        otpWindowStart: new Date(now),
        otpResendCount: 1
      });
    }

    const otp = generateSixDigitOtp();
    donor.setOtp(otp, OTP_TTL_MS);
    donor.otpLastSentAt = new Date(now);

    const smsResult = await sendOtpSms(normalizedPhone, otp);
    await donor.save();

    return res.status(201).json({
      success: true,
      donorId: donor._id,
      maskedPhone: maskPhone(normalizedPhone),
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      resendCooldownSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      remainingResends: Math.max(0, OTP_MAX_RESENDS_PER_WINDOW - donor.otpResendCount),
      verificationMode: smsResult.verificationMode,
      provider: smsResult.provider,
      message: smsResult.message
    });
  } catch (error) {
    console.error("POST /api/donors/register error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to initiate donor registration."
    });
  }
});

/**
 * POST /api/donors/resend-otp
 * Sends a new 6-digit OTP to an unverified donor registration with cooldown and max-resend limits.
 */
router.post("/resend-otp", otpRequestLimiter, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { donorId, phone } = req.body || {};
    let donor = null;

    if (donorId && mongoose.Types.ObjectId.isValid(donorId)) {
      donor = await BloodDonor.findById(donorId).select(
        "+otpHash +otpSalt +otpExpiresAt +otpAttempts +otpResendCount +otpLastSentAt +otpWindowStart"
      );
    } else if (phone) {
      const normalized = normalizePhone(String(phone));
      if (normalized) {
        donor = await BloodDonor.findOne({ phone: normalized }).select(
          "+otpHash +otpSalt +otpExpiresAt +otpAttempts +otpResendCount +otpLastSentAt +otpWindowStart"
        );
      }
    }

    if (!donor) {
      return res.status(404).json({
        success: false,
        message: "Pending donor registration not found. Please fill out the registration form again."
      });
    }

    if (donor.isPhoneVerified && donor.isActive) {
      return res.status(400).json({
        success: false,
        message: "This mobile number is already verified and active."
      });
    }

    const now = Date.now();
    if (donor.otpLastSentAt && now - new Date(donor.otpLastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS - (now - new Date(donor.otpLastSentAt).getTime())) / 1000
      );
      return res.status(429).json({
        success: false,
        message: `Please wait ${waitSec} seconds before resending the OTP.`
      });
    }

    const windowStart = donor.otpWindowStart ? new Date(donor.otpWindowStart).getTime() : 0;
    if (windowStart && now - windowStart < OTP_RESEND_WINDOW_MS) {
      if ((donor.otpResendCount || 0) >= OTP_MAX_RESENDS_PER_WINDOW) {
        return res.status(429).json({
          success: false,
          message: "OTP resend limit reached (3 requests per 30 minutes). Please try again later."
        });
      }
      donor.otpResendCount = (donor.otpResendCount || 0) + 1;
    } else {
      donor.otpWindowStart = new Date(now);
      donor.otpResendCount = 1;
    }

    const otp = generateSixDigitOtp();
    donor.setOtp(otp, OTP_TTL_MS);
    donor.otpLastSentAt = new Date(now);

    const smsResult = await sendOtpSms(donor.phone, otp);
    await donor.save();

    return res.json({
      success: true,
      donorId: donor._id,
      maskedPhone: maskPhone(donor.phone),
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      resendCooldownSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      remainingResends: Math.max(0, OTP_MAX_RESENDS_PER_WINDOW - donor.otpResendCount),
      verificationMode: smsResult.verificationMode,
      provider: smsResult.provider,
      message: smsResult.message
    });
  } catch (error) {
    console.error("POST /api/donors/resend-otp error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to resend OTP."
    });
  }
});

/**
 * POST /api/donors/verify-otp
 * Step 2: Verify 6-digit OTP and activate the donor profile in MongoDB.
 */
router.post("/verify-otp", otpVerifyLimiter, optionalAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { donorId, otp } = req.body || {};

    if (!donorId || !mongoose.Types.ObjectId.isValid(donorId)) {
      return res.status(400).json({
        success: false,
        message: "Valid registration session ID is required."
      });
    }

    const cleanOtp = String(otp || "").trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit numeric OTP."
      });
    }

    const donor = await BloodDonor.findById(donorId).select(
      "+otpHash +otpSalt +otpExpiresAt +otpAttempts"
    );

    if (!donor) {
      return res.status(404).json({
        success: false,
        message: "Registration record not found."
      });
    }

    if (donor.isPhoneVerified && donor.isActive) {
      return res.status(400).json({
        success: false,
        message: "This donor profile is already phone verified."
      });
    }

    if ((donor.otpAttempts || 0) >= OTP_MAX_VERIFY_ATTEMPTS) {
      donor.clearOtp();
      await donor.save();
      return res.status(429).json({
        success: false,
        message: "Too many incorrect OTP attempts. Please request a new OTP."
      });
    }

    const check = donor.verifyOtpCode(cleanOtp);
    if (!check.valid) {
      if (check.reason === "expired") {
        donor.clearOtp();
        await donor.save();
        return res.status(400).json({
          success: false,
          message: "This OTP has expired. Please request a new OTP."
        });
      }
      if (check.reason === "no_otp") {
        return res.status(400).json({
          success: false,
          message: "No active OTP found. Please request a new OTP."
        });
      }
      donor.otpAttempts = (donor.otpAttempts || 0) + 1;
      const remaining = Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - donor.otpAttempts);
      if (remaining === 0) {
        donor.clearOtp();
      }
      await donor.save();
      return res.status(400).json({
        success: false,
        message:
          remaining > 0
            ? `Incorrect OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
            : "Incorrect OTP. Maximum attempts reached; please request a new OTP."
      });
    }

    // OTP verified! Activate profile
    donor.isPhoneVerified = true;
    donor.phoneVerifiedAt = new Date();
    donor.isActive = true;
    if (req.user && !donor.ownerUserId) {
      donor.ownerUserId = req.user._id;
    }
    donor.clearOtp();
    await donor.save();

    // Issue a signed owner token scoped to this verified donor profile
    const donorToken = signDonorOwnerToken(donor._id, donor.phone);

    // Attach temporary owner context for serialization
    req.donorOwner = { donorId: String(donor._id), phone: donor.phone };

    return res.json({
      success: true,
      message: "Mobile number verified! Your Blood Donor profile is now active.",
      donorToken,
      donor: serializeDonor(donor, req, { includeOwnerPhone: true })
    });
  } catch (error) {
    console.error("POST /api/donors/verify-otp error:", error);
    return res.status(500).json({
      success: false,
      message: "OTP verification failed. Please try again."
    });
  }
});

/**
 * PATCH /api/donors/:id/availability
 * Update donor availability (Available / Not Available).
 * Strictly restricted to the authenticated owner of the donor profile.
 */
router.patch("/:id/availability", requireDonorAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid donor profile ID." });
    }

    const { availableToDonate } = req.body || {};
    if (typeof availableToDonate !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "availableToDonate must be a boolean (true or false)."
      });
    }

    const donor = await BloodDonor.findById(id);
    if (!donor || !donor.isPhoneVerified) {
      return res.status(404).json({
        success: false,
        message: "Verified donor profile not found."
      });
    }

    if (!isDonorOwner(donor, req)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only the authenticated owner of this donor profile can update availability."
      });
    }

    donor.availableToDonate = availableToDonate;
    await donor.save();

    return res.json({
      success: true,
      message: availableToDonate
        ? "Status updated to Available to Donate."
        : "Status updated to Not Available.",
      donor: serializeDonor(donor, req, { includeOwnerPhone: true })
    });
  } catch (error) {
    console.error("PATCH /api/donors/:id/availability error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update availability status."
    });
  }
});

/**
 * POST /api/donors/:id/report
 * Report a donor profile for inaccurate or suspicious information.
 * Duplicate reports from the same user/IP are blocked.
 * Repeated credible reports temporarily hide the profile (never permanently deletes).
 */
router.post("/:id/report", reportLimiter, optionalAuth, async (req, res) => {
  try {
    if (!checkDbConnection(res)) return;

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid donor profile ID." });
    }

    const { reason, details } = req.body || {};
    if (!reason || !DonorReport.REPORT_REASONS[reason]) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid report reason."
      });
    }

    const cleanDetails = String(details || "").trim().slice(0, 400);

    const donor = await BloodDonor.findById(id);
    if (!donor || !donor.isActive || !donor.isPhoneVerified) {
      return res.status(404).json({
        success: false,
        message: "Donor profile not found."
      });
    }

    if (isDonorOwner(donor, req)) {
      return res.status(400).json({
        success: false,
        message: "You cannot report your own donor profile."
      });
    }

    const reporterKey = buildReporterKey(req);

    // Safeguard against duplicate reports from the same reporter
    const existingReport = await DonorReport.findOne({
      donorId: donor._id,
      reporterKey
    });

    if (existingReport) {
      return res.status(409).json({
        success: false,
        message: "You have already submitted a report for this donor profile."
      });
    }

    await DonorReport.create({
      donorId: donor._id,
      reason,
      details: cleanDetails,
      reporterKey,
      reporterUserId: req.user ? req.user._id : null
    });

    // Count unique credible reports within the recent window
    const windowCutoff = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recentUniqueReports = await DonorReport.countDocuments({
      donorId: donor._id,
      createdAt: { $gte: windowCutoff }
    });

    donor.reportCount = recentUniqueReports;

    // Rule-based temporary hiding (never permanently deletes donor account)
    let hidNow = false;
    if (recentUniqueReports >= REPORT_HIDE_THRESHOLD && !donor.isTemporarilyHidden) {
      donor.isTemporarilyHidden = true;
      donor.hiddenAt = new Date();
      donor.hiddenUntil = new Date(
        Date.now() + REPORT_HIDE_DURATION_DAYS * 24 * 60 * 60 * 1000
      );
      donor.hiddenReason = `Temporarily hidden after ${recentUniqueReports} independent community reports.`;
      hidNow = true;
    }

    await donor.save();

    return res.status(201).json({
      success: true,
      temporarilyHidden: Boolean(donor.isTemporarilyHidden),
      message: hidNow
        ? "Thank you for reporting. This profile has been temporarily hidden due to multiple community reports."
        : "Thank you. Your report has been recorded and will help keep the directory reliable."
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "You have already submitted a report for this donor profile."
      });
    }
    console.error("POST /api/donors/:id/report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit report. Please try again."
    });
  }
});

module.exports = router;
