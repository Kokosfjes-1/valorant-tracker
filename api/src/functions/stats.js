const { app } = require("@azure/functions");
const accounts = require("../lib/accounts");
const tracker = require("../lib/tracker");

// Only accounts on the tracker can be looked up; the request only picks one by id.
const reply = (status, body, headers = {}) => ({
  status,
  jsonBody: body,
  headers: { "Cache-Control": "no-store", ...headers },
});

app.http("stats", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const log = (e) => context.warn(e);
    const list = await accounts.list(log);
    const wanted = (request.query.get("account") || "").toLowerCase();
    const acct = wanted ? list.find((a) => a.id === wanted) : list[0];
    if (!acct) return reply(404, { error: "That player isn't on this tracker." });
    if (!process.env.HENRIK_API_KEY) {
      return reply(500, { error: "The server has no HenrikDev API key yet. Add HENRIK_API_KEY to the Static Web App's environment variables." });
    }
    try {
      const body = await tracker.getStats(acct, log);
      return reply(200, body, { "Cache-Control": "public, max-age=60" });
    } catch (err) {
      context.error(err);
      const c = tracker.cacheFor(acct);
      if (c.body) return reply(200, { ...c.body, stale: true });
      return reply(502, { error: tracker.upstreamMessage(err, acct) });
    }
  },
});

app.http("accounts", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (_request, context) => {
    const list = await accounts.list((e) => context.warn(e));
    return reply(200, { accounts: list.map(accounts.publicView) }, { "Cache-Control": "public, max-age=60" });
  },
});
