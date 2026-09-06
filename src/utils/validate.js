import { appError, ErrorCodes } from "./errors.js";

// Parses req[source] with a Zod schema; stores the parsed value instead of overwriting
// req.query/req.body (Express 5 makes req.query read-only) so handlers read from req.validated(Query).
export function validate(schema, source = "body") {
  return (req, res, next) => {
    try {
      const data = schema.parse(req[source]);
      if (source === "query") req.validatedQuery = data;
      else req.validated = data;
      next();
    } catch (err) {
      const issues = Array.isArray(err.errors)
        ? err.errors.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message }))
        : String(err.message);
      next(
        appError(ErrorCodes.VALIDATION_ERROR, "Request validation failed", {
          issues,
          hint: "Fix each listed field (see issues[].path/message) and resubmit the request body."
        })
      );
    }
  };
}
