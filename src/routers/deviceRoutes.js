const express = require("express");
const authenticate = require("../middlewares/auth");
const checkManagePermission = require("../middlewares/checkPermission");
const {
    createDevice,
    getDeviceBrandOptions,
    getDevicesByVenue,
    updateDevice,
    deleteDevice,
    setDevicePower,
    setDeviceTemperature,
    setDeviceRemote,
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
router.post(
    "/power/:id",
    authenticate,
    checkManagePermission(),
    setDevicePower
);
router.post(
    "/temperature/:id",
    authenticate,
    checkManagePermission(),
    setDeviceTemperature
);
router.put(
    "/remote/:id",
    authenticate,
    checkManagePermission(),
    setDeviceRemote
);
router.delete(
    "/delete/:id",
    authenticate,
    checkManagePermission(),
    deleteDevice
);

module.exports = router;
