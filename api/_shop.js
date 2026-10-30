// Puro Hilo: what an order costs, computed on the server so the page's number is never trusted (shared by /api/mp-checkout and
// /api/mp-webhook; the leading underscore keeps Vercel from exposing it as an endpoint).
// Prices come from precios.json (website/make_precios.py, live GHL), shipping from the 3 delivery zones set in GHL on 2026-10-29,
// coupons are read live from GHL (GET /payments/coupon, checked read-only on 2026-10-30).

const PRECIOS = require("./precios.json"); // CODE -> { id, name, prices: { talle: amount }, priceIds: { ghlPriceId: talle } }

const GHL = "https://services.leadconnectorhq.com";
const LOCATION = "MvmUL33EtUoUyH184hmv";
const MAX_LINES = 40, MAX_QTY = 50;

// MG's province names (see mg-guia.js). Zone by state, exactly as GHL's checkout does: CABA and the province are both "Buenos Aires".
const ZONES = [
  { name: "Buenos Aires", fee: 10000, states: ["BUENOS AIRES", "CIUDAD AUTONOMA DE BUENOS AIRES"] },
  { name: "Centro, Litoral y Cuyo", fee: 15000, states: ["SANTA FE", "ENTRE RIOS", "CORDOBA", "LA PAMPA", "MENDOZA", "SAN LUIS", "SAN JUAN", "CORRIENTES"] },
];
const REST_FEE = 20000; // the other 14 states
const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const up = (s) => strip(s).toUpperCase().replace(/\s+/g, " ").trim();

function shippingFor(provincia) {
  const p = up(provincia);
  const zone = ZONES.find((z) => z.states.includes(p));
  return zone ? { zone: zone.name, fee: zone.fee } : { zone: "Resto del pais", fee: REST_FEE };
}

// lines: [{ code, size, qty }] (size = the Talle; a GHL price id in `priceId` also works). Throws Error with a customer-safe message.
function priceLines(lines, table = PRECIOS) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("El carrito est\u00e1 vac\u00edo");
  if (lines.length > MAX_LINES) throw new Error("Demasiados productos en el carrito");
  const items = lines.map((l) => {
    const code = String((l && l.code) || "").trim().toUpperCase();
    const product = table[code];
    if (!product) throw new Error(`Producto desconocido: ${code || "(sin codigo)"}`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error(`Cantidad inv\u00e1lida para ${code}`);
    let size = String(l.size || "").trim();
    if (!size && l.priceId) size = product.priceIds[l.priceId] || "";
    if (!size) { // no size sent: only fine when the product has one price
      const sizes = Object.keys(product.prices);
      if (new Set(sizes.map((s) => product.prices[s])).size === 1) size = sizes[0];
    }
    const unit = product.prices[size];
    if (!unit) throw new Error(`Talle inv\u00e1lido para ${code}: "${size}"`);
    return { code, size, qty, unit, name: product.name };
  });
  return { items, subtotal: items.reduce((a, i) => a + i.unit * i.qty, 0) };
}

// A GHL coupon, valid now? -> { code, discount } or throws. Percentage coupons apply to the subtotal (shipping is not discounted);
// GHL's own rule for this is not documented, so a mismatch with the page's total comes back as a 409 with both numbers.
async function couponDiscount(code, subtotal, { pit, now = new Date() } = {}) {
  const res = await fetch(`${GHL}/payments/coupon?${new URLSearchParams({ altId: LOCATION, altType: "location", code })}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: "2021-07-28", Accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404 || res.status === 400) throw new Error("El cup\u00f3n no es v\u00e1lido");
  if (!res.ok) throw new Error("No pudimos validar el cup\u00f3n, intent\u00e1 de nuevo");
  const c = await res.json();
  if (!c || String(c.code || "").toUpperCase() !== code.toUpperCase()) throw new Error("El cup\u00f3n no es v\u00e1lido");
  const used = Number(c.usageCount) || 0, limit = Number(c.usageLimit) || 0;
  if (c.status !== "active" || (c.startDate && new Date(c.startDate) > now) || (c.endDate && new Date(c.endDate) < now) || (limit && used >= limit)) throw new Error("El cup\u00f3n no es v\u00e1lido");
  const v = Number(c.discountValue) || 0;
  const raw = c.discountType === "percentage" ? Math.round((subtotal * v) / 100) : v;
  return { code: c.code, discount: Math.min(subtotal, Math.max(0, raw)) };
}

const newRef = () => `PH${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`; // last 10 chars are the MG remito, so they must differ per order

module.exports = { shippingFor, priceLines, couponDiscount, newRef, up, LOCATION, GHL, ZONES };
