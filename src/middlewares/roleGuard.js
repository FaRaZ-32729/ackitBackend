// src/middleware/roleGuard.js
const roleGuard = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: `Access denied. Required role: ${roles.join(" or ")}`
            });
        }
        next();
    };
};

module.exports = roleGuard;