class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || "ERROR";
  }
}

const badRequest = (msg, code) => new ApiError(400, msg, code || "BAD_REQUEST");
const unauthorized = (msg = "Authentication required", code = "UNAUTHENTICATED") => new ApiError(401, msg, code);
const forbidden = (msg = "You are not allowed to do this", code = "FORBIDDEN") => new ApiError(403, msg, code);
const notFound = (msg = "Not found", code = "NOT_FOUND") => new ApiError(404, msg, code);
const conflict = (msg, code) => new ApiError(409, msg, code || "CONFLICT");
const tooMany = (msg, code) => new ApiError(429, msg, code || "TOO_MANY_REQUESTS");
const badGateway = (msg = "Bad Gateway", code = "BAD_GATEWAY") => new ApiError(502, msg, code);
const gatewayTimeout = (msg = "Gateway Timeout", code = "GATEWAY_TIMEOUT") => new ApiError(504, msg, code);

// Wrap async route handlers so thrown/rejected errors reach the error middleware
// instead of crashing the process or hanging the request.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.code === "23505") {
    // Postgres unique_violation
    return res.status(409).json({ error: { code: "DUPLICATE", message: "That record already exists." } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
}

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  badGateway,
  gatewayTimeout,
  asyncHandler,
  errorHandler,
};
