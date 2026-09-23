const express = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { asyncHandler } = require("../../middlewares/errorHandler");
const { validate } = require("../../middlewares/validate");
const {
  listMyRestaurants,
  getMyRestaurant,
  getAdminDashboard,
  getOpsOverview,
  getReservasGlobales,
  updateRestaurant,
  eliminarRestaurante,
  enviarMensajeDueno,
  updateReservationStatus,
  addPointsManually,
  setRachaAdmin,
  ajustarRachaDias,
  unclaimLoginHoy,
} = require("./service");
const { getAllUsers } = require("../users/service");
const { subirTicket } = require("../reservations/service");
const restaurantService = require("../restaurants/service");

const router = express.Router();

router.get("/my-restaurants", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const lista = await listMyRestaurants(req.user.uid, req.user.email, req.query.currentId || null);
  res.json(lista);
}));

router.get("/my-restaurant", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const data = await getMyRestaurant(req.user.uid, req.query.id || req.query.restaurantId || null);
  res.json(data);
}));

router.get("/restaurant/:id", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const data = await getMyRestaurant(req.user.uid, req.params.id);
  res.json(data);
}));

router.get("/admin", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const data = await getAdminDashboard();
  res.json(data);
}));

router.get("/ops/overview", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const data = await getOpsOverview();
  res.json(data);
}));

router.get("/reservations", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const list = await getReservasGlobales({
    q: req.query.q || "",
    estado: req.query.estado || "",
    limite: parseInt(req.query.limite || "100", 10),
  });
  res.json(list);
}));

router.put("/restaurant/:id", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const result = await updateRestaurant(req.params.id, req.body);
  res.json(result);
}));

router.get("/restaurants", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const result = await restaurantService.listarRestaurantes({
    limit: req.query.limit !== undefined ? parseInt(req.query.limit, 10) : restaurantService.TAMANO_PAGINA,
    all: req.query.all === "1" || req.query.all === "true",
    cursor: req.query.cursor || null,
    q: req.query.q || null,
    ciudad: req.query.ciudad || null,
    cocina: req.query.cocina || null,
  });
  res.json(result);
}));

router.delete("/restaurant/:id", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const result = await eliminarRestaurante(req.params.id);
  res.json(result);
}));

router.post("/restaurant/:id/message", verifyFirebaseAuth, authorize("admin"), validate(z.object({
  asunto: z.string().min(1).max(160).optional(),
  mensaje: z.string().min(1).max(4000),
})), asyncHandler(async (req, res) => {
  const result = await enviarMensajeDueno(req.params.id, {
    asunto: req.validated.asunto,
    mensaje: req.validated.mensaje,
    adminUid: req.user.uid,
  });
  res.status(201).json(result);
}));

router.put("/reservations/:id/status", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const result = await updateReservationStatus(req.params.id, req.body.status, {
    precioBase: req.body.precioBase,
  });
  res.json(result);
}));

router.post("/reservations/:id/confirm-attendance", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const result = await updateReservationStatus(req.params.id, "completada", {
    precioBase: req.body.precioBase,
  });
  res.json(result);
}));

router.post("/reservations/:id/mark-no-show", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const result = await updateReservationStatus(req.params.id, "no_show", {});
  res.json(result);
}));

router.post("/reservations/:id/ticket", verifyFirebaseAuth, authorize("empresa", "admin"), asyncHandler(async (req, res) => {
  const result = await subirTicket(req.params.id, {
    uid: req.user.uid,
    totalPagado: req.body.totalPagado,
    asistio: req.body.asistio !== false,
    fileName: req.body.fileName || "",
    tipoDocumento: req.body.tipoDocumento || "Ticket TPV",
  });
  res.status(201).json(result);
}));

const addManualSchema = z.object({
  uid: z.string().min(1),
  cantidad: z.number().int().min(-100000).max(100000),
  motivo: z.string().max(200).optional(),
});

router.post("/points/add-manual", verifyFirebaseAuth, authorize("admin"), validate(addManualSchema), asyncHandler(async (req, res) => {
  const { uid, cantidad, motivo } = req.validated;
  const result = await addPointsManually(uid, cantidad, motivo);
  res.json({ ok: true, uid, cantidad, ...result });
}));

const rachaSetSchema = z.object({
  uid: z.string().min(1),
  dias: z.number().int().min(0).max(7),
});

router.post("/points/racha/set", verifyFirebaseAuth, authorize("admin"), validate(rachaSetSchema), asyncHandler(async (req, res) => {
  const { uid, dias } = req.validated;
  const balance = await setRachaAdmin(uid, dias);
  res.json({ ok: true, uid, rachaLogin: balance.rachaLogin, saldoActual: balance.saldoActual });
}));

const rachaDeltaSchema = z.object({
  uid: z.string().min(1),
  delta: z.number().int().min(-7).max(7).refine((n) => n !== 0, { message: "delta no puede ser 0" }),
});

router.post("/points/racha/delta", verifyFirebaseAuth, authorize("admin"), validate(rachaDeltaSchema), asyncHandler(async (req, res) => {
  const { uid, delta } = req.validated;
  const balance = await ajustarRachaDias(uid, delta);
  res.json({ ok: true, uid, delta, rachaLogin: balance.rachaLogin });
}));

router.post("/points/racha/unclaim-today", verifyFirebaseAuth, authorize("admin"), validate(z.object({ uid: z.string().min(1) })), asyncHandler(async (req, res) => {
  const { uid } = req.validated;
  const { balance, estabaReclamadoHoy } = await unclaimLoginHoy(uid);
  res.json({
    ok: true,
    uid,
    estabaReclamadoHoy,
    rachaLogin: balance.rachaLogin,
    aviso: "Si el frontend tenía caché de sesión, recarga la página del cliente.",
  });
}));

router.get("/users", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const users = await getAllUsers();
  res.json(users);
}));

module.exports = router;
