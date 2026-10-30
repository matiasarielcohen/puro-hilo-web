// Puro Hilo: the "Pagar con Mercado Pago" button of the GHL checkout calls this. It recomputes the order total from the shop's own
// prices + the delivery zone (the total the page shows is only compared, never charged), creates a Mercado Pago Checkout Pro
// preference with ONE item ("Pedido Puro Hilo") and returns its link. The order itself (products, buyer, address) rides in the
// preference metadata as flat strings: Mercado Pago copies it to the payment, which is how /api/mp-webhook knows what was bought.
//
// POST { items: [{ code, size, qty }], coupon?, base (the cart after discount, before shipping, as the page shows it; or total incl. shipping),
//        buyer: { first_name, last_name, email, phone }, address: { address1, address2, city, state, postal_code } }
// delivery: "pickup" -> collected at the Puro Hilo local: no address, no shipping, no MG guia (the webhook only records the order).
// quote_only: true (+ items, coupon, address) -> 200 { ok, quote: { subtotal, discount, shipping, zone, total } }, nothing is created.
// -> 200 { ok, init_point, ref, total }   409 { error, expected } when the page's total differs   4xx { error } (Spanish, safe to show)
// Env: MP_ACCESS_TOKEN (production), GHL_PIT (coupons only), PUBLIC_BASE_URL (default the Vercel domain),
//      THANKS_URL / FAILURE_URL (default https://purohilo.shop/checkout), LINK_HOURS (24), ALLOWED_ORIGINS (comma list, default purohilo.shop).

const { shippingFor, priceLines, couponDiscount, newRef } = require("./_shop.js");
const { province } = require("./mg-guia.js").helpers;

const MP = "https://api.mercadopago.com/checkout/preferences";
const text = (v, max = 120) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://purohilo.shop,https://www.purohilo.shop").split(",").map((s) => s.trim());
  const origin = req.headers.origin || req.headers.Origin;
  if (origin && allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const cleanAddress = (a = {}) => ({ address1: text(a.address1, 120), address2: text(a.address2, 60), city: text(a.city, 60), state: text(a.state, 60), postal_code: text(a.postal_code, 10) });

// What the cart costs for this destination: items from the shop's own prices, shipping by zone, coupon read from GHL.
// Throws Error with a Spanish message.
const isPickup = (body) => body.delivery === "pickup";

async function price(body, address, { pit } = {}) {
  let prov = { name: "" }, ship = { zone: "Retiro en local", fee: 0 };
  if (!isPickup(body)) {
    if (address.postal_code.replace(/\D/g, "").length < 4) throw new Error("Complet\u00e1 el c\u00f3digo postal");
    prov = province(address.state, address.city, address.postal_code);
    if (!prov.known) throw new Error("Eleg\u00ed una provincia");
    ship = shippingFor(prov.name);
  }
  const { items, subtotal } = priceLines(body.items);
  let discount = 0, coupon = "";
  const code = text(body.coupon, 40);
  if (code) { const c = await couponDiscount(code, subtotal, { pit }); discount = c.discount; coupon = c.code; }
  const total = subtotal - discount + ship.fee;
  if (total <= 0) throw new Error("El total es cero: no hay nada para pagar con Mercado Pago");
  return { provincia: prov.name, items, subtotal, shipping: ship.fee, zone: ship.zone, discount, coupon, total };
}

// Everything the order needs, validated.
async function quote(body, { pit } = {}) {
  const b = body.buyer || {};
  const buyer = { first_name: text(b.first_name, 60), last_name: text(b.last_name, 60), email: text(b.email, 100).toLowerCase(), phone: text(b.phone, 30) };
  const address = cleanAddress(body.address);
  if (!buyer.first_name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyer.email)) throw new Error("Complet\u00e1 tu nombre y email");
  if (!isPickup(body) && !address.address1) throw new Error("Complet\u00e1 tu direcci\u00f3n y c\u00f3digo postal");
  return { buyer, address, delivery: isPickup(body) ? "pickup" : "shipping", ...(await price(body, address, { pit })) };
}

async function handler(req, res) {
  cors(req, res);
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return send(400, { ok: false, error: "body is not JSON" }); }

  if (body.quote_only) { // the checkout page shows the shipping and the total as soon as an address is picked
    try { const p = await price(body, cleanAddress(body.address), { pit: process.env.GHL_PIT }); return send(200, { ok: true, quote: { subtotal: p.subtotal, discount: p.discount, shipping: p.shipping, zone: p.zone, total: p.total } }); }
    catch (e) { return send(422, { ok: false, error: e.message }); }
  }
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return send(500, { ok: false, error: "Pagos no disponibles por el momento" });

  let q;
  try { q = await quote(body, { pit: process.env.GHL_PIT }); } catch (e) { return send(422, { ok: false, error: e.message }); }
  // The page's number is only compared. `base` = the cart after discount, before shipping (GHL's checkout has no shipping rate for
  // some addresses, e.g. Capital Federal from Google's address picker, so its own total cannot be relied on); `total` = old callers.
  const hasBase = body.base !== undefined && body.base !== null && body.base !== "";
  const seen = Number(String(hasBase ? body.base : body.total ?? "").replace(/[^\d]/g, ""));
  const expected = hasBase ? q.subtotal - q.discount : q.total;
  if (!seen || seen !== expected) { // someone edited the number, a price changed since the page loaded, or a discount rule differs
    console.log(`mp-checkout: mismatch page ${seen} server ${expected} (${hasBase ? "base" : "total"}; subtotal ${q.subtotal} ship ${q.shipping} discount ${q.discount})`);
    return send(409, { ok: false, error: "El total cambi\u00f3, recarg\u00e1 la p\u00e1gina e intent\u00e1 de nuevo", expected });
  }

  const ref = newRef();
  const base = process.env.PUBLIC_BASE_URL || "https://puro-hilo.flujo.com.ar";
  const thanks = process.env.THANKS_URL || "https://purohilo.shop/checkout"; // GHL's /thank-you redirects to the shop when GHL has no order: the checkout page itself draws the confirmation (src/mp-pay.js)
  const retry = process.env.FAILURE_URL || thanks;
  const okUrl = q.delivery === "pickup" ? thanks + (thanks.includes("?") ? "&" : "?") + "retiro=1" : thanks; // the checkout page words the confirmation for a pickup
  const hours = Number(process.env.LINK_HOURS) || 24; // the link (and its price) stops working after this
  const now = Date.now();
  const preference = {
    items: [{ id: ref, title: "Pedido Puro Hilo", quantity: 1, unit_price: q.total, currency_id: "ARS" }],
    payer: { name: q.buyer.first_name, surname: q.buyer.last_name, email: q.buyer.email },
    external_reference: ref,
    back_urls: { success: okUrl, pending: okUrl, failure: retry },
    expires: true, expiration_date_from: new Date(now).toISOString(), expiration_date_to: new Date(now + hours * 3600 * 1000).toISOString(),
    auto_return: "approved",
    notification_url: `${base}/api/mp-webhook`,
    statement_descriptor: "PUROHILO",
    metadata: { // flat strings only: Mercado Pago copies metadata to the payment
      ref, total: String(q.total), subtotal: String(q.subtotal), shipping: String(q.shipping), discount: String(q.discount), coupon: q.coupon, zone: q.zone, delivery: q.delivery,
      items: q.items.map((i) => `${i.code}|${i.size}|${i.qty}|${i.unit}`).join(";"),
      first_name: q.buyer.first_name, last_name: q.buyer.last_name, email: q.buyer.email, phone: q.buyer.phone,
      address1: q.address.address1, address2: q.address.address2, city: q.address.city, state: q.address.state, postal_code: q.address.postal_code,
    },
  };
  try {
    const r = await fetch(MP, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Idempotency-Key": ref }, body: JSON.stringify(preference), signal: AbortSignal.timeout(10000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.init_point) {
      console.log(`mp-checkout: Mercado Pago refused ${ref}: ${r.status} ${JSON.stringify(out).slice(0, 300)}`);
      return send(502, { ok: false, error: "No pudimos iniciar el pago, intent\u00e1 de nuevo" });
    }
    console.log(`mp-checkout: preference ${out.id} ref ${ref} total ${q.total}`);
    return send(200, { ok: true, init_point: out.init_point, ref, total: q.total });
  } catch (e) {
    console.log(`mp-checkout: error ${e.message}`);
    return send(502, { ok: false, error: "No pudimos iniciar el pago, intent\u00e1 de nuevo" });
  }
}

module.exports = handler;
module.exports.quote = quote;
