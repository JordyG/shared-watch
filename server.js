// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET", "POST"] } });

// CSP zodat YouTube en Socket.IO werken
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://www.youtube.com", "https://www.youtube.com/iframe_api", "https://s.ytimg.com", "'unsafe-inline'"],
        frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
        connectSrc: ["'self'", "https:", "wss:"],
        imgSrc: ["'self'", "data:", "https://i.ytimg.com"]
      }
    }
  })
);

app.use(cors());
app.use(rateLimit({ windowMs: 60 * 1000, max: 200 }));
app.use(express.static("public"));

/**
 * Room state
 * rooms: Map<roomId, {
 *   videoId: string|null,
 *   hostId: string|null,
 *   playback: { isPlaying: boolean, currentTime: number, updatedAt: number, playbackRate: number },
 *   users: Map<socketId, { id: string, name: string }>
 * }>
 */
const rooms = new Map();

io.on("connection", socket => {
  let currentRoom = null;

  // tijdsync voor latency compensatie
  socket.on("time:ping", clientSentAt => {
    socket.emit("time:pong", { serverNow: Date.now(), clientSentAt });
  });

  // join met naam verplicht
  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId || typeof roomId !== "string" || roomId.length > 64) return;
    const displayName = String(name || "").trim().slice(0, 32) || "Gast";

    socket.join(roomId);
    currentRoom = roomId;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        videoId: null,
        hostId: socket.id,
        playback: { isPlaying: false, currentTime: 0, updatedAt: Date.now(), playbackRate: 1 },
        users: new Map()
      });
    }

    const state = rooms.get(roomId);
    if (!state.hostId) state.hostId = socket.id;
    state.users.set(socket.id, { id: socket.id, name: displayName });

    // room state naar nieuwe client
    socket.emit("room-state", {
      videoId: state.videoId,
      hostId: state.hostId,
      playback: state.playback
    });

    // deelnemerslijst naar iedereen
    io.to(roomId).emit("room-users", Array.from(state.users.values()));

    // systeemchat
    io.to(roomId).emit("chat:message", {
      id: "system",
      name: "Systeem",
      text: `${displayName} heeft de room betreden`,
      ts: Date.now(),
      type: "system"
    });
  });

  // host zet video
  socket.on("set-video", ({ roomId, videoId }) => {
    const state = rooms.get(roomId);
    if (!state || socket.id !== state.hostId) return;
    state.videoId = videoId || null;
    state.playback = { isPlaying: false, currentTime: 0, updatedAt: Date.now(), playbackRate: 1 };

    io.to(roomId).emit("room-state", { videoId: state.videoId, hostId: state.hostId, playback: state.playback });
  });

  // server-authoritative controls
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

  // chatbericht
  socket.on("chat:send", ({ roomId, text }) => {
    const state = rooms.get(roomId);
    if (!state) return;
    const user = state.users.get(socket.id) || { name: "Onbekend" };
    const clean = String(text || "").slice(0, 500);
    if (!clean) return;
    io.to(roomId).emit("chat:message", { id: socket.id, name: user.name, text: clean, ts: Date.now(), type: "user" });
  });

  // host wisselen als huidige host weg is
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

    // naam voor systeemchat
    const departed = state.users.get(socket.id)?.name || "Deelnemer";
    state.users.delete(socket.id);
    io.to(currentRoom).emit("room-users", Array.from(state.users.values()));
    io.to(currentRoom).emit("chat:message", {
      id: "system",
      name: "Systeem",
      text: `${departed} heeft de room verlaten`,
      ts: Date.now(),
      type: "system"
    });

    if (socket.id === state.hostId) {
      const peers = Array.from(io.sockets.adapter.rooms.get(currentRoom) || []);
      state.hostId = peers.find(id => id !== socket.id) || null;
      io.to(currentRoom).emit("host-changed", { hostId: state.hostId });
    }

    const left = io.sockets.adapter.rooms.get(currentRoom);
    if (!left || left.size === 0) rooms.delete(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
