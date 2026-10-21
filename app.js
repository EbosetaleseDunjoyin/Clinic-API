const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
const COLS = 'id, slot_id, name, email, status, created_at';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT = 5;

const fail = (status, error) => ({ status, body: { error } });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
app.get('/', (req, res) => res.type('html').send(page.replace('__API_KEY__', process.env.API_KEY ?? '')));

app.use((req, res, next) => {
  const key = process.env.API_KEY;
  if (!key || req.get('X-API-Key') !== key) return res.status(401).json({ error: 'Missing or invalid API key' });
  next();
});

app.use(express.json({ type: () => true }));

app.post('/reset', h(async (req, res) => {
  const slots = req.body?.slots;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
  const valid = slots.every((s) => s && ['id', 'provider', 'start', 'end'].every((k) => typeof s[k] === 'string' && s[k])
    && !isNaN(Date.parse(s.start)) && !isNaN(Date.parse(s.end)));
  if (!valid) return res.status(400).json({ error: 'each slot needs string id, provider, start and end' });
  if (new Set(slots.map((s) => s.id)).size !== slots.length) return res.status(400).json({ error: 'slot ids must be unique' });

  try {
    await db.tx(async (c) => {
      await c.query('TRUNCATE bookings, slots, idempotency, rate_hits');
      await c.query(
        'INSERT INTO slots (id, provider, start, "end") SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])',
        ['id', 'provider', 'start', 'end'].map((k) => slots.map((s) => s[k])),
      );
      // Later queries cast start to timestamptz, so reject anything Postgres can't parse now.
      await c.query('SELECT start::timestamptz, "end"::timestamptz FROM slots');
    });
  } catch (e) {
    if (e.code?.startsWith('22')) return res.status(400).json({ error: 'start and end must be ISO date-times' });
    throw e;
  }
  res.json({ ok: true });
}));

app.get('/slots', h(async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await db.query(
    `SELECT s.id, s.provider, s.start, s."end",
       NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
     FROM slots s WHERE $1::text IS NULL OR s.provider = $1
     ORDER BY s.start::timestamptz, s.id`,
    [provider],
  );
  res.json({ slots: rows });
}));

// Runs inside a transaction. Returns { status, body, retryAfter? }.
async function book(c, body) {
  const email = str(body.email).toLowerCase();

  if (email) {
    // Serialise attempts per email so concurrent requests can't slip past the limit.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    await c.query("DELETE FROM rate_hits WHERE email = $1 AND at <= clock_timestamp() - interval '60 seconds'", [email]);
    const { rows: [r] } = await c.query(
      `SELECT count(*)::int AS n, ceil(extract(epoch FROM min(at) + interval '60 seconds' - clock_timestamp()))::int AS wait
       FROM rate_hits WHERE email = $1`,
      [email],
    );
    if (r.n >= RATE_LIMIT) return { ...fail(429, 'too many booking attempts, try again later'), retryAfter: Math.max(1, r.wait) };
    await c.query('INSERT INTO rate_hits (email, at) VALUES ($1, clock_timestamp())', [email]);
  }

  const name = str(body.name);
  if (!str(body.slot_id) || !name || !email) return fail(400, 'slot_id, name and email are required');
  if (!EMAIL.test(email)) return fail(400, 'email is invalid');

  const { rows: [slot] } = await c.query('SELECT start::timestamptz <= now() AS started FROM slots WHERE id = $1', [body.slot_id]);
  if (!slot) return fail(404, 'slot not found');
  if (slot.started) return fail(400, 'slot has already started');

  // The partial unique index rejects a second confirmed booking; the savepoint keeps the transaction usable.
  await c.query('SAVEPOINT book');
  try {
    const { rows: [booking] } = await c.query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES ($1, $2, $3, $4, 'confirmed', $5) RETURNING ${COLS}`,
      [crypto.randomUUID(), body.slot_id, name, email, new Date().toISOString()],
    );
    return { status: 201, body: booking };
  } catch (e) {
    if (e.code !== '23505') throw e;
    await c.query('ROLLBACK TO SAVEPOINT book');
    return fail(409, 'slot is already booked');
  }
}

async function bookIdempotent(key, body) {
  const plain = body && !Array.isArray(body);
  const hash = crypto.createHash('sha256').update(JSON.stringify(body, plain ? Object.keys(body).sort() : undefined)).digest('hex');
  return db.tx(async (c) => {
    // A concurrent request with the same key blocks here until the first one commits.
    const ins = await c.query('INSERT INTO idempotency (key, body_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, hash]);
    if (!ins.rowCount) {
      const { rows: [row] } = await c.query('SELECT body_hash, status, response FROM idempotency WHERE key = $1', [key]);
      if (row.body_hash !== hash) return fail(422, 'Idempotency-Key was already used with a different body');
      return { status: row.status, body: row.response };
    }
    const result = await book(c, body);
    // A rate-limited attempt isn't a real answer, so a later retry must run again.
    if (result.status === 429) await c.query('DELETE FROM idempotency WHERE key = $1', [key]);
    else await c.query('UPDATE idempotency SET status = $2, response = $3 WHERE key = $1', [key, result.status, result.body]);
    return result;
  });
}

app.post('/bookings', h(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = req.get('Idempotency-Key');
  const result = key ? await bookIdempotent(key, body) : await db.tx((c) => book(c, body));
  if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
  res.status(result.status).json(result.body);
}));

app.get('/bookings', h(async (req, res) => {
  const email = str(req.query.email).toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });
  const limit = req.query.limit ?? '10';
  if (typeof limit !== 'string' || !/^\d+$/.test(limit) || +limit < 1 || +limit > 50) {
    return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
  }
  const cursor = req.query.cursor ?? '0';
  if (typeof cursor !== 'string' || !/^\d{1,18}$/.test(cursor)) return res.status(400).json({ error: 'cursor is invalid' });

  const { rows } = await db.query(
    `SELECT seq, ${COLS} FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [email, cursor, +limit + 1],
  );
  const page = rows.slice(0, +limit);
  res.json({
    bookings: page.map(({ seq, ...b }) => b),
    next_cursor: rows.length > page.length ? String(page.at(-1).seq) : null,
  });
}));

app.get('/bookings/:id', h(async (req, res) => {
  const { rows: [booking] } = await db.query(`SELECT ${COLS} FROM bookings WHERE id = $1`, [req.params.id]);
  if (!booking) return res.status(404).json({ error: 'booking not found' });
  res.json(booking);
}));

app.delete('/bookings/:id', h(async (req, res) => {
  const { rows: [booking] } = await db.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING ${COLS}`,
    [req.params.id],
  );
  if (booking) return res.json(booking);
  const { rowCount } = await db.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  res.status(rowCount ? 409 : 404).json({ error: rowCount ? 'booking already cancelled' : 'booking not found' });
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body must be valid JSON' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
