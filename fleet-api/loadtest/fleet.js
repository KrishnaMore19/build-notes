// k6 load test: a realistic read mix against the console endpoints.
//   k6 run -e BASE_URL=http://127.0.0.1:8080 loadtest/fleet.js
// Raise RATE_LIMIT_PER_MIN first (see README), or the limiter answers 429 instead of the API.
// There is deliberately no sleep(): with a pause, every setup would hit the same ~190 req/s ceiling.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';

export const options = {
  vus: Number(__ENV.VUS) || 20,
  duration: __ENV.DURATION || '30s',
};

export function setup() {
  const res = http.get(`${BASE}/api/vehicles?limit=100`);
  if (res.status !== 200) {
    throw new Error(`setup failed: status ${res.status}, body: ${String(res.body).slice(0, 200)}`);
  }
  return { ids: res.json('data').map((v) => v.id) };
}

export default function (data) {
  const roll = Math.random();
  let res;
  if (roll < 0.5) {
    res = http.get(`${BASE}/api/vehicles?limit=20`);            // fleet map
  } else if (roll < 0.8) {
    res = http.get(`${BASE}/api/alerts?state=unresolved`);      // needs-attention list
  } else {
    const id = data.ids[Math.floor(Math.random() * data.ids.length)];
    res = http.get(`${BASE}/api/vehicles/${id}`);               // vehicle panel
  }
  check(res, { 'status 200': (r) => r.status === 200 });
}
