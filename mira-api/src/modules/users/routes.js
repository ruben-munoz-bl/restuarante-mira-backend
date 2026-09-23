const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const userService = require("./service");

const router = Router();

router.get("/me", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const me = await userService.getMe(req.user.uid);
    res.json(me || { uid: req.user.uid, tipo: req.user.role, email: req.user.email || "" });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  tipo: z.enum(["cliente", "empresa", "admin"]).optional(),
  nombre: z.string().optional(),
  email: z.string().optional(),
  soloVegano: z.boolean().optional(),
  alergias: z.array(z.string()).optional(),
  lang: z.string().optional(),
  consentimientoCookies: z.any().optional(),
  preferencias: z.any().optional(),
  accesibilidad: z.any().optional(),
  favoritos: z.array(z.string()).optional(),
});

router.put("/me", verifyFirebaseAuth, validate(updateSchema), async (req, res, next) => {
  try {
    const result = await userService.updateMe(req.user.uid, req.validated);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/me/is-admin", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const admin = await userService.esAdmin(req.user.uid);
    res.json({ isAdmin: admin });
  } catch (err) {
    next(err);
  }
});

router.get("/all", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
