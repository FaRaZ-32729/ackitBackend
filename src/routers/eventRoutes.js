const express = require("express");
const authenticate = require("../middlewares/auth");
const checkManagePermission = require("../middlewares/checkPermission");
const {
    createEvent,
    listEvents,
    setEventEnabled,
    deleteEvent,
    getCoveringEvents,
    ignoreEvent,
} = require("../controllers/eventController");

const router = express.Router();

router.post("/create", authenticate, checkManagePermission(), createEvent);
router.get("/list", authenticate, listEvents);
router.get("/covering", authenticate, getCoveringEvents);
router.post(
    "/:id/ignore",
    authenticate,
    checkManagePermission(),
    ignoreEvent
);
router.patch(
    "/:id/enabled",
    authenticate,
    checkManagePermission(),
    setEventEnabled
);
router.delete("/:id", authenticate, checkManagePermission(), deleteEvent);

module.exports = router;
