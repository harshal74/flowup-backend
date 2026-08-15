/**
 * Email Service — OTP delivery via Nodemailer / Gmail SMTP.
 *
 * sendOtpEmail() THROWS on failure so callers can distinguish
 * "email sent" from "email failed" and report accurately to the frontend.
 *
 * No credentials, App Passwords, or OTP values are ever logged.
 */

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  console.warn("[Email] nodemailer not installed. Run: npm install nodemailer");
}

// ── Transporter factory ───────────────────────────────────────────
// Created fresh on each call so .env values loaded after startup are
// always picked up. The connectionTimeout prevents indefinite hangs.
function createTransporter() {
  if (!nodemailer) return null;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (
    !user || !pass ||
    user === "your-email@gmail.com" ||
    pass === "your-app-password-here"
  ) {
    return null; // Not configured — caller handles the null case
  }

  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || "smtp.gmail.com",
    port:   Number(process.env.EMAIL_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth:   { user, pass },
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
    tls: { rejectUnauthorized: false },
  });
}

// ── OTP generator ─────────────────────────────────────────────────
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── sendOtpEmail ──────────────────────────────────────────────────
/**
 * Send the OTP verification email.
 *
 * Returns { messageId } on success.
 *
 * THROWS on any failure (SMTP auth error, network error, not configured, etc.)
 * so callers can catch and report the real status to the frontend.
 *
 * SECURITY: OTP value, passwords, and App Passwords are NEVER logged.
 */
async function sendOtpEmail({ to, name, otp }) {
  const expiryMinutes = Number(process.env.OTP_EXPIRY_MINUTES) || 10;
  const transporter   = createTransporter();

  // No SMTP config — dev fallback: print OTP to terminal, then THROW
  // so the caller knows email was not actually delivered.
  if (!transporter) {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  [EMAIL NOT SENT — NO SMTP CONFIG]   ║`);
    console.log(`║  Recipient : ${to.padEnd(22)}║`);
    console.log(`║  Valid for : ${String(expiryMinutes + " min").padEnd(22)}║`);
    console.log(`╚══════════════════════════════════════╝\n`);
    // OTP intentionally omitted from the log in production.
    // In dev, check MongoDB directly or add NODE_ENV=development guard:
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Email] DEV — OTP for ${to}: ${otp}`);
    }
    const err = new Error("SMTP not configured. EMAIL_USER and EMAIL_PASS must be set in .env");
    err.code = "SMTP_NOT_CONFIGURED";
    throw err;
  }

  try {
    const from = process.env.EMAIL_FROM || `"FlowUp Staff" <${process.env.EMAIL_USER}>`;

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

    // Log success — messageId only, no credentials or OTP
    console.log(`[Email] ✓ OTP email sent to ${to} — MessageId: ${info.messageId}`);
    return { messageId: info.messageId };

  } catch (err) {
    // Log enough to diagnose SMTP issues without exposing secrets
    console.error("[Email] ✗ sendMail failed:", {
      to,
      message:  err.message,
      code:     err.code     || "unknown",
      response: err.response || null,
    });
    // Re-throw so the caller knows delivery failed
    throw err;
  }
}

// ── SMTP health check (used by /api/staff/test-email and server startup) ──
async function testSmtpConnection() {
  const transporter = createTransporter();
  if (!transporter) {
    return { ok: false, reason: "SMTP not configured — EMAIL_USER or EMAIL_PASS missing or using placeholder values in .env" };
  }
  try {
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SMTP verify timed out after 8 s")), 8000)
      ),
    ]);
    return { ok: true, user: process.env.EMAIL_USER };
  } catch (err) {
    return { ok: false, reason: err.message, code: err.code };
  }
}

module.exports = { generateOtp, sendOtpEmail, testSmtpConnection };
