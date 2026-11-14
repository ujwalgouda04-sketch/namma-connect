const mongoose = require("mongoose");
const crypto = require("crypto");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  email: { type: String, trim: true, lowercase: true, default: "" },
  area: { type: String, trim: true, default: "" },
  role: { type: String, enum: ["citizen", "provider"], default: "citizen" },
  passwordHash: { type: String, required: true },
  salt: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

UserSchema.methods.setPassword = function(password) {
  this.salt = crypto.randomBytes(16).toString("hex");
  this.passwordHash = crypto.scryptSync(password, this.salt, 64).toString("hex");
};

UserSchema.methods.validatePassword = function(password) {
  const hash = crypto.scryptSync(password, this.salt, 64).toString("hex");
  return this.passwordHash === hash;
};

module.exports = mongoose.model("User", UserSchema);
