// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

const authenticate = async (req, res, next) => {
    try {
        let token;

        // Check Authorization header first
        if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        } 
        // Check cookie
        else if (req.cookies?.token) {
            token = req.cookies.token;
        }

        if (!token) {
            return res.status(401).json({ success: false, message: "Access denied. No token provided." });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded._id).select("-password");

        if (!user) {
            return res.status(401).json({ success: false, message: "User not found" });
        }

        // if (!user.isActive) {
        //     return res.status(403).json({ success: false, message: "Account is not active" });
        // }

        req.user = user;
        next();
    } catch (error) {
        console.error("Auth Error:", error);
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
};

module.exports = authenticate;