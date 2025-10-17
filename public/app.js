// public/app.js

let socket;
let roomId = null;
let hostId = null;
let meId = null;

let player;
let ytReady = false;

// Voor zachte correctie
let rateResetTimer = null;

// Laad de YouTube IFrame API dynamisch
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();

// Deze callback moet global zijn voor de YT API
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
};

// Helper om huidige tijd veilig te lezen
function safeCurrentTime() {
  try { return player?.getCurrentTime() ?? 0; } catch { return 0; }
}

// Parse een YouTube link of direct videoId
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
  } catch { /* mogelijk direct een id */ }
  const idLike = url.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(idLike) ? idLike : null;
}

// Player aanmaken of vervangen
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
        // Geen periodieke forced sync meer
      },
      onStateChange: (e) => {
        const isHost = meId === hostId;
        if (!isHost) return;

        const t = safeCurrentTime();

        // Host stuurt alleen bij echte interacties
        if (e.data === YT.PlayerState.PLAYING) {
          emitControl("play", t);
        } else if (e.data === YT.PlayerState.PAUSED) {
          emitControl("pause", t);
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

// Socket verbinden
function connectSocket() {
  socket = io(); // relative, werkt lokaal en op Render
  meId = socket.id;

  socket.on("connect", () => { meId = socket.id; });

  socket.on("room-state", ({ videoId, hostId: h, playback }) => {
    hostId = h;
    updateHostBadge();

    if (videoId) {
      // Maak of vervang player indien andere video
      if (!player) {
        createPlayer(videoId);
      } else {
        const currentUrl = player.getVideoUrl?.() || "";
        if (!currentUrl.includes(videoId)) {
          createPlayer(videoId);
        }
      }
      // Pas sync toe op client, host negeert
      applySync(playback);
    }
  });

  socket.on("peer-join", () => { /* optioneel UI update */ });

  socket.on("host-changed", ({ hostId: h }) => {
    hostId = h;
    updateHostBadge();
  });

  socket.on("sync", (playback) => {
    // Host past geen sync toe op zichzelf
    applySync(playback);
  });
}

// UI helpers
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

// Zachte synchronisatie op clients
function applySync(playback) {
  if (!player || !playback) return;

  // Host corrigeert zichzelf niet om feedback loops te vermijden
  if (meId === hostId) return;

  const rate = playback.playbackRate || 1;
  const now = Date.now();

  let expected = playback.currentTime;
  if (playback.isPlaying) {
    const dt = (now - playback.updatedAt) / 1000;
    expected += dt * rate;
  }

  const actual = safeCurrentTime();
  const diff = expected - actual; // positief betekent dat wij achterlopen
  const abs = Math.abs(diff);

  // Play/pause status afstemmen
  const shouldPlay = playback.isPlaying;
  const state = player.getPlayerState?.();
  if (shouldPlay && state !== YT.PlayerState.PLAYING) {
    try { player.playVideo(); } catch {}
  } else if (!shouldPlay && state === YT.PlayerState.PLAYING) {
    try { player.pauseVideo(); } catch {}
  }

  // Snelheid normaliseren voor we corrigeren
  try {
    if (player.getPlaybackRate && player.getPlaybackRate() !== rate) {
      player.setPlaybackRate(rate);
    }
  } catch {}

  // Reset vorige nudge timer
  if (rateResetTimer) { clearTimeout(rateResetTimer); rateResetTimer = null; }

  // Correctiebeleid
  if (abs > 1.5) {
    // Grote afwijking. Eenmalige seek
    try { player.seekTo(expected, true); } catch {}
    // Zorg terug naar normale rate
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  } else if (abs > 0.3 && shouldPlay) {
    // Kleine afwijking. Tijdelijke nudge met licht andere snelheid
    const nudge = diff > 0 ? 1.1 : 0.9; // achter? iets sneller. voor? iets langzamer
    try { player.setPlaybackRate(nudge); } catch {}
    rateResetTimer = setTimeout(() => {
      try { player.setPlaybackRate(rate); } catch {}
    }, 2000);
  } else {
    // In sync
    try { if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate); } catch {}
  }
}

// Controle events uitsturen
function emitControl(action, time, playbackRate) {
  if (!roomId) return;
  socket.emit("control", {
    roomId,
    action,
    currentTime: typeof time === "number" ? time : undefined,
    playbackRate
  });
}

// DOM en event handlers
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
    socket.emit("set-video", { roomId, videoId: id });
  };

  playBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.playVideo(); } catch {}
    emitControl("play", safeCurrentTime());
  };

  pauseBtn.onclick = () => {
    if (meId !== hostId) return;
    try { player.pauseVideo(); } catch {}
    emitControl("pause", safeCurrentTime());
  };

  back10.onclick = () => {
    if (meId !== hostId) return;
    const t = Math.max(0, safeCurrentTime() - 10);
    try { player.seekTo(t, true); } catch {}
    emitControl("seek", t);
  };

  fwd10.onclick = () => {
    if (meId !== hostId) return;
    const t = safeCurrentTime() + 10;
    try { player.seekTo(t, true); } catch {}
    emitControl("seek", t);
  };

  rateSelect.onchange = () => {
    if (meId !== hostId) return;
    const rate = parseFloat(rateSelect.value);
    try { player.setPlaybackRate(rate); } catch {}
    emitControl("rate", safeCurrentTime(), rate);
  };
});
