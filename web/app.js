(() => {
  const $ = (id) => document.getElementById(id);
  const DEMO = new URLSearchParams(location.search).has("demo");
  const SOURCE = DEMO ? "demo.json" : "/api/stats";

  const TIER_COLORS = {
    iron: "#7d7f81", bronze: "#b0814f", silver: "#c3cbd0", gold: "#e8b443", platinum: "#45b3c4",
    diamond: "#c88cf0", ascendant: "#3fcf86", immortal: "#e0465e", radiant: "#fff1a8",
  };
  const tierColor = (tier) => TIER_COLORS[(tier || "").split(" ")[0].toLowerCase()] || "#8a9aa7";

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const pct = (x) => (isFinite(x) ? Math.round(x * 100) + "%" : "–");
  const fix = (x, d = 2) => (isFinite(x) ? x.toFixed(d) : "–");
  const int = (x) => (isFinite(x) ? Math.round(x).toString() : "–");
  const signed = (x) => (x > 0 ? "+" + x : String(x));

  function ago(ts) {
    if (!ts) return "";
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    const d = Math.round(s / 86400);
    return d === 1 ? "yesterday" : d < 7 ? d + " days ago" : new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function avatar(name, icon) {
    const a = el("span", "avatar");
    const url = safeUrl(icon);
    if (url) {
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.src = url;
      img.onerror = () => { img.remove(); a.textContent = initials(name); };
      a.appendChild(img);
    } else a.textContent = initials(name);
    return a;
  }
  const initials = (s) => (s || "?").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();

  // ---------- aggregation ----------
  function summarize(ms) {
    const t = { n: ms.length, wins: 0, losses: 0, draws: 0, k: 0, d: 0, a: 0, score: 0, dmg: 0, hs: 0, shots: 0, rounds: 0 };
    for (const m of ms) {
      if (m.result === "win") t.wins++; else if (m.result === "loss") t.losses++; else t.draws++;
      t.k += m.kills; t.d += m.deaths; t.a += m.assists;
      t.score += m.score; t.dmg += m.damage; t.hs += m.headshots; t.shots += m.shots; t.rounds += m.rounds;
    }
    return {
      ...t,
      winRate: t.n ? t.wins / t.n : NaN,
      kd: t.k / Math.max(t.d, 1),
      kda: (t.k + t.a) / Math.max(t.d, 1),
      acs: t.rounds ? t.score / t.rounds : NaN,
      adr: t.rounds ? t.dmg / t.rounds : NaN,
      hsr: t.shots ? t.hs / t.shots : NaN,
    };
  }
  function groupBy(ms, key) {
    const g = new Map();
    for (const m of ms) {
      const k = m[key];
      if (!g.has(k)) g.set(k, { name: k, icon: m.agentIcon, list: [] });
      g.get(k).list.push(m);
    }
    return [...g.values()].map((x) => ({ ...x, s: summarize(x.list) })).sort((a, b) => b.s.n - a.s.n || b.s.winRate - a.s.winRate);
  }

  // ---------- render ----------
  function renderHeader(d) {
    $("name").textContent = d.player.name;
    $("tag").textContent = "#" + d.player.tag;
    $("level").textContent = d.player.level ?? "–";
    $("region").textContent = (d.region || "eu").toUpperCase();
    document.title = `${d.player.name} · Valorant Stats`;
    const card = safeUrl(d.player.card);
    if (card) $("banner").style.setProperty("--card", `url("${card.replace(/"/g, "%22")}")`);
    const up = $("updated");
    up.textContent = (DEMO ? "Sample data · " : "") + "Updated " + ago(d.updatedAt);
    up.classList.toggle("stale", !!d.stale);
    if (d.stale) up.textContent += " · showing saved stats";
  }

  function renderRank(r) {
    const card = $("rank-card");
    const icon = $("rank-icon");
    icon.replaceChildren();
    if (!r) {
      $("rank-tier").textContent = "Unranked";
      icon.appendChild(el("span", "ph"));
      return;
    }
    card.style.setProperty("--tier", tierColor(r.tier));
    $("rank-tier").textContent = r.tier;
    const url = safeUrl(r.image);
    if (url) {
      const img = new Image();
      img.alt = r.tier;
      img.src = url;
      img.onerror = () => img.replaceWith(el("span", "ph"));
      icon.appendChild(img);
    } else icon.appendChild(el("span", "ph"));
    $("rr").textContent = r.rr ?? "–";
    requestAnimationFrame(() => ($("rr-fill").style.width = Math.max(0, Math.min(100, r.rr || 0)) + "%"));
    const lc = $("last-change");
    if (r.lastChange != null) {
      lc.textContent = signed(r.lastChange) + " RR";
      lc.className = "delta " + (r.lastChange > 0 ? "up" : r.lastChange < 0 ? "down" : "");
    }
    $("peak").textContent = r.peak ? r.peak.tier : "–";
  }

  function renderKpis(ms) {
    const s = summarize(ms);
    $("k-win").textContent = pct(s.winRate);
    $("k-record").textContent = s.n ? `${s.wins}W – ${s.losses}L${s.draws ? ` – ${s.draws}D` : ""}` : "No games";
    $("k-kd").textContent = fix(s.kd);
    $("k-kda").textContent = `KDA ${fix(s.kda)} · ${fix(s.k / (s.n || 1), 1)} kills/game`;
    $("k-acs").textContent = int(s.acs);
    $("k-hs").textContent = pct(s.hsr);
    $("k-adr").textContent = int(s.adr);
    const form = $("k-form");
    form.replaceChildren();
    ms.slice(0, 10).reverse().forEach((m) => {
      const i = el("i", m.result);
      i.title = `${m.result.toUpperCase()} · ${m.map} ${m.teamScore}–${m.enemyScore}`;
      form.appendChild(i);
    });
    $("k-sample").textContent = s.n ? `Last ${s.n} competitive` : "No games yet";
  }

  function renderChart(hist) {
    const box = $("rr-chart");
    box.replaceChildren();
    const h = hist.filter((x) => isFinite(x.change));
    if (!h.length) {
      box.appendChild(el("div", "empty-row", "RR history appears after your next competitive game."));
      $("rr-net").textContent = "";
      return;
    }
    const net = h.reduce((a, x) => a + x.change, 0);
    const meta = $("rr-net");
    meta.replaceChildren(`Net `, el("b", net > 0 ? "up" : net < 0 ? "down" : "", signed(net) + " RR"), ` over ${h.length} games`);

    const W = 960, H = 240, L = 40, R = 12, T = 22, B = 30;
    const maxAbs = Math.max(30, Math.ceil(Math.max(...h.map((x) => Math.abs(x.change))) / 10) * 10);
    const y = (v) => T + ((maxAbs - v) / (2 * maxAbs)) * (H - T - B);
    const band = (W - L - R) / h.length;
    const bw = Math.min(36, band * 0.62);
    const ns = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `RR change per game, net ${signed(net)} over ${h.length} games` });
    const grid = s("g", { class: "grid" });
    for (const v of [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs]) {
      grid.appendChild(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "zero" : "" }));
      grid.appendChild(s("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }, v === 0 ? "0" : signed(v)));
    }
    svg.appendChild(grid);
    const labelEvery = h.length > 24 ? Math.ceil(h.length / 12) : 1;
    h.forEach((x, i) => {
      const cx = L + band * i + band / 2;
      const top = y(Math.max(0, x.change)), bot = y(Math.min(0, x.change));
      const cls = x.change > 0 ? "up" : x.change < 0 ? "down" : "flat";
      const r = s("rect", { x: cx - bw / 2, y: top, width: bw, height: Math.max(2, bot - top), class: cls });
      r.appendChild(s("title", {}, `${signed(x.change)} RR${x.map ? " · " + x.map : ""}${x.tier ? " · " + x.tier : ""}`));
      svg.appendChild(r);
      if (h.length <= 24) svg.appendChild(s("text", { x: cx, y: x.change >= 0 ? top - 6 : bot + 14, "text-anchor": "middle", class: "v" }, signed(x.change)));
      if (i % labelEvery === 0 && x.map) svg.appendChild(s("text", { x: cx, y: H - 8, "text-anchor": "middle" }, x.map.slice(0, 6).toUpperCase()));
    });
    box.appendChild(svg);
  }

  function renderTable(id, rows, kind) {
    const tb = $(id);
    tb.replaceChildren();
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "empty", "No competitive games yet.");
      td.colSpan = 5;
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = el("tr");
      const name = el("td", "name");
      if (kind === "agent") name.appendChild(avatar(r.name, r.icon));
      name.appendChild(el("span", null, r.name));
      const wr = el("td", "n");
      const w = el("span", "wr");
      const bar = el("span", "wr-bar");
      const fill = el("i");
      fill.style.width = pct(r.s.winRate);
      bar.appendChild(fill);
      w.append(el("span", r.s.winRate >= 0.5 ? "good" : "bad", pct(r.s.winRate)), bar);
      wr.appendChild(w);
      const cells = kind === "agent"
        ? [name, el("td", "n", r.s.n), wr, el("td", "n " + (r.s.kd >= 1 ? "good" : "bad"), fix(r.s.kd)), el("td", "n", int(r.s.acs))]
        : [name, el("td", "n", r.s.n), el("td", "n", `${r.s.wins}–${r.s.losses}${r.s.draws ? "–" + r.s.draws : ""}`), wr, el("td", "n", int(r.s.acs))];
      tr.append(...cells);
      tb.appendChild(tr);
    }
  }

  function renderMatches(ms, hist) {
    const list = $("matches");
    list.replaceChildren();
    if (!ms.length) {
      list.appendChild(el("li", "empty-row", "No competitive matches found yet."));
      return;
    }
    const rrById = new Map(hist.filter((h) => h.matchId).map((h) => [h.matchId, h.change]));
    ms.forEach((m, i) => {
      const li = el("li", "match " + m.result);
      li.style.animationDelay = i * 40 + "ms";
      const map = el("div", "m-map");
      map.append(el("strong", null, m.map), el("span", null, `${m.agent} · ${ago(m.startedAt)}`));
      const score = el("div", "m-score", `${m.teamScore ?? "–"}–${m.enemyScore ?? "–"}`);
      score.appendChild(el("small", null, m.result === "win" ? "Victory" : m.result === "loss" ? "Defeat" : "Draw"));
      const stat = (v, k, cls) => {
        const d = el("div", "m-stat");
        d.append(el("b", cls || null, v), el("span", null, k));
        return d;
      };
      const kd = m.kills / Math.max(m.deaths, 1);
      const stats = el("div", "m-stats");
      stats.append(
        stat(`${m.kills}/${m.deaths}/${m.assists}`, "K/D/A", kd >= 1 ? "good" : "bad"),
        stat(int(m.score / Math.max(m.rounds, 1)), "ACS"),
        stat(pct(m.headshots / Math.max(m.shots, 1)), "HS%"),
        stat(int(m.damage / Math.max(m.rounds, 1)), "ADR"),
      );
      const change = rrById.get(m.id);
      const rr = el("div", "m-rr " + (change == null ? "none" : change > 0 ? "good" : change < 0 ? "bad" : ""), change == null ? "—" : signed(change));
      li.append(el("span", "stripe"), avatar(m.agent, m.agentIcon), map, score, stats, rr);
      list.appendChild(li);
    });
  }

  function render(d) {
    const ms = (d.matches || []).slice().sort((a, b) => b.startedAt - a.startedAt);
    const hist = d.history || [];
    renderHeader(d);
    renderRank(d.rank);
    renderKpis(ms);
    renderChart(hist);
    renderTable("agents", groupBy(ms, "agent"), "agent");
    renderTable("maps", groupBy(ms, "map"), "map");
    renderMatches(ms, hist);
  }

  function notice(msg, kind) {
    const n = $("notice");
    n.textContent = msg;
    n.className = "notice" + (kind ? " " + kind : "");
    n.hidden = !msg;
  }

  async function load() {
    const btn = $("refresh");
    btn.classList.add("spin");
    btn.disabled = true;
    document.body.classList.add("loading");
    try {
      const res = await fetch(SOURCE, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The stats service answered ${res.status}.`);
      render(body);
      notice(DEMO ? "You're viewing sample data. Remove ?demo from the address to see live stats." : "", DEMO ? "info" : "");
    } catch (err) {
      notice(err.message || "Couldn't load stats. Try again in a minute.");
      $("updated").textContent = "Stats unavailable";
    } finally {
      document.body.classList.remove("loading");
      btn.classList.remove("spin");
      btn.disabled = false;
    }
  }

  $("refresh").addEventListener("click", load);
  load();
})();
