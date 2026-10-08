/**
 * /v1/jams — reserva en grupo. Ver la sala es público (con el código basta,
 * como un enlace de JAM); unirse, votar y cerrar requieren sesión.
 * GET /:codigo/stream envía la sala en directo (Server-Sent Events) desde memoria.
 */
const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const restaurantsService = require("../restaurants/service");
const svc = require("./service");
const { vistaPublica } = require("./logica");

const router = Router();

const nombre = z.string().trim().min(1).max(40).optional();
const crearSchema = z.object({
  titulo: z.string().max(80).optional(),
  nombre,
  restaurantes: z.array(z.object({ id: z.string().min(1).max(120) })).min(1).max(4),
  franjas: z.array(z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hora: z.string().regex(/^\d{2}:\d{2}$/) })).min(1).max(4),
  cierraEnMin: z.coerce.number().int().min(5).max(7 * 24 * 60),
});
const votarSchema = z.object({
  restaurantes: z.array(z.string().max(120)).max(4).default([]),
  franjas: z.array(z.coerce.number().int().min(0).max(3)).max(4).default([]),
});

function usuarioDe(req) {
  const porEmail = req.user.email ? req.user.email.split("@")[0] : "";
  return { uid: req.user.uid, email: req.user.email || "", nombre: (req.body?.nombre || porEmail || "Invitado").slice(0, 40) };
}

function responder(res, next, err) {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || "ERROR", message: err.message });
  return next(err);
}

router.post("/", verifyFirebaseAuth, rateLimit(60 * 60000, 10), validate(crearSchema), async (req, res, next) => {
  try {
    const jam = await svc.crear(usuarioDe(req), req.validated, { obtenerRestaurante: restaurantsService.obtenerRestaurante });
    res.status(201).json(vistaPublica(jam, req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

router.get("/mias", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const lista = await svc.mias(req.user.uid);
    res.json({ items: lista.map((j) => vistaPublica(j, req.user.uid)) });
  } catch (err) {
    next(err);
  }
});

router.get("/:codigo", optionalAuth, async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.obtener(req.params.codigo), req.user?.uid || null));
  } catch (err) {
    responder(res, next, err);
  }
});

router.get("/:codigo/stream", async (req, res, next) => {
  let jam;
  try {
    jam = await svc.obtener(req.params.codigo);
  } catch (err) {
    return responder(res, next, err);
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const enviar = (j) => res.write(`event: sala\ndata: ${JSON.stringify(vistaPublica(j))}\n\n`);
  enviar(jam);
  const quitar = svc.suscribir(jam.codigo, enviar);
  // Comentario cada 25 s: mantiene viva la conexión a través de proxies (Render corta conexiones inactivas).
  const latido = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(latido); quitar(); });
});

router.post("/:codigo/unirse", verifyFirebaseAuth, rateLimit(60000, 20), validate(z.object({ nombre }).default({})), async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.unirse(req.params.codigo, usuarioDe(req)), req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

router.put("/:codigo/voto", verifyFirebaseAuth, rateLimit(60000, 60), validate(votarSchema), async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.votar(req.params.codigo, req.user.uid, req.validated), req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

router.post("/:codigo/salir", verifyFirebaseAuth, async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.salir(req.params.codigo, req.user.uid), req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

router.post("/:codigo/cerrar", verifyFirebaseAuth, async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.cerrar(req.params.codigo, req.user.uid), req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

router.post("/:codigo/cancelar", verifyFirebaseAuth, async (req, res, next) => {
  try {
    res.json(vistaPublica(await svc.cancelar(req.params.codigo, req.user.uid), req.user.uid));
  } catch (err) {
    responder(res, next, err);
  }
});

module.exports = router;
