// src/controllers/authConroller.js
const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sendEmail = require("../services/emailServices");
const Subscription = require("../models/subscriptionModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const checkSubscriptionLimit = require("../middlewares/subscriptionLimit");
const { registerSchema, adminCreateUserSchema, createSubUserSchema } = require("../validations/userValidation");
require("dotenv").config();


// register Admin
const registerAdmin = async (req, res) => {
    try {
        let { name, email, password } = req.body;
        email = email.toLowerCase().trim();

        // Strong validation
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "Name, email and password are required" });
        }

        if (password.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters long" });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "User with this email already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const admin = await User.create({
            name,
            email,
            password: hashedPassword,
            role: "admin",
            createdBy: "self",
            isActive: true,
            isVerified: true   // Admin is auto-verified
        });

        res.status(201).json({
            success: true,
            message: "Admin registered successfully",
            admin: {
                id: admin._id,
                name: admin.name,
                email: admin.email,
                role: admin.role
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error while registering admin" });
    }
};

// Register Self (Normal User → becomes Manager)
const registerUser = async (req, res) => {
    let user = null;   // For rollback

    try {
        let { name, email, password } = registerSchema.parse(req.body);
        email = email.toLowerCase().trim();

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: "User already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user first
        user = await User.create({
            name,
            email,
            password: hashedPassword,
            role: "manager",
            createdBy: "self",
            isActive: false,
            isVerified: false
        });

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otp = otp;
        user.otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
        await user.save();

        // Check & Link Pending Subscription
        if (req.pendingSubscription) {
            user.currentSubscription = req.pendingSubscription._id;
            await user.save();

            // Update subscription with user ID
            await Subscription.findByIdAndUpdate(req.pendingSubscription._id, {
                user: user._id
            });

            console.log(`Pending subscription linked for ${email}`);
        }

        // Try to send OTP Email
        try {
            await sendEmail(
                user.email,
                "Verify Your AC-KIT Account",
                `
                <h2>Welcome to IotFiy AC-KIT!</h2>
                <p>Hi <strong>${name}</strong>,</p>
                <p>Your verification OTP is: <strong>${otp}</strong></p>
                <p>This OTP will expire in 10 minutes.</p>
                `
            );

            console.log(`OTP Email sent to ${user.email}`);

        } catch (emailError) {
            console.error("Email sending failed:", emailError.message);

            if (user) {
                await User.findByIdAndDelete(user._id);
                console.log(`🗑️ User rolled back: ${user.email}`);
            }

            return res.status(500).json({
                success: false,
                message: "Failed to send verification email. Please try registering again."
            });
        }

        // Success Response
        res.status(201).json({
            success: true,
            message: "Registration successful. Please verify OTP sent to your email.",
            userId: user._id,
            email: user.email
        });

    } catch (error) {
        console.error("Register User Error:", error);

        if (user) {
            await User.findByIdAndDelete(user._id);
            console.log(`🗑️ User rolled back due to error: ${user.email}`);
        }

        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                errors: error.issues.map(err => ({
                    field: err.path[0],
                    message: err.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: "Server error during registration"
        });
    }
};

// Admin Creates Manager (Setup Password Flow)
const createUserByAdmin = async (req, res) => {
    let user = null;   // For rollback

    try {
        let { name, email, role = "manager" } = adminCreateUserSchema.parse(req.body);
        email = email.toLowerCase().trim();
        const admin = req.user;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "User already exists" });
        }

        const setupToken = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "24h" });

        console.log(setupToken)

        // Create user
        user = await User.create({
            name,
            email,
            role,
            creatorId: admin._id,
            createdBy: "admin",
            setupToken,
            isActive: false,
            isVerified: false
        });

        if (req.pendingSubscription) {
            user.currentSubscription = req.pendingSubscription._id;
            await user.save();

            await Subscription.findByIdAndUpdate(req.pendingSubscription._id, {
                user: user._id
            });

            console.log(`Pending subscription linked for admin-created user: ${email}`);
        }

        const setupLink = `${process.env.FRONTEND_URL}/setup-password/${setupToken}`;

        // Send Email
        try {
            await sendEmail(
                user.email,
                "Set Your AC-KIT Account Password",
                `
                <h2>Account Created Successfully</h2>
                <p>Hello <strong>${name}</strong>,</p>
                <p>Your account has been created by the administrator.</p>
                <p>Please click the link below to set your password:</p>
                <a href="${setupLink}" 
                   style="background:#0055a5; color:white; padding:12px 24px; text-decoration:none; border-radius:6px;">
                   Set Password
                </a>
                <p>This link will expire in 24 hours.</p>
                `
            );
        } catch (emailError) {
            console.error("Email sending failed:", emailError.message);
            await User.findByIdAndDelete(user._id);
            return res.status(500).json({
                success: false,
                message: "Failed to send setup email."
            });
        }

        res.status(201).json({
            success: true,
            message: "User created successfully. Setup link sent to email.",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Create User By Admin Error:", error);

        if (user) {
            await User.findByIdAndDelete(user._id);
            console.log(`User rolled back: ${user.email}`);
        }

        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                errors: error.issues.map((err) => ({
                    field: err.path[0],
                    message: err.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: "Failed to create user. " + (error.message.includes("ETIMEDOUT")
                ? "Email service is not responding."
                : "Please try again.")
        });
    }
};

//Manager Creates Users
const createSubUser = async (req, res) => {
    let newUser = null;

    try {
        const validatedData = createSubUserSchema.parse(req.body);
        const manager = req.user;

        // Only managers can create sub-users
        if (manager.role !== "manager") {
            return res.status(403).json({ success: false, message: "Only managers can create sub-users" });
        }

        let email = validatedData.email.toLowerCase().trim();

        // Check subscription limit
        await checkSubscriptionLimit("user")(req, res, () => { });
        if (res.headersSent) return;

        // Check if email already exists
        const existingUser = await User.findOne({ email: email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "Email already exists" });
        }

        // Validate organizations belong to this manager
        const validOrgs = await Organization.find({
            _id: { $in: validatedData.organizations },
            owner: manager._id
        });

        if (validOrgs.length !== validatedData.organizations.length) {
            return res.status(403).json({
                success: false,
                message: "You can only assign organizations that you own"
            });
        }

        // Validate venues (if provided)
        let assignedVenues = [];
        if (validatedData.venues && validatedData.venues.length > 0) {
            const validVenues = await Venue.find({
                _id: { $in: validatedData.venues },
                organization: { $in: validatedData.organizations }
            });

            if (validVenues.length !== validatedData.venues.length) {
                return res.status(400).json({
                    success: false,
                    message: "One or more venues are invalid or not in selected organizations"
                });
            }

            assignedVenues = validVenues.map(v => ({
                venueId: v._id,
                venueName: v.name
            }));
        }

        // Create user
        newUser = await User.create({
            name: validatedData.name,
            email: email,
            role: "user",
            creatorId: manager._id,
            createdBy: "manager",
            organizations: validatedData.organizations,
            venues: assignedVenues,
            permission: validatedData.permission,
            isActive: false,
            isVerified: false
        });

        // Send setup email
        const setupToken = jwt.sign({ email: newUser.email }, process.env.JWT_SECRET, { expiresIn: "24h" });
        newUser.setupToken = setupToken;
        await newUser.save();

        const setupLink = `${process.env.FRONTEND_URL}/setup-password/${setupToken}`;

        await sendEmail(
            newUser.email,
            "Your Account Has Been Created",
            `
            <h2>Account Created</h2>
            <p>Hello ${newUser.name},</p>
            <p>Your account has been created by ${manager.name}.</p>
            <a href="${setupLink}">Set Your Password</a>
            `
        );

        res.status(201).json({
            success: true,
            message: "Sub-user created successfully. Setup link sent.",
            user: {
                id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                role: newUser.role,
                permission: newUser.permission
            }
        });

    } catch (error) {
        if (newUser) await User.findByIdAndDelete(newUser._id);

        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                errors: error.issues.map(err => ({
                    field: err.path[0],
                    message: err.message
                }))
            });
        }

        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// set password for admin created users 
const setPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        if (!token || !password) {
            return res.status(400).json({
                success: false,
                message: "Token and password are required"
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long"
            });
        }

        // Verify the setup token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired setup link"
            });
        }

        // Find user with this setup token
        const user = await User.findOne({
            email: decoded.email,
            setupToken: token
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired setup link"
            });
        }

        // Hash and save password
        const hashedPassword = await bcrypt.hash(password, 10);

        user.password = hashedPassword;
        user.setupToken = null;           // Clear setup token after use

        // Generate OTP for next step (verification)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otp = otp;
        user.otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

        await user.save();

        // Send OTP Email
        await sendEmail(
            user.email,
            "Verify Your AC-KIT Account",
            `
            <h2>Password Set Successfully!</h2>
            <p>Your account password has been set.</p>
            <p>Your verification OTP is: <strong>${otp}</strong></p>
            <p>This OTP will expire in 10 minutes.</p>
            `
        );

        res.status(200).json({
            success: true,
            message: "Password set successfully. Please verify OTP sent to your email.",
            email: user.email
        });

    } catch (error) {
        console.error("Set Password Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// Verify OTP
const verifyOTP = async (req, res) => {
    try {
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({
                success: false,
                message: "OTP is required"
            });
        }

        const user = await User.findOne({ otp: otp });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: "Invalid OTP"
            });
        }

        if (user.otpExpiry < Date.now()) {
            return res.status(400).json({
                success: false,
                message: "OTP has expired"
            });
        }

        // Verify and Activate User
        user.isVerified = true;
        user.isActive = true
        user.otp = null;
        user.otpExpiry = null;

        await user.save();

        res.status(200).json({
            success: true,
            message: "Account verified successfully. You can now login.",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Verify OTP Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// Resend OTP (for users who didn't verify in time)
const resendOTP = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required"
            });
        }

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        if (user.isVerified) {
            return res.status(400).json({
                success: false,
                message: "Account is already verified"
            });
        }

        // Generate new OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otp = otp;
        user.otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

        await user.save();

        // Send new OTP Email
        await sendEmail(
            user.email,
            "Your New Verification OTP - AC-KIT",
            `
            <h2>New Verification OTP</h2>
            <p>Hello ${user.name},</p>
            <p>Your new OTP is: <strong>${otp}</strong></p>
            <p>This OTP will expire in 10 minutes.</p>
            <p>If you didn't request this, please ignore this email.</p>
            `
        );

        console.log(`✅ New OTP sent to ${user.email}`);

        res.status(200).json({
            success: true,
            message: "New OTP has been sent to your email",
            email: user.email
        });

    } catch (error) {
        console.error("Resend OTP Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while resending OTP"
        });
    }
};

// Login
const loginUser = async (req, res) => {
    try {
        let { email, password } = req.body;
        email = email.toLowerCase().trim();

        const user = await User.findOne({ email });

        if (!user) {
            console.log("user not fount ", email)
            return res.status(404).json({ message: "Invalid credentials" })
        };

        if (!user.isVerified) return res.status(403).json({ message: "Please verify your email first" });
        if (!user.isActive) return res.status(403).json({ message: "Account is not active" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

        const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

        user.lastLogin = new Date();
        await user.save();

        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            message: "Login successful",
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive,
                permission: user.permission || null
            }
        });
    } catch (error) {
        res.status(500).json({ message: "Server error ...", });
        console.log(error.message)
    }
};

// logout user 
const logoutUser = async (req, res) => {
    try {
        res.clearCookie("token", { httpOnly: true, sameSite: "none", path: "/", secure: true });
        res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (error) {
        console.error("Error in logout:", error);
        res.status(500).json({ success: false, message: "Logout failed" });
    }
};

// ==================== FORGOT PASSWORD ====================
const forgotPassword = async (req, res) => {
    try {
        let { email } = req.body;
        email = email.toLowerCase().trim();

        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Generate reset token
        const resetToken = jwt.sign(
            { email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "15m" }
        );

        user.resetToken = resetToken;
        user.resetTokenExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes
        await user.save();

        const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

        await sendEmail(
            user.email,
            "Reset Your AC-KIT Account Password",
            `
            <h2>Password Reset Request</h2>
            <p>Hello ${user.name},</p>
            <p>You requested to reset your password. Click the link below:</p>
            <a href="${resetLink}" style="background:#0055a5; color:white; padding:12px 24px; text-decoration:none; border-radius:6px;">
                Reset Password
            </a>
            <p>This link will expire in 15 minutes.</p>
            <p>If you didn't request this, please ignore this email.</p>
            `
        );

        res.status(200).json({
            success: true,
            message: "Password reset link sent to your email"
        });

    } catch (error) {
        console.error("Forgot Password Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==================== RESET PASSWORD ====================
const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ success: false, message: "Token and password are required" });
        }

        if (password.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
        }

        // Verify token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(400).json({ success: false, message: "Invalid or expired reset link" });
        }

        const user = await User.findOne({
            email: decoded.email,
            resetToken: token,
            resetTokenExpiry: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: "Invalid or expired reset link" });
        }

        // Update password
        user.password = await bcrypt.hash(password, 10);
        user.resetToken = null;
        user.resetTokenExpiry = null;

        await user.save();

        res.status(200).json({
            success: true,
            message: "Password reset successfully. You can now login with new password."
        });

    } catch (error) {
        console.error("Reset Password Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// verified user after login
const me = async (req, res) => {
    try {
        const user = req.user;

        // Populate venues with venue details + organization info
        const populatedUser = await user.populate({
            path: 'venues.venueId',
            select: 'name organization',
            populate: {
                path: 'organization',
                select: 'name _id'   // Get organization name and id
            }
        });

        const safeUser = {
            id: populatedUser._id,
            name: populatedUser.name,
            email: populatedUser.email,
            role: populatedUser.role,
            permission: populatedUser.permission,
            isActive: populatedUser.isActive,
            isVerified: populatedUser.isVerified,
            createdBy: populatedUser.createdBy,
            lastLogin: populatedUser.lastLogin,

            // Organizations (array of IDs)
            organizations: populatedUser.organizations,

            // Venues with full info + organization
            venues: populatedUser.venues.map(v => ({
                venueId: v.venueId?._id,
                venueName: v.venueName || v.venueId?.name,
                organization: v.venueId?.organization ? {
                    id: v.venueId.organization._id,
                    name: v.venueId.organization.name
                } : null
            })),

            // Subscription info
            currentSubscription: populatedUser.currentSubscription
        };

        return res.status(200).json({
            success: true,
            user: safeUser
        });

    } catch (error) {
        console.error("Error While Verifying User:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};


module.exports = {
    registerUser,
    createUserByAdmin,
    setPassword,
    registerAdmin,
    verifyOTP,
    resendOTP,
    loginUser,
    logoutUser,
    createSubUser,
    forgotPassword,
    resetPassword,
    me
};