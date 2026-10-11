const { badRequest } = require("../utils/errors");

// validate({ body: zodSchema, query: zodSchema, params: zodSchema })
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      // Zod v4 exposes issues via `.issues` (the old `.errors` alias from v3 is gone).
      const issues = err.issues || err.errors;
      const message = issues ? issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ") : "Invalid request";
      next(badRequest(message, "VALIDATION_ERROR"));
    }
  };
}

module.exports = { validate };
