// Run: DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres node --test
process.env.API_KEY = 'test-key';
const test = require('node:test');
const assert = require('node:assert');
const app = require('./app');
const db = require('./db');

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); return db.pool.end(); });

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace('.000', '');
const reset = () => call('POST', '/api/reset', {
  slots: [
    { id: 's2', provider: 'Dr Bo', start: future(2), end: future(3) },
    { id: 's1', provider: 'Dr Ade', start: future(1), end: future(2) },
    { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, provider: 'Dr Pg', start: future(10 + i), end: future(11 + i) })),
  ],
});

test('docs are public', async () => {
  assert.equal((await fetch(`${base}/docs`)).status, 200);
  assert.match(await (await fetch(`${base}/openapi.yaml`)).text(), /^openapi: 3/);
});

test('level 1-2: auth, slots, booking, lookup, validation', async () => {
  assert.equal((await fetch(`${base}/api/slots`)).status, 401);
  assert.equal((await call('GET', '/api/slots', undefined, { 'X-API-Key': 'wrong' })).status, 401);
  assert.equal((await reset()).status, 200);

  const { body: { slots } } = await call('GET', '/api/slots');
  assert.deepEqual(slots.slice(0, 3).map((s) => s.id), ['past', 's1', 's2']);
  const ade = (await call('GET', '/api/slots?provider=Dr%20Ade')).body.slots;
  assert.deepEqual(ade.map((s) => s.id), ['past', 's1']);
  assert.equal(ade[0].start, '2020-01-01T09:00:00Z');

  const made = await call('POST', '/api/bookings', { slot_id: 's1', name: '  Ada Obi ', email: ' ADA@Example.com ' });
  assert.equal(made.status, 201);
  assert.equal(made.body.status, 'confirmed');
  assert.equal(made.body.name, 'Ada Obi');
  assert.equal(made.body.email, 'ada@example.com');
  assert.deepEqual(Object.keys(made.body).sort(), ['created_at', 'email', 'id', 'name', 'slot_id', 'status']);

  assert.deepEqual((await call('GET', `/api/bookings/${made.body.id}`)).body, made.body);
  assert.equal((await call('GET', '/api/bookings/nope')).status, 404);
  assert.equal((await call('GET', '/api/slots')).body.slots.find((s) => s.id === 's1').available, false);

  for (const bad of [{ name: 'A', email: 'b@c.io' }, { slot_id: 's2', name: ' ', email: 'b@c.io' },
    { slot_id: 's2', name: 'A' }, { slot_id: 's2', name: 'A', email: 'not-an-email' }]) {
    const r = await call('POST', '/api/bookings', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('POST', '/api/bookings', { slot_id: 'zzz', name: 'A', email: 'z@c.io' })).status, 404);
  assert.equal((await call('POST', '/api/bookings', { slot_id: 'past', name: 'A', email: 'p@c.io' })).status, 400);
  const badJson = await fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
});

test('level 3: concurrent bookings and cancellation', async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call('POST', '/api/bookings', { slot_id: 's2', name: 'Racer', email: `racer${i}@x.io` })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 19);

  const winner = results.find((r) => r.status === 201).body;
  const cancelled = await call('DELETE', `/api/bookings/${winner.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await call('DELETE', `/api/bookings/${winner.id}`)).status, 409);
  assert.equal((await call('DELETE', '/api/bookings/nope')).status, 404);
  assert.equal((await call('POST', '/api/bookings', { slot_id: 's2', name: 'B', email: 'again@x.io' })).status, 201);
});

test('level 4: idempotency and pagination', async () => {
  await reset();
  const body = { slot_id: 's1', name: 'Idem', email: 'idem@x.io' };
  const tries = await Promise.all([1, 2, 3].map(() => call('POST', '/api/bookings', body, { 'Idempotency-Key': 'k1' })));
  assert.deepEqual(tries.map((r) => r.status), [201, 201, 201]);
  assert.equal(new Set(tries.map((r) => r.body.id)).size, 1);
  const reordered = await call('POST', '/api/bookings', { email: 'idem@x.io', name: 'Idem', slot_id: 's1' }, { 'Idempotency-Key': 'k1' });
  assert.equal(reordered.body.id, tries[0].body.id);
  assert.equal((await call('POST', '/api/bookings', { ...body, name: 'Other' }, { 'Idempotency-Key': 'k1' })).status, 422);
  assert.equal((await call('GET', '/api/bookings?email=IDEM@x.io')).body.bookings.length, 1);

  // A stored failure replays too.
  const conflict = await call('POST', '/api/bookings', { ...body, email: 'late@x.io' }, { 'Idempotency-Key': 'k2' });
  assert.equal(conflict.status, 409);
  assert.equal((await call('POST', '/api/bookings', { ...body, email: 'late@x.io' }, { 'Idempotency-Key': 'k2' })).status, 409);

  // 4 bookings for one email (the rate limit is 5 per minute), paged 3 + 1.
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/api/bookings', { slot_id: `p${i}`, name: 'Pager', email: 'pager@x.io' })).status, 201);
  }
  const p1 = await call('GET', '/api/bookings?email=Pager@X.io&limit=3');
  assert.deepEqual(p1.body.bookings.map((b) => b.slot_id), ['p0', 'p1', 'p2']);
  assert.equal(typeof p1.body.next_cursor, 'string');
  const p2 = await call('GET', `/api/bookings?email=pager@x.io&limit=3&cursor=${p1.body.next_cursor}`);
  assert.deepEqual(p2.body.bookings.map((b) => b.slot_id), ['p3']);
  assert.equal(p2.body.next_cursor, null);
  for (const l of ['0', '51', 'abc', '2.5', '']) {
    assert.equal((await call('GET', `/api/bookings?email=pager@x.io&limit=${l}`)).status, 400, `limit=${l}`);
  }
  assert.equal((await call('GET', '/api/bookings?email=nobody@x.io')).body.next_cursor, null);
});

test('level 5: rate limit per email', async () => {
  await reset();
  const attempts = [];
  for (let i = 0; i < 5; i++) attempts.push(await call('POST', '/api/bookings', { slot_id: 'zzz', name: 'S', email: 'spam@x.io' }));
  assert.deepEqual(attempts.map((r) => r.status), [404, 404, 404, 404, 404]);
  const sixth = await call('POST', '/api/bookings', { slot_id: 's1', name: 'S', email: 'SPAM@x.io' });
  assert.equal(sixth.status, 429);
  const wait = Number(sixth.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, `Retry-After ${wait}`);
  assert.equal((await call('POST', '/api/bookings', { slot_id: 's1', name: 'O', email: 'other@x.io' })).status, 201);
});
