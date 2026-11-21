const store = require("./store");

// Fetching, normalizing and caching one player's stats.
//
// Cache layers:
//   1. memory (per Functions instance), re-checked against storage every MEMORY_MS
//   2. a snapshot per player in Table Storage (partition "cache"), shared by every instance and cold start
// A snapshot is served until it's CACHE_SECONDS old (default 3 hours). The scheduled GitHub workflow calls
// /api/refresh well before that, so visitors almost never wait on HenrikDev.
//
// "Complete" means HenrikDev gave us everything: account, rank, RR history, the archive, and full detail
// for the last 10 competitive games. Missing parts are retried inside one call while time allows, and the
// scheduled workflow keeps calling until a refresh comes back complete.
const BASE = "https://api.henrikdev.xyz/valorant";
const TTL_MS = Math.max(60, Number(process.env.CACHE_SECONDS) || 3 * 60 * 60) * 1000;
const INCOMPLETE_RETRY_MS = 10 * 60 * 1000;
const MEMORY_MS = 60 * 1000;
const ARCHIVE_PAGES = Math.min(4, Math.max(0, Number(process.env.ARCHIVE_PAGES ?? 2)));
// Games kept per player, in the snapshot and in storage. Older ones are deleted as new ones arrive.
const MAX_MATCHES = 30;
const WANT_FULL = 10;
const MAX_INNER_ATTEMPTS = 4;
const RETRY_WAIT_MS = 2500;

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function henrik(path, timeoutMs = 10000) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: process.env.HENRIK_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new UpstreamError(res.status, `HenrikDev returned ${res.status} for ${path}`);
  const json = await res.json();
  return json.data;
}

// Network errors, timeouts and 5xx are worth another try. 401/403/404 aren't, and 429 means stop.
const retryable = (err) => !err || !err.status || err.status === 408 || err.status >= 500;

const sameName = (acct) => (p) =>
  (p.name || "").toLowerCase() === acct.name.toLowerCase() && (p.tag || "").toLowerCase() === acct.tag.toLowerCase();
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Full match (v3): your stats plus the other nine players' ranks and ACS.
function normalizeMatch(m, puuid, acct) {
  const players = (m.players && m.players.all_players) || [];
  const isMe = sameName(acct);
  const me = players.find((p) => (puuid ? p.puuid === puuid : isMe(p))) || players.find(isMe);
  if (!me) return null;

  const meta = m.metadata || {};
  const team = (me.team || "").toLowerCase();
  const teams = m.teams || {};
  const mine = teams[team] || {};
  const other = teams[team === "red" ? "blue" : "red"] || {};
  const s = me.stats || {};
  const rounds = meta.rounds_played || (mine.rounds_won || 0) + (other.rounds_won || 0);
  const result = mine.has_won ? "win" : mine.rounds_won === other.rounds_won ? "draw" : "loss";

  const others = players.filter((p) => p !== me);
  const ranked = others.map((p) => p.currenttier).filter((t) => Number(t) >= 3);
  const lobbyAcs = rounds ? avg(others.map((p) => ((p.stats && p.stats.score) || 0) / rounds)) : null;

  return {
    id: meta.matchid || null,
    full: true,
    map: meta.map || "Unknown",
    startedAt: (meta.game_start || 0) * 1000,
    agent: me.character || "Unknown",
    agentIcon: (me.assets && me.assets.agent && me.assets.agent.small) || null,
    tierId: Number(me.currenttier) || null,
    rounds,
    result,
    teamScore: mine.rounds_won ?? null,
    enemyScore: other.rounds_won ?? null,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
    assists: s.assists || 0,
    score: s.score || 0,
    damage: me.damage_made || 0,
    headshots: s.headshots || 0,
    shots: (s.headshots || 0) + (s.bodyshots || 0) + (s.legshots || 0),
    lobby: ranked.length ? { avgTier: avg(ranked), ranked: ranked.length, avgAcs: lobbyAcs } : null,
  };
}

// Archived match (stored-matches v1): only your own stats, no lobby.
function normalizeStored(m) {
  const meta = m.meta || {};
  const s = m.stats || {};
  const t = m.teams || {};
  const team = (s.team || "").toLowerCase();
  const mineScore = Number(t[team]);
  const otherScore = Number(t[team === "red" ? "blue" : "red"]);
  if (!meta.id || !isFinite(mineScore) || !isFinite(otherScore)) return null;
  const shots = s.shots || {};
  return {
    id: meta.id,
    full: false,
    map: (meta.map && meta.map.name) || "Unknown",
    startedAt: Date.parse(meta.started_at) || 0,
    agent: (s.character && s.character.name) || "Unknown",
    agentIcon: null,
    tierId: Number(s.tier) || null,
    rounds: mineScore + otherScore,
    result: mineScore > otherScore ? "win" : mineScore < otherScore ? "loss" : "draw",
    teamScore: mineScore,
    enemyScore: otherScore,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
    assists: s.assists || 0,
    score: s.score || 0,
    damage: (s.damage && s.damage.made) || 0,
    headshots: shots.head || 0,
    shots: (shots.head || 0) + (shots.body || 0) + (shots.leg || 0),
    lobby: null,
  };
}

function normalizeHistory(h) {
  const date = h.date_raw ? h.date_raw * 1000 : Date.parse(h.date) || null;
  return {
    id: h.match_id || (date ? "t" + date : null),
    matchId: h.match_id || null,
    change: h.mmr_change_to_last_game ?? 0,
    rr: h.ranking_in_tier ?? null,
    tierId: Number(h.currenttier) || null,
    tier: h.currenttierpatched || null,
    map: (h.map && h.map.name) || null,
    date,
  };
}

// Full detail wins over archive-only rows for the same match.
function mergeById(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const x of list || []) {
      if (!x || !x.id) continue;
      const prev = out.get(x.id);
      if (!prev || (x.full && !prev.full) || (x.full === prev.full && !prev.lobby && x.lobby)) out.set(x.id, x);
    }
  }
  return [...out.values()];
}

async function archivePages(acct) {
  const pages = [];
  for (let page = 1; page <= ARCHIVE_PAGES; page++) {
    const data = await henrik(`/v1/stored-matches/${acct.region}/${acct.who}?mode=competitive&page=${page}&size=25`);
    pages.push(...(data || []));
    if (!data || data.length < 25 || pages.length >= MAX_MATCHES) break;
  }
  return pages.slice(0, MAX_MATCHES);
}

// Fetches every live part, then re-fetches only what's missing until it's complete, rate-limited,
// out of attempts or out of time. Full matches from every attempt are pooled by match id, so a short
// answer followed by another short answer can still add up to all ten games.
async function fetchLive(acct, deadline) {
  const { region, who } = acct;
  const jobs = {
    account: () => henrik(`/v1/account/${who}`),
    mmr: () => henrik(`/v2/mmr/${region}/${who}`),
    history: () => henrik(`/v1/mmr-history/${region}/${who}`),
    matches: () => henrik(`/v3/matches/${region}/${who}?mode=competitive&size=${WANT_FULL}`),
    archive: () => (ARCHIVE_PAGES ? archivePages(acct) : Promise.resolve([])),
  };
  const got = {};
  const errors = {};
  const pool = new Map();
  let pending = Object.keys(jobs);
  let attempts = 0;
  let rateLimited = false;
  let state;

  for (;;) {
    attempts++;
    const results = await Promise.allSettled(pending.map((k) => jobs[k]()));
    pending.forEach((k, i) => {
      const r = results[i];
      if (r.status === "fulfilled") {
        delete errors[k];
        if (k === "matches") {
          for (const m of r.value || []) {
            const id = m && m.metadata && m.metadata.matchid;
            if (id) pool.set(id, m);
          }
          got.matches = [...pool.values()]
            .sort((a, b) => ((b.metadata && b.metadata.game_start) || 0) - ((a.metadata && a.metadata.game_start) || 0))
            .slice(0, WANT_FULL);
        } else got[k] = r.value;
      } else {
        errors[k] = r.reason;
        if (r.reason && r.reason.status === 429) rateLimited = true;
      }
    });

    state = assess(acct, got, errors);
    if (state.complete || rateLimited || attempts >= MAX_INNER_ATTEMPTS) break;
    const retry = state.missing.filter((k) => k === "matches" ? !errors.matches || retryable(errors.matches) : retryable(errors[k]));
    if (!retry.length) break;
    const wait = RETRY_WAIT_MS * attempts;
    if (Date.now() + wait + 5000 > deadline) break;
    await sleep(wait);
    pending = retry;
  }

  return { got, errors, attempts, rateLimited, state };
}

function assess(acct, got, errors) {
  const missing = [];
  for (const k of ["account", "mmr", "history", "archive"]) if (!(k in got)) missing.push(k);

  const puuid = got.account && got.account.puuid;
  const raw = got.matches || [];
  const full = raw.map((m) => normalizeMatch(m, puuid, acct)).filter(Boolean);
  // A player with fewer than 10 competitive games ever can't give us 10. The archive tells us how many exist.
  const archiveCount = Array.isArray(got.archive) ? got.archive.length : null;
  const expected =
    archiveCount != null && archiveCount < WANT_FULL ? Math.max(archiveCount, raw.length) : WANT_FULL;
  if (!("matches" in got) || full.length < expected) missing.push("matches");

  return {
    complete: missing.length === 0,
    missing,
    fullMatches: full.length,
    expected,
    full,
    errors: Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, (e && e.status) || "network"])),
  };
}

async function load(acct, log, prev, deadline) {
  const [live, savedMatches, savedHistory] = await Promise.all([
    fetchLive(acct, deadline),
    store.readAll(`m.${acct.key}`).catch((e) => (log(e), [])),
    store.readAll(`rr.${acct.key}`).catch((e) => (log(e), [])),
  ]);
  const { got, errors, state } = live;
  if (!Object.keys(got).length) throw errors.account || errors.mmr || Object.values(errors)[0];

  const acc = got.account || null;
  const cur = got.mmr && got.mmr.current_data;
  const peak = got.mmr && got.mmr.highest_rank;

  const liveFull = state.full;
  const liveArchive = (got.archive || []).map(normalizeStored).filter(Boolean);
  const liveHistory = (got.history || []).map(normalizeHistory).filter((h) => h.id);

  const allMatches = mergeById(prev && prev.matches, savedMatches, liveArchive, liveFull)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_MATCHES);
  const allHistory = mergeById(prev && prev.history, savedHistory, liveHistory)
    .sort((a, b) => (a.date || 0) - (b.date || 0))
    .slice(-MAX_MATCHES);

  if (store.enabled()) {
    // Save what's new among the latest 30, upgrade archive-only rows once full detail arrives,
    // and delete rows that have fallen out of the latest 30.
    const keptMatches = new Set(allMatches.map((m) => m.id));
    const keptHistory = new Set(allHistory.map((h) => h.id));
    const knownFull = new Set(savedMatches.filter((m) => m.full).map((m) => m.id));
    const knownAny = new Set(savedMatches.map((m) => m.id));
    try {
      await store.saveNew(`m.${acct.key}`, liveFull.filter((m) => keptMatches.has(m.id)), (m) => m.id, knownFull);
      await store.saveNew(`m.${acct.key}`, liveArchive.filter((m) => keptMatches.has(m.id)), (m) => m.id, new Set([...knownAny, ...liveFull.map((m) => m.id)]));
      await store.saveNew(`rr.${acct.key}`, liveHistory.filter((h) => keptHistory.has(h.id)), (h) => h.id, new Set(savedHistory.map((h) => h.id)));
      await store.removeRows(`m.${acct.key}`, savedMatches.map((m) => m.id).filter((id) => id && !keptMatches.has(id)));
      await store.removeRows(`rr.${acct.key}`, savedHistory.map((h) => h.id).filter((id) => id && !keptHistory.has(id)));
    } catch (err) {
      log(err);
    }
  }

  // A part that failed this time keeps its last good value instead of blanking the page.
  const rank =
    cur && cur.currenttierpatched
      ? {
          tier: cur.currenttierpatched,
          tierId: cur.currenttier ?? null,
          rr: cur.ranking_in_tier ?? null,
          image: (cur.images && (cur.images.large || cur.images.small)) || null,
          lastChange: cur.mmr_change_to_last_game ?? null,
          peak: peak && peak.patched_tier ? { tier: peak.patched_tier, season: peak.season || null } : null,
        }
      : got.mmr
      ? null
      : (prev && prev.rank) || null;

  const player = acc
    ? { name: acc.name || acct.name, tag: acc.tag || acct.tag, level: acc.account_level ?? null, card: (acc.card && acc.card.wide) || null }
    : (prev && prev.player) || { name: acct.name, tag: acct.tag, level: null, card: null };

  const now = Date.now();
  return {
    updatedAt: now,
    id: acct.id,
    region: acct.region,
    archive: store.enabled(),
    fetch: {
      at: now,
      complete: state.complete,
      fullMatches: state.fullMatches,
      expected: state.expected,
      missing: state.missing,
      errors: state.errors,
      attempts: live.attempts,
      rateLimited: live.rateLimited,
      lastComplete: state.complete ? now : (prev && prev.fetch && prev.fetch.lastComplete) || null,
    },
    player,
    rank,
    history: allHistory,
    matches: allMatches,
  };
}

const caches = new Map();

function cacheFor(acct) {
  if (!caches.has(acct.id)) caches.set(acct.id, { body: null, checked: 0, reading: null, refreshing: null });
  return caches.get(acct.id);
}

async function readSnapshot(acct, log) {
  const c = cacheFor(acct);
  if (store.enabled()) {
    try {
      const snap = await store.getDoc("cache", acct.key);
      if (snap && (!c.body || (snap.updatedAt || 0) >= (c.body.updatedAt || 0))) c.body = snap;
    } catch (err) {
      log(err);
    }
  }
  c.checked = Date.now();
  return c.body;
}

function needsRefresh(body) {
  if (!body) return true;
  const age = Date.now() - ((body.fetch && body.fetch.at) || body.updatedAt || 0);
  if (age >= TTL_MS) return true;
  return !!(body.fetch && !body.fetch.complete && age >= INCOMPLETE_RETRY_MS);
}

// Fetch now, save the snapshot, and return it. budgetMs caps how long the retry loop may run.
function refresh(acct, log, { budgetMs = 30000 } = {}) {
  const c = cacheFor(acct);
  if (!c.refreshing) {
    c.refreshing = (async () => {
      const prev = c.body || (await readSnapshot(acct, log));
      const body = await load(acct, log, prev, Date.now() + budgetMs);
      c.body = body;
      c.checked = Date.now();
      if (store.enabled()) await store.putDoc("cache", acct.key, body).catch(log);
      return body;
    })().finally(() => {
      c.refreshing = null;
    });
  }
  return c.refreshing;
}

// What a visitor gets: the cached snapshot, refreshed first only if it's too old (or missing).
async function getStats(acct, log) {
  const c = cacheFor(acct);
  if (c.body && Date.now() - c.checked < MEMORY_MS && !needsRefresh(c.body)) return c.body;
  if (!c.reading) {
    c.reading = readSnapshot(acct, log).finally(() => {
      c.reading = null;
    });
  }
  const body = await c.reading;
  if (!needsRefresh(body)) return body;
  try {
    return await refresh(acct, log, { budgetMs: 12000 });
  } catch (err) {
    if (c.body) return { ...c.body, stale: true };
    throw err;
  }
}

async function status(acct, log) {
  const c = cacheFor(acct);
  const body = c.body && Date.now() - c.checked < MEMORY_MS ? c.body : await readSnapshot(acct, log);
  if (!body) return null;
  return {
    updatedAt: body.updatedAt,
    matches: (body.matches || []).length,
    rank: body.rank ? `${body.rank.tier} · ${body.rank.rr ?? "–"} RR` : null,
    fetch: body.fetch || null,
    nextRefresh: ((body.fetch && body.fetch.at) || body.updatedAt || 0) + TTL_MS,
  };
}

function upstreamMessage(err, acct) {
  const s = err && err.status;
  return s === 401 || s === 403
    ? "HenrikDev refused the API key. Check HENRIK_API_KEY in the app settings."
    : s === 404
    ? `No Valorant account found for ${acct.name}#${acct.tag} in region ${acct.region.toUpperCase()}.`
    : s === 429
    ? "HenrikDev is rate-limiting requests. Try again in a minute."
    : "Couldn't reach HenrikDev right now. Try again shortly.";
}

async function forget(acct) {
  caches.delete(acct.id);
  if (store.enabled()) await store.remove("cache", acct.key);
}

module.exports = { henrik, upstreamMessage, getStats, refresh, status, forget, cacheFor, UpstreamError, TTL_MS };
