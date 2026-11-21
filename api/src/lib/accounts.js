const store = require("./store");

// The player list. With storage it lives in the table (partition "accounts") and is managed from /admin;
// RIOT_ACCOUNTS seeds it the first time. Without storage, RIOT_ACCOUNTS is the whole list.
const REGIONS = ["eu", "na", "ap", "kr", "latam", "br"];
const DEFAULT_REGION = (process.env.RIOT_REGION || "eu").toLowerCase();
const DEFAULT_ACCOUNTS = "Kokosfjes#kokos, pasta#tspmo, Alhagga#1234, Thalhagga#6767, Nino enjoyer#199cm";
const PARTITION = "accounts";
const MEMO_MS = 30 * 1000;

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function makeAccount(name, tag, region, extra = {}) {
  name = String(name || "").trim();
  tag = String(tag || "").trim();
  region = String(region || DEFAULT_REGION).trim().toLowerCase();
  if (!name || !tag) return null;
  return {
    id: `${name}-${tag}`.toLowerCase().replace(/[^a-z0-9-]+/g, ""),
    name,
    tag,
    region,
    who: `${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
    key: `${name}.${tag}`.toLowerCase(),
    ...extra,
  };
}

// "Name#tag" or "Name#tag@region", comma-separated.
function parseAccounts(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [riotId, region] = s.split("@");
      const i = riotId.lastIndexOf("#");
      if (i < 0) return null;
      return makeAccount(riotId.slice(0, i), riotId.slice(i + 1), region, { source: "env" });
    })
    .filter(Boolean);
}

const ENV_ACCOUNTS = parseAccounts(process.env.RIOT_ACCOUNTS || DEFAULT_ACCOUNTS);

let memo = { at: 0, list: null };

async function seed() {
  const now = Date.now();
  for (const [i, a] of ENV_ACCOUNTS.entries()) {
    await store.putRow(PARTITION, a.id, { name: a.name, tag: a.tag, region: a.region, addedAt: now + i });
  }
  await store.putDoc("meta", "accounts-seeded", { at: now });
  return ENV_ACCOUNTS.map((a, i) => ({ name: a.name, tag: a.tag, region: a.region, addedAt: now + i }));
}

async function list(log = () => {}) {
  if (!store.enabled()) return ENV_ACCOUNTS;
  if (memo.list && Date.now() - memo.at < MEMO_MS) return memo.list;
  try {
    let rows = await store.readAll(PARTITION);
    if (!rows.length && !(await store.getDoc("meta", "accounts-seeded"))) rows = await seed();
    const accounts = rows
      .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
      .map((r) => makeAccount(r.name, r.tag, r.region, { source: "admin", addedAt: r.addedAt || null }))
      .filter(Boolean);
    memo = { at: Date.now(), list: accounts };
    return accounts;
  } catch (err) {
    log(err);
    return memo.list || ENV_ACCOUNTS;
  }
}

async function find(id, log) {
  return (await list(log)).find((a) => a.id === id) || null;
}

// riotId is "Name#tag". Returns the new account, or throws InputError.
function parseInput(riotId, region) {
  const raw = String(riotId || "").trim();
  const i = raw.lastIndexOf("#");
  if (i < 1 || i === raw.length - 1) throw new InputError(400, "Write the Riot ID as Name#tag.");
  const name = raw.slice(0, i).trim();
  const tag = raw.slice(i + 1).trim();
  if (name.length > 16 || tag.length > 5) throw new InputError(400, "Riot names are at most 16 characters and tags at most 5.");
  if (/[\u0000-\u001f\u007f/\\?#]/.test(name + tag)) throw new InputError(400, "That Riot ID has characters Riot doesn't allow.");
  const r = String(region || DEFAULT_REGION).trim().toLowerCase();
  if (!REGIONS.includes(r)) throw new InputError(400, `Region must be one of ${REGIONS.join(", ")}.`);
  const acct = makeAccount(name, tag, r);
  if (!acct.id.replace(/-/g, "")) throw new InputError(400, "That Riot ID needs at least one letter or digit.");
  return acct;
}

async function add(acct) {
  if (!store.enabled()) throw new InputError(503, "Adding players needs STORAGE_CONNECTION_STRING. Without storage, edit RIOT_ACCOUNTS instead.");
  memo.at = 0;
  const existing = await list();
  if (existing.some((a) => a.id === acct.id)) throw new InputError(409, `${acct.name}#${acct.tag} is already on the tracker.`);
  const addedAt = Date.now();
  await store.putRow(PARTITION, acct.id, { name: acct.name, tag: acct.tag, region: acct.region, addedAt });
  memo.at = 0;
  return { ...acct, source: "admin", addedAt };
}

async function remove(id) {
  if (!store.enabled()) throw new InputError(503, "Removing players needs STORAGE_CONNECTION_STRING. Without storage, edit RIOT_ACCOUNTS instead.");
  memo.at = 0;
  const acct = await find(id);
  if (!acct) throw new InputError(404, "That player isn't on this tracker.");
  await store.remove(PARTITION, acct.id);
  memo.at = 0;
  return acct;
}

const publicView = ({ id, name, tag, region }) => ({ id, name, tag, region });

module.exports = { list, find, parseInput, add, remove, publicView, InputError, REGIONS };
