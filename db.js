const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const schema = `
CREATE TABLE IF NOT EXISTS slots (id text PRIMARY KEY, provider text NOT NULL, start text NOT NULL, "end" text NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (
  seq bigserial, id text PRIMARY KEY, slot_id text NOT NULL, name text NOT NULL, email text NOT NULL,
  status text NOT NULL, created_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
CREATE TABLE IF NOT EXISTS idempotency (key text PRIMARY KEY, body_hash text NOT NULL, status int, response jsonb);
CREATE TABLE IF NOT EXISTS rate_hits (email text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS rate_hits_email_at ON rate_hits (email, at);
`;

let ready;
// Runs once per process; a failed attempt is retried on the next request.
function init() {
  ready ??= pool.query(schema).catch((e) => { ready = null; throw e; });
  return ready;
}

async function query(text, params) {
  await init();
  return pool.query(text, params);
}

async function tx(fn) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, tx, pool };
