// public/app.js

let socket;
let roomId = null;
let hostId = null;
let meId = null;
let myName = null;

let player;
let ytReady = false;

// kloksync
let clock = { offsetMs: 0, rttMs: 9999, samples: [], maxSamples: 10 };
function getServerNowMs() { return Date.now() + clock.offsetMs; }

// correctie
let rateResetTimer = null;
let lastSeekAtMs = 0;
let localActionBlockUntilMs = 0;
let lastSnapshotKey = "";
let lastKnownTime = 0;

// YT API
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();
window.onYouTubeIframeAPIReady = function () { ytReady = true; };

// helpers
function safeCurrentTime() { try { return player?.getCurrentTime() ?? 0; } catch { return 0; } }
function stableTime() { const t = safeCurrentTime(); if (t > 0.25) { lastKnownTime = t; return t; } return lastKnownTime > 0.25 ? lastKnownTime : t; }
function parseYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v"); if (v) return v;
      const parts = u.pathname.split("/"); const idx = parts.findIndex(p => p === "shorts" || p === "embed");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {}
  const idLike = url.trim(); return /^[a-zA-Z0-9_-]{11}$/.test(idLike) ? idLike : null;
}

function createPlayer(videoId) {
  if (!ytReady) return;
  if (player) { try { player.destroy(); } catch {} }
  player = new YT.Player("player", {
    videoId,
    playerVars: { modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin },
    events: {
      onReady: () => { lastKnownTime = 0; },
      onStateChange: (e) => {
        const isHost = meId === hostId;
        if (!isHost) return;
        const armBlock = () => { localActionBlockUntilMs = Date.now() + 500; };
        const send = (action) => { const t = stableTime(); armBlock(); emitControl(action, t); };
        if (e.data === YT.PlayerState.PLAYING) { setTimeout(() => { lastKnownTime = stableTime(); send("play"); }, 50); }
        else if (e.data === YT.PlayerState.PAUSED) { lastKnownTime = stableTime(); send("pause"); }
      },
      onError: (e) => {
        const map = {2:"Ongeldige video of URL",5:"Ongeldige spelerparams",100:"Video niet gevonden of privé",101:"Embedding uit",150:"Embedding uit"};
        alert("YouTube fout: " + (map[e.data] || "Onbekend")); console.error("YT error", e.data);
      }
    }
  });
}

// socket
function connectSocket() {
  socket = io(); meId = socket.id;
  socket.on("connect", () => { meId = socket.id; startClockSync(); });
  socket.on("time:pong", ({ serverNow, clientSentAt }) => {
    const clientNow = Date.now();
    const rtt = clientNow - clientSentAt;
    const offset = serverNow - (clientSentAt + rtt / 2);
    clock.samples.push({ rtt, offset });
    if (clock.samples.length > clock.maxSamples) clock.samples.shift();
    const best = clock.samples.reduce((a,b) => a.rtt < b.rtt ? a : b);
    clock.offsetMs = (clock.offsetMs * 0.7) + (best.offset * 0.3);
    clock.rttMs = (clock.rttMs * 0.7) + (best.rtt * 0.3);
  });

  socket.on("room-state", ({ videoId, hostId: h, playback }) => {
    hostId = h; updateHostBadge();
    if (videoId) {
      const currentUrl = player?.getVideoUrl?.() || "";
      if (!player || !currentUrl.includes(videoId)) createPlayer(videoId);
      applySync(playback);
    }
  });

  socket.on("host-changed", ({ hostId: h }) => { hostId = h; updateHostBadge(); });

  socket.on("sync", playback => { applySync(playback); });

  // chat
  socket.on("chat:message", msg => addChatMessage(msg));
  socket.on("room-users", users => renderUsers(users));
}

function startClockSync() {
  for (let i = 0; i < 3; i++) setTimeout(() => socket.emit("time:ping", Date.now()), 100 * i);
  setInterval(() => socket.emit("time:ping", Date.now()), 5000);
}

function updateHostBadge() {
  const el = document.getElementById("hostBadge");
  if (!el) return;
  if (meId === hostId) { el.textContent = "Host"; el.style.background = "#20304a"; }
  else { el.textContent = "Gast"; el.style.background = "#2b3142"; }
}

// sync
function applySync(playback) {
  if (!player || !playback) return;
  if (meId === hostId) return;
  if (Date.now() < localActionBlockUntilMs) return;

  const key = `${playback.isPlaying}|${playback.currentTime.toFixed(3)}|${playback.updatedAt}|${playback.playbackRate}`;
  if (key === lastSnapshotKey) return;
  lastSnapshotKey = key;

  const rate = playback.playbackRate || 1;
  const serverNow = getServerNowMs();
  let expected = playback.currentTime;
  if (playback.isPlaying) {
    const dt = Math.max(0, (serverNow - playback.updatedAt) / 1000);
    expected += dt * rate;
  }

  const state = player.getPlayerState?.();
  const shouldPlay = playback.isPlaying;
  if (shouldPlay && state !== YT.PlayerState.PLAYING) { try { player.playVideo(); } catch {} }
  else if (!shouldPlay && state === YT.PlayerState.PLAYING) { try { player.pauseVideo(); } catch {} }

  try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}

  const actual = safeCurrentTime();
  const diff = expected - actual;
  const abs = Math.abs(diff);
  const nowMs = Date.now();
  const seekCooldownMs = 4000;

  if (abs > 1.75 && (nowMs - lastSeekAtMs) > seekCooldownMs) {
    try { player.seekTo(expected, true); } catch {}
    lastSeekAtMs = nowMs;
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
    return;
  }

  if (abs > 0.25 && shouldPlay) {
    const nudge = diff > 0 ? 1.02 : 0.98;
    try { player.setPlaybackRate(nudge); } catch {}
    if (rateResetTimer) clearTimeout(rateResetTimer);
    rateResetTimer = setTimeout(() => {
      try { player.setPlaybackRate(rate); } catch {}
    }, 1500);
  } else {
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  }
}

// emit controls
function emitControl(action, time, playbackRate) {
  if (!roomId) return;
  socket.emit("control", { roomId, action, currentTime: typeof time === "number" ? time : undefined, playbackRate });
}

// chat ui
function addChatMessage({ id, name, text, ts, type }) {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const line = document.createElement("div");
  if (type === "system") {
    line.className = "chat-system";
    line.textContent = text;
  } else {
    line.className = "chat-line";
    const bubble = document.createElement("div");
    bubble.className = "chat-msg";
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const when = new Date(ts || Date.now()).toLocaleTimeString();
    meta.textContent = `${name || "Onbekend"} • ${when}`;
    const body = document.createElement("div");
    body.textContent = text;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    line.appendChild(bubble);
  }
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function renderUsers(users) {
  const ul = document.getElementById("userList");
  if (!ul) return;
  ul.innerHTML = "";
  users.forEach(u => {
    const li = document.createElement("li");
    li.textContent = u.name || "Onbekend";
    ul.appendChild(li);
  });
}

// DOM
document.addEventListener("DOMContentLoaded", () => {
  connectSocket();

  const nameInput = document.getElementById("nameInput");
  const roomInput = document.getElementById("roomInput");
  const joinBtn = document.getElementById("joinBtn");
  const roomStatus = document.getElementById("roomStatus");

  const urlInput = document.getElementById("urlInput");
  const loadBtn = document.getElementById("loadBtn");

  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const back10 = document.getElementById("back10");
  const fwd10 = document.getElementById("fwd10");
  const rateSelect = document.getElementById("rateSelect");

  const chatMessage = document.getElementById("chatMessage");
  const chatSend = document.getElementById("chatSend");

  // naam onthouden
  const savedName = localStorage.getItem("sw_name");
  if (savedName) nameInput.value = savedName;

  joinBtn.onclick = () => {
    const nm = nameInput.value.trim();
    const id = roomInput.value.trim();
    if (!nm) { alert("Vul eerst je naam in"); return; }
    if (!id) { alert("Vul een room code in"); return; }
    myName = nm; roomId = id;
    localStorage.setItem("sw_name", myName);
    socket.emit("join-room", { roomId: id, name: myName });
    if (roomStatus) roomStatus.textContent = `Verbonden met room: ${id}`;
  };

  loadBtn.onclick = () => {
    if (meId !== hostId) { alert("Alleen de host kan de video wisselen"); return; }
    const id = parseYouTubeId(urlInput.value);
    if (!id) { alert("Ongeldige YouTube link of videoId"); return; }
    if (!player) createPlayer(id);
    lastKnownTime = 0;
    localActionBlockUntilMs = Date.now() + 500;
    socket.emit("set-video", { roomId, videoId: id });
  };

  playBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.playVideo(); } catch {}
    localActionBlockUntilMs = Date.now() + 500;
    emitControl("play", stableTime());
  };

  pauseBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.pauseVideo(); } catch {}
    lastKnownTime = stableTime();
    localActionBlockUntilMs = Date.now() + 500;
    emitControl("pause", lastKnownTime);
  };

  back10.onclick = () => {
    if (meId !== hostId) return;
    const t = Math.max(0, stableTime() - 10);
    lastKnownTime = t;
    try { player.seekTo(t, true); } catch {}
    localActionBlockUntilMs = Date.now() + 500;
    emitControl("seek", t);
  };

  fwd10.onclick = () => {
    if (meId !== hostId) return;
    const t = stableTime() + 10;
    lastKnownTime = t;
    try { player.seekTo(t, true); } catch {}
    localActionBlockUntilMs = Date.now() + 500;
    emitControl("seek", t);
  };

  rateSelect.onchange = () => {
    if (meId !== hostId) return;
    const rate = parseFloat(rateSelect.value);
    try { player.setPlaybackRate(rate); } catch {}
    localActionBlockUntilMs = Date.now() + 500;
    emitControl("rate", stableTime(), rate);
  };

  // chat
  chatSend.onclick = () => {
    const txt = chatMessage.value.trim();
    if (!txt) return;
    socket.emit("chat:send", { roomId, text: txt });
    chatMessage.value = "";
  };
  chatMessage.addEventListener("keydown", e => {
    if (e.key === "Enter") { chatSend.click(); }
  });
});
