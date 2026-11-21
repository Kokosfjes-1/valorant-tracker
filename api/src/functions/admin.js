const crypto = require("crypto");
const { app } = require("@azure/functions");
const accounts = require("../lib/accounts");
const tracker = require("../lib/tracker");
const store = require("../lib/store");

// Admin API behind ADMIN_KEY, sent as the x-admin-key header.
// Routes can't start with "admin" (Azure Functions reserves it), so the API lives under /api/manage.
const reply = (status, body) => ({ status, jsonBody: body, headers: { "Cache-Control": "no-store" } });
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

function authorize(request) {
  const expected = process.env.ADMIN_KEY;
  if (!expected || expected.length < 12) {
    return reply(503, { error: "The admin panel is off. Set ADMIN_KEY (at least 12 characters) in the app's environment variables." });
  }
  const given = request.headers.get("x-admin-key") || "";
  if (!crypto.timingSafeEqual(digest(given), digest(expected))) return reply(401, { error: "Wrong admin key." });
  return null;
}

function fail(context, err) {
  if (err instanceof accounts.InputError) return reply(err.status, { error: err.message });
  context.error(err);
  return reply(500, { error: "Something went wrong on the server. Check the function logs." });
}

app.http("manageAccounts", {
  route: "manage/accounts",
  methods: ["GET", "POST", "DELETE"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = authorize(request);
    if (denied) return denied;
    const log = (e) => context.warn(e);

    try {
      if (request.method === "GET") {
        const list = await accounts.list(log);
        const rows = await Promise.all(
          list.map(async (a) => ({ ...accounts.publicView(a), source: a.source, addedAt: a.addedAt || null, status: await tracker.status(a, log) })),
        );
        return reply(200, {
          accounts: rows,
          storage: store.enabled(),
          hasApiKey: !!process.env.HENRIK_API_KEY,
          cacheSeconds: tracker.TTL_MS / 1000,
          regions: accounts.REGIONS,
        });
      }

      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const acct = accounts.parseInput(body.riotId, body.region);
        if (!process.env.HENRIK_API_KEY) throw new accounts.InputError(503, "Set HENRIK_API_KEY before adding players.");
        // Check the account exists, and pick up Riot's exact spelling of the name.
        let found;
        try {
          found = await tracker.henrik(`/v1/account/${acct.who}`);
        } catch (err) {
          if (err.status === 404) throw new accounts.InputError(404, `HenrikDev has no account called ${acct.name}#${acct.tag}.`);
          if (err.status === 429) throw new accounts.InputError(429, "HenrikDev is rate-limiting requests. Try again in a minute.");
          throw new accounts.InputError(502, "Couldn't reach HenrikDev to check the account. Try again shortly.");
        }
        const exact = found && found.name && found.tag ? accounts.parseInput(`${found.name}#${found.tag}`, acct.region) : acct;
        const added = await accounts.add(exact);
        return reply(201, { account: accounts.publicView(added) });
      }

      // DELETE ?id=<account id>. Saved matches stay in storage, so re-adding the player brings them back.
      const id = (request.query.get("id") || "").toLowerCase();
      const removed = await accounts.remove(id);
      await tracker.forget(removed).catch(log);
      return reply(200, { removed: accounts.publicView(removed) });
    } catch (err) {
      return fail(context, err);
    }
  },
});

// POST /api/refresh?account=<id>: fetch one player now. Called by the scheduled workflow and the admin panel.
// Answers 200 with complete:false when HenrikDev left gaps, so the caller knows to try again.
app.http("refresh", {
  route: "refresh",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = authorize(request);
    if (denied) return denied;
    const log = (e) => context.warn(e);
    if (!process.env.HENRIK_API_KEY) return reply(500, { error: "HENRIK_API_KEY isn't set." });

    const acct = await accounts.find((request.query.get("account") || "").toLowerCase(), log);
    if (!acct) return reply(404, { error: "That player isn't on this tracker." });
    try {
      const body = await tracker.refresh(acct, log, { budgetMs: 30000 });
      return reply(200, { id: acct.id, updatedAt: body.updatedAt, matches: body.matches.length, ...body.fetch });
    } catch (err) {
      context.error(err);
      const status = err && err.status;
      return reply(status === 429 ? 429 : 502, {
        id: acct.id,
        complete: false,
        rateLimited: status === 429,
        error: tracker.upstreamMessage(err, acct),
      });
    }
  },
});
