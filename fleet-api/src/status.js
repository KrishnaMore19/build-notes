// Vehicle status is derived on read, never stored (see the header of db/01-schema.sql).
// ASSUMPTION: the rules below are mine. Swap in your own status.ts logic if it differs.
const STALE_AFTER_S = Number(process.env.STALE_AFTER_S) || 120;

function deriveStatus(v, now = Date.now()) {
  if (!v.last_seen_at) return 'offline'; // never reported
  if (!v.ignition) return 'parked';
  const ageS = (now - new Date(v.last_seen_at).getTime()) / 1000;
  if (ageS > STALE_AFTER_S) return 'offline'; // engine on but the tracker went quiet
  return v.last_speed_kmph > 0 ? 'moving' : 'idle';
}

module.exports = { deriveStatus };
