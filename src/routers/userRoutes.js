// src/modules/authRoutes.js
const express = require("express");
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const { suspendManager, getAllUsers, getAllManagers, getUsersByManager, getSingleUser, deleteUser, deleteManager, updateManagerCreatedUser, requestEmailChange, verifyEmailChange } = require("../controllers/userController");
const router = express.Router();

router.put("/suspend/:managerId",
    authenticate,
    roleGuard(["admin"]),
    suspendManager
);

// this api is used to add or remove organization , venues , and update permission
router.put(
    "/update-user/:userId",
    authenticate,
    updateManagerCreatedUser
);

router.post("/request-email-change", authenticate, requestEmailChange);
router.post("/verify-email-change", authenticate, verifyEmailChange);

router.get("/all", authenticate, getAllUsers);
router.get("/single/:userId", authenticate, getSingleUser);
router.get("/managers", authenticate, getAllManagers);
router.get("/manager/:managerId", authenticate, getUsersByManager);

router.delete("/delete-user/:id", authenticate, deleteUser);
router.delete("/delete-manager/:id", authenticate, roleGuard(["admin"]), deleteManager);


module.exports = router;