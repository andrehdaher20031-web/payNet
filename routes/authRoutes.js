const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

router.post("/login", require('../middleware/loginRateLimit'), authController.login);

module.exports = router;
