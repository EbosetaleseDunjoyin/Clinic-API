# Clinic Booking API

An Express + Postgres API that lets patients book clinic appointment slots, plus a one-page web UI at `/`.
It implements all five levels of the [assessment spec](https://koyaacademy.com/assessment-api).

Every API request needs the `X-API-Key` header. Every error looks like `{"error": "..."}`.

| Endpoint | Purpose |
|---|---|
| `POST /reset` | Replace all slots and delete every booking |
| `GET /slots?provider=` | Slots, earliest first, each with `available` |
| `POST /bookings` | Book a slot (optional `Idempotency-Key` header) |
| `GET /bookings?email=&limit=&cursor=` | A person's bookings, oldest first, cursor-paginated |
| `GET /bookings/:id` | Look up a booking |
| `DELETE /bookings/:id` | Cancel a booking |

## How the hard parts work

- **No double booking (L3):** a partial unique index, `bookings(slot_id) WHERE status = 'confirmed'`, lets Postgres reject the second of two simultaneous bookings (→ 409). Cancelling frees the slot automatically.
- **Idempotency (L4):** the key is inserted with a hash of the body in the same transaction as the booking. A concurrent retry waits on that row and then replays the stored status and body. A different body → 422.
- **Pagination (L4):** the cursor is the last row's sequence number. The last page returns `next_cursor: null`.
- **Rate limit (L5):** 5 attempts per email per sliding minute, failed attempts included. A per-email advisory lock stops parallel requests from slipping past the limit. The 6th attempt → 429 with `Retry-After`.

## Run locally

```sh
docker run -d --name clinic-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
export DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres
npm install
npm test
API_KEY=dev-key npm start   # http://localhost:3000
```

## Deploy

Deployed on Vercel (`api/index.js` exports the app, and `vercel.json` routes every path to it) with a Neon Postgres database.
Environment variables: `DATABASE_URL` and `API_KEY`. The tables are created on first request.
