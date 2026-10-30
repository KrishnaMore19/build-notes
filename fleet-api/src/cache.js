const Redis = require('ioredis');

// Fail fast when Redis is down instead of queueing commands: the API must keep working without it.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on('error', () => {}); // connection errors are handled per call below

const enabled = process.env.CACHE_ENABLED !== 'false';

async function getCached(key) {
  try {
    return await redis.get(key);
  } catch {
    return null; // Redis down: fall back to the database
  }
}

async function setCached(key, value, ttlSeconds) {
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // caching is an optimization, never fail a request because of it
  }
}

// Caches successful GET responses. The key is the full URL, so filters and pages never collide.
function cache(ttlSeconds) {
  return async (req, res, next) => {
    if (!enabled) return next();
    const key = `cache:${req.originalUrl}`;
    const hit = await getCached(key);
    if (hit) {
      res.set('X-Cache', 'HIT');
      return res.type('json').send(hit);
    }
    res.set('X-Cache', 'MISS');
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) setCached(key, JSON.stringify(body), ttlSeconds);
      return send(body);
    };
    next();
  };
}

// Writes (acknowledge / resolve) drop the cached pages they affect.
async function invalidate(patterns) {
  if (!enabled) return;
  try {
    for (const match of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } catch {
    // entries expire on their own via the TTL
  }
}

module.exports = { redis, cache, invalidate };
