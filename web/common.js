// Shared by the landing page and the player page.
window.VT = (() => {
  const DEMO = new URLSearchParams(location.search).has("demo");

  const TIER_COLORS = {
    iron: "#7d7f81", bronze: "#b0814f", silver: "#c3cbd0", gold: "#e8b443", platinum: "#45b3c4",
    diamond: "#c88cf0", ascendant: "#3fcf86", immortal: "#e0465e", radiant: "#fff1a8",
  };
  const tierColor = (tier) => TIER_COLORS[(tier || "").split(" ")[0].toLowerCase()] || "#8a9aa7";

  // Competitive tier ids: 3 = Iron 1 … 26 = Immortal 3, 27 = Radiant.
  const TIER_NAMES = ["Unranked", "", ""].concat(
    ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Ascendant", "Immortal"].flatMap((t) => [1, 2, 3].map((n) => `${t} ${n}`)),
    ["Radiant"],
  );
  const clampTier = (id) => Math.max(3, Math.min(27, Math.floor(id)));
  const tierName = (id) => TIER_NAMES[clampTier(id)];
  const tierShort = (id) => {
    const n = tierName(id);
    if (n === "Radiant") return "RAD";
    const [t, d] = n.split(" ");
    return (t === "Immortal" ? "IM" : t[0]) + d;
  };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

  // ---------- hidden MMR estimate ----------
  // Works in "division units": tier id + RR/100, so Gold 3 at 62 RR is 14.62.
  const AVG_ACS = 215;
  function estimateMmr(d, ms) {
    const r = d.rank;
    if (!r || !(r.tierId >= 3)) return null;
    const cur = r.tierId + clamp(r.rr || 0, 0, 99) / 100;
    const sigs = [];

    const hist = (d.history || []).slice(-40);
    const wins = hist.filter((h) => h.change > 0).map((h) => h.change);
    const losses = hist.filter((h) => h.change < 0).map((h) => -h.change);
    if (wins.length >= 2 && losses.length >= 2) {
      const aw = mean(wins), al = mean(losses), gap = aw - al;
      sigs.push({
        name: "RR gains vs losses", weight: 0.35, n: wins.length + losses.length,
        value: cur + clamp(gap / 8, -3, 3),
        ev: `Wins +${Math.round(aw)} RR, losses −${Math.round(al)} RR over ${wins.length + losses.length} games. Gap ${signed(Math.round(gap))}.`,
      });
    } else sigs.push({ name: "RR gains vs losses", weight: 0.35, n: 0, ev: "Needs at least 2 wins and 2 losses in your RR history." });

    const lob = ms.filter((m) => m.lobby && m.lobby.avgTier >= 3).slice(0, 40);
    if (lob.length) {
      const avgTier = mean(lob.map((m) => m.lobby.avgTier));
      sigs.push({
        name: "Lobby rank", weight: 0.5, n: lob.length,
        value: avgTier + 0.5,
        ev: `The other players in your last ${lob.length} game${lob.length === 1 ? "" : "s"} averaged ${tierName(avgTier)}.`,
      });
    } else sigs.push({ name: "Lobby rank", weight: 0.5, n: 0, ev: "Needs full match details, which arrive after your next game." });

    const perf = ms.filter((m) => m.rounds > 0).slice(0, 60);
    if (perf.length >= 3) {
      const idx = mean(perf.map((m) => m.score / m.rounds / ((m.lobby && m.lobby.avgAcs) || AVG_ACS)));
      const vs = perf.some((m) => m.lobby && m.lobby.avgAcs) ? "the lobby" : "an average player";
      sigs.push({
        name: "Performance", weight: 0.15, n: perf.length,
        value: cur + clamp((idx - 1) * 5, -2, 2),
        ev: `Your ACS is ${Math.abs(Math.round((idx - 1) * 100))}% ${idx >= 1 ? "above" : "below"} ${vs} across ${perf.length} games.`,
      });
    } else sigs.push({ name: "Performance", weight: 0.15, n: 0, ev: "Needs at least 3 games." });

    const live = sigs.filter((s) => s.n);
    if (!live.length) return { cur, est: null, sigs, conf: "low" };
    const wsum = live.reduce((a, s) => a + s.weight, 0);
    const est = clamp(live.reduce((a, s) => a + s.value * s.weight, 0) / wsum, 3, 27.99);
    const score = (Math.min(lob.length, 20) / 20) * 0.5 + (Math.min(wins.length + losses.length, 30) / 30) * 0.35 + (Math.min(perf.length, 30) / 30) * 0.15;
    return { cur, est, sigs, conf: score >= 0.7 && lob.length >= 15 ? "high" : score >= 0.4 ? "medium" : "low" };
  }

  // Stats for one account. With ?demo, every account gets the labeled sample file.
  async function fetchStats(id) {
    const res = await fetch(DEMO ? "demo.json" : `/api/stats?account=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The stats service answered ${res.status}.`);
    if (DEMO) {
      const a = (await fetchAccounts()).find((x) => x.id === id);
      if (a) body.player = { ...body.player, name: a.name, tag: a.tag };
    }
    return body;
  }

  async function fetchAccounts() {
    const res = await fetch(DEMO ? "demo-accounts.json" : "/api/accounts", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`The player list couldn't load (${res.status}).`);
    return (await res.json()).accounts || [];
  }

  return {
    DEMO, tierColor, tierName, tierShort, mean, clamp, el, safeUrl, pct, fix, int, signed, ago, avatar, initials,
    summarize, groupBy, estimateMmr, fetchStats, fetchAccounts,
  };
})();
