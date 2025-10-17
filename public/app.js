// public/app.js — server-authoritative sync met klok-offset en latencycompensatie

let socket;
let roomId = null;
let hostId = null;
let meId = null;

let player;
let ytReady = false;

// Kloksync
let clock = {
  offsetMs: 0,         // serverNow ≈ Date.now() + offsetMs
  rttMs: 9999,
  samples: [],
  maxSamples: 10
};

function getServerNowMs() {
  return Date.now() + clock.offsetMs;
}

// Seeks en nudges debouncen
let rateResetTimer = null;
let lastSeekAtMs = 0;
let localActionBlockUntilMs = 0; // tijdens/na local user action even geen sync toepassen
let lastSnapshotKey = "";        // voorkomt dubbel verwerken identieke snapshots
let lastKnownTime = 0;           // stabiele hosttijd tegen 0-spurts

// YouTube IFrame API dynamisch laden
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
};

// Helpers
function safeCurrentTime() {
  try { return player?.getCurrentTime() ?? 0; } catch { return 0; }
}
function stableTime() {
  const t = safeCurrentTime();
  if (t > 0.25) { lastKnownTime = t; return t; }
  return lastKnownTime > 0.25 ? lastKnownTime : t;
}

// Parse YouTube
function parseYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/");
      const idx = parts.findIndex(p => p === "shorts" || p === "embed");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {}
  const idLike = url.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(idLike) ? idLike : null;
}

// Player
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

        // blokkeer binnenkomende sync even na lokale actie
        const armBlock = () => { localActionBlockUntilMs = Date.now() + 500; };

        // stuur alleen acties met stabiele tijd op SERVER basis
        const send = (action) => {
          const t = stableTime(); // stabiele player tijd (geen 0-spike)
          armBlock();
          emitControl(action, t);
        };

        if (e.data === YT.PlayerState.PLAYING) {
          setTimeout(() => {
            lastKnownTime = stableTime();
            send("play");
          }, 50);
        } else if (e.data === YT.PlayerState.PAUSED) {
          lastKnownTime = stableTime();
          send("pause");
        }
      },
      onError: (e) => {
        const map = {2:"Ongeldige video URL/params",5:"Ongeldige spelerparams",100:"Video niet gevonden/privé",101:"Embedding geblokkeerd",150:"Embedding geblokkeerd"};
        alert("YouTube fout: " + (map[e.data] || "Onbekend"));
        console.error("YT error", e.data);
      }
    }
  });
}

// Socket
function connectSocket() {
  socket = io();
  meId = socket.id;

  socket.on("connect", () => { meId = socket.id; startClockSync(); });

  socket.on("time:pong", ({ serverNow, clientSentAt }) => {
    // NTP-achtige offset schatting
    const clientNow = Date.now();
    const rtt = clientNow - clientSentAt;
    const offset = serverNow - (clientSentAt + rtt / 2);

    // Houd beste sample bij (laagste rtt) en update EWMA
    clock.samples.push({ rtt, offset });
    if (clock.samples.length > clock.maxSamples) clock.samples.shift();

    const best = clock.samples.reduce((a,b) => a.rtt < b.rtt ? a : b);
    // Eenvoudige EWMA richting beste offset
    clock.offsetMs = (clock.offsetMs * 0.7) + (best.offset * 0.3);
    clock.rttMs = (clock.rttMs * 0.7) + (best.rtt * 0.3);
  });

  socket.on("room-state", ({ videoId, hostId: h, playback }) => {
    hostId = h;
    updateHostBadge();

    if (videoId) {
      const currentUrl = player?.getVideoUrl?.() || "";
      if (!player || !currentUrl.includes(videoId)) createPlayer(videoId);
      applySync(playback);
    }
  });

  socket.on("host-changed", ({ hostId: h }) => { hostId = h; updateHostBadge(); });

  socket.on("sync", (playback) => { applySync(playback); });
}

// Start periodieke kloksync
function startClockSync() {
  // direct een paar snelle pings
  for (let i = 0; i < 3; i++) {
    setTimeout(() => socket.emit("time:ping", Date.now()), 100 * i);
  }
  // daarna elke 5 s
  setInterval(() => { socket.emit("time:ping", Date.now()); }, 5000);
}

// UI badge
function updateHostBadge() {
  const el = document.getElementById("hostBadge");
  if (!el) return;
  if (meId === hostId) { el.textContent = "Host"; el.style.background = "#20304a"; }
  else { el.textContent = "Gast"; el.style.background = "#2b3142"; }
}

// Server-authoritative sync op clients
function applySync(playback) {
  if (!player || !playback) return;

  // Host negeert eigen broadcast
  if (meId === hostId) return;

  // Debounce binnenkomende sync vlak na eigen actie
  if (Date.now() < localActionBlockUntilMs) return;

  // Skip duplicaten
  const key = `${playback.isPlaying}|${playback.currentTime.toFixed(3)}|${playback.updatedAt}|${playback.playbackRate}`;
  if (key === lastSnapshotKey) return;
  lastSnapshotKey = key;

  const rate = playback.playbackRate || 1;
  const serverNow = getServerNowMs();
  let expected = playback.currentTime;

  // Gebruik server-tijd, niet lokale Date.now()
  if (playback.isPlaying) {
    const dt = Math.max(0, (serverNow - playback.updatedAt) / 1000);
    expected += dt * rate;
  }

  // Zet play/pause conform host
  const state = player.getPlayerState?.();
  const shouldPlay = playback.isPlaying;
  if (shouldPlay && state !== YT.PlayerState.PLAYING) { try { player.playVideo(); } catch {} }
  else if (!shouldPlay && state === YT.PlayerState.PLAYING) { try { player.pauseVideo(); } catch {} }

  // Normaliseer rate eerst
  try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}

  const actual = safeCurrentTime();
  const diff = expected - actual; // positief betekent dat wij achterlopen
  const abs = Math.abs(diff);

  // Harde seek alleen bij echt grote afwijking en met cooldown
  const nowMs = Date.now();
  const seekCooldownMs = 4000;

  if (abs > 1.75 && (nowMs - lastSeekAtMs) > seekCooldownMs) {
    try { player.seekTo(expected, true); } catch {}
    lastSeekAtMs = nowMs;
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
    return;
  }

  // Zachte correctie bij kleine drift
  if (abs > 0.25 && shouldPlay) {
    const nudge = diff > 0 ? 1.02 : 0.98; // heel licht versnellen/vertragen
    try { player.setPlaybackRate(nudge); } catch {}
    if (rateResetTimer) clearTimeout(rateResetTimer);
    rateResetTimer = setTimeout(() => {
      try { player.setPlaybackRate(rate); } catch {}
    }, 1500);
  } else {
    // In sync
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  }
}

// Events uitsturen (host only)
function emitControl(action, time, playbackRate) {
  if (!roomId) return;
  socket.emit("control", {
    roomId,
    action,
    currentTime: typeof time === "number" ? time : undefined,
    playbackRate
  });
}

// DOM
document.addEventListener("DOMContentLoaded", () => {
  connectSocket();

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

  joinBtn.onclick = () => {
    const id = roomInput.value.trim();
    if (!id) { alert("Vul een room code in"); return; }
    roomId = id;
    socket.emit("join-room", { roomId: id });
    if (roomStatus) roomStatus.textContent = `Verbonden met room: ${id}`;
  };

  loadBtn.onclick = () => {
    if (meId !== hostId) { alert("Alleen de host kan de video wisselen"); return; }
    const id = parseYouTubeId(urlInput.value);
    if (!id) { alert("Ongeldige YouTube link of videoId"); return; }
    if (!player) createPlayer(id);
    lastKnownTime = 0;
    // blok sync kort tegen echo
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
});
