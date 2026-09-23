const { Router } = require("express");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const mensajeService = require("./service");

const router = Router();

router.get("/", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const list = await mensajeService.listarMensajes(req.user.uid);
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get("/unread-count", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const n = await mensajeService.contarNoLeidos(req.user.uid);
    res.json({ count: n });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/read", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const result = await mensajeService.marcarLeido(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
