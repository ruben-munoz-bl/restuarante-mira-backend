const { Router } = require("express");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const adminService = require("./service");

const router = Router();

router.get("/revenue", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const result = await adminService.getRevenue({ from: req.query.from, to: req.query.to });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/fraud-flags", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const flags = await adminService.getFraudFlags();
    res.json({ data: flags });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
