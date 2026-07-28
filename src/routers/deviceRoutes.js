const express = require("express");
const authenticate = require("../middlewares/auth");
const checkManagePermission = require("../middlewares/checkPermission");
const {
    createDevice,
    getDeviceBrandOptions,
    getDeviceById,
    getDevicesByVenue,
    updateDevice,
    deleteDevice,
    setDevicePower,
    setDeviceTemperature,
    setDeviceRemote,
    setDeviceMode,
    setDeviceFan,
} = require("../controllers/deviceController");
const { getDeviceEnergy } = require("../controllers/energyController");

const router = express.Router();

router.get("/brand-options", authenticate, getDeviceBrandOptions);
router.get("/energy", authenticate, getDeviceEnergy);
router.get("/by-venue/:venueId", authenticate, getDevicesByVenue);
router.get("/:id", authenticate, getDeviceById);
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
router.post(
    "/mode/:id",
    authenticate,
    checkManagePermission(),
    setDeviceMode
);
router.post(
    "/fan/:id",
    authenticate,
    checkManagePermission(),
    setDeviceFan
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
