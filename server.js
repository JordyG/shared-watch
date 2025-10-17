// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

// ✅ Beveiliging met versoepelde Content-Security-Policy
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://www.youtube.com/iframe_api",
          "https://s.ytimg.com",
          "'unsafe-inline'", // tijdelijk nodig voor lokale scripts
        ],
        frameSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://www.youtube-nocookie.com",
        ],
        connectSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://s.ytimg.com",
          "wss://localhost:3000",
        ],
        imgSrc: ["'self'", "https://i.ytimg.com", "data:"],
      },
    },
  })
);

// ✅ Basisbeveiliging en limieten
app.use(cors());
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 })); // 120 requests/minuut per IP
app.use(express.static("public"));

// ---------------------- SOCKET.IO ----------------------
/**
 * Room state structuur:
 * {
 *   [roomId]: {
 *     videoId: "abc123",
 *     hostId: "socketId",
 *     playback: { isPlaying: false, currentTime: 0, updatedAt: 0, playbackRate: 1 }
 *   }
 * }
 */
const rooms = new Map();

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomId }) => {
    if (!roomId || typeof roomId !== "string" || roomId.length > 32) return;
    socket.join(roomId);
    currentRoom = roomId;

    // Room aanmaken als die niet bestaat
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        videoId: null,
        hostId: socket.id,
        playback: {
          isPlaying: false,
          currentTime: 0,
          updatedAt: Date.now(),
          playbackRate: 1,
        },
      });
    }

    const state = rooms.get(roomId);
    if (!state.hostId) state.hostId = socket.id;

    // Stuur state naar nieuwe client
    socket.emit("room-state", {
      videoId: state.videoId,
      hostId: state.hostId,
      playback: state.playback,
    });

    // Laat anderen weten dat iemand jointe
    socket.to(roomId).emit("peer-join", { id: socket.id });
  });

  socket.on("set-video", ({ roomId, videoId }) => {
    const state = rooms.get(roomId);
    if (!state || socket.id !== state.hostId) return;
    state.videoId = videoId;
    state.playback = {
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
      playbackRate: 1,
    };
    io.to(roomId).emit("room-state", {
      videoId: state.videoId,
      hostId: state.hostId,
      playback: state.playback,
    });
  });

  socket.on("control", ({ roomId, action, currentTime, playbackRate }) => {
    const state = rooms.get(roomId);
    if (!state || socket.id !== state.hostId) return;

    const now = Date.now();
    switch (action) {
      case "play":
        state.playback.isPlaying = true;
        state.playback.currentTime = currentTime ?? state.playback.currentTime;
        state.playback.updatedAt = now;
        break;
      case "pause":
        state.playback.isPlaying = false;
        state.playback.currentTime = currentTime ?? state.playback.currentTime;
        state.playback.updatedAt = now;
        break;
      case "seek":
        state.playback.currentTime = currentTime ?? 0;
        state.playback.updatedAt = now;
        break;
      case "rate":
        state.playback.playbackRate = playbackRate ?? 1;
        state.playback.updatedAt = now;
        break;
    }
    io.to(roomId).emit("sync", state.playback);
  });

  socket.on("request-host", ({ roomId }) => {
    const state = rooms.get(roomId);
    if (!state) return;
    const sockets = io.sockets.adapter.rooms.get(roomId) || new Set();
    if (!sockets.has(state.hostId)) {
      state.hostId = socket.id;
      io.to(roomId).emit("host-changed", { hostId: state.hostId });
    }
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    if (!state) return;

    if (socket.id === state.hostId) {
      const peers = Array.from(io.sockets.adapter.rooms.get(currentRoom) || []);
      state.hostId = peers.find((id) => id !== socket.id) || null;
      io.to(currentRoom).emit("host-changed", { hostId: state.hostId });
    }

    const left = io.sockets.adapter.rooms.get(currentRoom);
    if (!left || left.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

// ---------------------- SERVER START ----------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
