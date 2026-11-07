// Cloudflare Pages Function: GET /api/trpc/<namespace.procedure>
// Read-only proxy for a few WarEra tRPC procedures. The API key stays on the server.
// region.getRegionsObject is trimmed to the fields the country page uses.
const UPSTREAM = "https://api2.warera.io/trpc/";
const TTL = 60;
const ALLOWED = /^(region|company|country|worker|workOffer|government|gameConfig)\.[A-Za-z]+$/;
const REGION_KEYS = ["_id", "name", "country", "initialCountry", "strategicResource", "income", "companyCount", "employeeCount"];

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const unwrap = p => { let d = Array.isArray(p) ? p[0] : p; d = d?.result?.data ?? d; return d?.json ?? d; };
const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const proc = decodeURIComponent(params.proc || "");
  if (!ALLOWED.test(proc)) return json({ error: "Procedure not allowed" }, 400);

  const url = new URL(request.url);
  const input = url.searchParams.get("input");
  const cache = caches.default;
  const key = new Request(url.origin + url.pathname + (input ? "?input=" + encodeURIComponent(input) : ""));

  const hit = await cache.match(key);
  if (hit) return hit;

  let res;
  try {
    res = await fetch(UPSTREAM + proc + (input ? "?input=" + encodeURIComponent(input) : ""), {
      headers: env.WARERA_API_KEY ? { "X-API-Key": env.WARERA_API_KEY } : {},
    });
  } catch (err) {
    return json({ error: "Upstream request failed" }, 502);
  }
  const text = await res.text();
  if (!res.ok) return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });

  let body = text;
  if (proc === "region.getRegionsObject") {
    try {
      const d = unwrap(JSON.parse(text));
      const out = {};
      for (const [id, r] of Object.entries(d)) out[id] = pick(r, REGION_KEYS);
      body = JSON.stringify({ result: { data: out } });
    } catch (err) { /* pass the original through */ }
  }

  const out = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=0, s-maxage=${TTL}` } });
  context.waitUntil(cache.put(key, out.clone()));
  return out;
}
