const { getRedis } = require("../redis");

// Simple cache-aside wrapper with a short TTL rather than explicit
// invalidation. For read-heavy, frequently-changing lists (product/event
// browsing) a short TTL is a much simpler correct-enough strategy than
// tracking every write path that could invalidate the cache — and it's
// the standard pragmatic choice for this kind of endpoint. If Redis is
// unavailable, this just calls straight through to `fn()`.
async function cached(key, ttlSeconds, fn) {
  const redis = getRedis();
  if (!redis || redis.status !== "ready") return fn();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (err) {
    console.warn("[cache] read failed, falling through to source:", err.message);
  }

  const result = await fn();
  try {
    await redis.set(key, JSON.stringify(result), "EX", ttlSeconds);
  } catch (err) {
    console.warn("[cache] write failed (non-fatal):", err.message);
  }
  return result;
}

module.exports = { cached };
