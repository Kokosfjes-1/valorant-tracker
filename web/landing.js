(() => {
  const $ = (id) => document.getElementById(id);
  const { DEMO, tierColor, tierName, el, safeUrl, pct, fix, ago, summarize, estimateMmr, fetchStats, fetchAccounts } = window.VT;

  function notice(msg, kind) {
    const n = $("notice");
    n.textContent = msg;
    n.className = "notice" + (kind ? " " + kind : "");
    n.hidden = !msg;
  }

  function stat(label, value, id) {
    const d = el("div", "pstat");
    const v = el("dd", null, value);
    if (id) v.dataset.k = id;
    d.append(el("dt", null, label), v);
    return d;
  }

  function card(a, i) {
    const li = el("li");
    const link = el("a", "pcard chamfer loading");
    link.href = `player.html?a=${encodeURIComponent(a.id)}${DEMO ? "&demo" : ""}`;
    link.style.animationDelay = i * 90 + "ms";

    const art = el("div", "pcard-art");
    art.setAttribute("aria-hidden", "true");

    const body = el("div", "pcard-body");
    const id = el("div", "pcard-id");
    id.append(el("span", "pcard-region", a.region.toUpperCase()), el("span", "pcard-name", a.name), el("span", "pcard-tag", "#" + a.tag));

    const rank = el("div", "pcard-rank");
    const icon = el("div", "pcard-icon");
    icon.appendChild(el("span", "ph"));
    const rtext = el("div", "pcard-rtext");
    const tier = el("strong", "pcard-tier", "Loading");
    const rr = el("div", "rr");
    const bar = el("div", "rr-bar");
    const fill = el("i");
    bar.appendChild(fill);
    const rrNum = el("span", "rr-num", "– RR");
    rr.append(bar, rrNum);
    rtext.append(tier, rr);
    rank.append(icon, rtext);

    const stats = el("dl", "pstats");
    stats.append(stat("Level", "–", "level"), stat("Win rate", "–", "win"), stat("K/D", "–", "kd"), stat("Plays like", "–", "mmr"));

    const foot = el("div", "pcard-foot");
    const when = el("span", "pcard-when", "Loading stats…");
    const go = el("span", "pcard-go");
    go.append("View stats");
    go.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>');
    foot.append(when, go);

    body.append(id, rank, stats, foot);
    link.append(art, body);
    li.appendChild(link);

    fetchStats(a.id).then(
      (d) => {
        link.classList.remove("loading");
        const card = safeUrl(d.player.card);
        if (card) art.style.setProperty("--card", `url("${card.replace(/"/g, "%22")}")`);
        if (d.player.name) link.querySelector(".pcard-name").textContent = d.player.name;
        if (d.player.tag) link.querySelector(".pcard-tag").textContent = "#" + d.player.tag;

        const r = d.rank;
        tier.textContent = r ? r.tier : "Unranked";
        if (r) {
          link.style.setProperty("--tier", tierColor(r.tier));
          rrNum.textContent = `${r.rr ?? "–"} RR`;
          requestAnimationFrame(() => (fill.style.width = Math.max(0, Math.min(100, r.rr || 0)) + "%"));
          const url = safeUrl(r.image);
          if (url) {
            const img = new Image();
            img.alt = "";
            img.src = url;
            img.onerror = () => img.replaceWith(el("span", "ph"));
            icon.replaceChildren(img);
          }
        } else rrNum.textContent = "Placements";

        const ms = (d.matches || []).slice().sort((x, y) => y.startedAt - x.startedAt);
        const s = summarize(ms);
        const set = (k, v) => (stats.querySelector(`[data-k="${k}"]`).textContent = v);
        set("level", d.player.level ?? "–");
        set("win", ms.length ? pct(s.winRate) : "–");
        set("kd", ms.length ? fix(s.kd) : "–");
        const m = estimateMmr(d, ms);
        const mmr = stats.querySelector('[data-k="mmr"]');
        if (m && m.est != null) {
          mmr.textContent = tierName(m.est);
          mmr.style.color = tierColor(tierName(m.est));
        }
        when.textContent = ms.length ? `${ms.length} games · last played ${ago(ms[0].startedAt)}` : "No competitive games yet";
      },
      (err) => {
        link.classList.remove("loading");
        link.classList.add("failed");
        tier.textContent = "Stats unavailable";
        when.textContent = err.message || "Couldn't load stats.";
      },
    );
    return li;
  }

  (async () => {
    try {
      const accounts = await fetchAccounts();
      $("players").replaceChildren(...accounts.map(card));
      if (!accounts.length) notice("No players are set up yet. Add them to RIOT_ACCOUNTS in the app settings.");
      else if (DEMO) notice("You're viewing sample data. Remove ?demo from the address to see live stats.", "info");
    } catch (err) {
      notice(err.message || "The player list couldn't load. Try again in a minute.");
    }
  })();
})();
