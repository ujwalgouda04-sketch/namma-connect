const mongoose = require("mongoose");
const crypto = require("crypto");

const VALID_BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const BloodDonorSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, "Full name is required."],
      trim: true,
      minlength: [2, "Full name must be at least 2 characters."],
      maxlength: [100, "Full name must be under 100 characters."]
    },
    bloodGroup: {
      type: String,
      required: [true, "Blood group is required."],
      enum: {
        values: VALID_BLOOD_GROUPS,
        message: "Blood group must be one of A+, A-, B+, B-, AB+, AB-, O+, O-."
      }
    },
    phone: {
      type: String,
      required: [true, "Mobile number is required."],
      unique: true,
      trim: true
    },
    city: {
      type: String,
      required: [true, "City or location is required."],
      trim: true,
      minlength: [2, "City / Location must be at least 2 characters."],
      maxlength: [100, "City / Location must be under 100 characters."]
    },
    availableToDonate: {
      type: Boolean,
      default: true
    },
    consentToShareContact: {
      type: Boolean,
      required: true,
      default: false
    },
    // Phone OTP Verification state (only confirms phone reachability, NOT medical eligibility)
    isPhoneVerified: {
      type: Boolean,
      default: false
    },
    phoneVerifiedAt: {
      type: Date,
      default: null
    },
    isActive: {
      type: Boolean,
      default: false
    },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },

    // Hashed OTP fields (never exposed in default queries)
    otpHash: { type: String, select: false, default: null },
    otpSalt: { type: String, select: false, default: null },
    otpExpiresAt: { type: Date, select: false, default: null },
    otpAttempts: { type: Number, select: false, default: 0 },
    otpResendCount: { type: Number, select: false, default: 0 },
    otpLastSentAt: { type: Date, select: false, default: null },
    otpWindowStart: { type: Date, select: false, default: null },

    // Rule-based temporary hiding after repeated credible reports (never auto-deleted)
    reportCount: {
      type: Number,
      default: 0
    },
    isTemporarilyHidden: {
      type: Boolean,
      default: false
    },
    hiddenReason: {
      type: String,
      default: ""
    },
    hiddenAt: {
      type: Date,
      default: null
    },
    hiddenUntil: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

BloodDonorSchema.index({
  isActive: 1,
  isPhoneVerified: 1,
  isTemporarilyHidden: 1,
  bloodGroup: 1,
  city: 1
});

BloodDonorSchema.methods.setOtp = function (plainOtp, ttlMs = 5 * 60 * 1000) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHmac("sha256", salt)
    .update(String(plainOtp))
    .digest("hex");
  this.otpSalt = salt;
  this.otpHash = hash;
  this.otpExpiresAt = new Date(Date.now() + ttlMs);
  this.otpAttempts = 0;
};

BloodDonorSchema.methods.verifyOtpCode = function (candidateOtp) {
  if (!this.otpHash || !this.otpSalt || !this.otpExpiresAt) {
    return { valid: false, reason: "no_otp" };
  }
  if (Date.now() > new Date(this.otpExpiresAt).getTime()) {
    return { valid: false, reason: "expired" };
  }
  const candidateHash = crypto
    .createHmac("sha256", this.otpSalt)
    .update(String(candidateOtp).trim())
    .digest("hex");

  const hashBuf = Buffer.from(this.otpHash, "hex");
  const candBuf = Buffer.from(candidateHash, "hex");
  if (hashBuf.length !== candBuf.length || !crypto.timingSafeEqual(hashBuf, candBuf)) {
    return { valid: false, reason: "mismatch" };
  }
  return { valid: true };
};

BloodDonorSchema.methods.clearOtp = function () {
  this.otpHash = null;
  this.otpSalt = null;
  this.otpExpiresAt = null;
  this.otpAttempts = 0;
};

BloodDonorSchema.statics.VALID_BLOOD_GROUPS = VALID_BLOOD_GROUPS;

module.exports = mongoose.model("BloodDonor", BloodDonorSchema);
