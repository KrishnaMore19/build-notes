const express = require('express');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { z, ZodError } = require('zod');
const { pool } = require('./db');
const { redis, cache, invalidate } = require('./cache');
const { deriveStatus } = require('./status');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0); // 1 when running behind nginx
app.use(express.json({ limit: '10kb' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const uuid = z.string().uuid();
const limitParam = z.coerce.number().int().min(1).max(100).default(20);
const DEMO_OPERATOR = '00000000-0000-4000-8000-000000000001';

// Fetch limit + 1 rows to know whether another page exists, then trim.
const paginate = (rows, limit, cursorOf) => {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, next: hasMore ? cursorOf(data[data.length - 1]) : null };
};

app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, redis: redis.status === 'ready' });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Rate limiting uses a shared Redis store, so every API instance counts against the same limit.
// The limiter is attached once Redis is ready; if Redis is unreachable at boot, the API runs without it.
let limiter = (req, res, next) => next();
app.use('/api', (req, res, next) => limiter(req, res, next));

async function enableRateLimit() {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return;
  const ready = redis.status === 'ready' || (await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    redis.once('ready', () => { clearTimeout(timer); resolve(true); });
  }));
  if (!ready) return console.warn('Redis unreachable: rate limiting disabled');
  limiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.RATE_LIMIT_PER_MIN) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true, // Redis hiccup mid-request: do not block traffic
    skip: () => redis.status !== 'ready', // Redis down: skip limiting quietly (no error + stack trace logged per request)
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  });
}

const VEHICLE_SELECT = `
  select v.id, v.registration, v.make_model, v.speed_limit_kmph, v.odometer_km,
         v.last_lat, v.last_lng, v.last_speed_kmph, v.last_heading_deg,
         v.fuel_pct, v.battery_pct, v.ignition, v.last_seen_at,
         d.id as depot_id, d.name as depot_name,
         dr.full_name as driver_name, dr.employee_code
    from public.vehicles v
    join public.depots d on d.id = v.depot_id
    left join public.drivers dr on dr.id = v.driver_id`;

const toVehicle = (r) => ({
  id: r.id,
  registration: r.registration,
  makeModel: r.make_model,
  status: deriveStatus(r),
  overspeeding: r.last_speed_kmph != null && r.last_speed_kmph > r.speed_limit_kmph,
  speedLimitKmph: r.speed_limit_kmph,
  odometerKm: r.odometer_km,
  position: r.last_lat == null ? null : { lat: r.last_lat, lng: r.last_lng },
  speedKmph: r.last_speed_kmph,
  headingDeg: r.last_heading_deg,
  fuelPct: r.fuel_pct,
  batteryPct: r.battery_pct,
  ignition: r.ignition,
  lastSeenAt: r.last_seen_at,
  depot: { id: r.depot_id, name: r.depot_name },
  driver: r.driver_name ? { name: r.driver_name, employeeCode: r.employee_code } : null,
});

// GET /api/vehicles?depot=<uuid>&limit=20&cursor=<vehicle id>
app.get('/api/vehicles', cache(Number(process.env.CACHE_TTL_S) || 5), wrap(async (req, res) => {
  const q = z.object({ depot: uuid.optional(), limit: limitParam, cursor: uuid.optional() }).parse(req.query);
  const { rows } = await pool.query(
    `${VEHICLE_SELECT}
      where ($1::uuid is null or v.depot_id = $1) and ($2::uuid is null or v.id > $2)
      order by v.id limit $3`,
    [q.depot ?? null, q.cursor ?? null, q.limit + 1]
  );
  const { data, next } = paginate(rows, q.limit, (r) => r.id);
  res.json({ data: data.map(toVehicle), nextCursor: next });
}));

const TRIP_COLS = `id, status, started_at, ended_at, start_label, end_label, distance_km, duration_s,
                   avg_speed_kmph, max_speed_kmph, idle_s, halt_count, overspeed_count`;
const ALERT_COLS = `a.id, a.vehicle_id, v.registration, a.trip_id, a.kind, a.severity, a.message,
                    a.opened_at, a.state, a.acknowledged_at, a.resolved_at`;

// GET /api/vehicles/:id  (vehicle + 5 latest trips + unresolved alerts)
app.get('/api/vehicles/:id', cache(Number(process.env.CACHE_TTL_S) || 5), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const [vehicle, trips, alerts] = await Promise.all([
    pool.query(`${VEHICLE_SELECT} where v.id = $1`, [id]),
    pool.query(`select ${TRIP_COLS} from public.trips where vehicle_id = $1 order by started_at desc limit 5`, [id]),
    pool.query(
      `select ${ALERT_COLS} from public.alerts a join public.vehicles v on v.id = a.vehicle_id
        where a.vehicle_id = $1 and a.state <> 'resolved' order by a.opened_at desc`,
      [id]
    ),
  ]);
  if (!vehicle.rows[0]) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ ...toVehicle(vehicle.rows[0]), recentTrips: trips.rows, openAlerts: alerts.rows });
}));

// GET /api/vehicles/:id/trips?limit=20&before=<ISO timestamp>
app.get('/api/vehicles/:id/trips', cache(30), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const q = z.object({ limit: limitParam, before: z.string().datetime().optional() }).parse(req.query);
  const { rows } = await pool.query(
    `select ${TRIP_COLS} from public.trips
      where vehicle_id = $1 and ($2::timestamptz is null or started_at < $2)
      order by started_at desc limit $3`,
    [id, q.before ?? null, q.limit + 1]
  );
  const { data, next } = paginate(rows, q.limit, (r) => r.started_at.toISOString());
  res.json({ data, nextBefore: next });
}));

// GET /api/trips/:id/points?every=1   (every=5 returns each 5th breadcrumb, for light map rendering)
app.get('/api/trips/:id/points', cache(60), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const q = z.object({ every: z.coerce.number().int().min(1).max(100).default(1) }).parse(req.query);
  const [trip, points] = await Promise.all([
    pool.query('select 1 from public.trips where id = $1', [id]),
    pool.query(
      `select seq, recorded_at, lat, lng, speed_kmph, ignition from public.trip_points
        where trip_id = $1 and seq % $2::int = 0 order by seq`,
      [id, q.every]
    ),
  ]);
  if (!trip.rowCount) return res.status(404).json({ error: 'Trip not found' });
  res.json({ data: points.rows });
}));

// GET /api/alerts?state=unresolved|open|acknowledged|resolved|all&vehicle=<uuid>&limit=20&before=<ISO>
const STATE_FILTER = {
  unresolved: "a.state <> 'resolved'", // literal, so Postgres can use the partial index alerts_unresolved_idx
  open: "a.state = 'open'",
  acknowledged: "a.state = 'acknowledged'",
  resolved: "a.state = 'resolved'",
  all: 'true',
};
app.get('/api/alerts', cache(Number(process.env.CACHE_TTL_S) || 5), wrap(async (req, res) => {
  const q = z.object({
    state: z.enum(['unresolved', 'open', 'acknowledged', 'resolved', 'all']).default('unresolved'),
    vehicle: uuid.optional(),
    limit: limitParam,
    before: z.string().datetime().optional(),
  }).parse(req.query);
  const { rows } = await pool.query(
    `select ${ALERT_COLS} from public.alerts a join public.vehicles v on v.id = a.vehicle_id
      where ${STATE_FILTER[q.state]}
        and ($1::uuid is null or a.vehicle_id = $1)
        and ($2::timestamptz is null or a.opened_at < $2)
      order by a.opened_at desc limit $3`,
    [q.vehicle ?? null, q.before ?? null, q.limit + 1]
  );
  const { data, next } = paginate(rows, q.limit, (r) => r.opened_at.toISOString());
  res.json({ data, nextBefore: next });
}));

// PATCH /api/alerts/:id  {"action":"acknowledge"|"resolve"}
// The only write path. It calls the schema's set_alert_state(), which enforces the state
// machine and stamps who/when. Operator identity: X-Operator-Id header (stand-in for real auth).
app.patch('/api/alerts/:id', wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { action } = z.object({ action: z.enum(['acknowledge', 'resolve']) }).parse(req.body);
  const operator = uuid.catch(DEMO_OPERATOR).parse(req.get('x-operator-id'));

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [operator]); // what auth.uid() reads
    const { rows } = await client.query('select * from public.set_alert_state($1, $2)', [id, action]);
    await client.query('commit');
    await invalidate(['cache:/api/alerts*', 'cache:/api/vehicles/*']);
    res.json(rows[0]);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// SQLSTATEs raised by set_alert_state() and constraints, mapped to HTTP statuses.
const PG_STATUS = { '28000': 401, '22023': 400, P0002: 404, '55000': 409, '23503': 400 };
app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  if (PG_STATUS[err.code]) return res.status(PG_STATUS[err.code]).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`fleet-api listening on :${port}`));
enableRateLimit().catch((err) => console.error('rate limit setup failed', err.message));

function shutdown() {
  server.close(async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);