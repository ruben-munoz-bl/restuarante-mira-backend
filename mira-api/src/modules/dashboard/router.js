const express = require("express");
const { verifyFirebaseAuth, authorize, db } = require("../../middlewares/verifyFirebaseAuth");
const { asyncHandler } = require("../../middlewares/errorHandler");
const {
  getRestaurantDashboard,
  getAdminDashboard,
  updateRestaurant,
  updateReservationStatus,
  addPointsManually,
  getAllUsers,
} = require("./service");

const router = express.Router();

async function attachRestaurantId(req, res, next) {
  try {
    if (req.user && (req.user.role === "restaurante" || req.user.role === "admin")) {
      const userDoc = await db.collection("usuarios").doc(req.user.uid).get();
      if (userDoc.exists) {
        req.user.restaurantId = userDoc.data().restaurantId || req.user.uid;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.get("/my-restaurant", verifyFirebaseAuth, attachRestaurantId, asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.uid;
  const data = await getRestaurantDashboard(restaurantId);
  res.json(data);
}));

router.get("/restaurant/:id", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const data = await getRestaurantDashboard(req.params.id);
  res.json(data);
}));

router.get("/admin", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const data = await getAdminDashboard();
  res.json(data);
}));

router.put("/restaurant/:id", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const result = await updateRestaurant(req.params.id, req.body);
  res.json(result);
}));

router.put("/reservations/:id/status", verifyFirebaseAuth, authorize("admin", "restaurante"), asyncHandler(async (req, res) => {
  const { status } = req.body;
  const result = await updateReservationStatus(req.params.id, status, {
    uid: req.user.uid,
    precioBase: req.body.precioBase,
    ticketData: req.body.ticketData,
  });
  res.json(result);
}));

router.post("/reservations/:id/confirm-attendance", verifyFirebaseAuth, authorize("admin", "restaurante"), asyncHandler(async (req, res) => {
  const result = await updateReservationStatus(req.params.id, "completada", {
    uid: req.user.uid,
    precioBase: req.body.precioBase,
  });
  res.json(result);
}));

router.post("/reservations/:id/mark-no-show", verifyFirebaseAuth, authorize("admin", "restaurante"), asyncHandler(async (req, res) => {
  const result = await updateReservationStatus(req.params.id, "no_show", { uid: req.user.uid });
  res.json(result);
}));

router.post("/points/add-manual", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const { uid, cantidad, motivo } = req.body;
  const result = await addPointsManually(uid, cantidad, motivo, req.user.uid);
  res.json(result);
}));

router.get("/users", verifyFirebaseAuth, authorize("admin"), asyncHandler(async (req, res) => {
  const users = await getAllUsers();
  res.json(users);
}));

module.exports = router;
