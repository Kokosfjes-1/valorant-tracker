const { TableClient } = require("@azure/data-tables");

// Optional match archive in Azure Table Storage. Without STORAGE_CONNECTION_STRING every call is a no-op,
// so the tracker still works, just without history beyond what HenrikDev returns.
const TABLE = process.env.STORAGE_TABLE || "valorant";
const MAX_ROWS = 1000;

let clientPromise = null;

function client() {
  const conn = process.env.STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  if (!clientPromise) {
    const c = TableClient.fromConnectionString(conn, TABLE);
    clientPromise = c.createTable().then(
      () => c,
      (err) => {
        if (err.statusCode === 409) return c;
        clientPromise = null;
        throw err;
      },
    );
  }
  return clientPromise;
}

// Table keys can't contain / \ # ? or control characters.
const key = (s) => String(s).replace(/[\/\\#?\u0000-\u001f\u007f-\u009f]/g, "_").slice(0, 512);

async function readAll(partition) {
  const c = await client();
  if (!c) return [];
  const rows = [];
  const filter = `PartitionKey eq '${key(partition).replace(/'/g, "''")}'`;
  for await (const e of c.listEntities({ queryOptions: { filter, select: ["data"] } })) {
    try {
      rows.push(JSON.parse(e.data));
    } catch (_) {
      // skip a damaged row rather than failing the whole page
    }
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

async function saveNew(partition, items, idOf, known) {
  const c = await client();
  if (!c) return 0;
  const fresh = items.filter((x) => idOf(x) && !known.has(idOf(x)));
  for (let i = 0; i < fresh.length; i += 100) {
    const actions = fresh.slice(i, i + 100).map((x) => [
      "upsert",
      { partitionKey: key(partition), rowKey: key(idOf(x)), data: JSON.stringify(x) },
    ]);
    await c.submitTransaction(actions);
  }
  return fresh.length;
}

module.exports = { enabled: () => !!process.env.STORAGE_CONNECTION_STRING, readAll, saveNew };
