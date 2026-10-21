const { app } = require("@azure/functions");

// One account only: the Riot ID is fixed here (or in app settings), never taken from the request.
const BASE = "https://api.henrikdev.xyz/valorant";
const NAME = process.env.RIOT_NAME || "Kokosfjes";
const TAG = process.env.RIOT_TAG || "koko";
const REGION = (process.env.RIOT_REGION || "eu").toLowerCase();
const TTL_MS = Math.max(60, Number(process.env.CACHE_SECONDS) || 300) * 1000;

const who = `${encodeURIComponent(NAME)}/${encodeURIComponent(TAG)}`;

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
  const result = mine.has_won ? "win" : mine.rounds_won === other.rounds_won ? "draw" : "loss";

  return {
    id: meta.matchid || null,
    map: meta.map || "Unknown",
    startedAt: (meta.game_start || 0) * 1000,
    agent: me.character || "Unknown",
    agentIcon: (me.assets && me.assets.agent && me.assets.agent.small) || null,
    tier: me.currenttier_patched || null,
    rounds: meta.rounds_played || (mine.rounds_won || 0) + (other.rounds_won || 0),
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
  };
}

async function load() {
  const [account, mmr, history, matches] = await Promise.allSettled([
    henrik(`/v1/account/${who}`),
    henrik(`/v2/mmr/${REGION}/${who}`),
    henrik(`/v1/mmr-history/${REGION}/${who}`),
    henrik(`/v3/matches/${REGION}/${who}?mode=competitive&size=10`),
  ]);
  const all = [account, mmr, history, matches];
  if (all.every((r) => r.status === "rejected")) throw account.reason;
  const val = (r) => (r.status === "fulfilled" ? r.value : null);

  const acc = val(account);
  const cur = val(mmr) && val(mmr).current_data;
  const peak = val(mmr) && val(mmr).highest_rank;

  return {
    updatedAt: Date.now(),
    region: REGION,
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
    history: (val(history) || [])
      .map((h) => ({
        matchId: h.match_id || null,
        change: h.mmr_change_to_last_game ?? 0,
        rr: h.ranking_in_tier ?? null,
        tier: h.currenttierpatched || null,
        map: (h.map && h.map.name) || null,
        date: h.date_raw ? h.date_raw * 1000 : Date.parse(h.date) || null,
      }))
      .reverse(),
    matches: (val(matches) || []).map((m) => normalizeMatch(m, acc && acc.puuid)).filter(Boolean),
  };
}

async function getStats() {
  if (cache.body && Date.now() - cache.at < TTL_MS) return cache.body;
  if (!inflight) {
    inflight = load()
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
      const body = await getStats();
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
