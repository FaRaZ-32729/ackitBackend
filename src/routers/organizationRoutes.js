const express = require("express");
const { createOrganization, getAllOrganizations, getOrganizationsByOwner, getOrganizationById, getUserOrganizations, deleteOrganization } = require("../controllers/organizationController");
const authenticate = require("../middlewares/auth");
const router = express.Router();


router.post("/create", authenticate, createOrganization);
router.get("/all", getAllOrganizations);
router.get("/owner/:ownerId", getOrganizationsByOwner);
router.get("/single/:id", getOrganizationById);
router.get("/my-organizations", authenticate, getUserOrganizations);
router.delete("/delete-org/:id", authenticate, deleteOrganization)


module.exports = router;