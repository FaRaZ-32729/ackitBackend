const express = require("express");
const authenticate = require("../middlewares/auth");
const checkManagePermission = require("../middlewares/checkPermission");
const {
    createDevice,
    getDeviceBrandOptions,
} = require("../controllers/deviceController");

const router = express.Router();

router.get("/brand-options", authenticate, getDeviceBrandOptions);
router.post(
    "/create",
    authenticate,
    checkManagePermission(),
    createDevice
);

module.exports = router;
