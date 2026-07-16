const express = require("express");
const { getAllPlans, getPlanById, createSubscriptionPlan } = require("../controllers/subscriptionPlanController");
const { purchaseSubscription, getMySubscription, getSubscriptionUsage } = require("../controllers/SubscriptionController");
const authenticate = require("../middlewares/auth");
const router = express.Router();

// Public - View Plans
router.get("/get-all-plans", getAllPlans);
router.get("/get-plan/:id", getPlanById);

// Protected
router.post("/purchase", authenticate, purchaseSubscription);
router.get("/my-subscription", getMySubscription);

router.get("/usage", authenticate, getSubscriptionUsage);
router.post("/create-plan", authenticate, createSubscriptionPlan);

module.exports = router;