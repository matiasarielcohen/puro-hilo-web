// Puro Hilo: Mercado Pago tells us a payment changed. Only an APPROVED payment does anything: it is fetched from Mercado Pago's API
// (the notification itself is never trusted), its amount must equal the one /api/mp-checkout charged, then
//   1. the buyer becomes a GHL contact (tag pago-mercadopago) with a note listing products, totals and the payment id,
//      (a pickup order, metadata delivery "pickup": tag "retiro", no address, no guia: the note tells the shop to arrange the retiro),
//   2. the MG Logistica guia is created through the same code as /api/mg-guia (createGuia, remito = order ref).
// Mercado Pago sends several notifications per payment (created, updated, retries), sometimes at the same moment, so the order note
// doubles as a claim: the first note for a payment id wins (see claim()), later notifications skip. A failed run leaves its note
// behind and is retried by Mercado Pago once the note is older than CLAIM_STALE_MS. Steps are safe to repeat (contact upsert,
// remito lookup), so a transient failure answers 500 and Mercado Pago retries; an unfixable one (address MG cannot serve, payment
// that does not exist) answers 200 and is logged.
// Env: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET (signature), GHL_PIT, SHIPPING_API_TOKEN (MG), MG_DRY_RUN=1 (guia as dry run),
//      CLAIM_WAIT_MS (default 1500), MG_SUCURSAL / PIECE_KG ... (see mg-guia.js).

const crypto = require("crypto");
const { createGuia } = require("./mg-guia.js");
const { GHL, LOCATION } = require("./_shop.js");

const MP = "https://api.mercadopago.com";
const TIMEOUT_MS = 10000;
const CLAIM_STALE_MS = 20000; // a note younger than this belongs to a run that may still be working
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mercado Pago signs "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" with the app's webhook secret (HMAC SHA256, hex in v1).
// data.id comes from the query string and is lower-cased when alphanumeric. Returns true only for a valid signature.
function validSignature(req, secret, dataId) {
  const header = String(req.headers["x-signature"] || "");
  const ts = (header.match(/(?:^|,)\s*ts=([^,]+)/) || [])[1], v1 = (header.match(/(?:^|,)\s*v1=([^,]+)/) || [])[1];
  if (!secret || !ts || !v1 || !dataId) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${req.headers["x-request-id"] || ""};ts:${ts};`;
  const mine = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(mine), b = Buffer.from(v1.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const peso = (n) => `$${Number(n).toLocaleString("es-AR")}`;

// "CODE|talle|qty|unit;..." -> [{ code, size, qty, unit }]
const parseOrderItems = (s) => String(s || "").split(";").filter(Boolean).map((x) => { const [code, size, qty, unit] = x.split("|"); return { code, size, qty: Number(qty), unit: Number(unit) }; });

async function api(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, txt };
}

function noteFor(payment, m, items) {
  const lines = items.map((i) => `${i.qty} x ${i.code} talle ${i.size} (${peso(i.unit)} c/u)`);
  return [
    `Pago Mercado Pago #${payment.id} aprobado (${payment.payment_method_id || "?"}).`,
    `Pedido ${m.ref}`,
    ...lines,
    `Subtotal ${peso(m.subtotal)}` + (Number(m.discount) ? ` | Cupon ${m.coupon} -${peso(m.discount)}` : "") + ` | Envio ${peso(m.shipping)} (${m.zone}) | Total ${peso(m.total)}`,
    m.delivery === "pickup" ? `RETIRO EN EL LOCAL${m.pickup_location ? ": " + m.pickup_location : ""} (sin envio, no se crea guia MG): coordinar el retiro con el cliente.` : `Entrega: ${[m.address1, m.address2, m.city, m.state, m.postal_code].filter(Boolean).join(", ")}`,
  ].join("\n");
}

// The order data normally rides on the payment (preference metadata). If Mercado Pago did not copy it, read it from the preference
// itself: search by external_reference (the search result has no metadata), then GET the preference.
async function orderMeta(payment, mpToken) {
  if (payment.metadata && payment.metadata.ref) return payment.metadata;
  if (!payment.external_reference) return {};
  const auth = { Authorization: `Bearer ${mpToken}` };
  const found = await api(`${MP}/checkout/preferences/search?external_reference=${encodeURIComponent(payment.external_reference)}`, { headers: auth });
  const id = found.ok && found.json && found.json.elements && found.json.elements[0] && found.json.elements[0].id;
  if (!id) return {};
  const pref = await api(`${MP}/checkout/preferences/${encodeURIComponent(id)}`, { headers: auth });
  return (pref.ok && pref.json && pref.json.metadata) || {};
}

// Who handles this payment? "go": this run, "skip": another notification does. The note is created first, then the notes are read
// again after a pause and the earliest one (dateAdded, then id) wins, so two runs that started together agree on one winner.
async function claim(contactId, payment, m, items, ghl, waitMs) {
  const marker = `#${payment.id} `;
  const mine = (notes) => (notes || []).filter((n) => String(n.body || "").includes(marker));
  const list = async () => { const r = await api(`${GHL}/contacts/${contactId}/notes`, { headers: ghl }); if (!r.ok) throw new Error(`GHL notes ${r.status}`); return mine(r.json && r.json.notes); };
  const existing = await list();
  if (existing.length) { // a run already started: still working (young note) or failed earlier (old note, this is Mercado Pago's retry)
    const young = existing.some((n) => Date.now() - Date.parse(n.dateAdded) < CLAIM_STALE_MS);
    return young ? "skip" : "go";
  }
  const added = await api(`${GHL}/contacts/${contactId}/notes`, { method: "POST", headers: ghl, body: { body: noteFor(payment, m, items) } });
  const noteId = added.ok && added.json && added.json.note && added.json.note.id;
  if (!noteId) throw new Error(`GHL note create ${added.status} ${added.txt.slice(0, 120)}`);
  await sleep(waitMs);
  const order = (await list()).sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)) || String(a.id).localeCompare(String(b.id)));
  return order.length && order[0].id !== noteId ? "skip" : "go";
}

async function handler(req, res) {
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } })() : req.body || {};
  const query = req.query || {};
  const dataId = String(query["data.id"] || (body.data && body.data.id) || "");
  const type = String(query.type || query.topic || body.type || "");
  const secret = process.env.MP_WEBHOOK_SECRET, mpToken = process.env.MP_ACCESS_TOKEN, pit = process.env.GHL_PIT, mgToken = process.env.SHIPPING_API_TOKEN;
  if (!secret || !mpToken || !pit || !mgToken) { console.log("mp-webhook: missing env var"); return send(500, { ok: false, error: "not configured" }); }
  if (!query["data.id"] && query.topic) return send(200, { ok: true, ignored: "legacy IPN notification" }); // old-style ping (?topic=payment&id=): unsigned, the signed event covers it
  if (!validSignature(req, secret, dataId)) { console.log("mp-webhook: bad signature"); return send(401, { ok: false, error: "bad signature" }); }
  if (type !== "payment") return send(200, { ok: true, ignored: `type ${type}` }); // merchant_order, etc.: the payment event carries what we need

  try {
    const pay = await api(`${MP}/v1/payments/${encodeURIComponent(dataId)}`, { headers: { Authorization: `Bearer ${mpToken}` } });
    if (pay.status === 404) { console.log(`mp-webhook: payment ${dataId} does not exist (test notification?)`); return send(200, { ok: true, ignored: "payment not found" }); }
    if (!pay.ok || !pay.json) { console.log(`mp-webhook: payment ${dataId} lookup ${pay.status}`); return send(500, { ok: false, error: "payment lookup failed" }); }
    const payment = pay.json;
    if (payment.status !== "approved") return send(200, { ok: true, ignored: `status ${payment.status}` });
    const m = await orderMeta(payment, mpToken);
    if (!m.ref || m.ref !== payment.external_reference) { console.log(`mp-webhook: payment ${payment.id} is not one of ours (ref ${payment.external_reference})`); return send(200, { ok: true, ignored: "not a Puro Hilo order" }); }
    if (payment.currency_id !== "ARS" || Math.abs(Number(payment.transaction_amount) - Number(m.total)) > 0.01) {
      console.log(`mp-webhook: AMOUNT MISMATCH payment ${payment.id} paid ${payment.transaction_amount} ${payment.currency_id}, order ${m.ref} expects ${m.total}`);
      return send(200, { ok: false, error: "amount mismatch, order not processed" }); // 200: retrying cannot fix it, the log line is the alert
    }
    const items = parseOrderItems(m.items);
    const pickup = m.delivery === "pickup";
    const ghl = { Authorization: `Bearer ${pit}`, Version: "2021-07-28" };

    // 1. contact, then the claim note (see claim())
    const up = await api(`${GHL}/contacts/upsert`, { method: "POST", headers: ghl, body: {
      locationId: LOCATION, firstName: m.first_name, lastName: m.last_name, email: m.email, phone: m.phone || undefined,
      ...(pickup ? {} : { address1: m.address1, city: m.city, state: m.state, postalCode: m.postal_code, country: "AR" }),
      tags: pickup ? ["pago-mercadopago", "retiro"] : ["pago-mercadopago"], source: "Mercado Pago",
    } });
    const contactId = up.json && up.json.contact && up.json.contact.id;
    if (!up.ok || !contactId) { console.log(`mp-webhook: GHL upsert ${up.status} ${up.txt.slice(0, 200)}`); return send(500, { ok: false, error: "GHL contact failed" }); }
    const who = await claim(contactId, payment, m, items, ghl, Number(process.env.CLAIM_WAIT_MS ?? 1500));
    if (who === "skip") { console.log(`mp-webhook: payment ${payment.id} is handled by another notification`); return send(200, { ok: true, skipped: "handled by another notification", order: m.ref }); }

    // 2. MG guia (a pickup has nothing to ship: the note and the "retiro" tag are the notice)
    if (pickup) { console.log(`mp-webhook: order ${m.ref} is a pickup, no MG guia`); return send(200, { ok: true, order: m.ref, payment: payment.id, contact: contactId, pickup: true }); }
    const guia = await createGuia({
      first_name: m.first_name, last_name: m.last_name, email: m.email, phone: m.phone,
      address1: m.address1, address2: m.address2, city: m.city, state: m.state, postal_code: m.postal_code,
      order_id: m.ref, order_total: String(m.total), items: items.map((i) => ({ code: i.code, quantity: i.qty })),
    }, { token: mgToken, dry: process.env.MG_DRY_RUN === "1" });
    if (guia.obj.unprocessable) console.log(`mp-webhook: order ${m.ref} paid but MG cannot ship it: ${guia.obj.error}`); // address problem: retrying will not help, someone has to call the buyer
    else if (guia.code >= 400) return send(500, { ok: false, error: "MG guia failed", mg: guia.obj.error });
    return send(200, { ok: true, order: m.ref, payment: payment.id, contact: contactId, guia: guia.obj.skipped || guia.obj.dry_run ? guia.obj : { ok: guia.obj.ok, remito: guia.obj.remito } });
  } catch (e) {
    console.log(`mp-webhook: error ${e.message}`);
    return send(500, { ok: false, error: String(e.message).slice(0, 200) });
  }
}

module.exports = handler;
module.exports.helpers = { validSignature, parseOrderItems, noteFor };
