const { TableClient } = require("@azure/data-tables");

// Azure Table Storage: match archive, cached stats snapshots and the admin-managed player list.
// Without STORAGE_CONNECTION_STRING every call is a no-op, so the tracker still works with env-only accounts
// and an in-memory cache.
const TABLE = process.env.STORAGE_TABLE || "valorant";
const MAX_ROWS = 1000;
// A string property holds at most 64 KiB (32K UTF-16 chars) and an entity at most 1 MiB,
// so big documents are split over several properties.
const CHUNK = 30000;
const MAX_CHUNKS = 15;

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

// One JSON document per row, chunked so it can exceed the 64 KiB property limit.
async function getDoc(partition, row) {
  const c = await client();
  if (!c) return null;
  try {
    const e = await c.getEntity(key(partition), key(row));
    const n = Number(e.chunks) || 0;
    let json = "";
    for (let i = 0; i < n; i++) json += e["d" + i] || "";
    return JSON.parse(json);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function putDoc(partition, row, value) {
  const c = await client();
  if (!c) return false;
  const json = JSON.stringify(value);
  const n = Math.ceil(json.length / CHUNK);
  if (n > MAX_CHUNKS) throw new Error(`Document ${partition}/${row} is too large to store (${json.length} chars).`);
  const entity = { partitionKey: key(partition), rowKey: key(row), chunks: n };
  for (let i = 0; i < n; i++) entity["d" + i] = json.slice(i * CHUNK, (i + 1) * CHUNK);
  await c.upsertEntity(entity, "Replace");
  return true;
}

async function remove(partition, row) {
  const c = await client();
  if (!c) return false;
  try {
    await c.deleteEntity(key(partition), key(row));
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

async function removeRows(partition, rowIds) {
  const c = await client();
  if (!c || !rowIds.length) return 0;
  const rows = [...new Set(rowIds.map(key))];
  for (let i = 0; i < rows.length; i += 100) {
    await c.submitTransaction(rows.slice(i, i + 100).map((r) => ["delete", { partitionKey: key(partition), rowKey: r }]));
  }
  return rows.length;
}

async function removePartition(partition) {
  const c = await client();
  if (!c) return 0;
  const filter = `PartitionKey eq '${key(partition).replace(/'/g, "''")}'`;
  const rows = [];
  for await (const e of c.listEntities({ queryOptions: { filter, select: ["RowKey"] } })) rows.push(e.rowKey);
  for (let i = 0; i < rows.length; i += 100) {
    await c.submitTransaction(rows.slice(i, i + 100).map((r) => ["delete", { partitionKey: key(partition), rowKey: r }]));
  }
  return rows.length;
}

// Plain-row helpers for small records (the player list).
async function putRow(partition, row, value) {
  const c = await client();
  if (!c) return false;
  await c.upsertEntity({ partitionKey: key(partition), rowKey: key(row), data: JSON.stringify(value) }, "Replace");
  return true;
}

module.exports = {
  enabled: () => !!process.env.STORAGE_CONNECTION_STRING,
  readAll,
  saveNew,
  getDoc,
  putDoc,
  putRow,
  remove,
  removeRows,
  removePartition,
};
