// src/modules/authRoutes.js
const express = require("express");
const { registerUser, loginUser, verifyOTP, setPassword, createUserByAdmin, registerAdmin, logoutUser, createSubUser, forgotPassword, resetPassword, me, resendOTP } = require("../controllers/authController");
const authenticate = require("../middlewares/auth");
const checkPendingSubscription = require("../middlewares/checkPendingSubscription");
const roleGuard = require("../middlewares/roleGuard");
const router = express.Router();

// Routes
router.post("/register-admin", registerAdmin);
router.post("/register", checkPendingSubscription, registerUser);
router.post("/register-user", authenticate, roleGuard(["manager"]), createSubUser);
router.post("/login", loginUser);
router.post("/verify-otp", verifyOTP);
router.post("/verify-otp/:token", verifyOTP);
router.post("/resend-otp", resendOTP);
router.post("/set-password/:token", setPassword);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);
router.get('/me', authenticate, me);
router.delete("/logout", logoutUser);

// Protected Routes (Only Admin)
router.post("/admin/register", authenticate, roleGuard(["admin"]), checkPendingSubscription, createUserByAdmin);

module.exports = router;