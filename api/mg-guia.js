// Puro Hilo: GHL order -> MG Logistica guia. Stateless: holds no secret and never calls GHL.
// A GHL workflow (trigger "Order Form Submission") POSTs the contact/order data here with the MG token in the
// x-mg-token header; this asks MG which service covers the postcode, creates the guia and returns MG's answer.
// MG validates the token itself, so a caller without a valid one cannot do anything.
//
// Body: GHL's standard webhook contact fields (first_name, last_name, email, phone, address1, city, state,
// postal_code) plus optional customData: order_id, order_total, items (text or list; product codes + quantities set the
// real weight and size, see parseItems), pieces (fallback when no code is found), and shipping_address1,
// shipping_city, shipping_state, shipping_postal_code, shipping_name, shipping_phone (win over the contact's when filled).
// ?dry_run=1 (or body dry_run) returns the guia that would be sent, without creating it.
// Optional env: MG_SUCURSAL ("PURO HILO"), PIECE_KG (0.5), PKG_ALTO/PKG_LARGO/PKG_PROF (m: 0.10/0.30/0.25), DEFAULT_VALUE (20000).
//
// Field names and allowed values were checked against MG's own reference data (docs at mglogistica.epresis.com/docs/):
// tipo_operacion ENTREGA is in listar-tipo-operacion, provincia is one of the 24 names of provincias.json
// (Capital Federal is "CIUDAD AUTONOMA DE BUENOS AIRES"), and dimensiones are mandatory for the price quote.

const CATALOG = require("./catalogo-envio.json"); // code -> { kg per piece, alto/largo/prof of one folded piece in m }, see website/make_envio_catalog.py
const MG = "https://mglogistica.epresis.com/api/";
const TIMEOUT_MS = 8000;

// provincias.json, as MG spells them (accents stripped, upper case)
const CABA = "CIUDAD AUTONOMA DE BUENOS AIRES";
const PROVINCES = ["BUENOS AIRES", "CATAMARCA", "CORDOBA", "CORRIENTES", "CHACO", "CHUBUT", "ENTRE RIOS", "FORMOSA", "JUJUY", "LA PAMPA", "LA RIOJA",
  "MENDOZA", "MISIONES", "NEUQUEN", "RIO NEGRO", "SALTA", "SAN JUAN", "SAN LUIS", "SANTA CRUZ", "SANTA FE", "SANTIAGO DEL ESTERO", "TUCUMAN", "TIERRA DEL FUEGO"];

const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const up = (s) => strip(s).toUpperCase().replace(/\s+/g, " ").trim();
// an unresolved GHL merge field arrives as "" or as the literal "{{...}}": both mean "not filled"
const clean = (v) => (v === undefined || v === null || /\{\{/.test(String(v)) ? "" : String(v).trim());
const pick = (...vals) => vals.map(clean).find((v) => v !== "") || "";

// "Av. Rivadavia 3312 4 B" -> calle "Av. Rivadavia", altura "3312", piso "4", dpto "B". The raw text always goes to otra_info too.
function splitAddress(address1, address2) {
  const raw = String(address1 || "").trim();
  const marked = raw.match(/^(.*?)[\s,]+(?:n[°ºo]\.?|nro\.?|numero|num\.?|#)\s*(\d+[A-Za-z]?)\b[\s,]*(.*)$/i); // "Calle 12 nro 345": the marker wins
  const plain = raw.match(/^(.*?)[\s,]+(\d+[A-Za-z]?)\b[\s,]*(.*)$/);
  const m = marked || plain;
  let calle = raw, altura = "S/N", rest = "";
  if (m) { calle = m[1].trim(); altura = m[2]; rest = m[3].trim(); }
  const extra = [rest, address2].filter(Boolean).join(" ");
  const piso = (extra.match(/(?:piso|p\.?)\s*([0-9]+[A-Za-z]?)/i) || extra.match(/^(\d+)\b/) || [])[1] || "";
  const dpto = (extra.match(/(?:dpto\.?|depto\.?|departamento|dto\.?)\s*([0-9A-Za-z]+)/i) || extra.match(/\b([A-Za-z])\s*$/) || [])[1] || "";
  return { calle, altura, piso, dpto, otra_info: [raw, address2].filter(Boolean).join(" | ") };
}

// Province as MG spells it, and whether it is Capital Federal. Text first; the postcode (1000-1439) only settles
// the cases where the customer wrote "Buenos Aires" or nothing.
function province(state, city, cp) {
  const s = up(state), c = up(city);
  const cabaText = /(CAPITAL FEDERAL|AUTONOM|CIUDAD DE BUENOS AIRES|CITY OF BUENOS AIRES|^CABA$|C\.?A\.?B\.?A\.?$)/.test(s) || /^(CABA|C\.A\.B\.A\.?|CAPITAL FEDERAL|CIUDAD AUTONOMA DE BUENOS AIRES|CIUDAD DE BUENOS AIRES)$/.test(c);
  const n = Number(cp);
  const cabaCp = (s === "" || s === "BUENOS AIRES") && n >= 1000 && n <= 1439;
  if (cabaText || cabaCp) return { name: CABA, caba: true, known: true };
  const hit = PROVINCES.filter((p) => s.includes(p)).sort((a, b) => b.length - a.length)[0];
  return hit ? { name: hit, caba: false, known: true } : { name: s, caba: false, known: false };
}

function recipient(p) {
  const name = pick(p.shipping_name, p.full_name, `${clean(p.first_name)} ${clean(p.last_name)}`.trim(), p.name, "Cliente Puro Hilo");
  const cp = pick(p.shipping_postal_code, p.postal_code, p.postalCode).replace(/\D/g, "").slice(0, 4);
  const stateRaw = pick(p.shipping_state, p.state), city = pick(p.shipping_city, p.city);
  const prov = province(stateRaw, city, cp);
  const cityUp = up(city);
  const caba = prov.caba;
  return {
    name, email: pick(p.email), phone: pick(p.shipping_phone, p.phone),
    ...splitAddress(pick(p.shipping_address1, p.address1), pick(p.shipping_address2, p.address2)),
    cp, provincia: prov.name, provinciaKnown: prov.known, caba,
    // Capital Federal's localidades in MG are barrios plus the entry "CIUDAD AUTONOMA DE BUENOS AIRES"
    localidad: caba && (cityUp === "" || /^(CABA|C\.A\.B\.A\.?|CAPITAL FEDERAL|CIUDAD DE BUENOS AIRES)$/.test(cityUp)) ? CABA : cityUp,
  };
}

// "2 x Jean HOL-1008MR, 1 Camisa PCP-0114ML" / "HOL-1008MR x2" / [{name, quantity}] -> [{ code, qty }]. One line per product code.
const CODE = /\b[A-Z]{3}-\d{3,4}[A-Z]{0,4}\b/i;
function parseItems(items) {
  const segs = Array.isArray(items)
    ? items.map((it) => (it && typeof it === "object" ? `${it.sku || ""} ${it.code || ""} ${it.name || it.title || ""} x${it.quantity || it.qty || 1}` : String(it)))
    : String(clean(items)).split(/[\n;|]|,(?=[^,]*[A-Z]{3}-\d)/i);
  const lines = new Map();
  for (const seg of segs) {
    const m = seg.match(CODE);
    if (!m) continue;
    const code = m[0].toUpperCase(), rest = seg.replace(m[0], " ");
    const q = rest.match(/(?:qty|cantidad|cant\.?)\D{0,3}(\d+)/i) || rest.match(/[x×]\s*(\d+)\b/i) || rest.match(/\b(\d+)\s*[x×]/i) || rest.match(/^\s*(\d+)\b/);
    lines.set(code, (lines.get(code) || 0) + Math.max(1, Number(q && q[1]) || 1));
  }
  return [...lines].map(([code, qty]) => ({ code, qty }));
}

// The Webhook action adds an `order` object by itself when the workflow trigger is the order form (GHL: "dynamic data, run the
// test to get example data", so its shape is not documented). Read it defensively; customData keys still win when filled.
function orderLines(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return out;
  if (Array.isArray(node)) { node.forEach((n) => orderLines(n, out, depth + 1)); return out; }
  const qty = Number(node.qty ?? node.quantity ?? node.units);
  const code = JSON.stringify(node).match(CODE);
  if (qty > 0 && code) { out.push({ code: code[0], quantity: qty }); return out; }
  if (code && typeof (node.sku || node.name || node.title) === "string" && CODE.test(`${node.sku} ${node.name} ${node.title}`)) { out.push({ code: code[0], quantity: 1 }); return out; }
  Object.values(node).forEach((n) => orderLines(n, out, depth + 1));
  return out;
}
function fromOrder(p) {
  const o = p.order;
  if (!o || typeof o !== "object") return p;
  const q = { ...p };
  const set = (k, v) => { if (clean(q[k]) === "" && clean(v) !== "") q[k] = v; };
  set("order_id", o._id || o.id || o.orderId || o.altId);
  set("order_total", o.amount ?? o.total ?? o.totalAmount ?? o.grandTotal);
  const lines = orderLines(o);
  if (lines.length && !clean(q.items)) q.items = lines;
  const a = [o.shippingAddress, o.shipping_address, o.shipping, o.fulfillment && o.fulfillment.address, o.address].find((x) => x && typeof x === "object");
  if (a) {
    set("shipping_address1", a.address1 || a.addressLine1 || a.line1 || a.street || a.address);
    set("shipping_city", a.city); set("shipping_state", a.state || a.province);
    set("shipping_postal_code", a.postalCode || a.postal_code || a.zip || a.zipCode);
  }
  return q;
}

// One parcel for the whole order: weights add up, pieces stack (heights add) on the widest footprint. Returns null when
// no item matches the catalogue (caller falls back to pieces x PIECE_KG).
function parcelFromItems(items) {
  const lines = parseItems(items), known = lines.filter((l) => CATALOG[l.code]);
  if (!known.length) return { parcel: null, lines, unknown: lines.map((l) => l.code) };
  const kg = known.reduce((a, l) => a + CATALOG[l.code].kg * l.qty, 0);
  const alto = known.reduce((a, l) => a + CATALOG[l.code].alto * l.qty, 0);
  const largo = Math.max(...known.map((l) => CATALOG[l.code].largo)), prof = Math.max(...known.map((l) => CATALOG[l.code].prof));
  const r = (n, d) => Math.round(n * d) / d;
  return {
    parcel: { peso: Math.max(0.1, r(kg, 1000)), dimensiones: { alto: r(alto, 100), largo: r(largo, 100), profundidad: r(prof, 100) }, pieces: known.reduce((a, l) => a + l.qty, 0) },
    lines: known, unknown: lines.filter((l) => !CATALOG[l.code]).map((l) => l.code),
  };
}

function buildGuia(p, service, token, env = {}) {
  const r = recipient(p);
  const warnings = [];
  const { parcel, lines, unknown } = parcelFromItems(p.items);
  const pieces = parcel ? parcel.pieces : Math.max(1, Math.round(Number(clean(p.pieces))) || 1);
  let kg, dims;
  if (parcel) {
    kg = parcel.peso; dims = parcel.dimensiones;
    if (unknown.length) warnings.push(`items without catalogue data (not weighed): ${unknown.join(",")}`);
  } else {
    if (!clean(p.pieces)) warnings.push("no product code in items and no pieces: weight assumes 1 garment");
    const perPiece = Number(env.PIECE_KG) || 0.5; // the catalogue averages 0.47 kg per garment (median 0.52, max 0.98)
    kg = Math.max(0.1, Math.round(pieces * perPiece * 100) / 100);
  }
  const desc = (lines.length ? lines.map((l) => `${l.qty} x ${l.code}`).join(", ") : pick(typeof p.items === "string" ? p.items : "", "Indumentaria Puro Hilo")).slice(0, 200);
  const orderId = pick(p.order_id, p.orderId);
  if (!orderId) warnings.push("order_id missing: no remito, duplicates cannot be prevented");
  const total = Number(clean(p.order_total).replace(/[^\d.]/g, ""));
  if (!total) warnings.push("order_total missing: declared value uses the default");
  if (!r.provinciaKnown) warnings.push(`province "${r.provincia}" is not one of MG's 24 names`);
  if (!r.email) warnings.push("no email");
  const num = (v, d) => Number(v) > 0 ? Number(v) : d;
  dims = dims || { alto: num(env.PKG_ALTO, 0.1), largo: num(env.PKG_LARGO, 0.3), profundidad: num(env.PKG_PROF, 0.25) };
  return {
    warnings,
    guia: {
      api_token: token,
      sucursal: env.MG_SUCURSAL || "PURO HILO",
      servicio: service,
      fragil: false,
      remito: orderId ? orderId.slice(-10) : undefined,
      internacional: false,
      valorDeclarado: total || num(env.DEFAULT_VALUE, 20000),
      isInversa: false,
      observaciones: `Pedido web Puro Hilo ${orderId}`.trim().slice(0, 200),
      pago_en: "ORIGEN",
      tipo_operacion: "ENTREGA",
      is_urgente: false,
      comprador: {
        empresa: r.name, destinatario: r.name, calle: r.calle, altura: r.altura, piso: r.piso, dpto: r.dpto,
        localidad: r.localidad, provincia: r.provincia, otra_info: r.otra_info.slice(0, 250), cp: r.cp,
        email: r.email, celular: r.phone, contenido: desc,
      },
      // MG refuses to price a product without dimensions (precios.json, 400): the real ones from the catalogue, else a typical garment parcel (metres)
      productos: [{ bultos: 1, peso: kg, descripcion: desc, dimensiones: dims }],
    },
  };
}

async function mg(path, body) {
  const res = await fetch(MG + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

const mgEnv = () => ({ MG_SUCURSAL: process.env.MG_SUCURSAL, PIECE_KG: process.env.PIECE_KG, PKG_ALTO: process.env.PKG_ALTO, PKG_LARGO: process.env.PKG_LARGO, PKG_PROF: process.env.PKG_PROF, DEFAULT_VALUE: process.env.DEFAULT_VALUE });

// The whole order -> guia step, shared by the GHL webhook handler below and /api/mp-webhook. p = flat order fields (see header).
// Returns { code, obj }: the HTTP status and JSON answer the handler sends.
async function createGuia(p, { token, dry = false, env = mgEnv(), orderSeen = null } = {}) {
  const receivedKeys = Object.keys(p).sort(); // names only: shows in the dry-run answer and the Vercel log what the caller really sends
  try {
    console.log(`mg-guia: received keys ${receivedKeys.join(",")}`);
    const r = recipient(p);
    if (!r.calle || r.cp.length < 4) return { code: 422, obj: { ok: false, unprocessable: true, error: `incomplete address (calle "${r.calle}", cp "${r.cp}")` } };
    const svc = await mg("v1/public/servicios-cp.json", { api_token: token, sucursal: env.MG_SUCURSAL || "PURO HILO", cp_entrega: r.cp });
    const service = Array.isArray(svc.json) && svc.json[0]?.cod_serv;
    if (!service) return { code: 502, obj: { ok: false, unprocessable: !svc.ok ? false : true, error: `MG has no service for cp ${r.cp}: ${svc.text.slice(0, 200)}` } }; // unprocessable: MG answered, it just does not cover this postcode
    const { guia, warnings } = buildGuia(p, service, token, env);

    if (guia.remito && !dry) { // one guia per order: MG answers 404 when the remito is unknown, 200 with the movements when it exists
      const seen = await mg("v2/seguimiento.json", { api_token: token, remito: guia.remito }).catch(() => null);
      if (seen && seen.ok && seen.json && seen.json.status === "ok") {
        console.log(`mg-guia: remito ${guia.remito} already has a guia, skipped`);
        return { code: 200, obj: { ok: true, skipped: "guia already exists for this remito", remito: guia.remito } };
      }
      const clearlyNone = seen && (seen.status === 404 || (seen.ok && seen.json && seen.json.status !== "ok"));
      if (!clearlyNone) { // the lookup itself failed: creating now could duplicate a guia the caller's retry already made, so let the caller retry
        console.log(`mg-guia: remito ${guia.remito} lookup failed (${seen ? seen.status : "no answer"}), not creating`);
        return { code: 503, obj: { ok: false, error: "could not check whether this remito already has a guia, try again" } };
      }
    }
    if (dry) return { code: 200, obj: { ok: true, dry_run: true, service, warnings, received_keys: receivedKeys, order_seen: orderSeen, guia: { ...guia, api_token: "***" } } };

    const out = await mg("v1/public/guias.json", guia);
    // MG's real success answer (seen 2026-10-30) is {guia: <number>, sub_zona_destino, importe_por_producto} with no `status`; a refusal carries status "error"
    const made = out.ok && out.json && out.json.status !== "error" && (out.json.guia || out.json.status === "ok");
    if (!made) {
      console.log(`mg-guia: MG refused remito ${guia.remito}: ${out.status} ${out.text.slice(0, 200)}`);
      return { code: 502, obj: { ok: false, error: `MG guias -> ${out.status} ${out.text.slice(0, 300)}`, warnings } };
    }
    console.log(`mg-guia: created remito ${guia.remito} guia ${typeof out.json.guia === "object" ? "" : out.json.guia} service ${service} cp ${r.cp}`);
    return { code: 200, obj: { ok: true, service, remito: guia.remito, warnings, mg: out.json } };
  } catch (e) {
    console.log(`mg-guia: error ${e.message}`);
    return { code: 500, obj: { ok: false, error: String(e.message).slice(0, 300) } };
  }
}

async function handler(req, res) {
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return send(400, { ok: false, error: "body is not JSON" }); }
  const p = fromOrder({ ...body, ...(body.customData || {}) });
  const token = clean(req.headers["x-mg-token"] || p.api_token);
  if (!token) return send(401, { ok: false, error: "x-mg-token header missing" });
  const orderSeen = body.order && typeof body.order === "object" ? JSON.stringify(body.order).slice(0, 3000) : null; // dry-run only: the order object GHL sends is undocumented, this shows its real shape
  const dry = [p.dry_run, req.query?.dry_run].some((v) => v === true || v === "true" || v === "1");
  const { code, obj } = await createGuia(p, { token, dry, orderSeen });
  return send(code, obj);
}

module.exports = handler;
module.exports.createGuia = createGuia;
module.exports.helpers = { fromOrder, parseItems, parcelFromItems, splitAddress, recipient, buildGuia, province, clean };
