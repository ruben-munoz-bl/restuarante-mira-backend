/** /v1/metricas — carga en directo de la API (solo admin, solo memoria). */
const { Router } = require("express");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { instantanea } = require("./metricas");

const router = Router();

router.get("/directo", verifyFirebaseAuth, authorize("admin"), (req, res) => {
  const segundos = Math.min(Math.max(Number(req.query.segundos) || 300, 30), 300);
  res.set("Cache-Control", "no-store").json(instantanea(segundos));
});

module.exports = router;
