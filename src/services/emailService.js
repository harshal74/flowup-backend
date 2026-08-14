let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  console.warn("[Email] nodemailer not installed — run 'npm install'. OTPs will be logged to console only.");
}

// Do NOT cache the transporter at startup — create fresh each time
// This avoids issues when env vars are loaded after module init
function createTransporter() {
  if (!nodemailer) {
    console.warn("[Email] nodemailer not available");
    return null;
  }

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass || user === "your-email@gmail.com" || pass === "your-app-password-here") {
    console.warn("[Email] EMAIL_USER / EMAIL_PASS not configured in .env");
    return null;
  }

  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.gmail.com",
    port:   Number(process.env.EMAIL_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth: { user, pass },
    connectionTimeout: 10000, // 10s — never hangs the request indefinitely
    greetingTimeout:   10000,
    socketTimeout:     15000,
    tls: {
      rejectUnauthorized: false,
    },
  });
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail({ to, name, otp }) {
  const expiryMinutes = Number(process.env.OTP_EXPIRY_MINUTES) || 10;
  const transporter   = createTransporter();

  if (!transporter) {
    // Dev fallback — always print to console so dev can test without SMTP
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  [EMAIL NOT SENT — NO SMTP CONFIG]`);
    console.log(`║  Recipient : ${to}`);
    console.log(`║  OTP Code  : ${otp}`);
    console.log(`║  Valid for : ${expiryMinutes} min`);
    console.log(`╚══════════════════════════════════════╝\n`);
    return { success: true, dev: true };
  }

  const from = process.env.EMAIL_FROM || `"FlowUp Staff" <${process.env.EMAIL_USER}>`;

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: "FlowUp Staff — Email Verification OTP",
      text: `Hi ${name},\n\nYour OTP is: ${otp}\n\nValid for ${expiryMinutes} minutes. Do not share this code.\n\n— FlowUp`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#111827;border-radius:16px;color:#f9fafb">
          <div style="text-align:center;margin-bottom:24px">
            <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:#f97316;border-radius:14px;margin-bottom:12px">
              <span style="font-size:24px">🍴</span>
            </div>
            <h2 style="margin:0;color:#f9fafb;font-size:20px">Email Verification</h2>
          </div>
          <p style="color:#d1d5db;margin-bottom:8px">Hi <strong style="color:#f9fafb">${name}</strong>,</p>
          <p style="color:#d1d5db">Use the code below to verify your email address:</p>
          <div style="text-align:center;margin:28px 0">
            <div style="display:inline-block;background:#1f2937;border:2px solid #f97316;border-radius:14px;padding:18px 40px">
              <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#f97316;font-family:monospace">${otp}</span>
            </div>
          </div>
          <p style="color:#9ca3af;font-size:13px;text-align:center">
            Expires in <strong style="color:#f9fafb">${expiryMinutes} minutes</strong>. Do not share this code.
          </p>
          <hr style="border:none;border-top:1px solid #374151;margin:24px 0"/>
          <p style="color:#6b7280;font-size:12px;text-align:center">— The FlowUp Team</p>
        </div>
      `,
    });

    console.log(`[Email] ✓ OTP sent to ${to}  MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error("[Email] ✗ sendMail failed:", err.message);
    // Always log OTP to console as fallback
    console.log(`[Email] FALLBACK OTP for ${to}: ${otp}`);
    return { success: false, error: err.message };
  }
}

/**
 * Test the SMTP connection without sending an email.
 * Used by the /api/staff/test-email diagnostic endpoint.
 */
async function testSmtpConnection() {
  const transporter = createTransporter();
  if (!transporter) {
    return { ok: false, reason: "SMTP not configured — EMAIL_USER or EMAIL_PASS missing in .env" };
  }
  try {
    // 8-second timeout so the test endpoint doesn't hang
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SMTP verify timed out after 8s")), 8000)
      ),
    ]);
    return { ok: true, user: process.env.EMAIL_USER };
  } catch (err) {
    return { ok: false, reason: err.message, code: err.code };
  }
}

module.exports = { generateOtp, sendOtpEmail, testSmtpConnection };
