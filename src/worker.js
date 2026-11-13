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
const NAMES_KEY = "alliance-names";
let namesWritten = "";

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
  if (found.size) {
    allianceMemo = { at: Date.now(), body };
    /* The daily report job needs the names too, but must not spend its limited requests looking them up. */
    if (env.HISTORY) {
      const names = JSON.stringify(Object.fromEntries([...found.values()].map(a => [a._id, a.name])));
      if (names !== namesWritten) { try { await env.HISTORY.put(NAMES_KEY, names); namesWritten = names; } catch (e) { /* ignore */ } }
    }
  }
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

// ---------- Daily Discord reports ----------
// A visitor gives a Discord webhook URL and picks a country, an alliance or the world top 10. Once a day, at the hour
// they choose (in their own time zone), the cron job posts a short report to that channel.
// Subscriptions live in one KV value. The webhook URL is stored, is never sent back to anyone, and is needed to list or remove a report.
const SUBS_KEY = "subs";
const MAX_SUBS = 300, MAX_PER_WEBHOOK = 3, MAX_SENDS_PER_RUN = 25;   // the free plan allows 50 outgoing requests per run
const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const noStore = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const readSubs = async env => (await env.HISTORY.get(SUBS_KEY, "json")) || [];
const writeSubs = (env, subs) => env.HISTORY.put(SUBS_KEY, JSON.stringify(subs));

/* Simple abuse limit per visitor address. */
async function allow(env, key, limit, ttl) {
  const k = "rl:" + key;
  const n = parseInt((await env.HISTORY.get(k)) || "0", 10);
  if (n >= limit) return false;
  await env.HISTORY.put(k, String(n + 1), { expirationTtl: ttl });
  return true;
}

function localParts(tz, ms = Date.now()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(ms).map(x => [x.type, x.value]));
  return { hour: parseInt(p.hour, 10) % 24, day: `${p.year}-${p.month}-${p.day}` };
}
const validTz = tz => { try { return typeof tz === "string" && tz.length < 64 && !!localParts(tz); } catch (e) { return false; } };

async function readNames(env) {
  try {
    if (allianceMemo) return Object.fromEntries(JSON.parse(allianceMemo.body).result.data.alliances.map(a => [a._id, a.name]));
    return (await env.HISTORY.get(NAMES_KEY, "json")) || {};
  } catch (e) { return {}; }
}

async function gather(env) {
  const res = await cached("countries", () => upstream("country.getAllCountries", null, env, trimCountries));
  if (!res.ok) throw new Error("countries unavailable");
  const d = unwrap(JSON.parse(await res.text()));
  const list = Array.isArray(d) ? d : [];
  return { list, byId: Object.fromEntries(list.map(c => [c._id, c])), hist: await readHistory(env), names: await readNames(env), now: Date.now() };
}

/* Number helpers. Income values from the API are per hour; reports show per day. */
const n0 = v => Math.round(v).toLocaleString("en-US");
const day = c => (c.income?.total || 0) * 24;
const pct = d => d === null ? "" : (d > 0.05 ? "▲ +" : d < -0.05 ? "▼ −" : "") + Math.abs(d).toFixed(1) + "%";
const flagOf = code => { code = code === "uk" ? "gb" : code; return /^[a-z]{2}$/.test(code || "") ? String.fromCodePoint(...[...code.toUpperCase()].map(ch => 127397 + ch.charCodeAt(0))) + " " : ""; };

function baseIndex(h, now) {
  if (!h || !h.t.length) return -1;
  const target = now - 24 * 3600e3;
  let best = 0;
  h.t.forEach((t, i) => { if (Math.abs(t - target) < Math.abs(h.t[best] - target)) best = i; });
  return now - h.t[best] >= 12 * 3600e3 ? best : -1;
}
function histValue(h, i, ids) {
  let s = 0, n = 0;
  for (const id of ids) { const j = h.ids.indexOf(id); const v = j < 0 ? null : h.d[i][j]; if (typeof v === "number") { s += v; n++; } }
  return n ? s : null;
}
/* Change of the sum of these countries' income since the baseline snapshot, in %. */
function changePct(data, ids) {
  const bi = baseIndex(data.hist, data.now);
  if (bi < 0) return null;
  const members = ids.map(id => data.byId[id]).filter(Boolean);
  const base = histValue(data.hist, bi, ids), cur = members.reduce((t, c) => t + (c.income?.total || 0), 0);
  return base && base > 0 ? (cur - base) / base * 100 : null;
}
function spark(data, ids) {
  const h = data.hist;
  if (!h || !h.t.length) return "";
  const from = data.now - 7 * 24 * 3600e3;
  const vals = [];
  h.t.forEach((t, i) => { if (t >= from) { const v = histValue(h, i, ids); if (v !== null) vals.push(v); } });
  if (vals.length < 3) return "";
  const pick = vals.length > 16 ? Array.from({ length: 16 }, (_, k) => vals[Math.round(k * (vals.length - 1) / 15)]) : vals;
  const lo = Math.min(...pick), hi = Math.max(...pick), blocks = "▁▂▃▄▅▆▇█";
  return pick.map(v => blocks[hi === lo ? 3 : Math.round((v - lo) / (hi - lo) * 7)]).join("");
}

function groupsOf(data) {
  const g = {};
  for (const c of data.list) if (c.allianceId) (g[c.allianceId] = g[c.allianceId] || []).push(c);
  return g;
}
/* Real name when known, otherwise the same label the website uses: the biggest members. */
function allianceName(data, id) {
  if (data.names[id]) return data.names[id];
  const mem = (groupsOf(data)[id] || []).sort((a, b) => day(b) - day(a));
  return mem.length ? "Alliance of " + mem.slice(0, 3).map(m => m.name).join(", ") + (mem.length > 3 ? " +" + (mem.length - 3) : "") : "Alliance";
}
const embedBase = (origin, extra) => ({ color: 0xd9a73a, timestamp: new Date().toISOString(), footer: { text: "WarEra Country Rankings · " + origin.replace(/^https?:\/\//, "") }, ...extra });

function countryReport(data, id, origin) {
  const c = data.byId[id]; if (!c) return null;
  const ranked = [...data.list].sort((a, b) => day(b) - day(a));
  const rank = ranked.findIndex(x => x._id === id) + 1;
  const ch = changePct(data, [id]), sp = spark(data, [id]);
  const inc = c.income || {}, t = c.taxes || {};
  const src = [["Development", inc.development], ["Strategic resources", inc.strategicResourcesBonus], ["Employee tax", inc.employeeIncomeTax], ["Manager tax", inc.managerIncomeTax], ["Gov. bonus", inc.govType]]
    .filter(([l, v]) => l !== "Strategic resources" || v).map(([l, v]) => `${l} **${n0((v || 0) * 24)}**`).join("\n");
  const fields = [
    { name: "Daily income", value: `**${n0(day(c))}** gold` + (ch !== null ? `\n${pct(ch)} vs 24 h ago` : ""), inline: true },
    { name: "Rank", value: `#${rank} of ${ranked.length}`, inline: true },
    { name: "Population", value: n0(c.currentPopulation || 0), inline: true },
    { name: "Income by source (per day)", value: src, inline: true },
    { name: "Tax rates", value: `Income **${+(t.income || 0).toFixed(2)}%**\nManager **${+(t.manager || 0).toFixed(2)}%**\nMarket **${+(t.market || 0).toFixed(2)}%**`, inline: true },
  ];
  if (c.allianceId) {
    const mem = groupsOf(data)[c.allianceId] || [];
    fields.push({ name: "Alliance", value: `${allianceName(data, c.allianceId)} · ${mem.length} countries · **${n0(mem.reduce((t2, m) => t2 + day(m), 0))}** gold per day`, inline: false });
  }
  if (sp) fields.push({ name: "Last 7 days", value: sp, inline: false });
  return embedBase(origin, { title: `${flagOf(c.code)}${c.name}: daily report`, url: `${origin}/country.html?c=${encodeURIComponent(id)}`, fields });
}

function allianceReport(data, id, origin) {
  const mem = groupsOf(data)[id]; if (!mem || !mem.length) return null;
  mem.sort((a, b) => day(b) - day(a));
  const total = mem.reduce((t, m) => t + day(m), 0);
  const all = Object.values(groupsOf(data)).map(g => g.reduce((t, m) => t + day(m), 0)).sort((a, b) => b - a);
  const rank = all.findIndex(v => v === total) + 1;
  const ids = mem.map(m => m._id), ch = changePct(data, ids), sp = spark(data, ids);
  const list = mem.slice(0, 10).map((m, i) => `${i + 1}. ${flagOf(m.code)}${m.name}: **${n0(day(m))}** (${total ? Math.round(day(m) / total * 100) : 0}%)`).join("\n") + (mem.length > 10 ? `\n…and ${mem.length - 10} more` : "");
  const fields = [
    { name: "Combined daily income", value: `**${n0(total)}** gold` + (ch !== null ? `\n${pct(ch)} vs 24 h ago` : ""), inline: true },
    { name: "Rank", value: `#${rank} of ${all.length} alliances`, inline: true },
    { name: "Countries", value: String(mem.length), inline: true },
    { name: "Members, by income", value: list, inline: false },
  ];
  if (sp) fields.push({ name: "Last 7 days", value: sp, inline: false });
  return embedBase(origin, { title: `${allianceName(data, id)}: daily report`, url: `${origin}/#alliance/${encodeURIComponent(id)}`, fields });
}

function worldReport(data, origin) {
  const ranked = [...data.list].sort((a, b) => day(b) - day(a));
  const bi = baseIndex(data.hist, data.now);
  const delta = c => { if (bi < 0) return null; const b = histValue(data.hist, bi, [c._id]); return b && b > 0 ? { abs: (c.income.total - b) * 24, pc: (c.income.total - b) / b * 100 } : null; };
  const top = ranked.slice(0, 10).map((c, i) => { const d = delta(c); return `${i + 1}. ${flagOf(c.code)}${c.name}: **${n0(day(c))}**${d ? " " + pct(d.pc) : ""}`; }).join("\n");
  const fields = [];
  if (bi >= 0) {
    const moved = ranked.map(c => ({ c, d: delta(c) })).filter(x => x.d);
    const fmt = x => `${flagOf(x.c.code)}${x.c.name}: **${x.d.abs > 0 ? "+" : "−"}${n0(Math.abs(x.d.abs))}** (${pct(x.d.pc)})`;
    const up = [...moved].sort((a, b) => b.d.abs - a.d.abs).filter(x => x.d.abs > 0).slice(0, 3).map(fmt).join("\n");
    const dn = [...moved].sort((a, b) => a.d.abs - b.d.abs).filter(x => x.d.abs < 0).slice(0, 3).map(fmt).join("\n");
    if (up) fields.push({ name: "Biggest gains in 24 h", value: up, inline: true });
    if (dn) fields.push({ name: "Biggest drops in 24 h", value: dn, inline: true });
  }
  const total = data.list.reduce((t, c) => t + day(c), 0), ch = changePct(data, data.list.map(c => c._id));
  fields.push({ name: "All countries together", value: `**${n0(total)}** gold per day` + (ch !== null ? ` (${pct(ch)})` : ""), inline: false });
  return embedBase(origin, { title: "WarEra: top 10 countries by daily income", url: origin + "/", description: top, fields });
}

function buildReport(data, sub, origin) {
  if (sub.type === "country") return countryReport(data, sub.target, origin);
  if (sub.type === "alliance") return allianceReport(data, sub.target, origin);
  if (sub.type === "world") return worldReport(data, origin);
  return null;
}

async function postWebhook(webhook, embed, content) {
  try {
    const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "WarEra Rankings", content, embeds: [embed], allowed_mentions: { parse: [] } }) });
    return res.status;
  } catch (e) { return 0; }
}

/* Runs from the cron trigger: sends every report that is due. A report is due when the local hour has reached the chosen hour
   and nothing was sent yet today, so a missed run is simply caught up on the next one. */
async function sendDue(env) {
  if (!env.HISTORY) return;
  const subs = await readSubs(env);
  if (!subs.length) return;
  const now = Date.now();
  const due = subs.filter(s => { const lt = localParts(s.tz, now); return lt.hour >= s.hour && s.last !== lt.day; }).slice(0, MAX_SENDS_PER_RUN);
  if (!due.length) return;
  const data = await gather(env);
  const drop = new Set();
  for (const s of due) {
    const embed = buildReport(data, s, s.origin);
    if (!embed) { drop.add(s.id); continue; }
    const status = await postWebhook(s.wh, embed, "");
    if (status >= 200 && status < 300) s.last = localParts(s.tz, now).day;
    else if (status === 401 || status === 403 || status === 404) drop.add(s.id);   // the webhook was deleted
  }
  await writeSubs(env, subs.filter(s => !drop.has(s.id)));
}

const typeName = { country: "Country", alliance: "Alliance", world: "World top 10" };
function subLabel(data, s) {
  if (s.type === "country") return data.byId[s.target]?.name || "Unknown country";
  if (s.type === "alliance") return allianceName(data, s.target);
  return "World top 10";
}

async function reportApi(request, url, env) {
  if (!env.HISTORY) return noStore({ error: "Reports are not available: storage is not set up on this site." }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let body;
  try { const t = await request.text(); if (t.length > 2000) throw new Error("big"); body = JSON.parse(t); }
  catch (e) { return noStore({ error: "Invalid request." }, 400); }
  const action = url.pathname.slice("/api/report/".length);
  const wh = typeof body.webhook === "string" ? body.webhook.trim() : "";
  if (!WEBHOOK_RE.test(wh)) return noStore({ error: "That is not a Discord webhook URL. It should look like https://discord.com/api/webhooks/…" }, 400);

  if (action === "list" || action === "unsubscribe") {
    if (!(await allow(env, action + ":" + ip, 30, 3600))) return noStore({ error: "Too many requests, try again later." }, 429);
    const subs = await readSubs(env);
    if (action === "unsubscribe") {
      const next = subs.filter(s => !(s.wh === wh && (body.all || s.id === body.id)));
      if (next.length !== subs.length) await writeSubs(env, next);
      return noStore({ ok: true, removed: subs.length - next.length });
    }
    const mine = subs.filter(s => s.wh === wh);
    const data = mine.length ? await gather(env) : null;
    return noStore({ ok: true, reports: mine.map(s => ({ id: s.id, type: s.type, typeName: typeName[s.type], name: subLabel(data, s), hour: s.hour, tz: s.tz })) });
  }

  if (action === "subscribe") {
    if (!(await allow(env, "sub:" + ip, 6, 3600))) return noStore({ error: "Too many attempts from your address, try again in an hour." }, 429);
    const type = body.type, target = typeof body.target === "string" ? body.target.slice(0, 64) : "";
    const hour = Number.isInteger(body.hour) ? body.hour : -1;
    if (!typeName[type] || hour < 0 || hour > 23 || !validTz(body.tz)) return noStore({ error: "Invalid report settings." }, 400);
    const origin = new URL(request.url).origin;
    const data = await gather(env);
    if (!Object.keys(data.names).length) { await alliances(env).catch(() => {}); data.names = await readNames(env); }   // first use: look the names up once
    if (type === "country" && !data.byId[target]) return noStore({ error: "Unknown country." }, 400);
    if (type === "alliance" && !groupsOf(data)[target]) return noStore({ error: "Unknown alliance." }, 400);

    const check = await fetch(wh).catch(() => null);   // a real webhook answers a plain GET with its details
    if (!check || !check.ok) return noStore({ error: "Discord does not recognise this webhook. Check that you copied the whole URL and that the webhook still exists." }, 400);

    const subs = await readSubs(env);
    const same = subs.find(s => s.wh === wh && s.type === type && (type === "world" || s.target === target));
    if (!same && subs.filter(s => s.wh === wh).length >= MAX_PER_WEBHOOK) return noStore({ error: `At most ${MAX_PER_WEBHOOK} reports per webhook. Remove one first.` }, 400);
    if (!same && subs.length >= MAX_SUBS) return noStore({ error: "This site has reached its limit of daily reports. Try again later." }, 503);

    const sub = same || { id: crypto.randomUUID().slice(0, 8), wh, type, target: type === "world" ? "" : target, created: now0() };
    Object.assign(sub, { hour, tz: body.tz, origin });
    const lt = localParts(sub.tz);
    const embed = buildReport(data, sub, origin);
    const hh = String(hour).padStart(2, "0") + ":00";
    const status = await postWebhook(wh, embed, `✅ Daily report is set up. It will be posted here every day at ${hh} (${sub.tz}). To stop it, use ${origin}/reports.html with this webhook. This is today's report:`);
    if (!(status >= 200 && status < 300)) return noStore({ error: `Discord refused the message (status ${status}). Does the webhook's channel still exist?` }, 400);
    sub.last = lt.hour >= hour ? lt.day : null;    // the report just sent counts for today if the chosen hour has passed
    if (!same) subs.push(sub);
    await writeSubs(env, subs);
    return noStore({ ok: true, name: subLabel(data, sub), hour, tz: sub.tz });
  }
  return noStore({ error: "Not found" }, 404);
}
const now0 = () => new Date().toISOString().slice(0, 10);

/* Pages are served through the Worker only so the address of the site can be put into the link-preview tags (og:image needs a full URL). */
async function page(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const origin = new URL(request.url).origin;
  try {
    return new HTMLRewriter().on("meta, link", { element(el) {
      for (const a of ["content", "href"]) { const v = el.getAttribute(a); if (v && v.includes("__ORIGIN__")) el.setAttribute(a, v.replaceAll("__ORIGIN__", origin)); }
    } }).transform(res);
  } catch (e) { return res; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.startsWith("/api/report/")) return reportApi(request, url, env);
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
    if (/^\/(index\.html|country(\.html)?|reports(\.html)?)?$/.test(url.pathname)) return page(request, env);
    return env.ASSETS.fetch(request);   // static files from public/
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await snapshot(env).catch(() => {});
      await sendDue(env).catch(() => {});
    })());
  },
};
