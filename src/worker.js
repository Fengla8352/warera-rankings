// Cloudflare Worker with static assets.
// /api/countries and /api/trpc/<proc> are answered here (the WarEra API key stays secret on the server).
// Everything else is served from the public/ folder by Cloudflare, which does not run this code.
const UPSTREAM = "https://api2.warera.io/trpc/";
const TTL_MS = 60 * 1000;
const ALLOWED = /^(region|company|country|worker|workOffer|government|gameConfig|alliance)\.[A-Za-z]+$/;
const COUNTRY_KEYS = ["_id", "name", "code", "govType", "income", "taxes", "currentPopulation", "currentDevelopment", "allianceId"];
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

// Alliance names: the API's alliance procedures are undocumented, so several likely names are tried.
// Whatever works is returned; if nothing does, the page falls back to labels built from member countries.
// alliance.getById is the one that exists on the live API (the list-style names all returned 404).
const LIST_PROCS = [];
const ONE_PROCS = ["alliance.getById", "alliance.getAllianceById", "alliance.getAlliance"];
const ttl = 10 * 60 * 1000;
let allianceMemo = null;

async function tryProc(proc, input, env) {
  const r = await upstream(proc, input, env, null);
  let data = null;
  if (r.status === 200) { try { data = unwrap(JSON.parse(r.body)); } catch (e) { /* ignore */ } }
  return { status: r.status, data };
}

// The alliance picture's field name is not documented, so any text field that looks like an image is used.
const IMG_KEY = /avatar|logo|emblem|image|icon|banner|picture/i;
function imageOf(a) {
  const keys = Object.keys(a).filter(k => IMG_KEY.test(k) && typeof a[k] === "string" && a[k]);
  const best = keys.find(k => /avatar|logo|emblem/i.test(k)) || keys[0];
  return best ? a[best] : undefined;
}

async function alliances(env) {
  if (allianceMemo && Date.now() - allianceMemo.at < ttl) return respond(allianceMemo.body);
  const tried = [];
  const found = new Map();
  let fields = [];
  const add = a => {
    if (!a || !a._id || !a.name) return;
    if (!fields.length) fields = Object.keys(a);
    found.set(a._id, { _id: a._id, name: a.name, image: imageOf(a) });
  };
  for (const proc of LIST_PROCS) {
    const r = await tryProc(proc, JSON.stringify({ limit: 100 }), env);
    tried.push({ proc, status: r.status });
    const d = r.data;
    const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.alliances) ? d.alliances : [];
    list.forEach(add);
    if (found.size) break;
  }
  if (!found.size) {
    const c = await upstream("country.getAllCountries", null, env, null);
    let ids = [];
    try {
      const d = unwrap(JSON.parse(c.body));
      const list = Array.isArray(d) ? d : Object.values(d);
      ids = [...new Set(list.map(x => x.allianceId).filter(Boolean))];
    } catch (e) { /* ignore */ }
    for (const proc of ONE_PROCS) {
      if (!ids.length) break;
      const r = await tryProc(proc, JSON.stringify({ allianceId: ids[0] }), env);
      tried.push({ proc, status: r.status });
      if (r.data && r.data.name) {
        add(r.data);
        for (const id of ids.slice(1)) {
          const x = await tryProc(proc, JSON.stringify({ allianceId: id }), env);
          add(x.data);
        }
        break;
      }
    }
  }
  const body = JSON.stringify({ result: { data: { alliances: [...found.values()], fields, tried } } });
  if (found.size) allianceMemo = { at: Date.now(), body };
  return respond(body);
}

// ---------- History ----------
// Snapshots (about one every 2 hours) of every country's income are kept in one KV value (binding HISTORY), for 14 days.
// Format: { ids: [countryId...], t: [epoch ms...], d: [[hourly income total per id]...] } (row i belongs to t[i]).
const HIST_KEY = "history";
const KEEP_MS = 14 * 24 * 3600 * 1000;
const MIN_GAP_MS = 100 * 60 * 1000;   // one snapshot about every 2 hours
let histMemo = null; // { at, h }

async function readHistory(env, fresh) {
  if (!env.HISTORY) return null;
  if (!fresh && histMemo && Date.now() - histMemo.at < TTL_MS) return histMemo.h;
  const h = (await env.HISTORY.get(HIST_KEY, "json")) || { ids: [], t: [], d: [] };
  histMemo = { at: Date.now(), h };
  return h;
}

async function snapshot(env) {
  if (!env.HISTORY) return;
  const h = await readHistory(env, true);
  const now = Date.now();
  if (h.t.length && now - h.t[h.t.length - 1] < MIN_GAP_MS) return;
  const res = await cached("countries", () => upstream("country.getAllCountries", null, env, trimCountries));
  if (!res.ok) return;
  const d = unwrap(JSON.parse(await res.text()));
  const list = Array.isArray(d) ? d : [];
  const idx = new Map(h.ids.map((id, i) => [id, i]));
  const row = [];
  for (const c of list) {
    if (!c._id || typeof c.income?.total !== "number") continue;
    if (!idx.has(c._id)) { idx.set(c._id, h.ids.length); h.ids.push(c._id); }
    row[idx.get(c._id)] = Math.round(c.income.total * 100) / 100;
  }
  for (let i = 0; i < h.ids.length; i++) if (row[i] === undefined) row[i] = null;
  h.t.push(now); h.d.push(row);
  while (h.t.length && h.t[0] < now - KEEP_MS) { h.t.shift(); h.d.shift(); }
  await env.HISTORY.put(HIST_KEY, JSON.stringify(h));
  histMemo = { at: now, h };
}

async function history(url, env, ctx) {
  const h = await readHistory(env);
  if (!h) return respond(JSON.stringify({ result: { data: { enabled: false, ids: [], t: [], d: [] } } }));
  if (!h.t.length || Date.now() - h.t[h.t.length - 1] > MIN_GAP_MS) ctx.waitUntil(snapshot(env).catch(() => {}));
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "336", 10) || 336, 1), 336);
  const from = Date.now() - hours * 3600 * 1000;
  const start = h.t.findIndex(t => t >= from);
  const i0 = start < 0 ? h.t.length : start;
  return respond(JSON.stringify({ result: { data: { enabled: true, ids: h.ids, t: h.t.slice(i0), d: h.d.slice(i0) } } }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return fail("Method not allowed", 405);

    if (url.pathname === "/api/countries") {
      return cached("countries", () => upstream("country.getAllCountries", null, env, trimCountries));
    }

    if (url.pathname === "/api/alliances") return alliances(env);
    if (url.pathname === "/api/history") return history(url, env, ctx);

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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshot(env).catch(() => {}));
  },
};
