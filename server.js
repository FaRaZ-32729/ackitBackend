const express = require("express");
const dotenv = require("dotenv");
const dbConnection = require("./src/config/dbConnection");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { connectMqtt } = require("./src/mqtt/mqttConfig");

// Routers
const centeralRoutes = require("./src/routers/centeralRoutes");

// Utilities
dotenv.config();
dbConnection();
connectMqtt();


const port = process.env.PORT || 5054;
const app = express();
const server = http.createServer(app);

// Middlewares
const allowedOrigins = [
    "https://ackit.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // allow mobile/postman
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true
}));

// Initialize Socket.io
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:3000", "https://iotfiy-ackit.vercel.app", "https://ackit.vercel.app"],
        methods: ["GET", "POST"],
        credentials: true
    }
});


app.use(express.json());
app.use(cookieParser());



// Routes
app.use("/api", centeralRoutes);

global.io = io;

io.on("connection", (socket) => {
    socket.on("brand:join", (configureId) => {
        if (!configureId || typeof configureId !== "string") return;
        const room = `brand:${configureId.trim()}`;
        socket.join(room);
        socket.emit("brand:joined", { configureId: configureId.trim(), room });
    });

    socket.on("brand:leave", (configureId) => {
        if (!configureId || typeof configureId !== "string") return;
        socket.leave(`brand:${configureId.trim()}`);
    });
});

// Start server
server.listen(port, () => {
    console.log(`Express & WebSocket is running on port : ${port}`);
});
