let socket;
let roomId = null;
let hostId = null;
let meId = null;

let player;
let ytReady = false;

// Wacht tot YouTube IFrame API klaar is
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  // Player pas maken als er een videoId is
};

function createPlayer(videoId) {
  if (!ytReady) return;
  if (player) { player.destroy(); }

  player = new YT.Player('player', {
    videoId,
    playerVars: { modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin },
    events: {
      onReady: () => {
        // Periodieke driftcheck
        setInterval(driftCheck, 2500);
      },
      onStateChange: (e) => {
        const isHost = meId === hostId;
        const t = safeCurrentTime();
        if (!isHost) return;

        if (e.data === YT.PlayerState.PLAYING) {
          emitControl("play", t);
        } else if (e.data === YT.PlayerState.PAUSED) {
          emitControl("pause", t);
        } else if (e.data === YT.PlayerState.BUFFERING) {
          // geen actie
        }
      }
    }
  });
}

function safeCurrentTime() {
  try { return player?.getCurrentTime() ?? 0; } catch { return 0; }
}

function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      // Shorts of embed
      const parts = u.pathname.split("/");
      const idx = parts.findIndex(p => p === "shorts" || p === "embed");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // misschien direct een videoId
  }
  // Fallback: als het lijkt op een videoId
  const idLike = url.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(idLike) ? idLike : null;
}

function connectSocket() {
  socket = io();
  meId = socket.id;

  socket.on("connect", () => { meId = socket.id; });

  socket.on("room-state", ({ videoId, hostId: h, playback }) => {
    hostId = h;
    updateHostBadge();

    if (videoId) {
      if (!player) createPlayer(videoId);
      else {
        // Als de video anders is, wissel
        const currentUrl = player.getVideoUrl?.() || "";
        if (!currentUrl.includes(videoId)) {
          createPlayer(videoId);
        }
      }
      // Pas sync toe bij join
      applySync(playback);
    }
  });

  socket.on("peer-join", () => { /* optioneel UI update */ });

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
  if (meId === hostId) {
    el.textContent = "Host";
    el.style.background = "#20304a";
  } else {
    el.textContent = "Gast";
    el.style.background = "#2b3142";
  }
}

function applySync(playback) {
  if (!player || !playback) return;

  const now = Date.now();
  let expected = playback.currentTime;
  if (playback.isPlaying) {
    const dt = (now - playback.updatedAt) / 1000;
    expected += dt * (playback.playbackRate || 1);
  }

  const actual = safeCurrentTime();
  const diff = Math.abs(actual - expected);

  // Stel snelheid in
  const rate = playback.playbackRate || 1;
  try { if (player.getPlaybackRate() !== rate) player.setPlaybackRate(rate); } catch {}

  // Play/pause status
  const state = player.getPlayerState?.();
  const shouldPlay = playback.isPlaying;

  if (diff > 2.0) {
  // Alleen kleine correctie als iemand echt uit sync is
  player.seekTo(expected, true);
}

  if (shouldPlay && state !== YT.PlayerState.PLAYING) {
    player.playVideo();
  } else if (!shouldPlay && state === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  }
}

function emitControl(action, time, playbackRate) {
  if (!roomId) return;
  socket.emit("control", {
    roomId,
    action,
    currentTime: typeof time === "number" ? time : undefined,
    playbackRate
  });
}

// UI handlers
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
    roomStatus.textContent = `Verbonden met room: ${id}`;
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
    player.playVideo();
    emitControl("play", safeCurrentTime());
  };

  pauseBtn.onclick = () => {
    if (meId !== hostId) return;
    player.pauseVideo();
    emitControl("pause", safeCurrentTime());
  };

  back10.onclick = () => {
    if (meId !== hostId) return;
    const t = Math.max(0, safeCurrentTime() - 10);
    player.seekTo(t, true);
    emitControl("seek", t);
  };

  fwd10.onclick = () => {
    if (meId !== hostId) return;
    const t = safeCurrentTime() + 10;
    player.seekTo(t, true);
    emitControl("seek", t);
  };

  rateSelect.onchange = () => {
    if (meId !== hostId) return;
    const rate = parseFloat(rateSelect.value);
    player.setPlaybackRate(rate);
    emitControl("rate", safeCurrentTime(), rate);
  };
});

// Periodieke driftcheck vanuit client
function driftCheck() {
  if (!player) return;

  // Alleen de host bepaalt de timing
  if (meId !== hostId) return;

  const isPlaying = player.getPlayerState?.() === YT.PlayerState.PLAYING;
  const currentTime = safeCurrentTime();

  // Verstuur alleen statusupdate (geen seek) als er iets is veranderd
  socket.emit("control", {
    roomId,
    action: isPlaying ? "play" : "pause",
    currentTime,
    playbackRate: player.getPlaybackRate?.() || 1,
  });
}

