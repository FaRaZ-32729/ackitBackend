const express = require("express");
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const {
    createConfigureId,
    selectCommand,
    clearCommand,
    getConfigureSession,
    saveBrand,
    applyCommand,
    getAllBrands,
    deleteBrand,
} = require("../controllers/brandController");

const router = express.Router();

router.use(authenticate, roleGuard(["admin"]));

router.post("/configure", createConfigureId);
router.post("/select-command", selectCommand);
router.post("/clear-command", clearCommand);
router.get("/session/:configureId", getConfigureSession);
router.post("/save", saveBrand);
router.post("/apply", applyCommand);
router.get("/all", getAllBrands);
router.delete("/:id", deleteBrand);

module.exports = router;
