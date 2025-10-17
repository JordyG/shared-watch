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
  cors: { origin: true, methods: ["GET", "POST"] }
});

/**
 * Content Security Policy
 * Laat YouTube en Socket.IO toe. 'unsafe-inline' staat aan voor lokaal gemak.
 * Voor productie kun je dit later vervangen door een nonce.
 */
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
          "'unsafe-inline'"
        ],
        frameSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://www.youtube-nocookie.com"
        ],
        connectSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://s.ytimg.com",
          "wss:",
          "https:"
        ],
        imgSrc: ["'self'", "data:", "https://i.ytimg.com"]
      }
    }
  })
);

app.use(cors());
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use(express.static("public"));

/**
 * Room state
 * rooms: Map<roomId, {
 *   videoId: string|null,
 *   hostId: string|null,
 *   playback: {
 *     isPlaying: boolean,
 *     currentTime: number,
 *     updatedAt: number,     // server timestamp ms
 *     playbackRate: number
 *   }
 * }>
 */
const rooms = new Map();

io.on("connection", socket => {
  let currentRoom = null;

  // Tijd sync voor clients
  socket.on("time:ping", clientSentAt => {
    socket.emit("time:pong", { serverNow: Date.now(), clientSentAt });
  });

  socket.on("join-room", ({ roomId }) => {
    if (!roomId || typeof roomId !== "string" || roomId.length > 64) return;

    socket.join(roomId);
    currentRoom = roomId;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        videoId: null,
        hostId: socket.id,
        playback: {
          isPlaying: false,
          currentTime: 0,
          updatedAt: Date.now(),
          playbackRate: 1
        }
      });
    }

    const state = rooms.get(roomId);
    if (!state.hostId) state.hostId = socket.id;

    // Stuur actuele room state naar nieuwe client
    socket.emit("room-state", {
      videoId: state.videoId,
      hostId: state.hostId,
      playback: state.playback
    });

    // Meld join aan andere peers
    socket.to(roomId).emit("peer-join", { id: socket.id });
  });

  // Alleen host mag video wisselen
  socket.on("set-video", ({ roomId, videoId }) => {
    const state = rooms.get(roomId);
    if (!state || socket.id !== state.hostId) return;

    state.videoId = videoId || null;
    state.playback = {
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
      playbackRate: 1
    };

    io.to(roomId).emit("room-state", {
      videoId: state.videoId,
      hostId: state.hostId,
      playback: state.playback
    });
  });

  /**
   * Host controls
   * Acties: play, pause, seek, rate
   * Server schrijft server authoritative timestamps
   */
  socket.on("control", ({ roomId, action, currentTime, playbackRate }) => {
    const state = rooms.get(roomId);
    if (!state || socket.id !== state.hostId) return;

    const now = Date.now();
    switch (action) {
      case "play":
        state.playback.isPlaying = true;
        if (typeof currentTime === "number") state.playback.currentTime = currentTime;
        state.playback.updatedAt = now;
        break;
      case "pause":
        state.playback.isPlaying = false;
        if (typeof currentTime === "number") state.playback.currentTime = currentTime;
        state.playback.updatedAt = now;
        break;
      case "seek":
        if (typeof currentTime === "number") state.playback.currentTime = currentTime;
        state.playback.updatedAt = now;
        break;
      case "rate":
        state.playback.playbackRate = typeof playbackRate === "number" ? playbackRate : 1;
        state.playback.updatedAt = now;
        break;
      default:
        return;
    }

    io.to(roomId).emit("sync", state.playback);
  });

  // Host wisselen als oude host weg is
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

    // Als host weg is, kies nieuwe host
    if (socket.id === state.hostId) {
      const peers = Array.from(io.sockets.adapter.rooms.get(currentRoom) || []);
      state.hostId = peers.find(id => id !== socket.id) || null;
      io.to(currentRoom).emit("host-changed", { hostId: state.hostId });
    }

    // Ruim lege rooms op
    const leftSet = io.sockets.adapter.rooms.get(currentRoom);
    if (!leftSet || leftSet.size === 0) rooms.delete(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
