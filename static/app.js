const params = new URLSearchParams(window.location.search);
const isViewer = window.location.pathname.includes("watch") || params.get("mode") === "watch";

const statusEl = document.querySelector("#status");
const titleEl = document.querySelector("#title");
const stageEl = document.querySelector("#stage");
const videoEl = document.querySelector("#video");
const emptyEl = document.querySelector("#empty");
const emptyTitleEl = document.querySelector("#empty-title");
const emptyCopyEl = document.querySelector("#empty-copy");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const fullscreenButton = document.querySelector("#fullscreen");
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

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setStatus(text) {
  statusEl.textContent = text;
}

function socketIsOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function refreshHostStatus() {
  if (isViewer) return;
  if (localStream && socketIsOpen()) {
    setStatus("Transmitindo");
  } else if (localStream) {
    setStatus("Reconectando");
  } else if (socketIsOpen()) {
    setStatus("Conectado");
  } else {
    setStatus("Desconectado");
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

function displayCaptureOptions(audioMode) {
  const wantsBrowserAudio = audioMode === "tab" || audioMode === "screen";
  const options = {
    video: { frameRate: 30 },
    audio: wantsBrowserAudio,
  };

  if (audioMode === "tab") {
    options.preferCurrentTab = true;
    options.surfaceSwitching = "include";
  }

  return options;
}

async function captureDisplayStream(audioMode) {
  try {
    return await navigator.mediaDevices.getDisplayMedia(displayCaptureOptions(audioMode));
  } catch (error) {
    const constraintFailed = ["TypeError", "OverconstrainedError", "NotFoundError"].includes(error.name);

    if (audioMode === "tab" && constraintFailed) {
      return navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
    }

    throw error;
  }
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
  emptyEl.style.display = visible ? "grid" : "none";
  if (title) emptyTitleEl.textContent = title;
  if (copy) emptyCopyEl.textContent = copy;
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
    send({ type: "join", role: isViewer ? "viewer" : "host" });
    refreshHostStatus();
    if (isViewer && !videoEl.srcObject) {
      setStatus("Aguardando host");
    }
  });

  socket.addEventListener("close", () => {
    if (!isViewer) {
      viewerCount = 0;
      viewerCountEl.textContent = "0";
      peers.forEach((peer) => peer.close());
      peers.clear();
    }
    refreshHostStatus();
    if (isViewer) {
      setStatus("Reconectando");
      setEmpty(true, "Reconectando", "Tentando recuperar a transmissao automaticamente.");
    }
    reconnectTimer = setTimeout(connect, 1500);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "joined" && data.role === "viewer") {
      viewerId = data.viewerId;
      if (!videoEl.srcObject) setStatus("Aguardando host");
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
      viewerCount = Math.max(0, viewerCount - 1);
      viewerCountEl.textContent = String(viewerCount);
      closePeer(data.viewerId);
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
  try {
    manuallyStopped = false;
    const audioMode = audioModeSelect.value;
    stopFilteredAudio();
    await publishAudioSelection([]);

    localStream = await captureDisplayStream(audioMode);

    if (audioMode === "input") {
      const deviceId = audioDeviceSelect.value;
      const audioConstraints = deviceId ? { deviceId: { exact: deviceId } } : true;
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      audioStream.getAudioTracks().forEach((track) => localStream.addTrack(track));
      await loadAudioInputs();
    }

    videoEl.srcObject = localStream;
    setEmpty(false);
    refreshHostStatus();
    startButton.disabled = true;
    stopButton.disabled = false;

    localStream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (!manuallyStopped) stopShare();
      });
    });

    if (audioMode !== "none" && localStream.getAudioTracks().length === 0) {
      setStatus("Sem audio");
    }
  } catch (error) {
    console.error("Falha ao iniciar captura", error);
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
    setStatus(denied ? "Permissao negada" : "Captura bloqueada");
    setEmpty(
      true,
      denied ? "Captura cancelada" : "Captura indisponivel",
      denied
        ? "O navegador precisa da sua permissao para compartilhar a tela."
        : "O navegador recusou essa configuracao de captura. Tente novamente com Escolher tela/janela/guia."
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

  viewerPeer.addEventListener("track", (event) => {
    const [stream] = event.streams;
    videoEl.srcObject = stream;
    applyViewerVolume();
    setEmpty(false);
    setStatus(stream.getAudioTracks().length > 0 ? "Assistindo" : "Sem audio");
    videoEl.play().catch(() => {
      setStatus("Clique no video");
    });
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

  const target = videoEl.srcObject ? videoEl : stageEl;
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
    const fallback = stageEl.requestFullscreen || stageEl.webkitRequestFullscreen || stageEl.msRequestFullscreen;
    if (fallback && target !== stageEl) {
      await fallback.call(stageEl);
      return;
    }
    setStatus("Tela cheia bloqueada");
  }
}

function syncFullscreenButton() {
  const fullscreenElement =
    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  fullscreenButton.textContent = fullscreenElement ? "Sair da tela cheia" : "Tela cheia";
}

function applyViewerVolume() {
  const volume = Number(volumeInput.value);
  volumeValue.textContent = `${volume}%`;
  videoEl.volume = volume / 100;
  videoEl.muted = !isViewer || volume === 0;
  videoEl.defaultMuted = !isViewer || volume === 0;
  if (isViewer && volume > 0) {
    videoEl.removeAttribute("muted");
  }
}

function syncVolume() {
  applyViewerVolume();
  filteredAudioPlayer.volume = Number(volumeInput.value) / 100;
  if (remoteAudioGain) {
    remoteAudioGain.gain.value = Number(volumeInput.value) / 100;
  }
  remoteAudioContext?.resume();
  videoEl.play().catch(() => {
    if (isViewer && videoEl.srcObject) setStatus("Clique no video");
  });
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

async function publishAudioSelection(includePids) {
  if (isViewer) return;

  try {
    const response = await fetch("/audio/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: includePids.length > 0,
        includePids,
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
  audioDeviceControl.style.display = audioModeSelect.value === "input" ? "inline-flex" : "none";
  refreshAudioButton.style.display = audioModeSelect.value === "input" ? "inline-flex" : "none";
  appMixer.style.display = "none";
  audioPanel.style.display = "none";
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
    titleEl.textContent = "JANJA";
    modeEl.textContent = "Visitante";
    startButton.style.display = "none";
    stopButton.style.display = "none";
    audioModeControl.style.display = "none";
    audioDeviceControl.style.display = "none";
    refreshAudioButton.style.display = "none";
    sharePanel.style.display = "none";
    appMixer.style.display = "none";
    audioPanel.style.display = "none";
    volumeControl.style.display = "inline-flex";
    audioPanelLabel.textContent = "Audio da transmissao";
    audioPanelStatus.textContent = "Aguardando audio filtrado";
    switchLink.href = "/host";
    switchLink.textContent = "Abrir como host";
    videoEl.controls = true;
    videoEl.defaultMuted = false;
    videoEl.removeAttribute("muted");
    applyViewerVolume();
    setEmpty(true, "Aguardando transmissao", "Quando o host iniciar, a tela aparece aqui automaticamente.");
  } else {
    titleEl.textContent = "JANJA";
    modeEl.textContent = "Host";
    switchLink.href = "/watch";
    switchLink.textContent = "Abrir como visitante";
    appMixer.style.display = "none";
    audioPanel.style.display = "none";
  }

  startButton.addEventListener("click", startShare);
  stopButton.addEventListener("click", stopShare);
  fullscreenButton.addEventListener("click", toggleFullscreen);
  copyLinkButton.addEventListener("click", copyWatchLink);
  refreshAppsButton.addEventListener("click", loadAudioApps);
  audioModeSelect.addEventListener("change", syncAudioMode);
  refreshAudioButton.addEventListener("click", () => loadAudioInputs(true));
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
  volumeInput.addEventListener("input", syncVolume);
  volumeInput.addEventListener("change", syncVolume);
  videoEl.addEventListener("click", () => {
    if (isViewer) {
      syncVolume();
      remoteAudioContext?.resume();
    }
  });
  document.addEventListener("click", () => {
    if (isViewer) {
      remoteAudioContext?.resume();
      if (filteredAudioPlayer.src) filteredAudioPlayer.play().catch(() => {});
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
