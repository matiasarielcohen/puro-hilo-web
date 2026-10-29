// Puro Hilo: GHL order -> MG Logistica guia. Stateless: holds no secret and never calls GHL.
// A GHL workflow (trigger "Order Submitted") POSTs the contact/order data here with the MG token in the
// x-mg-token header; this asks MG which service covers the postcode, creates the guia and returns MG's answer.
// MG validates the token itself, so a caller without a valid one cannot do anything.
//
// Body: GHL's standard webhook contact fields (first_name, last_name, email, phone, address1, city, state,
// postal_code) plus optional customData: order_id, order_total, items (text), pieces, and shipping_address1,
// shipping_city, shipping_state, shipping_postal_code, shipping_name, shipping_phone (win over the contact's when filled).
// ?dry_run=1 (or body dry_run) returns the guia that would be sent, without creating it.

const MG = "https://mglogistica.epresis.com/api/v1/public/";

const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const up = (s) => strip(s).toUpperCase().trim();
// an unresolved GHL merge field arrives as "" or as the literal "{{...}}": both mean "not filled"
const clean = (v) => (v === undefined || v === null || /\{\{/.test(String(v)) ? "" : String(v).trim());
const pick = (...vals) => vals.map(clean).find((v) => v !== "") || "";

// "Av. Rivadavia 3312 4 B" -> calle "Av. Rivadavia", altura "3312", piso "4", dpto "B"
function splitAddress(address1, address2) {
  const raw = String(address1 || "").trim();
  const m = raw.match(/^(.*?)[\s,]+(?:n[°ºo.]*\s*)?(\d+[A-Za-z]?)\b[\s,]*(.*)$/i);
  let calle = raw, altura = "S/N", rest = "";
  if (m) { calle = m[1].trim(); altura = m[2]; rest = m[3].trim(); }
  const extra = [rest, address2].filter(Boolean).join(" ");
  const piso = (extra.match(/(?:piso|p\.?)\s*([0-9]+[A-Za-z]?)/i) || extra.match(/^(\d+)\b/) || [])[1] || "";
  const dpto = (extra.match(/(?:dpto\.?|depto\.?|departamento|dto\.?)\s*([0-9A-Za-z]+)/i) || extra.match(/\b([A-Za-z])\s*$/) || [])[1] || "";
  return { calle, altura, piso, dpto, otra_info: extra };
}

const isCaba = (state, city) => /(CAPITAL FEDERAL|CIUDAD AUTONOMA|^CABA$|C\.A\.B\.A)/.test(up(state)) || /^(CABA|CAPITAL FEDERAL|CIUDAD AUTONOMA DE BUENOS AIRES)$/.test(up(city));

// Recipient from the webhook body; the shipping_* custom fields win over the contact's own address when filled.
function recipient(p) {
  const name = pick(p.shipping_name, p.full_name, `${clean(p.first_name)} ${clean(p.last_name)}`.trim(), p.name, "Cliente Puro Hilo");
  const state = pick(p.shipping_state, p.state);
  const city = pick(p.shipping_city, p.city);
  return {
    name, email: pick(p.email), phone: pick(p.shipping_phone, p.phone),
    ...splitAddress(pick(p.shipping_address1, p.address1), pick(p.shipping_address2, p.address2)),
    cp: pick(p.shipping_postal_code, p.postal_code, p.postalCode).replace(/\D/g, "").slice(0, 4),
    state, city, caba: isCaba(state, city),
  };
}

function buildGuia(p, service, token, env = {}) {
  const r = recipient(p);
  const pieces = Math.max(1, Math.round(Number(clean(p.pieces)) || 1));
  const kg = Math.max(0.1, Math.round(pieces * (Number(env.PIECE_KG) || 0.4) * 100) / 100);
  const desc = pick(p.items, "Indumentaria Puro Hilo").slice(0, 200);
  const orderId = pick(p.order_id, p.orderId);
  return {
    api_token: token,
    sucursal: env.MG_SUCURSAL || "PURO HILO",
    servicio: service,
    fragil: false,
    remito: orderId.slice(-10) || undefined,
    internacional: false,
    valorDeclarado: Number(clean(p.order_total).replace(/[^\d.]/g, "")) || 1,
    isInversa: false,
    observaciones: `Pedido web Puro Hilo ${orderId}`.trim().slice(0, 200),
    pago_en: "ORIGEN",
    tipo_operacion: "ENTREGA",
    is_urgente: false,
    comprador: {
      empresa: r.name, destinatario: r.name, calle: r.calle, altura: r.altura, piso: r.piso, dpto: r.dpto,
      localidad: r.caba ? "CAPITAL FEDERAL" : up(r.city), provincia: r.caba ? "BUENOS AIRES" : up(r.state),
      otra_info: r.otra_info, cp: r.cp, email: r.email, celular: r.phone, contenido: desc,
    },
    productos: [{ bultos: 1, peso: kg, descripcion: desc }],
  };
}

async function mg(path, body) {
  const res = await fetch(MG + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

async function handler(req, res) {
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const p = { ...body, ...(body.customData || {}) };
  const token = clean(req.headers["x-mg-token"] || p.api_token);
  if (!token) return send(401, { ok: false, error: "x-mg-token header missing" });
  const dry = [p.dry_run, req.query?.dry_run].some((v) => v === true || v === "true" || v === "1");
  const env = { MG_SUCURSAL: process.env.MG_SUCURSAL, PIECE_KG: process.env.PIECE_KG };
  try {
    const r = recipient(p);
    if (!r.calle || r.cp.length < 4) return send(422, { ok: false, error: `incomplete address (calle "${r.calle}", cp "${r.cp}")` });
    const svc = await mg("servicios-cp.json", { api_token: token, sucursal: env.MG_SUCURSAL || "PURO HILO", cp_entrega: r.cp });
    const service = Array.isArray(svc.json) && svc.json[0]?.cod_serv;
    if (!service) return send(502, { ok: false, error: `MG has no service for cp ${r.cp}: ${svc.text.slice(0, 200)}` });
    const guia = buildGuia(p, service, token, env);
    if (dry) return send(200, { ok: true, dry_run: true, service, guia: { ...guia, api_token: "***" } });
    const out = await mg("guias.json", guia);
    if (!out.ok || !out.json || out.json.status !== "ok") return send(502, { ok: false, error: `MG guias -> ${out.status} ${out.text.slice(0, 300)}` });
    return send(200, { ok: true, service, remito: guia.remito, mg: out.json });
  } catch (e) {
    return send(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
}

module.exports = handler;
module.exports.helpers = { splitAddress, recipient, buildGuia, isCaba, clean };
