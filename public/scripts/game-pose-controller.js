(function () {
  const video = document.getElementById("poseControlVideo");
  const canvas = document.getElementById("poseControlCanvas");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;
  const toggleButton = document.getElementById("poseGameToggle");
  const calibrateButton = document.getElementById("poseGameCalibrate");
  const invertInput = document.getElementById("poseGameInvert");
  const statusEl = document.getElementById("poseGameStatus");
  const actionEl = document.getElementById("poseGameAction");
  const hintEl = document.getElementById("poseGameHint");

  const avatar = document.getElementById("bodyMirrorAvatar");
  const characterModel = document.getElementById("bodyMirrorCharacterModel");
  const avatarTorso = document.getElementById("bodyMirrorTorso");
  const avatarHead = document.getElementById("bodyMirrorHead");
  const avatarShoulders = document.getElementById("bodyMirrorShoulders");
  const avatarHips = document.getElementById("bodyMirrorHips");
  const avatarLeftHand = document.getElementById("bodyMirrorLeftHand");
  const avatarRightHand = document.getElementById("bodyMirrorRightHand");

  if (!video || !canvas || !ctx || !toggleButton) return;

  const params = new URLSearchParams(window.location.search);
  const ROOM_STORAGE_KEY = "hb_room_code";
  const POSE_CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [27, 31], [28, 32]
  ];
  const HIDDEN_AFRAME_IDS = [
    "enemy",
    "worldHud",
    "pauseButtonVR",
    "menuMainScreen",
    "menuCustomizeScreen",
    "menuHistoryScreen"
  ];
  const HIDDEN_DOM_IDS = ["pauseMenuDesktopToggle", "logoutButton", "userBadge", "pauseMenuDesktop"];

  let enabled = false;
  let mirrorMode = false;
  let stream = null;
  let rafId = 0;
  let poseLandmarker = null;
  let loadingPose = false;
  let lastVideoTime = -1;
  let baseline = null;
  let lastActionAt = 0;
  let lastActionName = "--";
  let roomSocket = null;
  let roomReconnectTimer = 0;
  let roomCode = resolveRoomCode();
  const hiddenState = new Map();

  function sanitizeRoomCode(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, 18);
  }

  function createRoomCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function resolveRoomCode() {
    const room = sanitizeRoomCode(params.get("room"))
      || sanitizeRoomCode(localStorage.getItem(ROOM_STORAGE_KEY))
      || createRoomCode();
    localStorage.setItem(ROOM_STORAGE_KEY, room);
    return room;
  }

  function setStatus(value) {
    if (statusEl) statusEl.textContent = value;
  }

  function setHint(value) {
    if (hintEl) hintEl.textContent = value;
  }

  function setAction(value) {
    lastActionName = value || "--";
    if (actionEl) actionEl.textContent = `acao: ${lastActionName}`;
  }

  function setRoomStatus(value) {
    if (!roomCode) return;
    setStatus(`${value} sala ${roomCode}`);
  }

  function getUserGender() {
    const user = window.authState && window.authState.user;
    return user && user.gender === "female" ? "female" : "male";
  }

  function applyCharacterModel() {
    if (!characterModel) return;
    const model = getUserGender() === "female" ? "#adventurerFemaleModel" : "#adventurerMaleModel";
    characterModel.setAttribute("gltf-model", model);
  }

  function landmarkOk(point) {
    return point && (point.visibility == null || point.visibility > 0.45);
  }

  function signedDegreesBetween(a, b) {
    if (!a || !b) return 0;
    return Math.atan2((b.y - a.y), (b.x - a.x)) * 180 / Math.PI;
  }

  function getGameState() {
    if (typeof window.getGameInputState !== "function") {
      return { running: false, waitingInput: false, expectedAction: null };
    }
    return window.getGameInputState();
  }

  function sendRoomMessage(payload) {
    if (!roomSocket || roomSocket.readyState !== WebSocket.OPEN) return;
    roomSocket.send(JSON.stringify(payload));
  }

  function connectRoom() {
    if (!("WebSocket" in window) || !roomCode) {
      setRoomStatus("sem ws");
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomCode)}&role=game`;

    try {
      roomSocket = new WebSocket(url);
    } catch (error) {
      setRoomStatus("erro");
      return;
    }

    roomSocket.addEventListener("open", () => setRoomStatus("conectado"));
    roomSocket.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      handleRoomMessage(message);
    });
    roomSocket.addEventListener("close", () => {
      setRoomStatus("reconectando");
      clearTimeout(roomReconnectTimer);
      roomReconnectTimer = setTimeout(connectRoom, 1600);
    });
    roomSocket.addEventListener("error", () => setRoomStatus("erro"));
  }

  function handleRoomMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "room-ready" || message.type === "peer-joined" || message.type === "peer-left") {
      const peerCount = Array.isArray(message.peers) ? Math.max(0, message.peers.length - 1) : 0;
      setRoomStatus(peerCount > 0 ? `${peerCount + 1} online` : "conectado");
      return;
    }

    if (message.type === "pose-action" && message.action) {
      const state = getGameState();
      setAction(`${message.action} remoto`);
      if (state.running && state.waitingInput && typeof window.dispatchGameAction === "function") {
        window.dispatchGameAction(message.action, "visao corporal remota");
      }
    }
  }

  async function ensurePoseLandmarker() {
    if (poseLandmarker) return poseLandmarker;
    if (loadingPose) {
      while (loadingPose && !poseLandmarker) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return poseLandmarker;
    }

    loadingPose = true;
    setRoomStatus("carregando");

    try {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35");
      const resolver = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );

      poseLandmarker = await vision.PoseLandmarker.createFromOptions(resolver, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.52,
        minPosePresenceConfidence: 0.52,
        minTrackingConfidence: 0.52
      });

      setRoomStatus("ativo");
      return poseLandmarker;
    } finally {
      loadingPose = false;
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setRoomStatus("sem camera");
      setHint("getUserMedia indisponivel");
      return false;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 960 },
        height: { ideal: 540 },
        facingMode: "user"
      }
    });
    video.srcObject = stream;
    await video.play();
    return true;
  }

  function hideDomElement(element) {
    if (!element || hiddenState.has(element)) return;
    hiddenState.set(element, {
      mode: "dom",
      display: element.style.display,
      ariaHidden: element.getAttribute("aria-hidden")
    });
    element.style.display = "none";
    element.setAttribute("aria-hidden", "true");
  }

  function hideAFrameElement(element) {
    if (!element || hiddenState.has(element)) return;
    hiddenState.set(element, {
      mode: "aframe",
      visible: element.getAttribute("visible")
    });
    element.setAttribute("visible", "false");
  }

  function restoreHiddenElements() {
    for (const [element, state] of hiddenState.entries()) {
      if (state.mode === "dom") {
        element.style.display = state.display || "";
        if (state.ariaHidden == null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", state.ariaHidden);
      } else {
        const visible = state.visible == null ? "true" : String(state.visible);
        element.setAttribute("visible", visible);
      }
    }
    hiddenState.clear();
  }

  function setMirrorMode(active) {
    if (mirrorMode === active) return;
    mirrorMode = active;

    if (!active) {
      restoreHiddenElements();
      if (avatar) avatar.setAttribute("visible", "false");
      sendRoomMessage({ type: "mirror-state", active: false });
      return;
    }

    if (typeof resetGame === "function") resetGame();
    const pauseMenu = document.getElementById("pauseMenuDesktop");
    if (pauseMenu) pauseMenu.classList.remove("open");

    for (const id of HIDDEN_DOM_IDS) hideDomElement(document.getElementById(id));
    hideDomElement(document.querySelector(".game-topbar"));
    for (const id of HIDDEN_AFRAME_IDS) hideAFrameElement(document.getElementById(id));

    if (avatar) avatar.setAttribute("visible", "true");
    sendRoomMessage({ type: "mirror-state", active: true });
  }

  function stop() {
    enabled = false;
    toggleButton.textContent = "Ativar";
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastVideoTime = -1;
    baseline = null;

    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }

    video.srcObject = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSimulationFrame();
    setMirrorMode(false);
    setRoomStatus(roomSocket && roomSocket.readyState === WebSocket.OPEN ? "conectado" : "offline");
    setAction("--");
    setHint("nao diagnostico");
  }

  function drawSimulationFrame(landmarks) {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#07131F";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(67, 215, 188, 0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255, 232, 182, 0.10)";
    ctx.beginPath();
    ctx.ellipse(width * 0.5, height * 0.52, width * 0.13, height * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    if (Array.isArray(landmarks) && landmarks.length > 0) drawPose(landmarks);
    else {
      ctx.strokeStyle = "rgba(255, 232, 182, 0.72)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(width * 0.5, height * 0.26, 18, 0, Math.PI * 2);
      ctx.moveTo(width * 0.36, height * 0.44);
      ctx.lineTo(width * 0.64, height * 0.44);
      ctx.moveTo(width * 0.5, height * 0.35);
      ctx.lineTo(width * 0.5, height * 0.72);
      ctx.moveTo(width * 0.43, height * 0.72);
      ctx.lineTo(width * 0.36, height * 0.90);
      ctx.moveTo(width * 0.57, height * 0.72);
      ctx.lineTo(width * 0.64, height * 0.90);
      ctx.stroke();
    }
  }

  function drawPose(landmarks) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#43D7BC";
    ctx.fillStyle = "#FFE8B6";

    for (const [from, to] of POSE_CONNECTIONS) {
      const a = landmarks[from];
      const b = landmarks[to];
      if (!landmarkOk(a) || !landmarkOk(b)) continue;
      ctx.beginPath();
      ctx.moveTo((1 - a.x) * canvas.width, a.y * canvas.height);
      ctx.lineTo((1 - b.x) * canvas.width, b.y * canvas.height);
      ctx.stroke();
    }

    for (const index of [0, 11, 12, 15, 16, 23, 24, 27, 28]) {
      const point = landmarks[index];
      if (!landmarkOk(point)) continue;
      ctx.beginPath();
      ctx.arc((1 - point.x) * canvas.width, point.y * canvas.height, index === 0 ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function readPoseFeatures(landmarks) {
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const nose = landmarks[0];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];

    if (![leftShoulder, rightShoulder, leftHip, rightHip, nose].every(landmarkOk)) return null;

    const shoulderCenter = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2,
      z: ((leftShoulder.z || 0) + (rightShoulder.z || 0)) / 2
    };
    const hipCenter = {
      x: (leftHip.x + rightHip.x) / 2,
      y: (leftHip.y + rightHip.y) / 2,
      z: ((leftHip.z || 0) + (rightHip.z || 0)) / 2
    };
    const bodyCenter = {
      x: (shoulderCenter.x + hipCenter.x) / 2,
      y: (shoulderCenter.y + hipCenter.y) / 2,
      z: (shoulderCenter.z + hipCenter.z) / 2
    };
    const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
    const bodyHeight = Math.abs(hipCenter.y - nose.y);
    const kneeCenterY = landmarkOk(leftKnee) && landmarkOk(rightKnee) ? (leftKnee.y + rightKnee.y) / 2 : hipCenter.y + 0.22;
    const stanceWidth = landmarkOk(leftAnkle) && landmarkOk(rightAnkle) ? Math.abs(rightAnkle.x - leftAnkle.x) : shoulderWidth;

    return {
      bodyCenter,
      shoulderCenter,
      hipCenter,
      kneeCenterY,
      stanceWidth,
      shoulderWidth,
      bodyHeight,
      shoulderTilt: signedDegreesBetween(leftShoulder, rightShoulder),
      hipTilt: signedDegreesBetween(leftHip, rightHip),
      noseZ: nose.z || 0,
      shoulderZ: shoulderCenter.z,
      shoulderTwist: (rightShoulder.z || 0) - (leftShoulder.z || 0),
      headOffsetX: nose.x - shoulderCenter.x,
      leftWrist,
      rightWrist
    };
  }

  function captureBaseline(features) {
    baseline = {
      centerX: features.bodyCenter.x,
      shoulderY: features.shoulderCenter.y,
      shoulderWidth: features.shoulderWidth,
      noseZ: features.noseZ,
      bodyHeight: features.bodyHeight,
      stanceWidth: features.stanceWidth
    };
    setHint("calibrado");
  }

  function chooseAction(features) {
    if (!baseline) captureBaseline(features);
    if (!baseline) return null;

    const invert = Boolean(invertInput && invertInput.checked);
    const lateral = features.bodyCenter.x - baseline.centerX;
    const duckDelta = features.shoulderCenter.y - baseline.shoulderY;
    const widthDelta = features.shoulderWidth - baseline.shoulderWidth;
    const depthDelta = features.noseZ - baseline.noseZ;
    const lean = features.shoulderTilt;
    const stanceDelta = features.stanceWidth - baseline.stanceWidth;

    if (duckDelta > 0.078 || features.kneeCenterY - features.hipCenter.y < 0.18) return "duck";
    if (widthDelta > 0.07 || depthDelta < -0.10 || stanceDelta > 0.10) return "attack";

    if (Math.abs(lateral) > 0.074 || Math.abs(lean) > 9.5 || Math.abs(features.headOffsetX) > 0.085) {
      const rawDirection = lateral > 0 || lean > 9.5 || features.headOffsetX > 0.085 ? "right" : "left";
      const direction = invert ? (rawDirection === "right" ? "left" : "right") : rawDirection;
      return direction === "left" ? "dodgeLeft" : "dodgeRight";
    }

    return null;
  }

  function dispatchPoseAction(action) {
    if (!action) return;

    const now = performance.now();
    if (now - lastActionAt < 520) return;
    lastActionAt = now;
    setAction(action);
    sendRoomMessage({ type: "pose-action", action });

    const state = getGameState();
    if (!state.running || !state.waitingInput) return;
    if (typeof window.dispatchGameAction !== "function") return;
    window.dispatchGameAction(action, "visao corporal");
  }

  function updateAvatar(features) {
    if (!avatar || !features) return;
    avatar.setAttribute("visible", "true");

    const lateral = baseline ? (features.bodyCenter.x - baseline.centerX) : 0;
    const crouch = baseline ? Math.max(0, features.shoulderCenter.y - baseline.shoulderY) : 0;
    const avatarX = Math.max(-0.75, Math.min(0.75, lateral * -2.35));
    const avatarY = Math.max(-0.22, -crouch * 1.25);
    const yaw = Math.max(-24, Math.min(24, features.shoulderTwist * -120));
    const roll = Math.max(-10, Math.min(10, -features.shoulderTilt * 0.35));

    avatar.setAttribute("position", `${avatarX.toFixed(2)} ${avatarY.toFixed(2)} -3.2`);
    avatar.setAttribute("rotation", `0 ${yaw.toFixed(1)} 0`);

    if (characterModel) {
      characterModel.setAttribute("rotation", `0 0 ${roll.toFixed(1)}`);
      characterModel.setAttribute("scale", getUserGender() === "female" ? "1.04 1.04 1.04" : "1.08 1.08 1.08");
    }

    if (avatarTorso) avatarTorso.setAttribute("rotation", `0 0 ${(-features.shoulderTilt).toFixed(1)}`);
    if (avatarShoulders) avatarShoulders.setAttribute("rotation", `0 0 ${(90 - features.shoulderTilt).toFixed(1)}`);
    if (avatarHips) avatarHips.setAttribute("rotation", `0 0 ${(90 - features.hipTilt).toFixed(1)}`);
    if (avatarHead) avatarHead.setAttribute("position", `${(-features.headOffsetX * 1.8).toFixed(2)} 0.72 0`);

    if (avatarLeftHand && landmarkOk(features.leftWrist)) {
      avatarLeftHand.setAttribute("position", `${((0.5 - features.leftWrist.x) * 1.4).toFixed(2)} ${((0.55 - features.leftWrist.y) * 1.25).toFixed(2)} 0`);
    }
    if (avatarRightHand && landmarkOk(features.rightWrist)) {
      avatarRightHand.setAttribute("position", `${((0.5 - features.rightWrist.x) * 1.4).toFixed(2)} ${((0.55 - features.rightWrist.y) * 1.25).toFixed(2)} 0`);
    }
  }

  function describeBias(features) {
    if (!features || !baseline) return "neutro";
    const shift = (features.bodyCenter.x - baseline.centerX) * 2;
    if (Math.abs(shift) > 0.16) return shift > 0 ? "tendencia direita" : "tendencia esquerda";
    if (Math.abs(features.shoulderTilt) > 7) return features.shoulderTilt > 0 ? "ombro direito baixo" : "ombro esquerdo baixo";
    return "central";
  }

  function updateHint(features, action) {
    if (mirrorMode) {
      setHint(action ? `detectado: ${action}` : `espelho VR ativo - ${describeBias(features)}`);
      return;
    }

    const state = getGameState();
    if (!state.running) {
      setHint("inicie o jogo para controlar");
      return;
    }
    if (!state.waitingInput) {
      setHint("aguardando janela de reacao");
      return;
    }
    if (action) {
      setHint(`detectado: ${action}`);
      return;
    }
    setHint(`esperado: ${state.expectedAction || "--"}`);
  }

  function frame() {
    if (!enabled) return;

    if (!video.videoWidth || !poseLandmarker) {
      drawSimulationFrame();
      rafId = requestAnimationFrame(frame);
      return;
    }

    drawSimulationFrame();

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = poseLandmarker.detectForVideo(video, performance.now());
      const landmarks = result && result.landmarks && result.landmarks[0];

      if (landmarks) {
        drawSimulationFrame(landmarks);
        const features = readPoseFeatures(landmarks);
        if (features) {
          const action = chooseAction(features);
          updateAvatar(features);
          updateHint(features, action);
          dispatchPoseAction(action);
          if (!action && lastActionName !== "--") setAction("--");
        } else {
          setHint("fique de frente para a camera");
        }
      } else {
        setHint("corpo nao detectado");
      }
    }

    rafId = requestAnimationFrame(frame);
  }

  async function start() {
    enabled = true;
    toggleButton.textContent = "Desativar";
    setMirrorMode(true);
    applyCharacterModel();
    setRoomStatus("iniciando");
    setHint("pedindo camera");

    try {
      const cameraReady = await startCamera();
      if (!cameraReady) {
        stop();
        return;
      }
      await ensurePoseLandmarker();
      setRoomStatus("ativo");
      setHint("calibre em posicao neutra");
      frame();
    } catch (error) {
      setRoomStatus("erro");
      setHint("camera/modelo indisponivel");
      stop();
    }
  }

  toggleButton.addEventListener("click", () => {
    if (enabled) stop();
    else start();
  });

  if (calibrateButton) {
    calibrateButton.addEventListener("click", () => {
      baseline = null;
      setHint("calibrando no proximo frame");
    });
  }

  window.addEventListener("auth-state-change", applyCharacterModel);
  applyCharacterModel();
  connectRoom();
  drawSimulationFrame();

  if (params.get("mirror") === "1") {
    window.setTimeout(() => {
      if (!enabled) start();
    }, 700);
  }
})();
