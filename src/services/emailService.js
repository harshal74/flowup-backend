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

// ── sendEnquiryEmail ──────────────────────────────────────────────
/**
 * Send a "Contact / Get in Touch" enquiry from the marketing landing page
 * to the FlowUp sales inbox.
 *
 * Recipient defaults to CONTACT_RECIPIENT_EMAIL (falls back to EMAIL_USER).
 * Sets replyTo to the enquirer's email so replies go straight to them.
 *
 * Returns { messageId } on success. THROWS on any failure so the caller
 * can report accurate status to the frontend.
 */
async function sendEnquiryEmail({ name, restaurant, phone, email, city, message }) {
  const transporter = createTransporter();

  if (!transporter) {
    const err = new Error("SMTP not configured. EMAIL_USER and EMAIL_PASS must be set in .env");
    err.code = "SMTP_NOT_CONFIGURED";
    throw err;
  }

  const to   = process.env.CONTACT_RECIPIENT_EMAIL || process.env.EMAIL_USER;
  const from = process.env.EMAIL_FROM || `"FlowUp Website" <${process.env.EMAIL_USER}>`;

  const safe = (v) => String(v || "").trim() || "—";

  const info = await transporter.sendMail({
    from,
    to,
    replyTo: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined,
    subject: `New FlowUp Enquiry — ${safe(restaurant)} (${safe(name)})`,
    text:
      `New FlowUp Enquiry\n\n` +
      `Name: ${safe(name)}\n` +
      `Restaurant: ${safe(restaurant)}\n` +
      `Phone: ${safe(phone)}\n` +
      `Email: ${safe(email)}\n` +
      `City: ${safe(city)}\n\n` +
      `Message:\n${safe(message)}\n`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0b1220;border-radius:16px;color:#f9fafb">
        <h2 style="margin:0 0 16px;color:#f97316;font-size:20px">New FlowUp Enquiry</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#e5e7eb">
          <tr><td style="padding:6px 0;color:#9ca3af;width:120px">Name</td><td style="padding:6px 0"><strong>${safe(name)}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#9ca3af">Restaurant</td><td style="padding:6px 0"><strong>${safe(restaurant)}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#9ca3af">Phone</td><td style="padding:6px 0">${safe(phone)}</td></tr>
          <tr><td style="padding:6px 0;color:#9ca3af">Email</td><td style="padding:6px 0">${safe(email)}</td></tr>
          <tr><td style="padding:6px 0;color:#9ca3af">City</td><td style="padding:6px 0">${safe(city)}</td></tr>
        </table>
        <div style="margin-top:16px;padding:16px;background:#111827;border-radius:12px;border:1px solid #1f2937">
          <p style="margin:0 0 6px;color:#9ca3af;font-size:12px">Message</p>
          <p style="margin:0;white-space:pre-wrap;color:#f9fafb">${safe(message)}</p>
        </div>
        <p style="color:#6b7280;font-size:12px;margin-top:20px">Sent from the FlowUp landing page contact form.</p>
      </div>
    `,
  });

  console.log(`[Email] ✓ Enquiry email sent to ${to} — MessageId: ${info.messageId}`);
  return { messageId: info.messageId };
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

module.exports = { generateOtp, sendOtpEmail, sendEnquiryEmail, testSmtpConnection };
