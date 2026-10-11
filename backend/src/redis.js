const Redis = require("ioredis");
require("dotenv").config({ quiet: true });

// Phase 1's rate limiter was explicitly documented as "in-memory, will not
// coordinate correctly across multiple server instances" (SRS Section 19
// flags Redis as the Phase 2 upgrade). This client is that upgrade.
//
// It's built to degrade gracefully rather than crash the API if Redis is
// unreachable: callers should treat a null return from `getRedis()` as
// "fall back to best-effort in-process behavior," not as a fatal error —
// see middleware/rateLimit.js for the pattern.
let client = null;
let triedConnect = false;

function getRedis() {
  if (!triedConnect) {
    triedConnect = true;
    try {
      client = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // don't keep retrying forever — fail fast, caller falls back
        lazyConnect: false,
      });
      client.on("error", (err) => {
        // Don't let an unhandled 'error' event crash the process; just log once per storm.
        if (!client._loggedError) {
          console.warn("[redis] connection issue, falling back to in-process behavior:", err.message);
          client._loggedError = true;
        }
      });
      client.on("connect", () => {
        client._loggedError = false;
        console.log("[redis] connected");
      });
    } catch (err) {
      console.warn("[redis] failed to initialize client:", err.message);
      client = null;
    }
  }
  return client;
}

module.exports = { getRedis };
