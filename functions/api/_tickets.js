// functions/api/_tickets.js
// Event ticket-number registry shared by the staff manual page (event.html)
// and guest self-upload. Backed by D1 (binding EVENTS_DB) so that a number can
// only ever be held by ONE order: uniqueness comes from the PRIMARY KEY
// (event_id, number), never from a read-then-write.
//
// If EVENTS_DB is not bound, hasDb() is false: callers fall back to the legacy
// KV-only behaviour (event:ticket:{eventId}:{n} = orderId) and guest uploads
// are switched off.
//
// Legacy KV tickets are copied into D1 once per event (event_backfill) the first
// time that event is touched, so numbers used before D1 existed stay taken.
// A failing KV list never fails a request here: the backfill is skipped (and
// retried later) and usedNumbers degrades to what it can read.
//
// Add-on magnets (more magnets bought later for a guest's existing ticket) never
// hold a row in event_tickets - the number belongs to the ticket's ROOT order.
// Each completed add-on is one row in ticket_addons (recordAddon), which is what
// the per-ticket extras limit is counted from (addonTally).
// Only ONE add-on per ticket may be at the payment step at a time: addon_holds
// has one row per root ticket (acquireAddonHold / extendAddonHold /
// releaseAddonHold), so the limit counted at pay time is exact.

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS event_tickets (
    event_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    order_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, number)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS event_tickets_order_id ON event_tickets (order_id)`,
  `CREATE TABLE IF NOT EXISTS event_backfill (
    event_id TEXT PRIMARY KEY,
    done_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_addons (
    addon_order_id TEXT PRIMARY KEY,
    root_order_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    photos INTEGER NOT NULL,
    amount REAL,
    completed_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_addons_root ON ticket_addons (root_order_id)`,
  `CREATE TABLE IF NOT EXISTS addon_holds (
    root_order_id TEXT PRIMARY KEY,
    addon_order_id TEXT NOT NULL,
    photos INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

// Take (or keep) the one payment hold of a root ticket for an add-on, in ONE
// statement: inserted when there is none, kept (and never shortened) when this
// add-on already has it, taken over only when another add-on's hold has expired.
// ?1 root, ?2 add-on, ?3 photos, ?4 expires_at (unix s), ?5 now (unix s).
const ACQUIRE_HOLD_SQL = `
INSERT INTO addon_holds (root_order_id, addon_order_id, photos, expires_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(root_order_id) DO UPDATE SET
  addon_order_id = excluded.addon_order_id,
  photos = excluded.photos,
  expires_at = CASE WHEN addon_holds.addon_order_id = excluded.addon_order_id
                    THEN MAX(addon_holds.expires_at, excluded.expires_at)
                    ELSE excluded.expires_at END
WHERE addon_holds.addon_order_id = excluded.addon_order_id OR addon_holds.expires_at <= ?5`;

const HOLD_SELECT_SQL = 'SELECT addon_order_id, photos, expires_at FROM addon_holds WHERE root_order_id = ?1';

// Lowest free number in [rangeStart, rangeEnd]. Candidates are rangeStart and
// every used number + 1 inside the range, so this never has to generate the
// whole range. ?1 = event_id, ?2 = rangeStart, ?3 = rangeEnd.
const FREE_CANDIDATES_SQL = `
  SELECT CAST(?2 AS INTEGER) AS n
  UNION ALL
  SELECT number + 1 FROM event_tickets WHERE event_id = ?1 AND number >= ?2 AND number < ?3`;

const LOWEST_FREE_SQL = `
SELECT MIN(c.n) AS n FROM (${FREE_CANDIDATES_SQL}
) AS c
WHERE c.n NOT IN (SELECT number FROM event_tickets WHERE event_id = ?1)`;

// Single atomic statement: pick the lowest free number and insert it for this
// order (inserts nothing when the range is full). A concurrent insert of the
// same number fails on the PRIMARY KEY; a second number for the same order
// fails on the UNIQUE(order_id) index. The number is then read back by
// order_id, so this doesn't depend on RETURNING / meta.changes support.
// ?4 = order_id, ?5 = source, ?6 = created_at.
const ALLOCATE_SQL = `
INSERT INTO event_tickets (event_id, number, order_id, source, created_at)
SELECT ?1, c.n, ?4, ?5, ?6 FROM (${FREE_CANDIDATES_SQL}
) AS c
WHERE c.n NOT IN (SELECT number FROM event_tickets WHERE event_id = ?1)
ORDER BY c.n
LIMIT 1`;

// Backfill from a JSON array [{n, o, l}] (n = number, o = order id from KV,
// l = fallback legacy id). Pass 1 keeps the KV order id unless another ticket
// already uses it; pass 2 fills anything pass 1 skipped with the legacy id.
const BACKFILL_KEEP_ID_SQL = `
INSERT OR IGNORE INTO event_tickets (event_id, number, order_id, source, created_at)
SELECT ?1,
       CAST(json_extract(j.value, '$.n') AS INTEGER),
       CASE
         WHEN json_extract(j.value, '$.o') = '' THEN json_extract(j.value, '$.l')
         WHEN EXISTS (SELECT 1 FROM event_tickets t WHERE t.order_id = json_extract(j.value, '$.o'))
           THEN json_extract(j.value, '$.l')
         ELSE json_extract(j.value, '$.o')
       END,
       'legacy', ?2
FROM json_each(?3) AS j`;

const BACKFILL_FILL_GAPS_SQL = `
INSERT OR IGNORE INTO event_tickets (event_id, number, order_id, source, created_at)
SELECT ?1, CAST(json_extract(j.value, '$.n') AS INTEGER), json_extract(j.value, '$.l'), 'legacy', ?2
FROM json_each(?3) AS j`;

// Most KV reads we spend fetching legacy order ids during a backfill (keeps the
// request well inside the per-invocation KV operation limit). Tickets past this
// just get a "legacy-..." order id - the number is still marked as taken.
const MAX_BACKFILL_READS = 400;

let schemaPromise = null;          // once per isolate
const backfillPromises = new Map(); // eventId -> Promise (once per isolate per event)

export function hasDb(env) {
  return !!(env && env.EVENTS_DB && typeof env.EVENTS_DB.prepare === 'function');
}

function getDb(env) {
  if (!hasDb(env)) throw new Error('EVENTS_DB binding is missing.');
  return env.EVENTS_DB;
}

export function isConstraintError(err) {
  const msg = String((err && (err.message || err.cause?.message)) || err || '');
  return msg.includes('UNIQUE') || msg.includes('constraint');
}

function legacyId(eventId, n) {
  return `legacy-${eventId}-${n}`;
}

function toTicketInt(number) {
  const n = typeof number === 'number' ? number : Number(String(number ?? '').trim());
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid ticket number: ${number}`);
  return n;
}

// Max photos a guest may upload for this event (hard cap 20 when no limit set).
export function maxPhotosFor(event) {
  const lim = Number(event && event.perTicketLimit);
  return Number.isInteger(lim) && lim > 0 ? lim : 20;
}

function ensureSchema(env) {
  if (!schemaPromise) {
    const db = getDb(env);
    const p = db.batch(SCHEMA_SQL.map(sql => db.prepare(sql))).then(() => true);
    schemaPromise = p;
    // Let a later request retry if this attempt failed.
    p.catch(() => { if (schemaPromise === p) schemaPromise = null; });
  }
  return schemaPromise;
}

// Legacy KV ticket keys for an event -> [{ n, name }] (all pages). Throws if a
// KV list call fails - callers catch that and degrade (see below).
async function listKvTickets(env, eventId) {
  const prefix = `event:ticket:${eventId}:`;
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await env.ORDERS_KV.list(cursor ? { prefix, cursor } : { prefix });
    for (const k of (res && res.keys) || []) {
      const n = Number(k.name.slice(prefix.length));
      if (!Number.isNaN(n)) out.push({ n, name: k.name });
    }
    if (!res || res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

// -> true when the event is backfilled, false when it had to be skipped because
// KV could not be listed (not marked done, so a later request tries again; in
// the meantime allocateNext's yieldToLegacyHolder and order.js's KV check still
// guard against re-using a legacy number).
async function backfillEvent(env, eventId) {
  const db = getDb(env);
  const done = await db.prepare('SELECT done_at FROM event_backfill WHERE event_id = ?1').bind(eventId).first();
  if (done) return true;

  let listed;
  try {
    listed = await listKvTickets(env, eventId);
  } catch (err) {
    console.error(`backfill: KV list failed for ${eventId}, will retry later:`, err);
    return false;
  }
  const keys = listed.filter(k => Number.isSafeInteger(k.n));

  // Order id stored in each legacy ticket key (bounded number of reads).
  const values = new Array(keys.length).fill('');
  const reads = Math.min(keys.length, MAX_BACKFILL_READS);
  for (let i = 0; i < reads; i += 50) {
    const chunk = keys.slice(i, Math.min(i + 50, reads));
    const got = await Promise.all(chunk.map(k => env.ORDERS_KV.get(k.name).catch(() => null)));
    got.forEach((v, j) => { values[i + j] = v ? String(v).trim() : ''; });
  }

  // An order id may only hold one ticket (UNIQUE index): repeats use the legacy id.
  const seenOrders = new Set();
  const rows = keys.map((k, i) => {
    let o = values[i];
    if (o && seenOrders.has(o)) o = '';
    if (o) seenOrders.add(o);
    return { n: k.n, o, l: legacyId(eventId, k.n) };
  });

  const now = new Date().toISOString();
  const stmts = [];
  if (rows.length) {
    const json = JSON.stringify(rows);
    stmts.push(db.prepare(BACKFILL_KEEP_ID_SQL).bind(eventId, now, json));
    stmts.push(db.prepare(BACKFILL_FILL_GAPS_SQL).bind(eventId, now, json));
  }
  stmts.push(
    db.prepare('INSERT OR REPLACE INTO event_backfill (event_id, done_at) VALUES (?1, ?2)').bind(eventId, now)
  );
  await db.batch(stmts); // one transaction
  return true;
}

// Schema + one-time legacy backfill for this event.
export async function ensureReady(env, eventId) {
  await ensureSchema(env);
  if (eventId == null || eventId === '') return;
  const id = String(eventId);
  let p = backfillPromises.get(id);
  if (!p) {
    const forget = () => { if (backfillPromises.get(id) === p) backfillPromises.delete(id); };
    // A skipped backfill (KV list failed) or a failed one is retried by a later call.
    p = backfillEvent(env, id).then(complete => { if (!complete) forget(); });
    backfillPromises.set(id, p);
    p.catch(forget);
  }
  await p;
}

// Reserve a specific number for an order. true = reserved (or already held by
// this same order), false = someone else has it.
export async function claimNumber(env, eventId, number, orderId, source) {
  const n = toTicketInt(number);
  const id = String(eventId);
  const oid = String(orderId);
  await ensureReady(env, id);
  const db = getDb(env);
  try {
    await db.prepare(
      'INSERT INTO event_tickets (event_id, number, order_id, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(id, n, oid, String(source || 'staff'), new Date().toISOString()).run();
    return true;
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    const row = await db.prepare('SELECT order_id FROM event_tickets WHERE event_id = ?1 AND number = ?2')
      .bind(id, n).first();
    return !!(row && row.order_id === oid);
  }
}

// Undo a claim - only if this order still holds that number.
export async function releaseNumber(env, eventId, number, orderId) {
  let n;
  try { n = toTicketInt(number); } catch { return false; }
  await ensureSchema(env);
  const res = await getDb(env).prepare(
    'DELETE FROM event_tickets WHERE event_id = ?1 AND number = ?2 AND order_id = ?3'
  ).bind(String(eventId), n, String(orderId)).run();
  return !!(res && res.meta && res.meta.changes > 0);
}

// The number (and when it was taken) held by an order in this event, or null.
export async function ticketForOrder(env, eventId, orderId) {
  await ensureSchema(env);
  const row = await getDb(env).prepare(
    'SELECT number, created_at FROM event_tickets WHERE event_id = ?1 AND order_id = ?2'
  ).bind(String(eventId), String(orderId)).first();
  return row ? { number: Number(row.number), createdAt: row.created_at } : null;
}

export async function numberForOrder(env, eventId, orderId) {
  const t = await ticketForOrder(env, eventId, orderId);
  return t ? t.number : null;
}

// Lowest free number in the event's range, or null if the range is full.
export async function lowestFree(env, event) {
  const id = String(event.id);
  const start = Number(event.rangeStart);
  const end = Number(event.rangeEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  await ensureReady(env, id);
  const row = await getDb(env).prepare(LOWEST_FREE_SQL).bind(id, start, end).first();
  return row && row.n != null ? Number(row.n) : null;
}

// Safety net: if a legacy KV ticket key says another order already used this
// number (e.g. it was written while D1 was unbound, after this event's backfill),
// hand the D1 row to that order and report a conflict so the caller re-allocates.
async function yieldToLegacyHolder(env, eventId, n, orderId) {
  let raw;
  try { raw = await env.ORDERS_KV.get(`event:ticket:${eventId}:${n}`); } catch { return false; }
  if (raw == null) return false;
  const holder = String(raw).trim();
  if (holder === orderId) return false;
  const res = await getDb(env).prepare(
    `UPDATE event_tickets
        SET order_id = CASE
              WHEN ?1 = '' OR EXISTS (SELECT 1 FROM event_tickets WHERE order_id = ?1) THEN ?2
              ELSE ?1 END,
            source = 'legacy'
      WHERE event_id = ?3 AND number = ?4 AND order_id = ?5`
  ).bind(holder, legacyId(eventId, n), eventId, n, orderId).run();
  console.warn(`allocateNext: #${n} of ${eventId} was already used by ${holder || 'a legacy ticket'}; re-allocating`, res && res.meta);
  return true;
}

// Give an order the lowest free number in the event's range. Atomic and
// idempotent per order: if the order already holds a number it is returned, and
// concurrent calls for the same order end up with the same single number.
// Returns null if the range is full.
export async function allocateNext(env, event, orderId, source = 'guest') {
  const id = String(event.id);
  const oid = String(orderId);
  const start = Number(event.rangeStart);
  const end = Number(event.rangeEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error(`Invalid ticket range for event ${id}.`);
  }
  await ensureReady(env, id);
  const db = getDb(env);

  for (let attempt = 0; attempt < 12; attempt++) {
    let n = await numberForOrder(env, id, oid);
    if (n == null) {
      if (end < start) return null;
      try {
        await db.prepare(ALLOCATE_SQL)
          .bind(id, start, end, oid, String(source || 'guest'), new Date().toISOString())
          .run();
      } catch (err) {
        // Lost a race (same order allocated concurrently, or the number was
        // taken between planning and insert): look again.
        if (isConstraintError(err)) continue;
        throw err;
      }
      n = await numberForOrder(env, id, oid);
      if (n == null) return null; // nothing was inserted: range full
    }
    if (await yieldToLegacyHolder(env, id, n, oid)) continue;
    return n;
  }
  throw new Error('Could not allocate a ticket number, please try again.');
}

const sortedUnique = (nums) => [...new Set(nums)].sort((a, b) => a - b);

// All used numbers for an event, sorted. With the events database this is the
// D1 rows ONLY: legacy KV tickets were copied in by the backfill, and staff
// numbers are claimed in D1 (order.js), so no KV list is spent per call. The
// legacy KV ticket keys are listed only when there is no DB or the D1 read
// failed - and a failing KV list then gives [] rather than an error.
export async function usedNumbers(env, eventId) {
  const id = String(eventId);
  if (hasDb(env)) {
    try {
      await ensureReady(env, id);
      const res = await getDb(env).prepare('SELECT number FROM event_tickets WHERE event_id = ?1').bind(id).all();
      return sortedUnique(((res && res.results) || []).map(r => Number(r.number)));
    } catch (err) {
      console.error('usedNumbers: D1 read failed, using KV tickets only:', err);
    }
  }
  try {
    return sortedUnique((await listKvTickets(env, id)).map(t => t.n));
  } catch (err) {
    console.error('usedNumbers: KV ticket list failed:', err);
    return [];
  }
}

// Like usedNumbers, but for decisions that must not be made on partial data (the
// admin changing an event's ticket range): every failure throws instead of falling
// back, and legacy KV tickets that haven't been copied into D1 yet count as a failure.
export async function usedNumbersStrict(env, eventId) {
  const id = String(eventId);
  if (hasDb(env)) {
    await ensureReady(env, id);
    const db = getDb(env);
    const done = await db.prepare('SELECT done_at FROM event_backfill WHERE event_id = ?1').bind(id).first();
    if (!done) throw new Error(`legacy tickets for ${id} not copied yet`);
    const res = await db.prepare('SELECT number FROM event_tickets WHERE event_id = ?1').bind(id).all();
    return sortedUnique(((res && res.results) || []).map(r => Number(r.number)));
  }
  return sortedUnique((await listKvTickets(env, id)).map(t => t.n));
}

// ─── Add-on magnets ────────────────────────────────────────────────────────

// Record a completed add-on for its root ticket. Idempotent per add-on order
// (INSERT OR IGNORE: a repeat keeps the first row). -> true
export async function recordAddon(env, { addonOrderId, rootOrderId, eventId, number, photos, amount = null, completedAt }) {
  const n = toTicketInt(number);
  const count = Number(photos);
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid add-on photo count: ${photos}`);
  const amt = amount === null || amount === undefined || !Number.isFinite(Number(amount)) ? null : Number(amount);
  await ensureSchema(env);
  await getDb(env).prepare(
    `INSERT OR IGNORE INTO ticket_addons
       (addon_order_id, root_order_id, event_id, number, photos, amount, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(
    String(addonOrderId), String(rootOrderId), String(eventId), n, count, amt,
    String(completedAt || new Date().toISOString()),
  ).run();
  return true;
}

// Photos and money (GBP) of every COMPLETED add-on of a root ticket order.
// -> { photos, amount, count }
export async function addonTally(env, rootOrderId) {
  await ensureSchema(env);
  const row = await getDb(env).prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(photos), 0) AS p, COALESCE(SUM(amount), 0) AS a
       FROM ticket_addons WHERE root_order_id = ?1`
  ).bind(String(rootOrderId)).first();
  return {
    photos: Number(row && row.p) || 0,
    amount: Math.round((Number(row && row.a) || 0) * 100) / 100,
    count: Number(row && row.c) || 0,
  };
}

// ─── Add-on payment holds (one live add-on per ticket) ─────────────────────
// A hold says "add-on X of this ticket may be paid until expires_at" (= the
// expiry of its Stripe Checkout Session, unix seconds). /api/guest-pay takes it
// before handing out a checkout url; it is released when the add-on completes
// or is cancelled, and simply runs out otherwise.

export const nowSeconds = () => Math.floor(Date.now() / 1000);

const holdFromRow = (rootOrderId, row) => (row ? {
  rootOrderId: String(rootOrderId),
  addonOrderId: String(row.addon_order_id),
  photos: Number(row.photos) || 0,
  expiresAt: Number(row.expires_at),
} : null);

// The ticket's hold (expired or not), or null.
// -> { rootOrderId, addonOrderId, photos, expiresAt } | null
export async function addonHold(env, rootOrderId) {
  await ensureSchema(env);
  const row = await getDb(env).prepare(HOLD_SELECT_SQL).bind(String(rootOrderId)).first();
  return holdFromRow(rootOrderId, row);
}

function toUnixSeconds(value, what) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${what}: ${value}`);
  return n;
}

// Take the ticket's hold for this add-on (atomic). -> { acquired, took, hold }
//   acquired: the add-on holds it now (until at least expiresAt)
//   took:     it did NOT hold it just before (new hold, or an expired one taken over)
//   hold:     the hold as it now stands (another add-on's when not acquired)
export async function acquireAddonHold(env, { rootOrderId, addonOrderId, photos, expiresAt, now = nowSeconds() }) {
  const root = String(rootOrderId);
  const addon = String(addonOrderId);
  const exp = toUnixSeconds(expiresAt, 'hold expiry');
  const at = toUnixSeconds(now, 'time');
  const count = Math.max(0, Math.floor(Number(photos) || 0));
  await ensureSchema(env);
  const db = getDb(env);
  const [before, , after] = await db.batch([ // one transaction
    db.prepare(HOLD_SELECT_SQL).bind(root),
    db.prepare(ACQUIRE_HOLD_SQL).bind(root, addon, count, exp, at),
    db.prepare(HOLD_SELECT_SQL).bind(root),
  ]);
  const prev = holdFromRow(root, before && before.results && before.results[0]);
  const hold = holdFromRow(root, after && after.results && after.results[0]);
  const acquired = !!(hold && hold.addonOrderId === addon);
  return { acquired, took: acquired && !(prev && prev.addonOrderId === addon), hold };
}

// Make this add-on's EXISTING hold last until at least expiresAt. Never creates
// a hold (one released meanwhile - the add-on completed / was cancelled - stays
// released). -> true when the add-on still holds it
export async function extendAddonHold(env, { rootOrderId, addonOrderId, expiresAt }) {
  const root = String(rootOrderId);
  const addon = String(addonOrderId);
  const exp = toUnixSeconds(expiresAt, 'hold expiry');
  await ensureSchema(env);
  const db = getDb(env);
  const [, after] = await db.batch([
    db.prepare(
      'UPDATE addon_holds SET expires_at = MAX(expires_at, ?3) WHERE root_order_id = ?1 AND addon_order_id = ?2'
    ).bind(root, addon, exp),
    db.prepare(HOLD_SELECT_SQL).bind(root),
  ]);
  const hold = holdFromRow(root, after && after.results && after.results[0]);
  return !!(hold && hold.addonOrderId === addon);
}

// Release the ticket's hold - only if this add-on has it. -> true when deleted
export async function releaseAddonHold(env, rootOrderId, addonOrderId) {
  await ensureSchema(env);
  const res = await getDb(env).prepare(
    'DELETE FROM addon_holds WHERE root_order_id = ?1 AND addon_order_id = ?2'
  ).bind(String(rootOrderId), String(addonOrderId)).run();
  return !!(res && res.meta && res.meta.changes > 0);
}

// ─── Guest link resolution (shared by guest-event / guest-order) ───────────

export const GUEST_MESSAGES = {
  invalid: "This upload link isn't valid. Please ask a member of staff for the current QR code.",
  closed: 'Uploads for this event are closed.',
  'not-setup': 'Guest uploads are not set up yet.',
  full: 'Sorry - all numbers for this event have been taken.',
};

// -> { open: true, event } | { open: false, reason, event? }
// opts.allowFull: don't refuse when every number is taken (add-on magnets join
// an existing ticket, so they never need a free number).
export async function resolveGuestToken(env, token, { allowFull = false } = {}) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(t)) return { open: false, reason: 'invalid' };

  const eventId = await env.ORDERS_KV.get(`event:guesttoken:${t}`);
  if (!eventId) return { open: false, reason: 'invalid' };
  const raw = await env.ORDERS_KV.get(`event:meta:${eventId}`);
  let event = null;
  try { event = raw ? JSON.parse(raw) : null; } catch { event = null; }
  if (!event || !event.id || event.guestToken !== t) return { open: false, reason: 'invalid' };

  if (!event.guestUpload) return { open: false, reason: 'closed', event };
  if (!hasDb(env)) return { open: false, reason: 'not-setup', event };
  if (!event.active) return { open: false, reason: 'closed', event };
  if (allowFull) return { open: true, event };

  const free = await lowestFree(env, event);
  if (free == null) return { open: false, reason: 'full', event };
  return { open: true, event };
}
