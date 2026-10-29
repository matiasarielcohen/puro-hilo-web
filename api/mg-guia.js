// Puro Hilo: GHL order -> MG Logistica guia. Stateless: holds no secret and never calls GHL.
// A GHL workflow (trigger "Order Form Submission") POSTs the contact/order data here with the MG token in the
// x-mg-token header; this asks MG which service covers the postcode, creates the guia and returns MG's answer.
// MG validates the token itself, so a caller without a valid one cannot do anything.
//
// Body: GHL's standard webhook contact fields (first_name, last_name, email, phone, address1, city, state,
// postal_code) plus optional customData: order_id, order_total, items (text), pieces, and shipping_address1,
// shipping_city, shipping_state, shipping_postal_code, shipping_name, shipping_phone (win over the contact's when filled).
// ?dry_run=1 (or body dry_run) returns the guia that would be sent, without creating it.
// Optional env: MG_SUCURSAL ("PURO HILO"), PIECE_KG (0.5), PKG_ALTO/PKG_LARGO/PKG_PROF (m: 0.10/0.30/0.25), DEFAULT_VALUE (20000).
//
// Field names and allowed values were checked against MG's own reference data (docs at mglogistica.epresis.com/docs/):
// tipo_operacion ENTREGA is in listar-tipo-operacion, provincia is one of the 24 names of provincias.json
// (Capital Federal is "CIUDAD AUTONOMA DE BUENOS AIRES"), and dimensiones are mandatory for the price quote.

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
  const cabaText = /(CAPITAL FEDERAL|CIUDAD AUTONOMA|CIUDAD DE BUENOS AIRES|^CABA$|C\.?A\.?B\.?A\.?$)/.test(s) || /^(CABA|C\.A\.B\.A\.?|CAPITAL FEDERAL|CIUDAD AUTONOMA DE BUENOS AIRES|CIUDAD DE BUENOS AIRES)$/.test(c);
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

function buildGuia(p, service, token, env = {}) {
  const r = recipient(p);
  const warnings = [];
  const pieces = Math.max(1, Math.round(Number(clean(p.pieces))) || 1);
  if (!clean(p.pieces)) warnings.push("pieces missing: weight assumes 1 garment");
  const perPiece = Number(env.PIECE_KG) || 0.5; // the catalogue averages 0.47 kg per garment (median 0.52, max 0.98)
  const kg = Math.max(0.1, Math.round(pieces * perPiece * 100) / 100);
  const desc = pick(p.items, "Indumentaria Puro Hilo").slice(0, 200);
  const orderId = pick(p.order_id, p.orderId);
  if (!orderId) warnings.push("order_id missing: no remito, duplicates cannot be prevented");
  const total = Number(clean(p.order_total).replace(/[^\d.]/g, ""));
  if (!total) warnings.push("order_total missing: declared value uses the default");
  if (!r.provinciaKnown) warnings.push(`province "${r.provincia}" is not one of MG's 24 names`);
  if (!r.email) warnings.push("no email");
  const num = (v, d) => Number(v) > 0 ? Number(v) : d;
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
      // MG refuses to price a product without dimensions (precios.json, 400), so send a typical garment parcel (metres)
      productos: [{ bultos: 1, peso: kg, descripcion: desc, dimensiones: { alto: num(env.PKG_ALTO, 0.1), largo: num(env.PKG_LARGO, 0.3), profundidad: num(env.PKG_PROF, 0.25) } }],
    },
  };
}

async function mg(path, body) {
  const res = await fetch(MG + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

async function handler(req, res) {
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return send(400, { ok: false, error: "body is not JSON" }); }
  const p = { ...body, ...(body.customData || {}) };
  const token = clean(req.headers["x-mg-token"] || p.api_token);
  if (!token) return send(401, { ok: false, error: "x-mg-token header missing" });
  const receivedKeys = Object.keys(p).sort(); // names only: shows in the dry-run answer and the Vercel log what GHL really sends
  const dry = [p.dry_run, req.query?.dry_run].some((v) => v === true || v === "true" || v === "1");
  const env = { MG_SUCURSAL: process.env.MG_SUCURSAL, PIECE_KG: process.env.PIECE_KG, PKG_ALTO: process.env.PKG_ALTO, PKG_LARGO: process.env.PKG_LARGO, PKG_PROF: process.env.PKG_PROF, DEFAULT_VALUE: process.env.DEFAULT_VALUE };
  try {
    console.log(`mg-guia: received keys ${receivedKeys.join(",")}`);
    const r = recipient(p);
    if (!r.calle || r.cp.length < 4) return send(422, { ok: false, error: `incomplete address (calle "${r.calle}", cp "${r.cp}")` });
    const svc = await mg("v1/public/servicios-cp.json", { api_token: token, sucursal: env.MG_SUCURSAL || "PURO HILO", cp_entrega: r.cp });
    const service = Array.isArray(svc.json) && svc.json[0]?.cod_serv;
    if (!service) return send(502, { ok: false, error: `MG has no service for cp ${r.cp}: ${svc.text.slice(0, 200)}` });
    const { guia, warnings } = buildGuia(p, service, token, env);

    if (guia.remito && !dry) { // one guia per order: MG answers 404 when the remito is unknown, 200 with the movements when it exists
      const seen = await mg("v2/seguimiento.json", { api_token: token, remito: guia.remito }).catch(() => null);
      if (seen && seen.ok && seen.json && seen.json.status === "ok") {
        console.log(`mg-guia: remito ${guia.remito} already has a guia, skipped`);
        return send(200, { ok: true, skipped: "guia already exists for this remito", remito: guia.remito });
      }
    }
    if (dry) return send(200, { ok: true, dry_run: true, service, warnings, received_keys: receivedKeys, guia: { ...guia, api_token: "***" } });

    const out = await mg("v1/public/guias.json", guia);
    if (!out.ok || !out.json || out.json.status !== "ok") {
      console.log(`mg-guia: MG refused remito ${guia.remito}: ${out.status} ${out.text.slice(0, 200)}`);
      return send(502, { ok: false, error: `MG guias -> ${out.status} ${out.text.slice(0, 300)}`, warnings });
    }
    console.log(`mg-guia: created remito ${guia.remito} service ${service} cp ${r.cp}`);
    return send(200, { ok: true, service, remito: guia.remito, warnings, mg: out.json });
  } catch (e) {
    console.log(`mg-guia: error ${e.message}`);
    return send(500, { ok: false, error: String(e.message).slice(0, 300) });
  }
}

module.exports = handler;
module.exports.helpers = { splitAddress, recipient, buildGuia, province, clean };
