// Puro Hilo: paid order -> Lightdata envio (second courier, next to MG Logistica; every shipping order goes to both).
// Called by /api/mp-webhook right after the MG guia, with the same flat order fields createGuia takes and the same proof of an
// approved Mercado Pago payment: without `payment` nothing real is created. Holds no secret of its own (env only).
// Lightdata API-Externa (https://apiexterna.lightdata.com.ar/externa): the company token goes in the Authorization header (Bearer), the
// integrator (client) token in the body. Envios are created in state "A retirar" (7).
// Env: LIGHTDATA_TOKEN_EMPRESA, LIGHTDATA_TOKEN_CLIENTE, LIGHTDATA_ID_EMPRESA (all three needed, else the step is skipped and logged),
//      LIGHTDATA_DID_SERVICIO (optional, see GET /externa/servicios-disponibles), LIGHTDATA_TIENDA (default "PURO HILO"), LIGHTDATA_URL (override).
// One envio per order: id_venta = the order ref, and before creating, /externa/obtener-datos-shipment-ml is asked for that id_venta
// (Lightdata has no remito check like MG's), so Mercado Pago's retries and double notifications cannot duplicate it.

const { helpers } = require("./mg-guia.js");
const { recipient, parcelFromItems, phoneAR, clean } = helpers;

const BASE = "https://apiexterna.lightdata.com.ar/externa";
const TIMEOUT_MS = 8000;

const lightdataEnv = () => ({
  tokenEmpresa: process.env.LIGHTDATA_TOKEN_EMPRESA, tokenCliente: process.env.LIGHTDATA_TOKEN_CLIENTE, idEmpresa: process.env.LIGHTDATA_ID_EMPRESA,
  didServicio: process.env.LIGHTDATA_DID_SERVICIO, tienda: process.env.LIGHTDATA_TIENDA, base: process.env.LIGHTDATA_URL,
});
const configured = (env) => !!(env.tokenEmpresa && env.tokenCliente && env.idEmpresa);

// "2026-11-03 14:05:00" in Argentina time (UTC-3, no DST)
const arNow = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

async function call(env, path, body) {
  const res = await fetch((env.base || BASE) + path, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${env.tokenEmpresa}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

// p = same flat fields as createGuia (first_name, last_name, email, phone, address1, address2, city, state, postal_code, order_id,
// order_total, items [{code, quantity}]). `names` (optional) maps product code -> title for the items detail.
function buildEnvio(p, env, names = {}) {
  const r = recipient(p);
  const { parcel, lines } = parcelFromItems(p.items);
  const orderId = clean(p.order_id) || clean(p.orderId);
  const total = Number(clean(p.order_total).replace(/[^\d.]/g, "")) || undefined;
  const phone = phoneAR(r.phone).replace(/\D/g, ""); // Lightdata wants 549... digits
  return {
    token: env.tokenCliente, idEmpresa: env.idEmpresa,
    fecha_venta: arNow(),
    destination_receiver_name: r.name,
    ...(phone ? { telefono: phone } : {}),
    flex: 0,
    ...(env.didServicio ? { didServicio: env.didServicio } : {}),
    peso: parcel ? parcel.peso : Math.max(0.1, Math.round((Math.round(Number(clean(p.pieces))) || 1) * 0.5 * 100) / 100),
    bultos: 1,
    ...(total ? { valor_declarado: total } : {}),
    id_venta: orderId,
    tienda: (env.tienda || "PURO HILO").slice(0, 32),
    ...(r.email ? { mail_destinatario: r.email } : {}),
    observaciones: [`Pedido web Puro Hilo ${orderId}`, r.otra_info].filter(Boolean).join(" | ").slice(0, 250),
    enviosDireccionesDestino: {
      calle: r.calle, numero: r.altura, ...(r.piso || r.dpto ? { piso_departamento: [r.piso, r.dpto].filter(Boolean).join(" ") } : {}),
      cp: r.cp, localidad: r.cityTyped || r.localidad, provincia: r.caba ? "CABA" : r.provincia,
    },
    enviosItems: lines.map((l) => ({ titulo: names[l.code] || l.code, cantidad: l.qty, sku: l.code })),
  };
}

// Returns { code, obj } like createGuia: unprocessable = Lightdata answered but refused (retrying will not help).
async function createEnvio(p, { env = lightdataEnv(), dry = false, payment = null, names = {} } = {}) {
  const orderId = clean(p.order_id) || clean(p.orderId);
  if (!configured(env)) { console.log("lightdata: not configured (LIGHTDATA_* env missing), envio skipped"); return { code: 200, obj: { ok: true, skipped: "not configured" } }; }
  if (!dry && !(payment && payment.id)) return { code: 402, obj: { ok: false, unprocessable: true, error: "no approved payment for this order, no envio created" } };
  try {
    const r = recipient(p);
    if (!r.calle || r.cp.length < 4) return { code: 422, obj: { ok: false, unprocessable: true, error: `incomplete address (calle "${r.calle}", cp "${r.cp}")` } };
    if (!orderId) return { code: 422, obj: { ok: false, unprocessable: true, error: "order_id missing: duplicates could not be prevented" } };
    const body = buildEnvio(p, env, names);
    if (dry) return { code: 200, obj: { ok: true, dry_run: true, envio: { ...body, token: "***" } } };

    const seen = await call(env, "/obtener-datos-shipment-ml", { idEmpresa: env.idEmpresa, idEnvio: orderId }).catch(() => null);
    if (seen && seen.json && seen.json.success === true) {
      console.log(`lightdata: order ${orderId} already has envio ${seen.json.data && seen.json.data.did}, skipped`);
      return { code: 200, obj: { ok: true, skipped: "envio already exists for this order", did: seen.json.data && seen.json.data.did } };
    }
    if (!(seen && /no se encontro/i.test(String(seen.json && seen.json.message)))) { // not a clear "does not exist": creating now could duplicate
      console.log(`lightdata: order ${orderId} lookup failed (${seen ? seen.status + " " + seen.text.slice(0, 120) : "no answer"}), not creating`);
      return { code: 503, obj: { ok: false, error: "could not check whether this order already has an envio, try again" } };
    }

    const out = await call(env, "/insertar-envio", body);
    if (!(out.ok && out.json && out.json.success === true)) {
      console.log(`lightdata: refused order ${orderId}: ${out.status} ${out.text.slice(0, 200)}`);
      return { code: 502, obj: { ok: false, unprocessable: out.status >= 400 && out.status < 500 && out.status !== 429, error: `Lightdata insertar-envio -> ${out.status} ${out.text.slice(0, 300)}` } };
    }
    const did = out.json.data && out.json.data.did;
    console.log(`lightdata: created order ${orderId} envio ${did}`);
    return { code: 200, obj: { ok: true, did, order: orderId } };
  } catch (e) {
    console.log(`lightdata: error ${e.message}`);
    return { code: 500, obj: { ok: false, error: String(e.message).slice(0, 300) } };
  }
}

module.exports = { createEnvio, helpers: { buildEnvio, lightdataEnv, configured, arNow } };
