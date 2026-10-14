// Live product feed for the catalog: reads the active, in-store products from the GHL account and returns
// a slim list. Runs on Vercel; needs two environment variables: GHL_PIT (the sub-account token) and
// GHL_LOCATION_ID. Cached 5 minutes at the edge, so an import in GHL shows on the site within minutes.
const BASE = "https://services.leadconnectorhq.com";

async function ghl(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.GHL_PIT}`, Version: "2021-07-28", Accept: "application/json" } });
  if (!res.ok) throw new Error(`GHL ${path} -> ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!process.env.GHL_PIT || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: "GHL_PIT / GHL_LOCATION_ID not set" });
  }
  try {
    const locationId = process.env.GHL_LOCATION_ID;
    const items = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await ghl("/products/", { locationId, limit: "100", offset: String(offset) })).products || [];
      items.push(...page);
      if (page.length < 100) break;
    }
    const live = items.filter((p) => p.status === "active" && p.availableInStore);
    const out = new Array(live.length);
    let next = 0;
    // prices are a separate call per product; only the lowest one is shown ("Desde ...")
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < live.length) {
        const i = next++;
        let price = null;
        try {
          const r = await ghl(`/products/${live[i]._id}/price`, { locationId, limit: "100" });
          const amounts = (r.prices || []).map((x) => x.amount).filter(Boolean);
          price = amounts.length ? Math.min(...amounts) : null;
        } catch (e) { /* no price: the card shows none */ }
        out[i] = { n: live[i].name, s: live[i].slug, i: live[i].image || "", p: price };
      }
    }));
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    res.status(200).json({ products: out });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
