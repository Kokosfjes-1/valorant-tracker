(() => {
  const $ = (id) => document.getElementById(id);
  const { el, ago } = window.VT;

  function notice(msg, kind) {
    const n = $("notice");
    n.textContent = msg || "";
    n.className = "notice" + (kind ? " " + kind : "");
    n.hidden = !msg;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !(path.startsWith("/api/refresh") && body.id)) throw new Error(body.error || `The server answered ${res.status}.`);
    return body;
  }

  function gamesCell(s) {
    const td = el("td");
    if (!s || !s.fetch) return td.appendChild(el("span", "muted", "Not fetched yet")), td;
    const f = s.fetch;
    const badge = el("span", "badge " + (f.complete ? "ok" : "warn"), `${f.fullMatches}/${f.expected}`);
    td.append(badge);
    const why = f.complete
      ? "complete"
      : f.rateLimited
      ? "rate-limited, retrying"
      : `missing ${f.missing.join(", ")}`;
    td.append(el("span", "muted", " " + why));
    return td;
  }

  function row(a) {
    const tr = el("tr");
    tr.dataset.id = a.id;
    const name = el("td", "name");
    const link = el("a", null, a.name);
    link.href = `player.html?a=${encodeURIComponent(a.id)}`;
    name.append(link, el("span", "muted", `#${a.tag} · ${a.region.toUpperCase()}`));

    const s = a.status;
    const rank = el("td", null, (s && s.rank) || "–");
    const updated = el("td");
    if (s && s.updatedAt) {
      updated.append(el("span", null, ago(s.updatedAt)));
      updated.title = new Date(s.updatedAt).toLocaleString();
      if (s.fetch && !s.fetch.complete && s.fetch.lastComplete) updated.append(el("span", "muted", ` · last complete ${ago(s.fetch.lastComplete)}`));
    } else updated.textContent = "–";

    const actions = el("td", "n actions");
    const refresh = el("button", "btn small ghost", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshOne(a, refresh));
    const del = el("button", "btn small danger", "Remove");
    del.type = "button";
    del.addEventListener("click", () => removeOne(a, del));
    actions.append(refresh, del);

    tr.append(name, rank, gamesCell(s), updated, actions);
    return tr;
  }

  let state = null;

  async function loadList() {
    state = await api("/api/manage/accounts");
    const sel = $("region");
    if (!sel.options.length) {
      for (const r of state.regions) {
        const o = el("option", null, r.toUpperCase());
        o.value = r;
        sel.appendChild(o);
      }
    }
    $("storage-note").textContent = state.storage ? `Cache ${Math.round(state.cacheSeconds / 360) / 10} h` : "Storage off · read-only list";
    $("add").querySelectorAll("input, select, button").forEach((x) => (x.disabled = !state.storage));
    if (!state.storage) notice("Adding and removing players needs STORAGE_CONNECTION_STRING. Until then the list comes from RIOT_ACCOUNTS.", "info");
    else if (!state.hasApiKey) notice("HENRIK_API_KEY isn't set, so nothing can be fetched.");
    $("rows").replaceChildren(...(state.accounts.length ? state.accounts.map(row) : [emptyRow()]));
  }

  function emptyRow() {
    const tr = el("tr");
    const td = el("td", "empty", "No players yet. Add one above.");
    td.colSpan = 5;
    tr.appendChild(td);
    return tr;
  }

  async function refreshOne(a, btn) {
    if (btn) btn.disabled = true;
    if (btn) btn.textContent = "Refreshing…";
    try {
      const r = await api(`/api/refresh?account=${encodeURIComponent(a.id)}`, { method: "POST" });
      if (r.error) notice(`${a.name}#${a.tag}: ${r.error}`);
      else if (!r.complete) notice(`${a.name}#${a.tag}: got ${r.fullMatches}/${r.expected} full games. The scheduled job will keep trying.`, "info");
      return r;
    } catch (err) {
      notice(err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Refresh";
      }
    }
  }

  async function removeOne(a, btn) {
    if (!confirm(`Remove ${a.name}#${a.tag} from the tracker? Their saved matches are kept in case you add them back.`)) return;
    btn.disabled = true;
    try {
      await api(`/api/manage/accounts?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
      notice(`Removed ${a.name}#${a.tag}.`, "info");
      await loadList();
    } catch (err) {
      notice(err.message);
      btn.disabled = false;
    }
  }

  $("add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("add").querySelector("button");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const { account } = await api("/api/manage/accounts", {
        method: "POST",
        body: JSON.stringify({ riotId: $("riot-id").value, region: $("region").value }),
      });
      $("riot-id").value = "";
      notice(`Added ${account.name}#${account.tag}. Fetching their stats…`, "info");
      await loadList();
      const r = await refreshOne(account);
      if (r && r.complete) notice(`Added ${account.name}#${account.tag}.`, "info");
      await loadList();
    } catch (err) {
      notice(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Add player";
    }
  });

  $("refresh-all").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      for (const [i, a] of state.accounts.entries()) {
        btn.textContent = `Refreshing ${i + 1}/${state.accounts.length}…`;
        const r = await refreshOne(a, document.querySelector(`tr[data-id="${CSS.escape(a.id)}"] .btn.ghost`));
        if (r && r.rateLimited) break;
      }
      await loadList();
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh all";
    }
  });

  async function start() {
    try {
      await loadList();
    } catch (err) {
      notice(err.message);
    }
  }

  start();
})();
