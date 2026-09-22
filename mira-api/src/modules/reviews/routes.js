const { Router } = require("express");
const { verifyFirebaseAuth, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const reviewService = require("./service");

const router = Router();

router.get("/:restauranteId", async (req, res, next) => {
  try {
    const reviews = await reviewService.getReviewsByRestaurant(req.params.restauranteId);
    res.json({ data: reviews });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
