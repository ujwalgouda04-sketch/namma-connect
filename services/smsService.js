/**
 * SMS Delivery Service for Blood Donor Mobile Number Verification
 *
 * Supported Real SMS Providers (configured via .env):
 *  1. Twilio (Global & India, free trial):
 *       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *  2. 2Factor.in (India OTP specialist, free trial credits):
 *       TWOFACTOR_API_KEY
 *  3. Fast2SMS (India):
 *       FAST2SMS_API_KEY
 *
 * Development-Only Fallback:
 *  When no SMS credentials are configured and NODE_ENV !== "production",
 *  falls back to Development Demo OTP Mode (prints OTP in backend console only).
 */

function hasTwilioConfig() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
  );
}

function hasTwoFactorConfig() {
  return Boolean(process.env.TWOFACTOR_API_KEY);
}

function hasFast2SmsConfig() {
  return Boolean(process.env.FAST2SMS_API_KEY);
}

function getSmsModeInfo() {
  if (hasTwilioConfig()) {
    return { verificationMode: "sms", provider: "twilio" };
  }
  if (hasTwoFactorConfig()) {
    return { verificationMode: "sms", provider: "2factor" };
  }
  if (hasFast2SmsConfig()) {
    return { verificationMode: "sms", provider: "fast2sms" };
  }
  if (process.env.NODE_ENV === "production" || process.env.REQUIRE_REAL_SMS === "true") {
    return { verificationMode: "unconfigured", provider: "none" };
  }
  return { verificationMode: "dev-demo", provider: "dev-demo-console" };
}

async function sendViaTwilio(toPhone, otp) {
  const sid = process.env.TWILIO_ACCOUNT_SID.trim();
  const token = process.env.TWILIO_AUTH_TOKEN.trim();
  const from = process.env.TWILIO_FROM_NUMBER.trim();

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const body = new URLSearchParams({
    To: toPhone,
    From: from,
    Body: `Namma Connect Blood Donor OTP: ${otp}. Valid for 5 minutes. Do not share this code.`
  });

  const authHeader = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    const detail = errJson.message || `HTTP ${response.status}`;
    throw new Error(`Twilio SMS failed: ${detail}`);
  }

  return {
    verificationMode: "sms",
    provider: "twilio",
    message: "A 6-digit verification OTP has been sent via SMS to your mobile number."
  };
}

async function sendViaTwoFactor(toPhone, otp) {
  const apiKey = process.env.TWOFACTOR_API_KEY.trim();
  const digits = toPhone.replace(/\D/g, "");
  const phoneParam = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  const template = (process.env.TWOFACTOR_TEMPLATE || "").trim();

  const endpoint = template
    ? `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${encodeURIComponent(phoneParam)}/${encodeURIComponent(otp)}/${encodeURIComponent(template)}`
    : `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${encodeURIComponent(phoneParam)}/${encodeURIComponent(otp)}`;

  const response = await fetch(endpoint, { method: "GET" });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || String(data.Status || "").toLowerCase() !== "success") {
    throw new Error(`2Factor SMS failed: ${data.Details || response.status}`);
  }

  return {
    verificationMode: "sms",
    provider: "2factor",
    message: "A 6-digit verification OTP has been sent via SMS to your mobile number."
  };
}

async function sendViaFast2Sms(toPhone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY.trim();
  const digits = toPhone.replace(/\D/g, "");
  const tenDigit = digits.length > 10 ? digits.slice(-10) : digits;

  // Try Fast2SMS OTP route first, fallback to Quick SMS route if needed
  const payload =
    process.env.FAST2SMS_ROUTE === "q"
      ? {
          route: "q",
          message: `Namma Connect Blood Donor OTP: ${otp}. Valid for 5 minutes.`,
          flash: 0,
          numbers: tenDigit
        }
      : {
          route: "otp",
          variables_values: String(otp),
          numbers: tenDigit
        };

  const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.return === false) {
    throw new Error(`Fast2SMS failed: ${data.message || response.status}`);
  }

  return {
    verificationMode: "sms",
    provider: "fast2sms",
    message: "A 6-digit verification OTP has been sent via SMS to your mobile number."
  };
}

/**
 * Sends a 6-digit OTP to the given normalized phone number.
 * Never returns the OTP value to the caller for API responses.
 */
async function sendOtpSms(normalizedPhone, otp) {
  if (hasTwilioConfig()) {
    return await sendViaTwilio(normalizedPhone, otp);
  }

  if (hasTwoFactorConfig()) {
    return await sendViaTwoFactor(normalizedPhone, otp);
  }

  if (hasFast2SmsConfig()) {
    return await sendViaFast2Sms(normalizedPhone, otp);
  }

  if (process.env.NODE_ENV === "production" || process.env.REQUIRE_REAL_SMS === "true") {
    throw new Error(
      "SMS provider is not configured. Add TWILIO_* credentials, TWOFACTOR_API_KEY, or FAST2SMS_API_KEY in .env to send real SMS OTPs."
    );
  }

  // Development-only demo OTP mode: log strictly on backend server console
  console.log("============================================================");
  console.log("[DEV-ONLY DEMO OTP MODE — NO SMS PROVIDER CONFIGURED]");
  console.log(`  Mobile Number : ${normalizedPhone}`);
  console.log(`  6-Digit OTP   : ${otp}`);
  console.log("  Expires In    : 5 minutes");
  console.log("  Note          : Add TWILIO_*, TWOFACTOR_API_KEY, or FAST2SMS_API_KEY to .env for real SMS.");
  console.log("============================================================");

  return {
    verificationMode: "dev-demo",
    provider: "dev-demo-console",
    message:
      "Development Demo Mode: Add an SMS provider key (Twilio, 2Factor, or Fast2SMS) in .env to deliver SMS to your phone. For now, check the server console for the 6-digit OTP."
  };
}

module.exports = {
  sendOtpSms,
  getSmsModeInfo
};
