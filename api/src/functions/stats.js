const { app } = require("@azure/functions");
const store = require("../lib/store");

// One account only: the Riot ID is fixed here (or in app settings), never taken from the request.
const BASE = "https://api.henrikdev.xyz/valorant";
const NAME = process.env.RIOT_NAME || "Kokosfjes";
const TAG = process.env.RIOT_TAG || "kokos";
const REGION = (process.env.RIOT_REGION || "eu").toLowerCase();
const TTL_MS = Math.max(60, Number(process.env.CACHE_SECONDS) || 300) * 1000;
const ARCHIVE_PAGES = Math.min(4, Math.max(0, Number(process.env.ARCHIVE_PAGES ?? 2)));
const MAX_MATCHES = 200;

const who = `${encodeURIComponent(NAME)}/${encodeURIComponent(TAG)}`;
const ACCOUNT_KEY = `${NAME}.${TAG}`.toLowerCase();

let cache = { at: 0, body: null };
let inflight = null;

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function henrik(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: process.env.HENRIK_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new UpstreamError(res.status, `HenrikDev returned ${res.status} for ${path}`);
  const json = await res.json();
  return json.data;
}

const sameName = (p) =>
  (p.name || "").toLowerCase() === NAME.toLowerCase() && (p.tag || "").toLowerCase() === TAG.toLowerCase();
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Full match (v3): your stats plus the other nine players' ranks and ACS.
function normalizeMatch(m, puuid) {
  const players = (m.players && m.players.all_players) || [];
  const me = players.find((p) => (puuid ? p.puuid === puuid : sameName(p))) || players.find(sameName);
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
    for (const x of list) {
      if (!x || !x.id) continue;
      const prev = out.get(x.id);
      if (!prev || (x.full && !prev.full) || (x.full === prev.full && !prev.lobby && x.lobby)) out.set(x.id, x);
    }
  }
  return [...out.values()];
}

async function archivePages() {
  const pages = [];
  for (let page = 1; page <= ARCHIVE_PAGES; page++) {
    const data = await henrik(`/v1/stored-matches/${REGION}/${who}?mode=competitive&page=${page}&size=25`);
    pages.push(...(data || []));
    if (!data || data.length < 25) break;
  }
  return pages;
}

async function load(log) {
  const [account, mmr, history, matches, archive, savedMatches, savedHistory] = await Promise.allSettled([
    henrik(`/v1/account/${who}`),
    henrik(`/v2/mmr/${REGION}/${who}`),
    henrik(`/v1/mmr-history/${REGION}/${who}`),
    henrik(`/v3/matches/${REGION}/${who}?mode=competitive&size=10`),
    archivePages(),
    store.readAll(`m.${ACCOUNT_KEY}`),
    store.readAll(`rr.${ACCOUNT_KEY}`),
  ]);
  const live = [account, mmr, history, matches];
  if (live.every((r) => r.status === "rejected")) throw account.reason;
  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  for (const r of [archive, savedMatches, savedHistory]) if (r.status === "rejected") log(r.reason);

  const acc = val(account);
  const cur = val(mmr) && val(mmr).current_data;
  const peak = val(mmr) && val(mmr).highest_rank;

  const liveFull = (val(matches) || []).map((m) => normalizeMatch(m, acc && acc.puuid)).filter(Boolean);
  const liveArchive = (val(archive) || []).map(normalizeStored).filter(Boolean);
  const liveHistory = (val(history) || []).map(normalizeHistory).filter((h) => h.id);
  const oldMatches = val(savedMatches) || [];
  const oldHistory = val(savedHistory) || [];

  const allMatches = mergeById(oldMatches, liveArchive, liveFull).sort((a, b) => b.startedAt - a.startedAt);
  const allHistory = mergeById(oldHistory, liveHistory).sort((a, b) => (a.date || 0) - (b.date || 0));

  if (store.enabled()) {
    // Save anything new, and upgrade archive-only rows once full detail arrives.
    const knownFull = new Set(oldMatches.filter((m) => m.full).map((m) => m.id));
    const knownAny = new Set(oldMatches.map((m) => m.id));
    try {
      await store.saveNew(`m.${ACCOUNT_KEY}`, liveFull, (m) => m.id, knownFull);
      await store.saveNew(`m.${ACCOUNT_KEY}`, liveArchive, (m) => m.id, new Set([...knownAny, ...liveFull.map((m) => m.id)]));
      await store.saveNew(`rr.${ACCOUNT_KEY}`, liveHistory, (h) => h.id, new Set(oldHistory.map((h) => h.id)));
    } catch (err) {
      log(err);
    }
  }

  return {
    updatedAt: Date.now(),
    region: REGION,
    archive: store.enabled(),
    player: {
      name: (acc && acc.name) || NAME,
      tag: (acc && acc.tag) || TAG,
      level: (acc && acc.account_level) ?? null,
      card: (acc && acc.card && acc.card.wide) || null,
    },
    rank:
      cur && cur.currenttierpatched
        ? {
            tier: cur.currenttierpatched,
            tierId: cur.currenttier ?? null,
            rr: cur.ranking_in_tier ?? null,
            image: (cur.images && (cur.images.large || cur.images.small)) || null,
            lastChange: cur.mmr_change_to_last_game ?? null,
            peak: peak && peak.patched_tier ? { tier: peak.patched_tier, season: peak.season || null } : null,
          }
        : null,
    history: allHistory.slice(-MAX_MATCHES),
    matches: allMatches.slice(0, MAX_MATCHES),
  };
}

async function getStats(log) {
  if (cache.body && Date.now() - cache.at < TTL_MS) return cache.body;
  if (!inflight) {
    inflight = load(log)
      .then((body) => {
        cache = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const reply = (status, body, headers = {}) => ({
  status,
  jsonBody: body,
  headers: { "Cache-Control": "no-store", ...headers },
});

app.http("stats", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (!process.env.HENRIK_API_KEY) {
      return reply(500, { error: "The server has no HenrikDev API key yet. Add HENRIK_API_KEY to the Static Web App's environment variables." });
    }
    try {
      const body = await getStats((e) => context.warn(e));
      return reply(200, body, { "Cache-Control": "public, max-age=60" });
    } catch (err) {
      context.error(err);
      if (cache.body) return reply(200, { ...cache.body, stale: true });
      const s = err.status;
      const error =
        s === 401 || s === 403
          ? "HenrikDev refused the API key. Check HENRIK_API_KEY in the app settings."
          : s === 404
          ? `No Valorant account found for ${NAME}#${TAG} in region ${REGION.toUpperCase()}.`
          : s === 429
          ? "HenrikDev is rate-limiting requests. Try again in a minute."
          : "Couldn't reach HenrikDev right now. Try again shortly.";
      return reply(502, { error });
    }
  },
});
