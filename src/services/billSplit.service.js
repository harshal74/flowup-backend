/**
 * Split-bill math. Pure functions, no DB access.
 *
 * All arithmetic is done in integer paise so the parts always add up to the
 * bill exactly: each component (subtotal, sgst, cgst, discount, amount) is
 * divided with floor() and the leftover paise go to the LAST split.
 *
 *   buildSplits(bill, { splitType, splits, defaultMethod })
 *     → { splits: [...] }  or  { error: "message" }
 */

const MAX_SPLITS = 20;
const PAYMENT_METHODS = ["Cash", "UPI", "Card"];

const toP = (rupees) => Math.round((Number(rupees) || 0) * 100);
const fromP = (paise) => Math.round(paise) / 100;

/** Divide totalP across weights; floor each share, remainder on the last. */
function allocate(totalP, weights) {
  const W = weights.reduce((s, w) => s + w, 0);
  const n = weights.length;
  const out = new Array(n).fill(0);
  if (n === 0) return out;
  if (W <= 0) {
    // No meaningful weights → equal shares
    return allocate(totalP, weights.map(() => 1));
  }
  let used = 0;
  for (let i = 0; i < n - 1; i++) {
    out[i] = Math.floor((totalP * weights[i]) / W);
    used += out[i];
  }
  out[n - 1] = totalP - used;
  return out;
}

/** Stable key for a bill line: same menu item at the same unit price. */
const itemKey = (menuItemId, price) => `${String(menuItemId)}|${toP(price)}`;

/** Bill item lines grouped by itemKey → { key, menuItemId, name, priceP, quantity } */
function groupBillItems(items) {
  const map = new Map();
  for (const it of items || []) {
    const key = itemKey(it.menuItemId, it.price);
    const cur = map.get(key);
    if (cur) cur.quantity += Number(it.quantity) || 0;
    else map.set(key, { key, menuItemId: it.menuItemId, name: it.name, priceP: toP(it.price), quantity: Number(it.quantity) || 0 });
  }
  return map;
}

function cleanLabel(label, i) {
  const s = typeof label === "string" ? label.trim().slice(0, 40) : "";
  return s || `Guest ${i + 1}`;
}

function cleanMethod(m, fallback) {
  return PAYMENT_METHODS.includes(m) ? m : (PAYMENT_METHODS.includes(fallback) ? fallback : "Cash");
}

/**
 * @param {object} bill  { items, subtotal, sgst, cgst, discount, grandTotal }
 * @param {object} req   { splitType, splits, splitCount, defaultMethod }
 *   EQUAL:   splitCount (2–20) or splits[] (its length; optional labels)
 *   BY_ITEM: splits[{ label?, paymentMethod?, items[{ key | menuItemId+price, quantity }] }]
 *   CUSTOM:  splits[{ label?, paymentMethod?, amount }]
 */
function buildSplits(bill, { splitType, splits, splitCount, defaultMethod } = {}) {
  const totals = {
    sub: toP(bill.subtotal),
    sgst: toP(bill.sgst),
    cgst: toP(bill.cgst),
    disc: toP(bill.discount),
    grand: toP(bill.grandTotal),
  };

  const assemble = (parts) => parts.map((p, i) => ({
    label: p.label,
    items: p.items || [],
    subtotal: fromP(p.sub),
    sgst: fromP(p.sgst),
    cgst: fromP(p.cgst),
    gst: fromP(p.sgst + p.cgst),
    discount: fromP(p.disc),
    amount: fromP(p.amount),
    paymentMethod: cleanMethod(p.paymentMethod, defaultMethod),
    paymentStatus: "Pending",
    paidAt: null,
  }));

  // ── EQUAL ────────────────────────────────────────────────────
  if (splitType === "EQUAL") {
    // Number of people: `splitCount`, or the length of `splits` (labels optional)
    const n = splitCount !== undefined && splitCount !== null
      ? Number(splitCount)
      : (Array.isArray(splits) ? splits.length : NaN);
    if (!Number.isInteger(n) || n < 2 || n > MAX_SPLITS) {
      return { error: `Equal split needs between 2 and ${MAX_SPLITS} people.` };
    }
    if (totals.grand <= 0) return { error: "Nothing to split — the bill total is zero." };
    const w = new Array(n).fill(1);
    const sub = allocate(totals.sub, w), sgst = allocate(totals.sgst, w),
      cgst = allocate(totals.cgst, w), disc = allocate(totals.disc, w), amount = allocate(totals.grand, w);
    const labels = Array.isArray(splits) ? splits : [];
    return {
      splits: assemble(w.map((_, i) => ({
        label: cleanLabel(labels[i]?.label, i),
        paymentMethod: labels[i]?.paymentMethod,
        sub: sub[i], sgst: sgst[i], cgst: cgst[i], disc: disc[i], amount: amount[i],
      }))),
    };
  }

  if (!Array.isArray(splits)) return { error: "Splits are required." };
  if (splits.length < 2 || splits.length > MAX_SPLITS) {
    return { error: `A split bill needs between 2 and ${MAX_SPLITS} parts.` };
  }

  // ── BY_ITEM ──────────────────────────────────────────────────
  if (splitType === "BY_ITEM") {
    const lines = groupBillItems(bill.items);
    const assigned = new Map([...lines.keys()].map((k) => [k, 0]));
    const perSplit = [];

    for (let i = 0; i < splits.length; i++) {
      const s = splits[i] || {};
      const rows = Array.isArray(s.items) ? s.items : [];
      const items = [];
      let subP = 0;
      for (const row of rows) {
        const key = typeof row?.key === "string" && row.key
          ? row.key
          : itemKey(row?.menuItemId, row?.price);
        const line = lines.get(key);
        const qty = Number(row?.quantity);
        if (!line) return { error: `Split ${i + 1} has an item that is not on this bill.` };
        if (!Number.isInteger(qty) || qty < 0) return { error: `Split ${i + 1} has an invalid quantity for ${line.name}.` };
        if (qty === 0) continue;
        assigned.set(key, assigned.get(key) + qty);
        const totalP = line.priceP * qty;
        subP += totalP;
        items.push({ menuItemId: line.menuItemId, name: line.name, quantity: qty, price: fromP(line.priceP), total: fromP(totalP) });
      }
      if (items.length === 0) return { error: `${cleanLabel(s.label, i)} has no items assigned.` };
      perSplit.push({ label: cleanLabel(s.label, i), paymentMethod: s.paymentMethod, items, subP });
    }

    for (const [key, qty] of assigned) {
      const line = lines.get(key);
      if (qty !== line.quantity) {
        return {
          error: qty < line.quantity
            ? `${line.quantity - qty} × ${line.name} is not assigned to anyone.`
            : `${line.name} is assigned ${qty} times but the bill has ${line.quantity}.`,
        };
      }
    }

    // Items always sum to the bill subtotal; tax and discount follow each
    // person's share of the subtotal, with leftover paise on the last split.
    const w = perSplit.map((p) => p.subP);
    const sgst = allocate(totals.sgst, w), cgst = allocate(totals.cgst, w), disc = allocate(totals.disc, w);
    const parts = perSplit.map((p, i) => ({
      ...p, sub: p.subP, sgst: sgst[i], cgst: cgst[i], disc: disc[i],
      amount: p.subP + sgst[i] + cgst[i] - disc[i],
    }));
    if (parts.some((p) => p.amount < 0)) return { error: "Discount is larger than one person's share. Adjust the split." };
    const sum = parts.reduce((s, p) => s + p.amount, 0);
    if (sum !== totals.grand) return { error: "Split amounts do not add up to the bill total." };
    return { splits: assemble(parts) };
  }

  // ── CUSTOM ───────────────────────────────────────────────────
  if (splitType === "CUSTOM") {
    if (totals.grand <= 0) return { error: "Nothing to split — the bill total is zero." };
    const amounts = splits.map((s) => toP(s?.amount));
    if (amounts.some((a) => !Number.isFinite(a) || a <= 0)) {
      return { error: "Every custom amount must be more than ₹0." };
    }
    const sum = amounts.reduce((s, a) => s + a, 0);
    if (Math.abs(sum - totals.grand) > 1) {
      return { error: `Custom amounts add up to ₹${fromP(sum).toFixed(2)} but the bill is ₹${fromP(totals.grand).toFixed(2)}.` };
    }
    amounts[amounts.length - 1] += totals.grand - sum; // absorb the ±₹0.01 tolerance
    if (amounts[amounts.length - 1] <= 0) return { error: "Every custom amount must be more than ₹0." };

    const sub = allocate(totals.sub, amounts), sgst = allocate(totals.sgst, amounts),
      cgst = allocate(totals.cgst, amounts), disc = allocate(totals.disc, amounts);
    return {
      splits: assemble(splits.map((s, i) => ({
        label: cleanLabel(s?.label, i),
        paymentMethod: s?.paymentMethod,
        sub: sub[i], sgst: sgst[i], cgst: cgst[i], disc: disc[i], amount: amounts[i],
      }))),
    };
  }

  return { error: "Invalid split type. Use EQUAL, BY_ITEM or CUSTOM." };
}

module.exports = { buildSplits, itemKey, toP, fromP, MAX_SPLITS, PAYMENT_METHODS };
