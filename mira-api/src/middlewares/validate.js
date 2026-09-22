function validate(schema, source = "body") {
  return (req, res, next) => {
    const data = source === "body" ? req.body : source === "query" ? req.query : req.params;
    const result = schema.safeParse(data);
    if (!result.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: result.error.flatten().fieldErrors,
      });
    }
    req[source] = result.data;
    req.validated = result.data;
    next();
  };
}

module.exports = { validate };
