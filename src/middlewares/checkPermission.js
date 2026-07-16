// src/middleware/checkPermission.js

const checkManagePermission = () => {
    return async (req, res, next) => {
        try {
            const user = req.user;

            // Admins and Managers have full access
            if (user.role === "admin" || user.role === "manager") {
                return next();
            }

            // For normal users (sub-users)
            if (user.role === "user") {
                if (user.permission === "manage") {
                    return next();
                } else {
                    return res.status(403).json({
                        success: false,
                        message: "You don't have permission access this"
                    });
                }
            }

            // Fallback
            return res.status(403).json({
                success: false,
                message: "Access denied"
            });

        } catch (error) {
            console.error("Permission Check Error:", error);
            res.status(500).json({ success: false, message: "Server error" });
        }
    };
};

module.exports = checkManagePermission;