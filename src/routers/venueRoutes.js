const express = require("express");
const authenticate = require("../middlewares/auth");
const { createVenue, getAllVenues, getSingleVenue, getVenuesByOrganization, updateVenue, deleteVenue } = require("../controllers/venueController");
const checkManagePermission = require("../middlewares/checkPermission");
const router = express.Router();

router.post("/create", authenticate, checkManagePermission(), createVenue);
router.get("/all",  getAllVenues);
router.get("/single/:id", getSingleVenue);
router.get("/get-by-org/:organizationId", getVenuesByOrganization);
router.put("/update/:id", authenticate, updateVenue);
router.delete("/delete-venue/:id", authenticate, deleteVenue)
module.exports = router;