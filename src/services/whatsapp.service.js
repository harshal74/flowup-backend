const twilio = require("twilio");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber =
  process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// Change this to true after you upgrade Twilio and configure
// a real WhatsApp Business Sender.
const ENABLE_WHATSAPP = false;

const client =
  ENABLE_WHATSAPP && accountSid && authToken
    ? twilio(accountSid, authToken)
    : null;

function toWhatsAppNumber(mobile) {
  if (!mobile) return null;

  const digits = mobile.replace(/\D/g, "");

  if (digits.length === 12 && digits.startsWith("91")) {
    return `whatsapp:+${digits}`;
  }

  const ten = digits.replace(/^0/, "").slice(-10);

  if (ten.length !== 10) return null;

  return `whatsapp:+91${ten}`;
}

function buildBillMessage({ bill, customerName, restaurantName }) {
  const date = new Date(bill.createdAt).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const itemLines =
    bill.items?.length > 0
      ? bill.items
          .map(
            (item) =>
              `• ${item.quantity} x ${item.name} - ₹${Number(item.total).toFixed(
                2
              )}`
          )
          .join("\n")
      : "No Items";

  return `
🧾 BILL

Restaurant : ${restaurantName}
Invoice    : ${bill.invoiceNumber}
Date       : ${date}
Table      : ${bill.tableNumber || "-"}

Items
-------------------------
${itemLines}

-------------------------
Subtotal : ₹${bill.subtotal.toFixed(2)}
GST      : ₹${bill.gst.toFixed(2)}
Discount : ₹${bill.discount.toFixed(2)}
Total    : ₹${bill.grandTotal.toFixed(2)}

Payment  : ${bill.paymentMethod}

Thank you ${customerName}! 🙏
`;
}

async function sendBillWhatsApp({
  mobile,
  bill,
  customerName,
  restaurantName,
}) {
  console.log("====================================");
  console.log("WhatsApp Notification");
  console.log("====================================");

  const to = toWhatsAppNumber(mobile);

  if (!to) {
    console.log("Invalid customer number.");
    return {
      success: false,
      error: "Invalid Number",
    };
  }

  const body = buildBillMessage({
    bill,
    customerName,
    restaurantName,
  });

  // Development Mode
  if (!ENABLE_WHATSAPP) {
    console.log("Development Mode (Twilio Disabled)");
    console.log("Recipient :", to);
    console.log("------------------------------------");
    console.log(body);
    console.log("------------------------------------");

    return {
      success: true,
      sid: "DEV_MODE",
    };
  }

  // Production
  try {
    const message = await client.messages.create({
      from: fromNumber,
      to,
      body,
    });

    console.log("WhatsApp Sent:", message.sid);

    return {
      success: true,
      sid: message.sid,
    };
  } catch (err) {
    console.error("Twilio Error");
    console.error(err);

    return {
      success: false,
      error: err.message,
    };
  }
}

module.exports = {
  sendBillWhatsApp,
};