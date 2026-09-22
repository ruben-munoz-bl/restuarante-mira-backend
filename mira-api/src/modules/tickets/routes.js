const { Router } = require("express");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const ticketService = require("./service");

const router = Router();

router.get("/", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const tickets = await ticketService.getTicketsByUser(req.user.uid);
    res.json({ data: tickets });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const ticket = await ticketService.getTicket(req.params.id, req.user.uid, req.user.role);
    res.json(ticket);
  } catch (err) {
    if (err.message.includes("no encontrado")) return res.status(404).json({ error: "NOT_FOUND" });
    if (err.message.includes("No autorizado")) return res.status(403).json({ error: "FORBIDDEN" });
    next(err);
  }
});

module.exports = router;
