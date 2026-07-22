const express = require("express");
const authenticate = require("../middlewares/auth");
const checkManagePermission = require("../middlewares/checkPermission");
const {
    createDevice,
    getDeviceBrandOptions,
    getDevicesByVenue,
    updateDevice,
    deleteDevice,
} = require("../controllers/deviceController");

const router = express.Router();

router.get("/brand-options", authenticate, getDeviceBrandOptions);
router.get("/by-venue/:venueId", authenticate, getDevicesByVenue);
router.post(
    "/create",
    authenticate,
    checkManagePermission(),
    createDevice
);
router.put(
    "/update/:id",
    authenticate,
    checkManagePermission(),
    updateDevice
);
router.delete(
    "/delete/:id",
    authenticate,
    checkManagePermission(),
    deleteDevice
);

module.exports = router;
