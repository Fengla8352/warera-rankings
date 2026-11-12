/* Shared by index.html and country.html: loading the income history and drawing the line chart.
   History comes from /api/history (hourly snapshots kept by the Worker). */
(function () {
  const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const isNum = v => typeof v === "number" && isFinite(v);
  const HOUR = 3600 * 1000;
  const escH = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  const css = document.createElement("style");
  css.textContent = `
    .hc { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 12px 14px 8px; margin: 0 0 16px; }
    .hc[hidden] { display: none; }
    .hc-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .hc-title { font: 600 15px var(--display); margin: 0; }
    .hc-plot { position: relative; }
    .hc-plot svg { display: block; width: 100%; height: auto; overflow: visible; }
    .hc-plot text { font: 11px var(--mono); fill: var(--muted); }
    .hc-tip { position: absolute; pointer-events: none; background: var(--head); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; font: 12px var(--mono); white-space: nowrap; transform: translate(-50%, -100%); }
    .hc-tip b { color: var(--gold); font-weight: 500; }
    .hc-tip[hidden] { display: none; }
    .tools-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .tools-right .theme { margin-left: 0; }
    .iconbtn { width: 36px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .iconbtn svg { width: 16px; height: 16px; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; fill: none; }
    .iconbtn:hover { border-color: var(--muted); }
    .iconbtn[aria-expanded=true] svg { stroke: var(--gold); }
    .iconbtn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .cm { position: absolute; z-index: 30; min-width: 210px; max-height: 70vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
    .cm[hidden] { display: none; }
    .cm-h { font: 600 11px var(--body); text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
    .cm label { display: flex; align-items: center; gap: 8px; padding: 4px 0; font: 13px var(--body); cursor: pointer; }
    .cm input { accent-color: var(--gold); }
    .cm-reset { margin-top: 6px; background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 4px; padding: 3px 8px; font: 12px var(--body); cursor: pointer; }
    .cm-reset:hover { color: var(--fg); }
    .spark { display: block; margin-left: auto; width: 84px; height: 22px; }
    .hc-leg { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-size: 12px; margin-top: 6px; }
    .hc-leg i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .hc-leg:empty { display: none; }
    .hc-note { color: var(--muted); font-size: 12px; margin: 6px 0 2px; }
  `;
  document.head.appendChild(css);

  /* ----- History data ----- */
  async function loadHistory(hours) {
    const res = await fetch("/api/history?hours=" + hours, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    let d = await res.json();
    d = d?.result?.data ?? d;
    const ids = d.ids || [];
    return { enabled: d.enabled !== false, ids, t: d.t || [], d: d.d || [], idx: new Map(ids.map((id, i) => [id, i])) };
  }

  /* Sum of the hourly totals of the given countries over time: [{ t, v }]. */
  function series(h, countryIds) {
    const js = countryIds.map(id => h.idx.get(id)).filter(j => j !== undefined);
    const out = [];
    h.t.forEach((t, i) => {
      let s = 0, n = 0;
      for (const j of js) { const v = h.d[i][j]; if (isNum(v)) { s += v; n++; } }
      if (n) out.push({ t, v: s });
    });
    return out;
  }

  /* Index of the snapshot closest to 24 h ago, or -1 if the history is not at least 12 h old yet. */
  function baselineIndex(h, now) {
    if (!h || !h.t.length) return -1;
    const target = now - 24 * HOUR;
    let best = 0;
    h.t.forEach((t, i) => { if (Math.abs(t - target) < Math.abs(h.t[best] - target)) best = i; });
    return now - h.t[best] >= 12 * HOUR ? best : -1;
  }
  const valueAt = (h, i, id) => { const j = h.idx.get(id); const v = j === undefined ? null : h.d[i][j]; return isNum(v) ? v : null; };

  /* ----- Chart ----- */
  const RANGES = [["24h", 24], ["7d", 168], ["All", Infinity]];

  function niceStep(span, ticks) {
    const raw = span / ticks, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  const fmtTime = (t, span) => {
    const d = new Date(t);
    return span <= 36 * HOUR
      ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  function mountHistoryChart(box) {
    box.classList.add("hc");
    box.innerHTML = `<div class="hc-head"><h3 class="hc-title"></h3><div class="seg" role="group" aria-label="Chart range">${
      RANGES.map(([l], i) => `<button type="button" data-r="${i}" aria-pressed="${l === "7d"}">${l}</button>`).join("")
    }</div></div><div class="hc-plot"></div><div class="hc-leg"></div><p class="hc-note"></p>`;
    const title = box.querySelector(".hc-title"), plot = box.querySelector(".hc-plot"), leg = box.querySelector(".hc-leg"), note = box.querySelector(".hc-note");
    let range = 1, pts = [], opts = {};

    function draw() {
      for (const b of box.querySelectorAll("[data-r]")) b.setAttribute("aria-pressed", +b.dataset.r === range);
      title.textContent = opts.title || "";
      /* one series (the default, gold) or several: opts.series = [{ name, color, pts }] */
      const all = opts.series || [{ name: null, color: "var(--gold)", pts }];
      const last = Math.max(0, ...all.map(s => s.pts.length ? s.pts[s.pts.length - 1].t : 0));
      const ser = all.map(s => ({ ...s, view: s.pts.filter(p => p.t >= last - RANGES[range][1] * HOUR) })).filter(s => s.view.length >= 2);
      leg.innerHTML = opts.series ? ser.map(s => `<span><i style="background:${s.color}"></i>${escH(s.name)}</span>`).join("") : "";
      if (!ser.length) {
        plot.innerHTML = "";
        note.textContent = "History is being collected. The chart appears once there are a few snapshots.";
        return;
      }
      const W = Math.max(plot.clientWidth || box.clientWidth || 600, 280), H = 220;
      const m = { l: 58, r: 12, t: 10, b: 24 };
      const vals = ser.flatMap(s => s.view.map(p => p.v)), times = ser.flatMap(s => s.view.map(p => p.t));
      const t0 = Math.min(...times), t1 = Math.max(...times), span = t1 - t0 || 1;
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 1);
      lo -= pad; hi += pad;
      const step = niceStep(hi - lo, 4);
      const g0 = Math.ceil(lo / step) * step;
      const x = t => m.l + (t - t0) / span * (W - m.l - m.r);
      const y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
      let grid = "";
      for (let v = g0; v <= hi; v += step) grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line)"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${nf0.format(v)}</text>`;
      let xt = "";
      for (let i = 0; i < 5; i++) {
        const t = t0 + span * i / 4;
        xt += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${fmtTime(t, span)}</text>`;
      }
      const paths = ser.map(s => `<path d="${s.view.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join("")}" fill="none" style="stroke:${s.color}" stroke-width="2" stroke-linejoin="round"/>`).join("");
      const dots = ser.map((s, i) => `<circle class="dot" data-i="${i}" r="4" style="fill:${s.color}" visibility="hidden"/>`).join("");
      plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${(opts.title || "History").replace(/"/g, "")}">${grid}${xt}${paths}
        <line class="cur" y1="${m.t}" y2="${H - m.b}" style="stroke:var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>${dots}</svg><div class="hc-tip" hidden></div>`;
      const svg = plot.querySelector("svg"), cur = svg.querySelector(".cur"), tip = plot.querySelector(".hc-tip");
      const dotEls = [...svg.querySelectorAll(".dot")];
      const hide = () => { cur.setAttribute("visibility", "hidden"); dotEls.forEach(d => d.setAttribute("visibility", "hidden")); tip.hidden = true; };
      const ref = ser[0].view;
      svg.addEventListener("pointermove", e => {
        const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
        let best = ref[0];
        for (const p of ref) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
        const cx = x(best.t);
        cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); cur.setAttribute("visibility", "visible");
        const d = new Date(best.t);
        let cy = y(best.v), lines = "";
        ser.forEach((s, i) => {
          const p = s.view.find(q => q.t === best.t);
          if (!p) { dotEls[i].setAttribute("visibility", "hidden"); return; }
          dotEls[i].setAttribute("cx", cx); dotEls[i].setAttribute("cy", y(p.v)); dotEls[i].setAttribute("visibility", "visible");
          if (i === 0) cy = y(p.v);
          lines += ser.length > 1 ? `<div><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px"></i>${escH(s.name)} <b>${nf0.format(p.v)}</b></div>` : ` · <b>${nf0.format(p.v)}</b>`;
        });
        tip.innerHTML = `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${lines}`;
        tip.hidden = false;
        tip.style.left = Math.min(Math.max(cx / W * r.width, 80), r.width - 80) + "px";
        tip.style.top = (ser.length > 1 ? 24 : cy / H * r.height - 10) + "px";
        tip.style.transform = ser.length > 1 ? "translate(-50%, 0)" : "";
      });
      svg.addEventListener("pointerleave", hide);
      note.textContent = opts.note || "";
    }

    box.addEventListener("click", e => { const b = e.target.closest("[data-r]"); if (b) { range = +b.dataset.r; draw(); } });
    window.addEventListener("resize", () => { if (!box.hidden && pts.length) draw(); });
    return { set(p, o) { pts = p; opts = o || {}; draw(); } };
  }

  /* ----- Sparkline: a tiny line of recent values. Blue if it ended higher than it started, red if lower. ----- */
  function sparkline(vals) {
    if (!vals || vals.length < 2) return "—";
    const W = 84, H = 22, p = 2;
    const lo = Math.min(...vals), hi = Math.max(...vals), r = hi - lo || 1;
    const pts = vals.map((v, i) => (p + i / (vals.length - 1) * (W - 2 * p)).toFixed(1) + "," + (H - p - (v - lo) / r * (H - 2 * p)).toFixed(1)).join(" ");
    const c = vals[vals.length - 1] >= vals[0] ? "var(--good)" : "var(--bad)";
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  /* ----- Column picker: the hamburger button opens a list of checkboxes. The choice is kept in localStorage. ----- */
  function loadHidden(key) {
    try { return new Set(JSON.parse(localStorage.getItem("cols:" + key) || "[]")); } catch (e) { return new Set(); }
  }
  function saveHidden(key, set) {
    try { localStorage.setItem("cols:" + key, JSON.stringify([...set])); } catch (e) {}
  }

  /* o: { columns(): [{key,label}], hidden(): Set, changed(set) } */
  function mountColumnMenu(btn, o) {
    const pop = document.createElement("div");
    pop.className = "cm"; pop.hidden = true;
    document.body.appendChild(pop);
    const close = () => { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    function build() {
      const hidden = o.hidden();
      pop.innerHTML = '<div class="cm-h">Columns</div>' + o.columns().map(c =>
        `<label><input type="checkbox" data-k="${escH(c.key)}"${hidden.has(c.key) ? "" : " checked"}> ${escH(c.label)}</label>`).join("")
        + '<button type="button" class="cm-reset">Show all</button>';
    }
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (!pop.hidden) return close();
      build();
      const r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + window.scrollY + 6) + "px";
      pop.style.right = (document.documentElement.clientWidth - r.right) + "px";
      pop.hidden = false; btn.setAttribute("aria-expanded", "true");
    });
    pop.addEventListener("click", e => e.stopPropagation());
    pop.addEventListener("change", e => {
      const k = e.target.dataset.k, set = new Set(o.hidden());
      if (e.target.checked) set.delete(k); else set.add(k);
      o.changed(set);
    });
    pop.addEventListener("click", e => { if (e.target.closest(".cm-reset")) { o.changed(new Set()); build(); } });
    document.addEventListener("click", close);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !pop.hidden) { close(); btn.focus(); } });
  }

  window.WE = { sparkline, loadHidden, saveHidden, mountColumnMenu, loadHistory, series, baselineIndex, valueAt, mountHistoryChart };
})();
