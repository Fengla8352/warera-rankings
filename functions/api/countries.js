// Cloudflare Pages Function: GET /api/countries
// Fetches WarEra's country list with the secret API key, keeps only the fields the pages use,
// and caches the result at Cloudflare's edge for 60 s, so the WarEra API is called at most
// about once a minute no matter how many people have the page open.
const UPSTREAM = "https://api2.warera.io/trpc/country.getAllCountries";
const TTL = 60;
const KEYS = ["_id", "name", "code", "govType", "income", "taxes", "currentPopulation", "currentDevelopment"];

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const unwrap = p => { let d = Array.isArray(p) ? p[0] : p; d = d?.result?.data ?? d; return d?.json ?? d; };

export async function onRequestGet(context) {
  const { request, env } = context;
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + "/api/countries");

  const hit = await cache.match(key);
  if (hit) return hit;

  let res;
  try {
    res = await fetch(UPSTREAM, { headers: env.WARERA_API_KEY ? { "X-API-Key": env.WARERA_API_KEY } : {} });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream request failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  const text = await res.text();
  if (!res.ok) return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });

  let body = text;
  try {
    const d = unwrap(JSON.parse(text));
    const list = Array.isArray(d) ? d : Object.entries(d).map(([_id, c]) => ({ _id, ...c }));
    body = JSON.stringify({ result: { data: list.map(c => pick(c, KEYS)) } });
  } catch (err) { /* unknown shape: pass the original through */ }

  const out = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=0, s-maxage=${TTL}` } });
  context.waitUntil(cache.put(key, out.clone()));
  return out;
}
