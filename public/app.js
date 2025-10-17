// public/app.js

let socket;
let roomId = null;
let hostId = null;
let meId = null;

let player;
let ytReady = false;

// Voor zachte correctie en stabiele host-tijd
let rateResetTimer = null;
let lastKnownTime = 0;

// YouTube IFrame API dynamisch laden
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
};

// Hulpjes
function safeCurrentTime() {
  try { return player?.getCurrentTime() ?? 0; } catch { return 0; }
}

// Geeft een stabiele tijd terug zodat we niet per ongeluk 0 uitzenden
function stableTime() {
  const t = safeCurrentTime();
  if (t > 0.25) {
    lastKnownTime = t;
    return t;
  }
  // Als de player net play triggert kan t heel even 0 zijn. Val terug op de laatste betrouwbare tijd.
  return lastKnownTime > 0.25 ? lastKnownTime : t;
}

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

// Player aanmaken
function createPlayer(videoId) {
  if (!ytReady) return;
  if (player) { player.destroy(); }

  player = new YT.Player("player", {
    videoId,
    playerVars: {
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        lastKnownTime = 0;
      },
      onStateChange: (e) => {
        const isHost = meId === hostId;
        if (!isHost) return;

        // kleine delay helpt soms om een vers tijdstip te krijgen na play
        const send = (action) => {
          // gebruik stabiele tijd, geen 0 spurts
          const t = stableTime();
          emitControl(action, t);
        };

        if (e.data === YT.PlayerState.PLAYING) {
          // update lastKnownTime nog een keer net na start
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
        console.error("YT error", e.data);
        const msg = {
          2: "Ongeldige video parameters of URL",
          5: "Ongeldige spelerparameters",
          100: "Video niet gevonden of privé",
          101: "Uploader staat embedding niet toe",
          150: "Uploader staat embedding niet toe"
        }[e.data] || "Onbekende YouTube fout";
        alert("YouTube fout: " + msg);
      }
    }
  });
}

// Socket verbinding
function connectSocket() {
  socket = io();
  meId = socket.id;

  socket.on("connect", () => { meId = socket.id; });

  socket.on("room-state", ({ videoId, hostId: h, playback }) => {
    hostId = h;
    updateHostBadge();

    if (videoId) {
      if (!player) {
        createPlayer(videoId);
      } else {
        const currentUrl = player.getVideoUrl?.() || "";
        if (!currentUrl.includes(videoId)) {
          createPlayer(videoId);
        }
      }
      applySync(playback);
    }
  });

  socket.on("peer-join", () => {});

  socket.on("host-changed", ({ hostId: h }) => {
    hostId = h;
    updateHostBadge();
  });

  socket.on("sync", (playback) => {
    applySync(playback);
  });
}

function updateHostBadge() {
  const el = document.getElementById("hostBadge");
  if (!el) return;
  if (meId === hostId) {
    el.textContent = "Host";
    el.style.background = "#20304a";
  } else {
    el.textContent = "Gast";
    el.style.background = "#2b3142";
  }
}

// Zachte synchronisatie bij clients
function applySync(playback) {
  if (!player || !playback) return;

  // host negeert eigen sync
  if (meId === hostId) return;

  const rate = playback.playbackRate || 1;
  const now = Date.now();

  let expected = playback.currentTime;
  if (playback.isPlaying) {
    const dt = (now - playback.updatedAt) / 1000;
    expected += dt * rate;
  }

  const actual = safeCurrentTime();
  const diff = expected - actual;
  const abs = Math.abs(diff);

  // play/pause afstemmen
  const shouldPlay = playback.isPlaying;
  const state = player.getPlayerState?.();
  if (shouldPlay && state !== YT.PlayerState.PLAYING) {
    try { player.playVideo(); } catch {}
  } else if (!shouldPlay && state === YT.PlayerState.PLAYING) {
    try { player.pauseVideo(); } catch {}
  }

  // normaliseer rate
  try {
    if (player.getPlaybackRate && player.getPlaybackRate() !== rate) {
      player.setPlaybackRate(rate);
    }
  } catch {}

  if (rateResetTimer) { clearTimeout(rateResetTimer); rateResetTimer = null; }

  if (abs > 1.5) {
    // grote afwijking, eenmalige seek
    try { player.seekTo(expected, true); } catch {}
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  } else if (abs > 0.3 && shouldPlay) {
    // kleine afwijking, nudge
    const nudge = diff > 0 ? 1.1 : 0.9;
    try { player.setPlaybackRate(nudge); } catch {}
    rateResetTimer = setTimeout(() => {
      try { player.setPlaybackRate(rate); } catch {}
    }, 2000);
  } else {
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  }
}

// Control events uitsturen
function emitControl(action, time, playbackRate) {
  if (!roomId) return;
  socket.emit("control", {
    roomId,
    action,
    currentTime: typeof time === "number" ? time : undefined,
    playbackRate
  });
}

// DOM events
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
    // bij nieuw laden reset lastKnownTime
    lastKnownTime = 0;
    socket.emit("set-video", { roomId, videoId: id });
  };

  playBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.playVideo(); } catch {}
    // gebruik stabiele tijd, niet direct safeCurrentTime
    emitControl("play", stableTime());
  };

  pauseBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.pauseVideo(); } catch {}
    lastKnownTime = stableTime();
    emitControl("pause", lastKnownTime);
  };

  back10.onclick = () => {
    if (meId !== hostId) return;
    const t = Math.max(0, stableTime() - 10);
    lastKnownTime = t;
    try { player.seekTo(t, true); } catch {}
    emitControl("seek", t);
  };

  fwd10.onclick = () => {
    if (meId !== hostId) return;
    const t = stableTime() + 10;
    lastKnownTime = t;
    try { player.seekTo(t, true); } catch {}
    emitControl("seek", t);
  };

  rateSelect.onchange = () => {
    if (meId !== hostId) return;
    const rate = parseFloat(rateSelect.value);
    try { player.setPlaybackRate(rate); } catch {}
    emitControl("rate", stableTime(), rate);
  };
});
