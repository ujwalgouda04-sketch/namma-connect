const mongoose = require("mongoose");

const REPORT_REASONS = {
  incorrect_contact: "Incorrect contact information",
  fake_profile: "Fake profile",
  incorrect_blood_group: "Incorrect blood group information",
  other: "Other concerns"
};

const DonorReportSchema = new mongoose.Schema(
  {
    donorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BloodDonor",
      required: true,
      index: true
    },
    reason: {
      type: String,
      required: [true, "A report reason is required."],
      enum: {
        values: Object.keys(REPORT_REASONS),
        message: "Invalid report reason selected."
      }
    },
    details: {
      type: String,
      trim: true,
      maxlength: [400, "Additional details must be 400 characters or fewer."],
      default: ""
    },
    // Hashed identifier (authenticated user ID or IP hash) to prevent duplicate abusive reports
    reporterKey: {
      type: String,
      required: true
    },
    reporterUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Safeguard: One report per unique reporter per donor profile
DonorReportSchema.index({ donorId: 1, reporterKey: 1 }, { unique: true });

DonorReportSchema.statics.REPORT_REASONS = REPORT_REASONS;

module.exports = mongoose.model("DonorReport", DonorReportSchema);
