// Allow authenticated admin / manager / user — no view/manage permission gate
const checkManagePermission = () => {
    return async (req, res, next) => {
        try {
            const user = req.user;

            if (
                user?.role === "admin" ||
                user?.role === "manager" ||
                user?.role === "user"
            ) {
                return next();
            }

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
