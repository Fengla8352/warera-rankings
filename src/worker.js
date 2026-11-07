// Cloudflare Worker with static assets.
// /api/countries and /api/trpc/<proc> are answered here (the WarEra API key stays secret on the server).
// Everything else is served from the public/ folder by Cloudflare, which does not run this code.
const UPSTREAM = "https://api2.warera.io/trpc/";
const TTL_MS = 60 * 1000;
const ALLOWED = /^(region|company|country|worker|workOffer|government|gameConfig)\.[A-Za-z]+$/;
const COUNTRY_KEYS = ["_id", "name", "code", "govType", "income", "taxes", "currentPopulation", "currentDevelopment"];
const REGION_KEYS = ["_id", "name", "country", "initialCountry", "strategicResource", "income", "companyCount", "employeeCount"];

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const unwrap = p => { let d = Array.isArray(p) ? p[0] : p; d = d?.result?.data ?? d; return d?.json ?? d; };
const respond = (body, status = 200) => new Response(body, {
  status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": status === 200 ? "public, max-age=0, s-maxage=60" : "no-store",
  },
});
const fail = (msg, status) => respond(JSON.stringify({ error: msg }), status);

// In-memory cache, shared by all requests handled by the same running instance.
// It keeps the WarEra API to about one request per minute per instance.
// A request already in flight is reused, so a burst of visitors causes a single upstream call.
const memo = new Map(); // key -> { at, body, promise }

async function cached(key, produce) {
  const e = memo.get(key);
  if (e?.body && Date.now() - e.at < TTL_MS) return respond(e.body);
  if (e?.promise) return e.promise.then(r => r.clone());
  const promise = (async () => {
    const out = await produce();           // { status, body }
    if (out.status === 200) memo.set(key, { at: Date.now(), body: out.body });
    else memo.delete(key);
    return respond(out.body, out.status);
  })();
  memo.set(key, { ...(e || {}), promise });
  try { return (await promise).clone(); }
  finally { const cur = memo.get(key); if (cur) { delete cur.promise; if (!cur.body) memo.delete(key); } }
}

async function upstream(proc, input, env, trim) {
  const url = UPSTREAM + proc + (input ? "?input=" + encodeURIComponent(input) : "");
  let res;
  try { res = await fetch(url, { headers: env.WARERA_API_KEY ? { "X-API-Key": env.WARERA_API_KEY } : {} }); }
  catch (err) { return { status: 502, body: JSON.stringify({ error: "Upstream request failed" }) }; }
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  let body = text;
  if (trim) { try { body = trim(unwrap(JSON.parse(text))); } catch (err) { /* unknown shape: pass through */ } }
  return { status: 200, body };
}

const trimCountries = d => {
  const list = Array.isArray(d) ? d : Object.entries(d).map(([_id, c]) => ({ _id, ...c }));
  return JSON.stringify({ result: { data: list.map(c => pick(c, COUNTRY_KEYS)) } });
};
const trimRegions = d => {
  const out = {};
  for (const [id, r] of Object.entries(d)) out[id] = pick(r, REGION_KEYS);
  return JSON.stringify({ result: { data: out } });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return fail("Method not allowed", 405);

    if (url.pathname === "/api/countries") {
      return cached("countries", () => upstream("country.getAllCountries", null, env, trimCountries));
    }

    const m = /^\/api\/trpc\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const proc = decodeURIComponent(m[1]);
      if (!ALLOWED.test(proc)) return fail("Procedure not allowed", 400);
      const input = url.searchParams.get("input");
      const trim = proc === "region.getRegionsObject" ? trimRegions : null;
      return cached(proc + "|" + (input || ""), () => upstream(proc, input, env, trim));
    }

    if (url.pathname.startsWith("/api/")) return fail("Not found", 404);
    return env.ASSETS.fetch(request);   // static files from public/
  },
};
