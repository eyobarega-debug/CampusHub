const { ApiError } = require("../utils/errors");
const { getRedis } = require("../redis");

// In-memory fallback (Phase 1's original implementation) — used only when
// Redis is unreachable, so a single-instance dev setup still works even
// without Redis running.
const memHits = new Map();
function memoryCheck(key, windowMs, max) {
  const now = Date.now();
  const arr = (memHits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  memHits.set(key, arr);
  return arr.length;
}

// Redis-backed fixed-window counter: INCR + EXPIRE on first hit. Simpler
// than a true sliding-window log, but coordinates correctly across multiple
// server instances, which was the entire point of the Phase 2 upgrade (SRS
// Section 19 / Section 21.3) — the in-memory version below cannot do that.
async function redisCheck(redis, key, windowMs, max) {
  const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.pexpire(windowKey, windowMs);
  return count;
}

function rateLimit({ windowMs = 60_000, max = 10, keyFn }) {
  return async (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const redis = getRedis();
    try {
      let count;
      if (redis && redis.status === "ready") {
        count = await redisCheck(redis, key, windowMs, max);
      } else {
        count = memoryCheck(key, windowMs, max);
      }
      if (count > max) {
        return next(new ApiError(429, "Too many attempts. Please wait and try again.", "RATE_LIMITED"));
      }
      next();
    } catch (err) {
      // Rate limiting must never be the reason a legitimate request fails —
      // if Redis errors mid-request, fall back to allowing it through rather
      // than 500ing the whole API.
      console.warn("[rateLimit] check failed, allowing request through:", err.message);
      next();
    }
  };
}

module.exports = { rateLimit };
