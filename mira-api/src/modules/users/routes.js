const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const userService = require("./service");

const { documentoId, alergias, preferencias, accesibilidad, consentimientoCookies } = require("../../middlewares/inputSchemas");
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
  // "admin" nunca se acepta desde el cliente: cualquiera podría nombrarse administrador.
  tipo: z.enum(["cliente", "empresa"]).optional(),
  nombre: z.string().trim().min(1).max(200).optional(),
  email: z.union([z.string().email().max(254), z.literal("")]).optional(),
  soloVegano: z.boolean().optional(),
  alergias: alergias.optional(),
  lang: z.enum(["es", "ca", "en"]).optional(),
  consentimientoCookies: consentimientoCookies.nullable().optional(),
  preferencias: preferencias.nullable().optional(),
  accesibilidad: accesibilidad.nullable().optional(),
  favoritos: z.array(documentoId).max(500).optional(),
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
