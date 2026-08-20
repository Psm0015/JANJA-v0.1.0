const params = new URLSearchParams(window.location.search);
const isViewer = window.location.pathname.includes("watch") || params.get("mode") === "watch";

const statusEl = document.querySelector("#status");
const titleEl = document.querySelector("#title");
const stageEl = isViewer ? document.querySelector("#viewer-stage") : document.querySelector("#stage");
const videoEl = isViewer ? document.querySelector("#video-viewer") : document.querySelector("#video-host");
const emptyEl = document.querySelector("#empty");
const emptyTitleEl = document.querySelector("#empty-title");
const emptyCopyEl = document.querySelector("#empty-copy");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const fullscreenButton = isViewer ? document.querySelector("#btn-fullscreen-viewer") : document.querySelector("#fullscreen");
const audioModeControl = document.querySelector("#audio-mode-control");
const audioModeSelect = document.querySelector("#audio-mode");
const audioDeviceControl = document.querySelector("#audio-device-control");
const audioDeviceSelect = document.querySelector("#audio-device");
const refreshAudioButton = document.querySelector("#refresh-audio");
const volumeControl = document.querySelector("#volume-control");
const volumeInput = document.querySelector("#volume");
const volumeValue = document.querySelector("#volume-value");
const switchLink = document.querySelector("#switch-link");
const viewerCountEl = document.querySelector("#viewer-count");
const modeEl = document.querySelector("#mode");
const sharePanel = document.querySelector("#share-panel");
const tunnelStatusEl = document.querySelector("#tunnel-status");
const watchLinkInput = document.querySelector("#watch-link");
const copyLinkButton = document.querySelector("#copy-link");
const appMixer = document.querySelector("#app-mixer");
const mixerStatus = document.querySelector("#mixer-status");
const appList = document.querySelector("#app-list");
const refreshAppsButton = document.querySelector("#refresh-apps");
const audioPanel = document.querySelector("#audio-panel");
const audioPanelLabel = document.querySelector("#audio-panel-label");
const audioPanelStatus = document.querySelector("#audio-panel-status");
const filteredAudioPlayer = document.querySelector("#filtered-audio-player");

const peers = new Map();
let socket;
let localStream;
let isSwitchingSource = false;
let viewerSessionId = sessionStorage.getItem("lule_session_id");
if (!viewerSessionId) {
    viewerSessionId = Array.from(crypto.getRandomValues(new Uint32Array(4))).map(b => b.toString(16).padStart(8, '0')).join('');
    sessionStorage.setItem("lule_session_id", viewerSessionId);
}
let heartbeatInterval;
let lastHeartbeatAck = Date.now();
let viewerId;
let viewerPeer;
let viewerCount = 0;
let reconnectTimer;
let manuallyStopped = false;
let tunnelTimer;
let appTimer;
let latestAudioApps = [];
const excludedProcessIds = new Set();
let filteredAudioSocket;
let filteredAudioContext;
let filteredAudioWorkletNode;
let filteredAudioDestination;
let filteredAudioSilentSink;
let remoteAudioSocket;
let remoteAudioContext;
let remoteAudioWorkletNode;
let remoteAudioGain;
let remoteAudioSelectionTimer;
let remoteAudioSelectionKey = "";
let audioCapabilities;

const CaptureState = {
  IDLE: 'IDLE',
  REQUESTING_CAPTURE: 'REQUESTING_CAPTURE',
  CAPTURE_ACTIVE: 'CAPTURE_ACTIVE',
  STREAMING: 'STREAMING',
  ERROR: 'ERROR'
};
let currentCaptureState = CaptureState.IDLE;

const AudioSource = {
  NONE: 'NONE',
  BROWSER_DISPLAY_AUDIO: 'BROWSER_DISPLAY_AUDIO',
  WASAPI_LOOPBACK: 'WASAPI_LOOPBACK'
};
let activeAudioSource = AudioSource.NONE;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setStatus(text) {
  statusEl.textContent = text;
}

function socketIsOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function updateHostCaptureState(newState) {
  currentCaptureState = newState;
  const btnSwitch = document.getElementById("switch-source");
  if (btnSwitch) {
      btnSwitch.style.display = newState === CaptureState.STREAMING ? "block" : "none";
  }
  if (newState === CaptureState.IDLE) {
    setStatus("Desconectado");
    activeAudioSource = AudioSource.NONE;
  } else if (newState === CaptureState.REQUESTING_CAPTURE) {
    setStatus("Solicitando captura");
  } else if (newState === CaptureState.STREAMING) {
    setStatus("Transmitindo");
  } else if (newState === CaptureState.ERROR) {
    // Error status set in startShare
  }
}

function refreshHostStatus() {
  if (isViewer) return;
  if (currentCaptureState === CaptureState.ERROR || currentCaptureState === CaptureState.REQUESTING_CAPTURE) {
    return; // Handled by state machine
  }
  if (localStream && socketIsOpen()) {
    updateHostCaptureState(CaptureState.STREAMING);
  } else if (localStream) {
    setStatus("Reconectando");
  } else if (socketIsOpen()) {
    setStatus("Conectado");
  } else {
    updateHostCaptureState(CaptureState.IDLE);
  }
}

function selectedIncludedPids() {
  return latestAudioApps
    .filter((app) => !excludedProcessIds.has(app.ProcessId))
    .map((app) => app.ProcessId);
}

function selectedIncludedNames() {
  return latestAudioApps
    .filter((app) => !excludedProcessIds.has(app.ProcessId))
    .map((app) => app.Name);
}

function stopStreamAudioTracks() {
  if (!localStream) return;

  localStream.getAudioTracks().forEach((track) => {
    track.stop();
    localStream.removeTrack(track);
  });
}

async function captureDisplayStream(audioMode) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: audioMode !== "none" && audioMode !== "screen-no-discord"
    });
  } catch (error) {
    if (error.name === "TypeError" || error.name === "NotSupportedError") {
      console.warn("[JANJA CAPTURE FALLBACK] Navegador recusou audio: true (ex: Firefox). Tentando apenas video...", error.name);
      return await navigator.mediaDevices.getDisplayMedia({
        video: true
      });
    }
    throw error;
  }
}

async function loadAudioCapabilities() {
  if (audioCapabilities) return audioCapabilities;

  try {
    const response = await fetch("/audio/capabilities", { cache: "no-store" });
    audioCapabilities = await response.json();
  } catch (error) {
    audioCapabilities = {
      ok: false,
      processLoopbackSupported: false,
      message: "Nao foi possivel detectar suporte ao filtro de audio por processo.",
    };
  }

  return audioCapabilities;
}

function updateMixerStatus() {
  if (!latestAudioApps.length) {
    mixerStatus.textContent = "Nenhum app com audio agora";
    return;
  }

  if (excludedProcessIds.size === 0) {
    mixerStatus.textContent = `${latestAudioApps.length} app${latestAudioApps.length === 1 ? "" : "s"} detectado${latestAudioApps.length === 1 ? "" : "s"}`;
    return;
  }

  const included = selectedIncludedNames();
  mixerStatus.textContent =
    included.length === 0
      ? "Todos os apps foram excluidos"
      : `Transmitindo: ${included.slice(0, 4).join(", ")}${included.length > 4 ? "..." : ""}`;
}

function setEmpty(visible, title, copy) {
  if (emptyEl) emptyEl.style.display = visible ? "grid" : "none";
  if (title && emptyTitleEl) emptyTitleEl.textContent = title;
  if (copy && emptyCopyEl) emptyCopyEl.textContent = copy;
}

function send(payload) {
  if (socketIsOpen()) {
    socket.send(JSON.stringify(payload));
  }
}

function connect() {
  clearTimeout(reconnectTimer);

  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    return;
  }

  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    send({ type: "join", role: isViewer ? "viewer" : "host", sessionId: viewerSessionId });
    refreshHostStatus();
    if (isViewer && !videoEl.srcObject && peers.size === 0) {
      setStatus("Aguardando host");
    } else if (isViewer) {
      setStatus("Sinalizacao conectada");
    }
    
    clearInterval(heartbeatInterval);
    lastHeartbeatAck = Date.now();
    heartbeatInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
            if (Date.now() - lastHeartbeatAck > 45000) {
                console.warn("[LULE3000] Heartbeat timeout. Fechando socket para forcar reconexao.");
                socket.close();
            } else {
                send({ type: "heartbeat", timestamp: Date.now() });
            }
        }
    }, 20000);
  });

  socket.addEventListener("close", () => {
    clearInterval(heartbeatInterval);
    if (!isViewer) {
      refreshHostStatus();
    } else {
      setStatus("Sinalizacao reconectando...");
      // Não damos setEmpty(true) para não matar o player!
    }
    reconnectTimer = setTimeout(connect, 2000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "heartbeat-ack") {
        lastHeartbeatAck = Date.now();
        return;
    }

    if (data.type === "joined" && data.role === "viewer") {
      viewerId = data.viewerId; // Na nova arq, o server devolve nosso sessionId como viewerId
      if (!videoEl.srcObject && peers.size === 0) setStatus("Aguardando host");
      return;
    }

    if (data.type === "joined" && data.role === "host") {
      refreshHostStatus();
      return;
    }

    if (data.type === "viewer-joined" && !isViewer) {
      viewerCount += 1;
      viewerCountEl.textContent = String(viewerCount);
      if (localStream) await createOfferForViewer(data.viewerId);
      return;
    }

    if (data.type === "viewer-left" && !isViewer) {
      // Grace period para o host ignorar quedas falsas de viewer
      setTimeout(() => {
         const peer = peers.get(data.viewerId);
         if (peer && peer.connectionState !== "connected" && peer.connectionState !== "checking") {
            viewerCount = Math.max(0, viewerCount - 1);
            viewerCountEl.textContent = String(viewerCount);
            closePeer(data.viewerId);
         }
      }, 5000);
      return;
    }

    if (data.type === "viewer-reconnected" && !isViewer) {
      console.log("[LULE3000] Viewer reconectou ao sinal: " + data.viewerId);
      const peer = peers.get(data.viewerId);
      if (!peer || peer.connectionState === "closed" || peer.connectionState === "failed") {
          viewerCount += 1;
          viewerCountEl.textContent = String(viewerCount);
          if (localStream) await createOfferForViewer(data.viewerId);
      }
      return;
    }

    if (data.type === "quality-request" && !isViewer) {
      handleHostQualityRequest(data.viewerId, data.quality);
      return;
    }

    if (data.type === "quality-applied" && isViewer) {
      if (data.effective !== "FAIL") {
        document.getElementById("btn-quality").textContent = data.effective;
        showToast("Qualidade definida para " + data.effective);
      } else {
        showToast("Falha ao alterar qualidade.");
      }
      return;
    }

    if (data.type === "answer" && !isViewer) {
      const peer = peers.get(data.viewerId);
      if (peer) {
        await peer.setRemoteDescription(data.answer);
      }
      return;
    }

    if (data.type === "viewer-ice" && !isViewer) {
      const peer = peers.get(data.viewerId);
      if (peer && data.candidate) {
        await peer.addIceCandidate(data.candidate);
      }
      return;
    }

    if (data.type === "offer" && isViewer) {
      await acceptOffer(data.offer);
      return;
    }

    if (data.type === "host-ice" && isViewer) {
      if (viewerPeer && data.candidate) {
        await viewerPeer.addIceCandidate(data.candidate);
      }
      return;
    }

    if (data.type === "host-left" && isViewer) {
      setStatus("Host saiu");
      setEmpty(true, "Aguardando host", "A transmissao volta automaticamente quando o host reconectar.");
      return;
    }
  });
}

async function startShare() {
  if (currentCaptureState === CaptureState.REQUESTING_CAPTURE || currentCaptureState === CaptureState.STREAMING) {
    return;
  }

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("getDisplayMedia não suportado ou contexto não seguro (precisa de HTTPS ou localhost).");
    }

    manuallyStopped = false;
    updateHostCaptureState(CaptureState.REQUESTING_CAPTURE);
    const audioMode = audioModeSelect.value;
    let canUseWasapiLoopback = true;
    let compatibilityMessage = "";
    stopFilteredAudio();
    
    if (audioMode === "screen-no-discord") {
      const capabilities = await loadAudioCapabilities();
      canUseWasapiLoopback = Boolean(capabilities.processLoopbackSupported || capabilities.ProcessLoopbackSupported) ||
        params.get("mockAudio") === "1";

      if (canUseWasapiLoopback) {
        await loadAudioApps();
        const discordApp = latestAudioApps.find(app => app.Name.toLowerCase().includes("discord"));
        const excludePids = discordApp ? [discordApp.ProcessId] : [];
        if (!discordApp) console.warn("[JANJA] Discord não encontrado na lista de apps de áudio.");
        await publishAudioSelection([], excludePids);
      } else {
        compatibilityMessage = capabilities.message || capabilities.Message ||
          "Esta versao do Windows nao suporta filtro de audio por aplicativo. O video sera transmitido sem audio para nao vazar Discord.";
        await publishAudioSelection([]);
      }
    } else {
      await publishAudioSelection([]);
    }

    localStream = await captureDisplayStream(audioMode);

    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length > 0) {
      try {
        await videoTracks[0].applyConstraints({ frameRate: { ideal: 30 } });
      } catch (e) {
        console.warn("[JANJA CAPTURE] Não foi possível otimizar para 30 FPS", e);
      }
    }

    if (audioMode === "input") {
      const deviceId = audioDeviceSelect.value;
      const audioConstraints = deviceId ? { deviceId: { exact: deviceId } } : true;
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      audioStream.getAudioTracks().forEach((track) => localStream.addTrack(track));
      await loadAudioInputs();
    }

    if (localStream.getAudioTracks().length > 0) {
      activeAudioSource = AudioSource.BROWSER_DISPLAY_AUDIO;
      console.log("[JANJA CAPTURE] Usando áudio nativo do navegador.");
    } else if (audioMode !== "none" && canUseWasapiLoopback) {
      console.log("[JANJA CAPTURE] Áudio nativo indisponível. Tentando WASAPI...");
      try {
        const audioTrack = await createFilteredAudioTrack();
        if (audioTrack) {
          localStream.addTrack(audioTrack);
          activeAudioSource = AudioSource.WASAPI_LOOPBACK;
          console.log("[JANJA CAPTURE] Áudio WASAPI conectado com sucesso.");
        }
      } catch (err) {
        activeAudioSource = AudioSource.NONE;
        console.warn("[JANJA CAPTURE] WASAPI fallback nao disponivel", err);
      }
    } else if (compatibilityMessage) {
      activeAudioSource = AudioSource.NONE;
      audioPanel.style.display = "grid";
      audioPanelLabel.textContent = "Compatibilidade de audio";
      audioPanelStatus.textContent = compatibilityMessage;
    }

    updateHostCaptureState(CaptureState.CAPTURE_ACTIVE);

    videoEl.srcObject = localStream;
    setEmpty(false);
    updateHostCaptureState(CaptureState.STREAMING);
    if (compatibilityMessage) {
      setStatus("Video sem audio");
    }
    startButton.disabled = true;
    stopButton.disabled = false;

    localStream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (!manuallyStopped && !isSwitchingSource) stopShare();
      });
    });
  } catch (error) {
    console.error("[JANJA CAPTURE ERROR]\n",
      "name:", error.name, "\n",
      "message:", error.message, "\n",
      "constraint:", error.constraint, "\n",
      "secureContext:", window.isSecureContext, "\n",
      "documentFocused:", document.hasFocus(), "\n",
      "userAgent:", navigator.userAgent
    );
    updateHostCaptureState(CaptureState.ERROR);
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError" || error.name === "PermissionDeniedError";
    setStatus(denied ? "Permissao negada" : "Captura bloqueada");
    setEmpty(
      true,
      denied ? "Captura cancelada" : "Captura indisponivel",
      denied
        ? "O navegador precisa da sua permissao para compartilhar a tela."
        : `O navegador recusou a configuração (${error.name}). Tente novamente com Escolher tela/janela/guia.`
    );
  }
}

async function createOfferForViewer(id) {
  closePeer(id);

  const peer = new RTCPeerConnection(rtcConfig);
  peers.set(id, peer);

  localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      send({ type: "host-ice", viewerId: id, candidate: event.candidate });
    }
  });

  peer.addEventListener("connectionstatechange", () => {
    if (["closed", "failed", "disconnected"].includes(peer.connectionState)) {
      closePeer(id);
    }
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  send({ type: "offer", viewerId: id, offer });
}

async function renegotiateViewers() {
  const viewerIds = [...peers.keys()];
  await Promise.all(viewerIds.map((id) => createOfferForViewer(id)));
}

async function acceptOffer(offer) {
  if (viewerPeer) viewerPeer.close();

  viewerPeer = new RTCPeerConnection(rtcConfig);
  
  viewerPeer.addEventListener("connectionstatechange", () => {
    if (viewerPeer.connectionState === "connected" && isViewer) {
       startViewerTelemetry();
    } else if (viewerPeer.connectionState === "disconnected" || viewerPeer.connectionState === "failed") {
       clearInterval(telemetryTimer);
       document.getElementById("viewer-status-text").textContent = "CONEXÃO INTERROMPIDA";
       document.getElementById("viewer-wait-screen").classList.remove("hidden");
       document.getElementById("viewer-stage").classList.add("hidden");
    }
  });


  viewerPeer.addEventListener("track", (event) => {
    const [stream] = event.streams;
    videoEl.srcObject = stream;
    setEmpty(false);
    
    const hasAudio = stream.getAudioTracks().length > 0;
    setStatus(hasAudio ? "Assistindo" : "Vídeo sem áudio");

    if (isViewer) {
      const unmuteBtn = document.querySelector("#unmute-overlay-btn");
      if (unmuteBtn) unmuteBtn.style.display = "inline-flex";
      enableViewerAudio();
    }
  });

  viewerPeer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      send({ type: "viewer-ice", viewerId, candidate: event.candidate });
    }
  });

  await viewerPeer.setRemoteDescription(offer);
  const answer = await viewerPeer.createAnswer();
  await viewerPeer.setLocalDescription(answer);
  send({ type: "answer", viewerId, answer });
}

function closePeer(id) {
  const peer = peers.get(id);
  if (peer) {
    peer.close();
    peers.delete(id);
  }
}

function stopShare() {
  manuallyStopped = true;
  localStream?.getTracks().forEach((track) => track.stop());
  stopFilteredAudio();
  publishAudioSelection([]);
  localStream = null;
  peers.forEach((peer) => peer.close());
  peers.clear();
  videoEl.srcObject = null;
  setEmpty(true, "Compartilhamento pausado", "Clique em iniciar para transmitir novamente.");
  refreshHostStatus();
  startButton.disabled = false;
  stopButton.disabled = true;
}

async function toggleFullscreen() {
  const fullscreenElement =
    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;

  if (fullscreenElement) {
    const exit =
      document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) await exit.call(document);
    return;
  }

  const target = videoEl.srcObject ? videoEl : (stageEl || videoEl);
  if (!target) return;
  const request =
    target.requestFullscreen ||
    target.webkitRequestFullscreen ||
    target.msRequestFullscreen ||
    videoEl.webkitEnterFullscreen;

  if (!request) {
    setStatus("Indisponivel");
    return;
  }

  try {
    await request.call(target);
  } catch (error) {
    if (stageEl && target !== stageEl) {
      const fallback = stageEl.requestFullscreen || stageEl.webkitRequestFullscreen || stageEl.msRequestFullscreen;
      if (fallback) {
        await fallback.call(stageEl);
        return;
      }
    }
    setStatus("Tela cheia bloqueada");
  }
}

function syncFullscreenButton() {
  const fullscreenElement =
    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  fullscreenButton.textContent = fullscreenElement ? "Sair da tela cheia" : "Tela cheia";
}

function setViewerVolume(val) {
  if (!isViewer) return;
  const volRatio = val / 100;
  videoEl.volume = volRatio;
  if (remoteAudioGain) {
    remoteAudioGain.gain.value = volRatio;
  }
}

function setViewerMuted(isMuted) {
  if (!isViewer) return;
  videoEl.muted = isMuted;
}

function applyViewerVolume() {
  const volume = Number(volumeInput.value);
  volumeValue.textContent = `${volume}%`;
  
  if (isViewer) {
    setViewerVolume(volume);
    setViewerMuted(volume === 0);
  } else {
    videoEl.muted = true;
  }
}

async function enableViewerAudio() {
  if (!isViewer) return;

  const volume = Number(volumeInput.value);
  if (volume === 0) {
    volumeInput.value = 85;
    volumeValue.textContent = "85%";
  }

  setViewerVolume(Number(volumeInput.value));
  setViewerMuted(false);
  remoteAudioContext?.resume();

  const unmuteBtn = document.querySelector("#unmute-overlay-btn");

  try {
    await videoEl.play();
    if (unmuteBtn) unmuteBtn.style.display = "none";
    setStatus("Assistindo");
  } catch (err) {
    console.warn("[JANJA AUDIO PLAY ERROR]", err);
    if (unmuteBtn) unmuteBtn.style.display = "inline-flex";
    setStatus("Clique no video para ouvir");
  }
}

function syncVolume() {
  enableViewerAudio();
}

async function loadRemoteAudioSelection() {
  if (!isViewer) return;

  try {
    const response = await fetch("/audio/selection", { cache: "no-store" });
    const selection = await response.json();
    const key = selection.enabled
      ? `${selection.version}:${selection.mock}:${(selection.includePids || []).join(",")}`
      : "disabled";

    if (key === remoteAudioSelectionKey) return;
    remoteAudioSelectionKey = key;

    stopRemoteAudio();
    if (selection.enabled) {
      const version = selection.version || Date.now();
      filteredAudioPlayer.src = `/audio-current.wav?v=${version}`;
      filteredAudioPlayer.volume = Number(volumeInput.value) / 100;
      audioPanelStatus.textContent = "Audio filtrado disponivel. Clique play se nao iniciar.";
      filteredAudioPlayer.play().catch(() => {
        setStatus("Clique para ouvir");
      });
    } else {
      filteredAudioPlayer.removeAttribute("src");
      filteredAudioPlayer.load();
      audioPanelStatus.textContent = "Aguardando audio filtrado";
    }
  } catch (error) {
    stopRemoteAudio();
  }
}

async function startRemoteAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  try {
    remoteAudioContext = new AudioContextClass({ sampleRate: 44100 });
  } catch (error) {
    remoteAudioContext = new AudioContextClass();
  }

  await remoteAudioContext.audioWorklet.addModule("/static/pcm-player-worklet.js");

  remoteAudioWorkletNode = new AudioWorkletNode(remoteAudioContext, "pcm-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  remoteAudioGain = remoteAudioContext.createGain();
  remoteAudioGain.gain.value = Number(volumeInput.value) / 100;
  remoteAudioWorkletNode.connect(remoteAudioGain);
  remoteAudioGain.connect(remoteAudioContext.destination);

  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  remoteAudioSocket = new WebSocket(`${scheme}://${window.location.host}/audio-stream-current`);
  remoteAudioSocket.binaryType = "arraybuffer";

  remoteAudioSocket.addEventListener("message", (event) => {
    remoteAudioWorkletNode?.port.postMessage(event.data, [event.data]);
  });

  remoteAudioSocket.addEventListener("open", () => {
    remoteAudioContext.resume().catch(() => {});
    if (remoteAudioContext.state === "suspended") {
      setStatus("Clique para ouvir");
    }
  });

  remoteAudioSocket.addEventListener("close", () => {
    if (isViewer && remoteAudioSelectionKey !== "disabled") {
      setStatus("Audio desconectado");
    }
  });
}

function stopRemoteAudio() {
  if (remoteAudioSocket && remoteAudioSocket.readyState <= WebSocket.OPEN) {
    remoteAudioSocket.close();
  }

  remoteAudioSocket = null;
  remoteAudioWorkletNode?.disconnect();
  remoteAudioWorkletNode = null;
  remoteAudioGain?.disconnect();
  remoteAudioGain = null;
  remoteAudioContext?.close();
  remoteAudioContext = null;
}

async function createFilteredAudioTrack(version) {
  stopFilteredAudio();

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.AudioWorkletNode) {
    throw new Error("Este navegador nao suporta AudioWorklet para o audio filtrado.");
  }

  try {
    filteredAudioContext = new AudioContextClass({ sampleRate: 44100 });
  } catch (error) {
    filteredAudioContext = new AudioContextClass();
  }

  await filteredAudioContext.audioWorklet.addModule("/static/pcm-player-worklet.js");

  filteredAudioWorkletNode = new AudioWorkletNode(filteredAudioContext, "pcm-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  filteredAudioDestination = filteredAudioContext.createMediaStreamDestination();
  filteredAudioSilentSink = filteredAudioContext.createGain();
  filteredAudioSilentSink.gain.value = 0;

  filteredAudioWorkletNode.connect(filteredAudioDestination);
  filteredAudioWorkletNode.connect(filteredAudioSilentSink);
  filteredAudioSilentSink.connect(filteredAudioContext.destination);

  const [track] = filteredAudioDestination.stream.getAudioTracks();
  if (!track) {
    throw new Error("O mixer filtrado nao gerou faixa de audio.");
  }

  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const cacheBust = version || Date.now();
  filteredAudioSocket = new WebSocket(`${scheme}://${window.location.host}/audio-stream-current?v=${cacheBust}`);
  filteredAudioSocket.binaryType = "arraybuffer";

  filteredAudioSocket.addEventListener("message", (event) => {
    filteredAudioWorkletNode?.port.postMessage(event.data, [event.data]);
  });

  filteredAudioSocket.addEventListener("close", () => {
    if (localStream?.getAudioTracks().includes(track) && !manuallyStopped) {
      setStatus("Audio desconectado");
      audioPanelStatus.textContent = "Fluxo de audio filtrado desconectou.";
    }
  });

  await filteredAudioContext.resume();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout ao conectar audio filtrado.")), 5000);

    filteredAudioSocket.addEventListener("open", () => {
      clearTimeout(timeout);
      audioPanelStatus.textContent = "Audio filtrado anexado ao WebRTC.";
      resolve();
    }, { once: true });

    filteredAudioSocket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Falha ao conectar audio filtrado."));
    }, { once: true });
  });

  return track;
}

async function applyAudioSelectionToActiveStream() {
  if (!localStream || audioModeSelect.value !== "screen") return;

  stopStreamAudioTracks();
  stopFilteredAudio();

  if (excludedProcessIds.size === 0) {
    setStatus("Reinicie audio");
    mixerStatus.textContent = "Para voltar ao audio original da tela/aba, pare e inicie a transmissao novamente.";
    await publishAudioSelection([]);
    await renegotiateViewers();
    return;
  }

  const includePids = selectedIncludedPids();
  if (includePids.length === 0) {
    setStatus("Sem audio");
    mixerStatus.textContent = "Todos os apps foram excluidos; nenhum audio sera transmitido.";
    await publishAudioSelection([]);
    await renegotiateViewers();
    return;
  }

  setStatus("Atualizando audio");
  mixerStatus.textContent = "Aplicando filtro de audio na transmissao...";
  const selection = await publishAudioSelection(includePids);
  const audioTrack = await createFilteredAudioTrack(selection?.version);
  localStream.addTrack(audioTrack);
  await renegotiateViewers();
  setStatus("Transmitindo");
  updateMixerStatus();
}

async function publishAudioSelection(includePids, excludePids = []) {
  if (isViewer) return;

  try {
    const response = await fetch("/audio/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: includePids.length > 0 || excludePids.length > 0,
        includePids,
        excludePids,
        mock: params.get("mockAudio") === "1",
      }),
    });
    const selection = await response.json();

    if (includePids.length > 0) {
      filteredAudioPlayer.src = `/audio-preview.wav?v=${selection.version || Date.now()}`;
      filteredAudioPlayer.volume = 0.75;
      audioPanelStatus.textContent = "Preview pronto e usado na transmissao.";
    } else {
      filteredAudioPlayer.removeAttribute("src");
      filteredAudioPlayer.load();
      audioPanelStatus.textContent = "Aguardando selecao";
    }

    return selection;
  } catch (error) {
    mixerStatus.textContent = "Falha ao publicar audio filtrado.";
    throw error;
  }
}

function stopFilteredAudio() {
  if (filteredAudioSocket && filteredAudioSocket.readyState <= WebSocket.OPEN) {
    filteredAudioSocket.close();
  }

  filteredAudioSocket = null;
  filteredAudioWorkletNode?.disconnect();
  filteredAudioWorkletNode = null;
  filteredAudioSilentSink?.disconnect();
  filteredAudioSilentSink = null;
  filteredAudioDestination = null;
  filteredAudioContext?.close();
  filteredAudioContext = null;
}

async function loadAudioInputs(requestPermission = false) {
  try {
    if (requestPermission) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === "audioinput");
    const previousValue = audioDeviceSelect.value;

    audioDeviceSelect.innerHTML = "";
    audioInputs.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Entrada de audio ${index + 1}`;
      audioDeviceSelect.append(option);
    });

    if (previousValue && audioInputs.some((device) => device.deviceId === previousValue)) {
      audioDeviceSelect.value = previousValue;
    }

    if (audioInputs.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Nenhuma entrada encontrada";
      audioDeviceSelect.append(option);
    }
  } catch (error) {
    setStatus("Audio bloqueado");
  }
}

function syncAudioMode() {
  if (audioDeviceControl && audioModeSelect) {
      audioDeviceControl.style.display = audioModeSelect.value === "input" ? "inline-flex" : "none";
  }
  if (refreshAudioButton && audioModeSelect) {
      refreshAudioButton.style.display = audioModeSelect.value === "input" ? "inline-flex" : "none";
  }
  if (appMixer) appMixer.style.display = "none";
  if (audioPanel) audioPanel.style.display = "none";
}

async function refreshTunnelLink() {
  if (isViewer) return;

  try {
    const response = await fetch("/tunnel", { cache: "no-store" });
    const tunnel = await response.json();

    tunnelStatusEl.textContent = tunnel.message || "Aguardando tunel...";

    if (tunnel.watchUrl) {
      watchLinkInput.value = tunnel.watchUrl;
      copyLinkButton.disabled = false;
      clearInterval(tunnelTimer);
      return;
    }

    copyLinkButton.disabled = true;
    if (tunnel.status === "missing") {
      watchLinkInput.value = "cloudflared.exe nao encontrado nesta pasta.";
      clearInterval(tunnelTimer);
    }
  } catch (error) {
    tunnelStatusEl.textContent = "Nao foi possivel ler o tunel.";
  }
}

async function copyWatchLink() {
  const value = watchLinkInput.value;

  try {
    await navigator.clipboard.writeText(value);
    copyLinkButton.textContent = "Copiado";
  } catch (error) {
    watchLinkInput.select();
    document.execCommand("copy");
    copyLinkButton.textContent = "Copiado";
  }

  setTimeout(() => {
    copyLinkButton.textContent = "Copiar";
  }, 1500);
}

function renderAudioApps(apps) {
  appList.innerHTML = "";

  updateMixerStatus();

  if (!apps.length) return;

  apps.forEach((app) => {
    const row = document.createElement("div");
    row.className = "app-row";

    const name = document.createElement("div");
    name.className = "app-name";

    const title = document.createElement("strong");
    title.textContent = app.Name;

    const subtitle = document.createElement("span");
    subtitle.textContent = app.WindowTitle || `PID ${app.ProcessId}`;

    const volume = document.createElement("span");
    volume.className = "app-volume";
    volume.textContent = `${Math.round(app.Volume * 100)}%`;

    const button = document.createElement("button");
    const excluded = excludedProcessIds.has(app.ProcessId);
    button.className = excluded ? "" : "secondary";
    button.textContent = excluded ? "Incluir" : "Excluir";
    button.addEventListener("click", () => toggleTransmissionExclude(app.ProcessId));

    name.append(title, subtitle);
    row.append(name, volume, button);
    appList.append(row);
  });
}

async function loadAudioApps() {
  if (isViewer) return;

  try {
    const response = await fetch("/audio/apps", { cache: "no-store" });
    const result = await response.json();

    if (!result.ok) {
      mixerStatus.textContent = result.message || "Nao foi possivel carregar";
      return;
    }

    latestAudioApps = result.apps;
    renderAudioApps(result.apps);
  } catch (error) {
    mixerStatus.textContent = "Nao foi possivel carregar";
  }
}

async function toggleTransmissionExclude(processId) {
  if (excludedProcessIds.has(processId)) {
    excludedProcessIds.delete(processId);
  } else {
    excludedProcessIds.add(processId);
  }

  renderAudioApps(latestAudioApps);
  await applyAudioSelectionToActiveStream();
}

function setupUi() {
  if (isViewer) {
    if (titleEl) titleEl.textContent = "JANJA";
    if (modeEl) modeEl.textContent = "Visitante";
    if (startButton) startButton.style.display = "none";
    if (stopButton) stopButton.style.display = "none";
    if (audioModeControl) audioModeControl.style.display = "none";
    if (audioDeviceControl) audioDeviceControl.style.display = "none";
    if (refreshAudioButton) refreshAudioButton.style.display = "none";
    if (sharePanel) sharePanel.style.display = "none";
    if (appMixer) appMixer.style.display = "none";
    if (audioPanel) audioPanel.style.display = "none";
    if (volumeControl) volumeControl.style.display = "inline-flex";
    if (typeof audioPanelLabel !== "undefined" && audioPanelLabel) audioPanelLabel.textContent = "Audio da transmissao";
    if (typeof audioPanelStatus !== "undefined" && audioPanelStatus) audioPanelStatus.textContent = "Aguardando audio filtrado";
    if (switchLink) {
        switchLink.href = "/host";
        switchLink.textContent = "Abrir como host";
    }
    if (videoEl) {
        videoEl.controls = true;
        videoEl.defaultMuted = false;
        videoEl.removeAttribute("muted");
    }
    applyViewerVolume();
    setEmpty(true, "Aguardando transmissao", "Quando o host iniciar, a tela aparece aqui automaticamente.");
  } else {
    if (titleEl) titleEl.textContent = "JANJA";
    if (modeEl) modeEl.textContent = "Host";
    if (switchLink) {
        switchLink.href = "/watch";
        switchLink.textContent = "Abrir como visitante";
    }
    if (appMixer) appMixer.style.display = "none";
    if (audioPanel) audioPanel.style.display = "none";
  }

  if (startButton) startButton.addEventListener("click", startShare);
  if (stopButton) stopButton.addEventListener("click", stopShare);
  if (fullscreenButton) fullscreenButton.addEventListener("click", toggleFullscreen);
  if (copyLinkButton) copyLinkButton.addEventListener("click", copyWatchLink);
  if (refreshAppsButton) refreshAppsButton.addEventListener("click", loadAudioApps);
  if (audioModeSelect) audioModeSelect.addEventListener("change", syncAudioMode);
  if (refreshAudioButton) refreshAudioButton.addEventListener("click", () => loadAudioInputs(true));
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
  if (volumeInput) {
      volumeInput.addEventListener("input", syncVolume);
      volumeInput.addEventListener("change", syncVolume);
  }
  if (videoEl) {
      videoEl.addEventListener("click", () => {
        if (isViewer) {
          syncVolume();
          remoteAudioContext?.resume();
        }
      });
  }
  document.addEventListener("click", () => {
    if (isViewer) {
      remoteAudioContext?.resume();
      if (typeof filteredAudioPlayer !== "undefined" && filteredAudioPlayer && filteredAudioPlayer.src) {
          filteredAudioPlayer.play().catch(() => {});
      }
    }
  });

  if (!isViewer) {
    syncAudioMode();
    loadAudioInputs();
    refreshTunnelLink();
    tunnelTimer = setInterval(refreshTunnelLink, 1500);
    publishAudioSelection([]);
  }
}

setupUi();
connect();

document.addEventListener("DOMContentLoaded", () => {
    // 1. Layout Switching
    const hostView = document.getElementById("host-view");
    const viewerView = document.getElementById("viewer-view");
    if (isViewer) {
        if(hostView) hostView.style.display = "none";
        if(viewerView) viewerView.style.display = "block";
        document.body.classList.add("viewer-mode");
    } else {
        if(viewerView) viewerView.style.display = "none";
        if(hostView) hostView.style.display = "block";
        document.body.classList.add("host-mode");
    }

    // 2. Intro Animation
    const introSeq = document.getElementById("intro-sequence");
    if (introSeq) {
        if (!sessionStorage.getItem("lule_intro_played")) {
            setTimeout(() => {
                introSeq.classList.remove("intro-active");
                sessionStorage.setItem("lule_intro_played", "true");
            }, 2000);
        } else {
            introSeq.style.display = "none";
        }
    }

    // 3. Settings Drawer (Host)
    const settingsBtn = document.getElementById("settings-btn");
    const closeSettings = document.getElementById("close-settings");
    const drawer = document.getElementById("settings-drawer");
    if (settingsBtn && drawer) {
        settingsBtn.addEventListener("click", () => drawer.classList.add("open"));
        closeSettings.addEventListener("click", () => drawer.classList.remove("open"));
    }

    // 4. Viewer Custom Player UI
    if (isViewer) {
        const btnPlayPause = document.getElementById("btn-play-pause");
        const btnMute = document.getElementById("btn-mute");
        const volSlider = document.querySelector(".vol-slider");
        const btnPip = document.getElementById("btn-pip");
        const btnFullscreenViewer = document.getElementById("btn-fullscreen-viewer");
        const btnQuality = document.getElementById("btn-quality");
        const qualityMenu = document.getElementById("quality-menu");
        
        // Hide/Show controls on idle
        const overlay = document.getElementById("player-overlay");
        let idleTimeout;
        const resetIdle = () => {
            if(overlay) overlay.classList.remove("idle");
            clearTimeout(idleTimeout);
            idleTimeout = setTimeout(() => {
                if(overlay) overlay.classList.add("idle");
            }, 3000);
        };
        document.addEventListener("mousemove", resetIdle);
        document.addEventListener("touchstart", resetIdle);
        resetIdle();

        if (btnPlayPause) {
            btnPlayPause.addEventListener("click", () => {
                if (videoEl.paused) { videoEl.play(); } else { videoEl.pause(); }
            });
            videoEl.addEventListener("play", () => {
                btnPlayPause.querySelector(".icon-play").classList.add("hidden");
                btnPlayPause.querySelector(".icon-pause").classList.remove("hidden");
            });
            videoEl.addEventListener("pause", () => {
                btnPlayPause.querySelector(".icon-play").classList.remove("hidden");
                btnPlayPause.querySelector(".icon-pause").classList.add("hidden");
            });
        }

        if (btnMute && volSlider) {
            btnMute.addEventListener("click", () => {
                videoEl.muted = !videoEl.muted;
                updateMuteIcon();
            });
            volSlider.addEventListener("input", (e) => {
                videoEl.volume = e.target.value / 100;
                videoEl.muted = (videoEl.volume === 0);
                updateMuteIcon();
                localStorage.setItem("lule_volume", e.target.value);
            });
            const savedVol = localStorage.getItem("lule_volume");
            if (savedVol) {
                volSlider.value = savedVol;
                videoEl.volume = savedVol / 100;
            }
            function updateMuteIcon() {
                if (videoEl.muted) {
                    btnMute.querySelector(".icon-vol").classList.add("hidden");
                    btnMute.querySelector(".icon-muted").classList.remove("hidden");
                } else {
                    btnMute.querySelector(".icon-vol").classList.remove("hidden");
                    btnMute.querySelector(".icon-muted").classList.add("hidden");
                }
            }
        }

        if (btnPip) {
            if (!document.pictureInPictureEnabled) {
                btnPip.style.display = "none";
            } else {
                btnPip.addEventListener("click", async () => {
                    try {
                        if (document.pictureInPictureElement) {
                            await document.exitPictureInPicture();
                        } else if (videoEl.readyState >= 2) {
                            await videoEl.requestPictureInPicture();
                        }
                    } catch (e) { console.warn("PiP error", e); }
                });
            }
        }
        
        if (btnFullscreenViewer) {
            btnFullscreenViewer.addEventListener("click", async () => {
                const stage = document.getElementById("viewer-stage");
                if (!document.fullscreenElement) {
                    await stage.requestFullscreen().catch(err => {
                        console.error("Erro fullscreen:", err);
                    });
                } else {
                    document.exitFullscreen();
                }
            });
        }

        if (btnQuality && qualityMenu) {
            btnQuality.addEventListener("click", (e) => {
                e.stopPropagation();
                qualityMenu.classList.toggle("hidden");
            });
            document.addEventListener("click", () => qualityMenu.classList.add("hidden"));
            
            qualityMenu.querySelectorAll(".q-option").forEach(opt => {
                opt.addEventListener("click", (e) => {
                    const q = e.currentTarget.dataset.q;
                    requestQuality(q);
                    qualityMenu.querySelectorAll(".q-option").forEach(o => o.classList.remove("active"));
                    e.currentTarget.classList.add("active");
                });
            });
        }
        
        // Unmute Overlay behavior
        const unmuteBtn = document.getElementById("unmute-overlay-btn");
        if (unmuteBtn) {
            unmuteBtn.addEventListener("click", () => {
                videoEl.muted = false;
                updateMuteIcon && updateMuteIcon();
                unmuteBtn.style.display = "none";
            });
            videoEl.addEventListener("volumechange", () => {
                if (!videoEl.muted) unmuteBtn.style.display = "none";
            });
        }
    }
});

function showToast(msg) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

// 5. Adaptive Quality Protocol
let currentViewerQuality = "AUTO";

function requestQuality(q) {
    currentViewerQuality = q;
    document.getElementById("btn-quality").textContent = q;
    if (socketIsOpen()) {
        showToast("Aplicando " + q + "...");
        socket.send(JSON.stringify({ type: "quality-request", quality: q }));
    }
}

async function handleHostQualityRequest(viewerId, quality) {
    const peer = peers.get(viewerId);
    if (!peer) return;

    const sender = peer.getSenders().find(s => s.track && s.track.kind === "video");
    if (!sender) return;

    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
    }

    let appliedQuality = quality;
    const isFirefox = window.navigator.userAgent.indexOf("Firefox") !== -1;

    try {
        switch (quality) {
            case "ECONOMY":
                parameters.encodings[0].maxBitrate = 400000;
                parameters.encodings[0].maxFramerate = 15;
                if(!isFirefox) parameters.encodings[0].scaleResolutionDownBy = 3;
                break;
            case "480p":
                parameters.encodings[0].maxBitrate = 800000;
                parameters.encodings[0].maxFramerate = 24;
                if(!isFirefox) parameters.encodings[0].scaleResolutionDownBy = 2.25;
                break;
            case "720p":
                parameters.encodings[0].maxBitrate = 2000000;
                parameters.encodings[0].maxFramerate = 30;
                if(!isFirefox) parameters.encodings[0].scaleResolutionDownBy = 1.5;
                break;
            case "1080p":
                parameters.encodings[0].maxBitrate = 4000000;
                parameters.encodings[0].maxFramerate = 30;
                if(!isFirefox) parameters.encodings[0].scaleResolutionDownBy = 1;
                break;
            case "ORIGINAL":
            case "AUTO":
            default:
                delete parameters.encodings[0].maxBitrate;
                delete parameters.encodings[0].maxFramerate;
                delete parameters.encodings[0].scaleResolutionDownBy;
                break;
        }
        await sender.setParameters(parameters);
    } catch (e) {
        console.warn("Failed to set quality parameters for viewer", viewerId, e);
        appliedQuality = "FAIL";
    }

    if (socketIsOpen()) {
        socket.send(JSON.stringify({
            type: "quality-applied",
            viewerId: viewerId,
            requested: quality,
            effective: appliedQuality
        }));
    }
}

// 6. Telemetry Engine & Auto Quality Loop
let telemetryTimer;
let badStatsCounter = 0;
let goodStatsCounter = 0;

function startViewerTelemetry() {
    if (!isViewer) return;
    clearInterval(telemetryTimer);
    
    // Hide wait screen, show player stage
    document.getElementById("viewer-wait-screen").classList.add("hidden");
    document.getElementById("viewer-stage").classList.remove("hidden");
    
    telemetryTimer = setInterval(async () => {
        if (!viewerPeer || viewerPeer.connectionState !== "connected") return;
        
        try {
            const stats = await viewerPeer.getStats();
            let res = "--", fps = "--", bitrate = "--", ping = "--", jitter = "--", loss = "--", codec = "--";
            let inboundRtp = null, candidatePair = null;

            stats.forEach(report => {
                if (report.type === "inbound-rtp" && report.kind === "video") inboundRtp = report;
                if (report.type === "candidate-pair" && report.state === "succeeded") candidatePair = report;
            });

            if (inboundRtp) {
                if (inboundRtp.frameWidth) res = inboundRtp.frameWidth + "x" + inboundRtp.frameHeight;
                if (inboundRtp.framesPerSecond) fps = inboundRtp.framesPerSecond;
                if (inboundRtp.packetsLost) loss = inboundRtp.packetsLost;
                if (inboundRtp.jitter) jitter = (inboundRtp.jitter * 1000).toFixed(1) + "ms";
                
                if (inboundRtp.codecId) {
                    const codecReport = stats.get(inboundRtp.codecId);
                    if (codecReport) codec = codecReport.mimeType.split("/")[1];
                }
            }

            if (candidatePair) {
                if (candidatePair.currentRoundTripTime) ping = (candidatePair.currentRoundTripTime * 1000).toFixed(0) + "ms";
                if (candidatePair.availableIncomingBitrate) {
                    bitrate = (candidatePair.availableIncomingBitrate / 1000000).toFixed(2) + " Mbps";
                }
            }
            
            // Auto quality logic
            if (currentViewerQuality === "AUTO") {
                const curPing = candidatePair?.currentRoundTripTime || 0;
                const curLoss = inboundRtp?.packetsLost || 0;
                if (curPing > 0.2 || curLoss > 5) {
                    badStatsCounter++;
                    goodStatsCounter = 0;
                    if (badStatsCounter >= 2) { 
                        requestQuality("480p"); 
                        setTimeout(() => { if (currentViewerQuality === "480p") requestQuality("AUTO"); }, 30000); 
                    }
                } else {
                    goodStatsCounter++;
                    badStatsCounter = 0;
                }
            }

            document.getElementById("stat-res").textContent = res;
            document.getElementById("stat-fps").textContent = fps;
            document.getElementById("stat-bitrate").textContent = bitrate;
            document.getElementById("stat-ping").textContent = ping;
            document.getElementById("stat-jitter").textContent = jitter;
            document.getElementById("stat-loss").textContent = loss;
            document.getElementById("stat-codec").textContent = codec;
            
            const pill = document.getElementById("conn-indicator");
            const pillText = document.getElementById("conn-text");
            if (pill && pillText) {
                pill.className = "connection-pill";
                const pTime = candidatePair?.currentRoundTripTime || 0;
                if (pTime < 0.05) { pill.classList.add("excellent"); pillText.textContent = "Excelente"; }
                else if (pTime < 0.15) { pill.classList.add("good"); pillText.textContent = "Boa"; }
                else if (pTime < 0.3) { pill.classList.add("poor"); pillText.textContent = "Instável"; }
                else { pill.classList.add("bad"); pillText.textContent = "Ruim"; }
                
                pill.onclick = () => document.getElementById("stats-panel").classList.toggle("hidden");
            }
        } catch (e) {}
    }, 3000);
}

// --- TROCA DE FONTE SEAMLESS ---
async function switchDisplaySource() {
    if (!localStream) return;
    try {
        isSwitchingSource = true;
        const newStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: localStream.getAudioTracks().length > 0 ? true : false
        });

        const newVideoTrack = newStream.getVideoTracks()[0];
        if (!newVideoTrack) throw new Error("Sem trilha de video");

        const replacements = [];
        for (const [viewerId, peer] of peers) {
            const sender = peer.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                replacements.push(sender.replaceTrack(newVideoTrack).catch(e => console.error("Erro replaceTrack video", e)));
            }
        }

        const newAudioTrack = newStream.getAudioTracks()[0];
        if (newAudioTrack) {
            for (const [viewerId, peer] of peers) {
                const audioSender = peer.getSenders().find(s => s.track && s.track.kind === "audio");
                if (audioSender) {
                    replacements.push(audioSender.replaceTrack(newAudioTrack).catch(e => console.error("Erro replaceTrack audio", e)));
                }
            }
        }

        await Promise.all(replacements);

        // Desliga video antigo
        const oldVideoTrack = localStream.getVideoTracks()[0];
        if (oldVideoTrack) oldVideoTrack.stop();
        localStream.removeTrack(oldVideoTrack);
        localStream.addTrack(newVideoTrack);

        // Desliga audio antigo se houver
        if (newAudioTrack) {
            const oldAudioTrack = localStream.getAudioTracks()[0];
            if (oldAudioTrack) {
                oldAudioTrack.stop();
                localStream.removeTrack(oldAudioTrack);
            }
            localStream.addTrack(newAudioTrack);
        }

        videoEl.srcObject = localStream;
        
        newVideoTrack.addEventListener("ended", () => {
            if (!manuallyStopped && !isSwitchingSource) stopShare();
        });

        showToast("Fonte de video alterada com sucesso!");
    } catch (e) {
        if (e.name !== 'NotAllowedError') {
            console.error("Falha ao trocar a fonte:", e);
            showToast("Falha ao trocar de tela.");
        }
    } finally {
        isSwitchingSource = false;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const btnSwitch = document.getElementById("switch-source");
    if (btnSwitch) {
        btnSwitch.addEventListener("click", () => {
            switchDisplaySource();
        });
    }

    // Visibilidade controlada diretamente em updateHostCaptureState()
});
