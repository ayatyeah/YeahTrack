import { FilesetResolver, HandLandmarker, PoseLandmarker, FaceLandmarker, ImageSegmenter }
  from './vendor/vision_bundle.mjs';

const video   = document.getElementById('video');
const canvas  = document.getElementById('overlay');
const ctx     = canvas.getContext('2d');
const splash  = document.getElementById('splash');
const splashText = document.getElementById('splashText');
const panel   = document.getElementById('panel');
const fpsEl   = document.getElementById('fps');
const handsEl = document.getElementById('hands');
const gestEl  = document.getElementById('gesture');
const bridgeEl = document.getElementById('bridge');
const toastEl = document.getElementById('toast');
const cameraSelect = document.getElementById('cameraSelect');
const startBtn = document.getElementById('startBtn');
const pinBtn = document.getElementById('pinBtn');
const compactBtn = document.getElementById('compactBtn');

// фоновый режим: браузер без окна, только распознавание и жесты
const DAEMON = new URLSearchParams(location.search).has('daemon');

// то же, что в bridge.py: страница должна работать, даже если /config не ответил
const cfg = {
  osd: true,
  gestures: {
    'swipe-left': 'workspace-right', 'swipe-right': 'workspace-left',
    'swipe-up': 'volume-up', 'swipe-down': 'volume-down',
    'fist-palm': 'overview', 'snap': 'close-tab',
  },
  mouse: { enabled: false, gain: 1700, scrollGain: 1.0, smooth: 0.45 },
  idle: { afterSec: 5, fps: 4 },
  posture: { fps: 3, slouch: 0.12, tiltDeg: 8, holdSec: 8, cooldownSec: 600, voice: false },
  guard: { armSec: 15, sensitivity: 12, cooldownSec: 30, person: true, shots: true },
  wow: { gravity: 1400, bounce: 0.45 },
  tony: { model: 'reactor' },
  edit: { preset: 'gym', seconds: 15, vertical: true, faceTrack: true, fx: [] },
  laid: {
    media: true,
    mediaAfter: 0,            // 0 — по первому сгибанию, иначе столько зачтённых повторений
    window: false,            // true — отдельные окна браузера вместо панелей по краям
    exercise: 'curl',         // какое упражнение выбрано при старте
    restSec: 60,              // отдых между подходами, 0 — без таймера
    muteVideo: true,          // звук отдаём плейлисту, иначе всё смешается
    video: 'https://www.youtube.com/watch?v=M0HEVK6dlGI',
    playlist: 'https://soundcloud.com/dewakii/sets/david-laid',
  },
};

const ACTION_LABELS = {
  'workspace-left': 'рабочий стол ←', 'workspace-right': 'рабочий стол →',
  'overview': 'обзор', 'close-tab': 'закрыть вкладку', 'escape': 'escape',
  'volume-up': 'громче', 'volume-down': 'тише', 'volume-mute': 'звук выключен',
  'media-play': 'пауза / играть', 'media-next': 'следующий трек',
  'media-prev': 'предыдущий трек', 'pin-window': 'окно на все столы',
  'window-above': 'поверх всех окон', 'unmaximize': 'из максимума',
  'maximize': 'развернуть', 'nothing': 'ничего',
};

async function loadConfig() {
  try {
    const j = await (await fetch('/config', { cache: 'no-store' })).json();
    for (const [k, v] of Object.entries(j.config || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(cfg[k], v);
      else cfg[k] = v;
    }
    if (j.error) toast(j.error, true);
  } catch (e) {
    console.warn('конфиг не прочитан, работаю на значениях по умолчанию', e);
  }
  if (opt.mouse) opt.mouse.checked = !!cfg.mouse.enabled;
  if (opt.windows) opt.windows.checked = !!cfg.laid.window;
  if (cfg.laid.exercise && EXERCISES[cfg.laid.exercise]) {
    exercise = cfg.laid.exercise;
    exerciseSel.value = exercise;
  }
  if (typeof cfg.laid.restSec === 'number') opt.rest.value = String(cfg.laid.restSec);
  if (typeof cfg.posture?.slouch === 'number') opt.slouch.value = String(cfg.posture.slouch);
  if (typeof cfg.posture?.holdSec === 'number') opt.hold.value = String(cfg.posture.holdSec);
  if (cfg.posture?.voice) opt.postureVoice.checked = true;
  if (typeof cfg.guard?.sensitivity === 'number') opt.sens.value = String(cfg.guard.sensitivity);
  if (cfg.guard && cfg.guard.person === false) opt.person.checked = false;
  if (cfg.guard && cfg.guard.shots === false) opt.shots.checked = false;
  if (cfg.edit?.preset && PRESETS[cfg.edit.preset]) {
    edit.preset = cfg.edit.preset;
    editPresetSel.value = edit.preset;
  }
  if (typeof cfg.edit?.seconds === 'number') opt.editSec.value = String(cfg.edit.seconds);
  if (cfg.edit && cfg.edit.vertical === false) opt.vertical.checked = false;
  if (cfg.edit && cfg.edit.faceTrack === false) opt.faceTrack.checked = false;
  if (cfg.tony?.model && HOLOS[cfg.tony.model]) {
    tony.model = cfg.tony.model;
    holoSel.value = tony.model;
  }
  if (typeof cfg.wow?.gravity === 'number') opt.gravity.value = String(cfg.wow.gravity);
  if (typeof cfg.wow?.bounce === 'number') opt.bounce.value = String(cfg.wow.bounce);
  for (const key of cfg.edit?.fx ?? []) {
    if (!FX[key]) continue;
    fxOn.add(key);
    if (FX[key].box) FX[key].box.checked = true;
    if (FX[key].needs.includes('seg')) loadSeg().catch(() => {});
  }
  if (cfg.mode && cfg.mode !== 'gestures') setMode(cfg.mode);
}

const opt = {
  skeleton: document.getElementById('optSkeleton'),
  palm:     document.getElementById('optPalm'),
  points:   document.getElementById('optPoints'),
  ids:      document.getElementById('optIds'),
  trail:    document.getElementById('optTrail'),
  mirror:   document.getElementById('optMirror'),
  video:    document.getElementById('optVideo'),
  width:    document.getElementById('optWidth'),
  swipe:    document.getElementById('optSwipe'),
  invert:   document.getElementById('optInvert'),
  thresh:   document.getElementById('optThresh'),
  seq:      document.getElementById('optSeq'),
  snap:     document.getElementById('optSnap'),
  mouse:    document.getElementById('optMouse'),
  grip:     document.getElementById('optGrip'),
  media:    document.getElementById('optMedia'),
  windows:  document.getElementById('optWindows'),
  voice:    document.getElementById('optVoice'),
  rest:     document.getElementById('optRest'),
  slouch:   document.getElementById('optSlouch'),
  hold:     document.getElementById('optHold'),
  postureVoice: document.getElementById('optPostureVoice'),
  person:   document.getElementById('optPerson'),
  sens:     document.getElementById('optSens'),
  shots:    document.getElementById('optShots'),
  editSec:  document.getElementById('optEditSec'),
  faceTrack: document.getElementById('optFaceTrack'),
  vertical: document.getElementById('optVertical'),
  gravity:  document.getElementById('optGravity'),
  bounce:   document.getElementById('optBounce'),
  snapShape: document.getElementById('optSnapShape'),
  hud:      document.getElementById('optHud'),
  telemetry: document.getElementById('optTelemetry'),
  spin:     document.getElementById('optSpin'),
  strict:   document.getElementById('optStrict'),
};

const counterEl  = document.getElementById('counter');
const repsEl     = document.getElementById('reps');
const repsLeftEl = document.getElementById('repsLeft');
const repsRightEl= document.getElementById('repsRight');
const phaseEl    = document.getElementById('phase');
const restEl     = document.getElementById('rest');
const todayEl    = document.getElementById('todayTotal');
const exerciseSel= document.getElementById('exerciseSel');
const postureWarnsEl = document.getElementById('postureWarns');
const guardCountEl   = document.getElementById('guardCount');
const editPresetSel  = document.getElementById('editPreset');
const editRecBtn     = document.getElementById('editRec');
const editSaveEl     = document.getElementById('editSave');
const editMusicEl    = document.getElementById('editMusic');
const shapeCountEl   = document.getElementById('shapeCount');
const wowRecBtn      = document.getElementById('wowRec');
const wowSaveEl      = document.getElementById('wowSave');
const holoSel        = document.getElementById('holoSel');
const holoScaleEl    = document.getElementById('holoScale');
const tonyRecBtn     = document.getElementById('tonyRec');
const tonySaveEl     = document.getElementById('tonySave');
const mediaLeft  = document.getElementById('mediaLeft');
const mediaRight = document.getElementById('mediaRight');
const mediaVideo = document.getElementById('mediaVideo');
const mediaAudio = document.getElementById('mediaAudio');

// --- топология кисти -------------------------------------------------------
const FINGERS = [
  { name: 'thumb',  idx: [0, 1, 2, 3, 4],   color: '#ff6b6b' },
  { name: 'index',  idx: [0, 5, 6, 7, 8],   color: '#ffd166' },
  { name: 'middle', idx: [0, 9, 10, 11, 12],color: '#5ce1e6' },
  { name: 'ring',   idx: [0, 13, 14, 15, 16],color:'#7c9cff' },
  { name: 'pinky',  idx: [0, 17, 18, 19, 20],color:'#c792ea' },
];
const PALM = [0, 1, 2, 5, 9, 13, 17];        // контур ладони
const KNUCKLES = [[5, 9], [9, 13], [13, 17], [2, 5], [0, 17]];
const TIPS = [4, 8, 12, 16, 20];

// --- состояние -------------------------------------------------------------
let landmarker = null;
let stream = null;
let lastVideoTime = -1;
let running = false;
let fpsSmoothed = 0;
let lastHands = 0;
let lastError = '';
const PAGE_ID = Math.random().toString(36).slice(2, 8);
let frameCount = 0;
let lastFrameTs = performance.now();
const trails = [[], []];                      // шлейф кончиков пальцев на руку
const TRAIL_LEN = 14;

// --- загрузка модели -------------------------------------------------------
async function loadModel() {
  const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
  if (DAEMON) return await create(fileset, 'CPU');
  try {
    return await create(fileset, 'GPU');
  } catch (e) {
    console.warn('GPU-делегат недоступен, переключаюсь на CPU', e);
    return await create(fileset, 'CPU');
  }
}

function create(fileset, delegate) {
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: './models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numHands: DAEMON ? 1 : 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

// --- камера ----------------------------------------------------------------
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  cameraSelect.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `Камера ${i + 1}`;
    cameraSelect.appendChild(o);
  });
  cameraSelect.style.display = cams.length > 1 ? '' : 'none';
}

async function startCamera(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: DAEMON ? {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width:  { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 20 },
      facingMode: 'user',
    } : {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    },
    audio: false,
  });
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      lastError = 'поток камеры оборвался';
      if (DAEMON) retryCamera();          // отдали камеру — ждём и берём обратно
    });
  }
  await video.play();
  await listCameras();
  if (!running) { running = true; nextFrame(); }
}

// --- геометрия холста ------------------------------------------------------
function syncCanvas() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  const box = video.getBoundingClientRect();
  const scale = Math.min(box.width / vw, box.height / vh);
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  if (canvas.style.width !== w + 'px') {
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return true;
}

// --- отрисовка -------------------------------------------------------------
function toPx(lm) {
  const x = opt.mirror.checked ? 1 - lm.x : lm.x;
  return [x * canvas.width, lm.y * canvas.height];
}

function drawHand(lms, handIndex, label) {
  const dpr = canvas.width / parseFloat(canvas.style.width);
  const lw = parseFloat(opt.width.value) * dpr;
  const pts = lms.map(toPx);

  if (opt.palm.checked) {
    ctx.beginPath();
    PALM.forEach((i, k) => k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i]));
    ctx.closePath();
    const [cx, cy] = pts[9];
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, canvas.width * 0.22);
    grad.addColorStop(0, 'rgba(92,225,230,.34)');
    grad.addColorStop(1, 'rgba(92,225,230,.06)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(92,225,230,.75)';
    ctx.lineWidth = lw * 0.6;
    ctx.stroke();
  }

  if (opt.skeleton.checked) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = lw * 0.55;
    KNUCKLES.forEach(([a, b]) => {
      ctx.beginPath(); ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); ctx.stroke();
    });

    for (const f of FINGERS) {
      ctx.shadowColor = f.color;
      ctx.shadowBlur = lw * 2.2;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      f.idx.forEach((i, k) => k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i]));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  if (opt.points.checked) {
    for (let i = 0; i < pts.length; i++) {
      const isTip = TIPS.includes(i);
      const r = (isTip ? lw * 0.85 : lw * 0.52);
      ctx.beginPath();
      ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? '#ffffff' : 'rgba(255,255,255,.72)';
      ctx.fill();
    }
  }

  if (opt.ids.checked) {
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.textAlign = 'center';
    pts.forEach((p, i) => ctx.fillText(String(i), p[0], p[1] - lw * 1.4));
  }

  // подпись руки
  const wrist = pts[0];
  ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText(label, wrist[0], wrist[1] + 26 * dpr);

  // шлейф кончиков
  if (opt.trail.checked) {
    const t = trails[handIndex] ||= [];
    t.push(TIPS.map(i => pts[i]));
    if (t.length > TRAIL_LEN) t.shift();
    for (let k = 0; k < t.length - 1; k++) {
      const alpha = (k / t.length) * 0.5;
      for (let f = 0; f < TIPS.length; f++) {
        ctx.beginPath();
        ctx.moveTo(...t[k][f]);
        ctx.lineTo(...t[k + 1][f]);
        ctx.strokeStyle = FINGERS[f].color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = lw * 0.5;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  } else {
    trails[handIndex] = [];
  }
}

// --- простые жесты ---------------------------------------------------------
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
// глубина от модели шумная, для пропорций кисти берём только плоскость
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function gestureOf(lms) {
  const w = lms[0];
  const ext = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]
    .map(([mcp, pip, tip]) => d(lms[tip], w) > d(lms[pip], w) * 1.05);
  const thumb = d(lms[4], lms[17]) > d(lms[3], lms[17]) * 1.08;
  const fingers = ext.filter(Boolean).length;
  const n = fingers + (thumb ? 1 : 0);

  let name = `${n} пальца`;
  if (n === 0) name = 'кулак';
  else if (n === 5) name = 'открытая ладонь';
  else if (thumb && n === 1) name = 'класс';
  else if (ext[0] && n === 1) name = 'указатель';
  else if (ext[0] && ext[1] && n === 2) name = 'виктория';
  else if (ext[0] && ext[3] && n === 2) name = 'рок';
  else if (fingers === 3 && !thumb) name = 'три пальца';

  // свайп ловим двумя позами: три пальца (большой прижат) и раскрытая ладонь
  const three = fingers === 3 && !thumb && ext[0] && ext[1] && ext[2];
  const palm  = fingers === 4;                   // все четыре подняты, большой не важен
  const pose  = three ? 'three' : palm ? 'palm' : null;
  const seqPose = n === 0 ? 'fist' : palm ? 'palm' : 'other';
  return { name, count: n, swipeReady: pose !== null, pose, seqPose, ext, thumb };
}

// --- свайп тремя пальцами → рабочий стол -----------------------------------
const SWIPE_WINDOW   = 460;   // мс, окно накопления траектории
const SWIPE_MIN_TIME = 90;    // мс, короче — это дрожание, а не свайп
const SWIPE_COOLDOWN = 800;   // мс между срабатываниями
const SWIPE_GRACE    = 170;   // мс, столько терпим потерю позы на быстром движении
const swipe = { hist: [], lastFire: 0, busy: false, pose: null, lastSeen: 0 };

let bridgeOk = false;

function palmCenterX(lms) {
  // центр по костяшкам устойчивее, чем одна точка
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += lms[i].x; y += lms[i].y; }
  x /= 5; y /= 5;
  return [opt.mirror.checked ? 1 - x : x, y];
}

function resetSwipe() {
  swipe.hist.length = 0;
  swipe.pose = null;
}

function trackSwipe(cand) {
  if (!opt.swipe.checked || !bridgeOk) { resetSwipe(); return; }
  const now = performance.now();

  if (cand) {
    swipe.pose = cand.pose;
    swipe.lastSeen = now;
    const [x, y] = palmCenterX(cand.lms);
    swipe.hist.push({ t: now, x, y });
  } else if (now - swipe.lastSeen > SWIPE_GRACE) {
    // позу потеряли надолго — это не свайп, а смена жеста
    resetSwipe();
    return;
  }
  while (swipe.hist.length && now - swipe.hist[0].t > SWIPE_WINDOW) swipe.hist.shift();
  if (swipe.hist.length < 3) return;   // в фоне бывает 11 кадров в секунду
  if (now - swipe.lastFire < SWIPE_COOLDOWN || swipe.busy) return;

  const a = swipe.hist[0], b = swipe.hist[swipe.hist.length - 1];
  if (b.t - a.t < SWIPE_MIN_TIME) return;

  const dx = b.x - a.x, dy = b.y - a.y;
  const thresh = parseFloat(opt.thresh.value) * (swipe.pose === 'palm' ? 1.35 : 1);
  const ax = Math.abs(dx), ay = Math.abs(dy);

  let dir = null;
  if (ax >= ay * 1.6 && ax >= thresh) {
    dir = dx > 0 ? 'right' : 'left';                 // направление на экране
    if (opt.invert.checked) dir = dir === 'right' ? 'left' : 'right';
  } else if (ay >= ax * 1.6 && ay >= thresh * 1.3) {
    // по вертикали кисть гуляет чаще, поэтому запас больше
    dir = dy > 0 ? 'down' : 'up';
  }
  if (!dir) return;                                   // диагональ не считаем

  swipe.lastFire = now;
  swipe.hist.length = 0;
  fireGesture('swipe-' + dir);
}

// жест → действие берётся из конфига, поэтому переназначается без правки кода
function fireGesture(gesture) {
  const action = cfg.gestures[gesture];
  if (!action || action === 'nothing') return;
  if (action === 'close-tab') return closeSelf();      // у вкладки свой путь
  fireAction(action, ACTION_LABELS[action] || action);
}

async function fireAction(action, label) {
  swipe.busy = true;
  try {
    const r = await fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) toast(label);
    else toast(j.reason || 'мост не смог', true);
  } catch (e) {
    bridgeOk = false;
    setBridge(false, e.message);
    toast('мост недоступен', true);
  } finally {
    swipe.busy = false;
  }
}

let toastTimer = 0;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.classList.toggle('err', isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 900);
}

function setBridge(ok, reason) {
  bridgeOk = ok;
  bridgeEl.textContent = ok ? 'мост: готов' : 'мост: нет';
  bridgeEl.title = ok ? 'GNOME RemoteDesktop' : (reason || '');
  bridgeEl.classList.toggle('good', ok);
  bridgeEl.classList.toggle('bad', !ok);
}

async function checkBridge() {
  try {
    const j = await (await fetch('/health', { cache: 'no-store' })).json();
    setBridge(!!j.ok, j.reason);
  } catch (e) {
    setBridge(false, 'сервер отдаёт только статику — запусти ./run.sh');
  }
}

// --- связка кулак → ладонь = Super -----------------------------------------
const SEQ_HOLD     = 110;   // мс, столько поза должна продержаться
const SEQ_WINDOW   = 1300;  // мс на разжимание после кулака
const SEQ_COOLDOWN = 1200;  // мс между срабатываниями
const seq = { stage: 'idle', cur: null, since: 0, fistAt: 0, lastFire: 0 };

function trackSequence(pose) {
  if (!opt.seq.checked || !bridgeOk) { seq.stage = 'idle'; seq.cur = null; return; }
  const now = performance.now();
  if (pose !== seq.cur) { seq.cur = pose; seq.since = now; }
  const held = now - seq.since;
  if (now - seq.lastFire < SEQ_COOLDOWN) return;

  if (pose === 'fist' && held >= SEQ_HOLD) {
    seq.stage = 'fist';
    seq.fistAt = now;                    // окно считаем от последнего кадра с кулаком
    return;
  }
  if (seq.stage !== 'fist') return;
  if (pose === 'palm' && held >= SEQ_HOLD) {
    seq.stage = 'idle';
    seq.lastFire = now;
    fireGesture('fist-palm');
  } else if (now - seq.fistAt > SEQ_WINDOW) {
    seq.stage = 'idle';                  // разжал слишком поздно — это не связка
  }
}

// --- щелчок пальцами = закрыть свою вкладку --------------------------------
const SNAP_PINCH  = 0.45;  // доли размера кисти: ближе — щепоть
const SNAP_DELTA  = 0.30;  // на столько должен разъехаться зазор
const SNAP_RATE   = 3.0;   // и не медленнее, чем столько размеров кисти в секунду
const SNAP_WINDOW = 220;   // мс на срыв, медленнее — это просто разжимание
const SNAP_COOLDOWN = 2000;
const SNAP_TRAVEL = 0.05;  // доля кадра: щёлкают пальцами, а не всей рукой
const snap = { armed: false, at: 0, gap: 0, lastFire: 0, wrist: null };

const indexUp = lms => d2(lms[8], lms[0]) > d2(lms[6], lms[0]) * 1.05;

function trackSnap(lms) {
  if (!opt.snap.checked || DAEMON || !lms || cfg.mouse.enabled) {
    snap.armed = false;
    return;
  }
  const now = performance.now();
  if (now - snap.lastFire < SNAP_COOLDOWN) return;

  const size = d2(lms[0], lms[9]) || 1e-6;
  const gap = d2(lms[4], lms[12]) / size;

  // указательный поднят: так щелчок не путается с разжиманием кулака
  if (gap < SNAP_PINCH && indexUp(lms)) {
    snap.armed = true; snap.at = now; snap.gap = gap;
    snap.wrist = { x: lms[0].x, y: lms[0].y };
    return;
  }
  if (!snap.armed) return;
  if (now - snap.at > SNAP_WINDOW) { snap.armed = false; return; }
  const grow = gap - snap.gap;
  const elapsed = Math.max(now - snap.at, 1) / 1000;
  // важна не только величина, но и темп: палец срывается, а не разжимается
  if (grow >= SNAP_DELTA && grow / elapsed >= SNAP_RATE) {
    snap.armed = false;
    // свайп начинается с раскрытия полусогнутой кисти и внешне похож
    // на щелчок; отличает его то, что при свайпе едет вся кисть
    if (snap.wrist && d2(lms[0], snap.wrist) > SNAP_TRAVEL) return;
    snap.lastFire = now;
    fireGesture('snap');
  }
}

function closeSelf() {
  toast('щелчок · закрываю окно');
  window.close();                       // сработает, только если вкладку открыл скрипт
  setTimeout(() => {
    if (!document.hasFocus()) {
      toast('окно не в фокусе — не закрываю', true);
      return;                           // иначе Ctrl+W закроет чужую вкладку
    }
    fireAction('close-tab', 'закрываю вкладку');
  }, 350);
}

// --- мышь рукой ------------------------------------------------------------
// Указательный ведёт курсор, щепоть с большим — левая кнопка и перетаскивание,
// два пальца — колесо, долгая щепоть со средним — правая кнопка.
const MOUSE_PINCH    = 0.5;   // доли размера кисти
const MOUSE_DEADZONE = 0.0015;// меньше — дрожание, а не движение
const RIGHT_HOLD     = 260;   // мс удержания щепоти для правой кнопки
const SCROLL_STEP    = 0.045; // доля кадра на один щелчок колеса

const mouse = {
  sx: 0, sy: 0, has: false,
  left: false, midPinchAt: 0, scrollAcc: 0, busy: false,
};

function sendPointer(body, coalesce = false) {
  // движения схлопываем, чтобы не копить очередь; нажатия — никогда,
  // иначе потерянное отпускание оставит кнопку зажатой
  if (coalesce) {
    if (mouse.busy) return;
    mouse.busy = true;
  }
  fetch('/pointer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {}).finally(() => { if (coalesce) mouse.busy = false; });
}

function mouseRelease() {
  if (mouse.left) {
    mouse.left = false;
    sendPointer({ button: 'left', down: false });
  }
  mouse.has = false;
  mouse.midPinchAt = 0;
  mouse.scrollAcc = 0;
}

function trackMouse(lms, g) {
  if (!cfg.mouse.enabled || !lms || !g) { mouseRelease(); return; }

  const size = d2(lms[0], lms[9]) || 1e-6;
  // кольцевой и мизинец прижаты — это рабочая поза мыши
  const idle = g.ext[2] || g.ext[3];
  if (idle) { mouseRelease(); return; }

  const scrolling = g.ext[0] && g.ext[1];
  const tip = lms[8];
  const x = opt.mirror.checked ? 1 - tip.x : tip.x;
  const y = tip.y;

  const k = Math.min(Math.max(cfg.mouse.smooth, 0), 0.95);
  if (!mouse.has) { mouse.sx = x; mouse.sy = y; mouse.has = true; return; }
  const px = mouse.sx, py = mouse.sy;
  mouse.sx = px * k + x * (1 - k);
  mouse.sy = py * k + y * (1 - k);

  const ndx = mouse.sx - px, ndy = mouse.sy - py;

  if (scrolling) {
    if (mouse.left) { mouse.left = false; sendPointer({ button: 'left', down: false }); }
    mouse.scrollAcc += ndy * (cfg.mouse.scrollGain || 1);
    const step = SCROLL_STEP;
    if (Math.abs(mouse.scrollAcc) >= step) {
      const steps = Math.trunc(mouse.scrollAcc / step);
      mouse.scrollAcc -= steps * step;
      sendPointer({ scroll: steps });               // вниз по экрану — прокрутка вниз
    }
    return;
  }

  if (Math.abs(ndx) > MOUSE_DEADZONE || Math.abs(ndy) > MOUSE_DEADZONE) {
    sendPointer({ move: [ndx * cfg.mouse.gain, ndy * cfg.mouse.gain] }, true);
  }

  const pinchIndex = d2(lms[4], lms[8]) / size < MOUSE_PINCH;
  if (pinchIndex && !mouse.left) {
    mouse.left = true;
    sendPointer({ button: 'left', down: true });
  } else if (!pinchIndex && mouse.left) {
    mouse.left = false;
    sendPointer({ button: 'left', down: false });
  }

  // правая кнопка: щепоть со средним, удержанная дольше щелчка пальцами
  const pinchMiddle = d2(lms[4], lms[12]) / size < MOUSE_PINCH;
  const now = performance.now();
  if (pinchMiddle) {
    if (!mouse.midPinchAt) mouse.midPinchAt = now;
  } else if (mouse.midPinchAt) {
    const held = now - mouse.midPinchAt;
    mouse.midPinchAt = 0;
    if (held >= RIGHT_HOLD && held <= 2000) {
      sendPointer({ button: 'right', down: true });
      setTimeout(() => sendPointer({ button: 'right', down: false }), 60);
      toast('правая кнопка');
    }
  }
}

// --- режим Дэвида Лэйда: счёт повторений ------------------------------------
// Скелет до плеч и ног даёт Pose Landmarker. Считаем угол в суставе по трём
// точкам и ловим переход «рабочее положение → исходное».
const POSE = { LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16, LH: 23, RH: 24 };

// work — угол в рабочей точке (согнуто), rest — в исходной (выпрямлено).
// invert: у махов всё наоборот, там рабочее положение — это больший угол.
const EXERCISES = {
  curl:   { name: 'Подъём на бицепс', joints: { left: [11, 13, 15], right: [12, 14, 16] },
            work: 70, rest: 145, form: true, grip: true },
  press:  { name: 'Жим над головой',  joints: { left: [11, 13, 15], right: [12, 14, 16] },
            work: 95, rest: 155, grip: true },
  pushup: { name: 'Отжимания',        joints: { left: [11, 13, 15], right: [12, 14, 16] },
            work: 100, rest: 155 },
  squat:  { name: 'Приседания',       joints: { left: [23, 25, 27], right: [24, 26, 28] },
            work: 100, rest: 160 },
  raise:  { name: 'Махи в стороны',   joints: { left: [23, 11, 13], right: [24, 12, 14] },
            work: 75, rest: 30, invert: true },
};

const DWELL_MS   = 140;   // столько угол должен продержаться за порогом
const MIN_REP_MS = 350;   // быстрее — это рывок, а не повторение
const MERGE_MS   = 700;   // два подъёма подряд разными сторонами — одно повторение
const GRIP_TTL   = 2500;  // мс: столько помним, что кисть сжата на снаряде
// Это синус наклона плеча от вертикали, больше единицы он не бывает:
// 0.62 — примерно 38 градусов, дальше локоть уже выносится вперёд.
const ELBOW_DRIFT = 0.62;
const CHEAT_FRAMES = 3;   // и не по одному шумному кадру, а подряд
const MIN_LIMB   = 0.05;  // доля кадра: короче — скелет схлопнулся, угол мусорный
const STUCK_MS   = 8000;  // столько висеть в рабочей фазе нельзя, это залипание
const NOTE_MS    = 1800;  // подсказку надо успеть прочитать
const SET_GAP_MS = 20000; // тишина дольше — подход закончился
const CALIB_MS   = 2600;  // столько держим каждое положение при калибровке

let poseLandmarker = null;
let poseLoading = null;
let lastPose = null;
let poseFrame = 0;
let exercise = 'curl';

const freshArm = () => ({
  phase: 'rest',   // rest — исходное положение, work — рабочее
  reps: 0,
  cand: 0,         // когда угол впервые ушёл за порог: ждём, что он там останется
  workAt: 0,       // начало повторения, по нему меряем длительность
  cheat: false,
  bad: 0,          // сколько кадров подряд локоть был не на месте
  gripAt: 0,
  angle: 180,
});

const curl = {
  left: freshArm(),
  right: freshArm(),
  total: 0,
  lastRepAt: 0,
  lastRepSide: null,
  setStartAt: 0,
  note: '',
  noteUntil: 0,
};

// Калибровка живёт в браузере: у каждого своя камера и свой ракурс.
let calib = {};
try {
  calib = JSON.parse(localStorage.getItem('yeahtrack.calib') || '{}');
} catch { calib = {}; }

function limits() {
  const ex = EXERCISES[exercise];
  const own = calib[exercise];
  return own ? { work: own.work, rest: own.rest, invert: ex.invert }
             : { work: ex.work, rest: ex.rest, invert: ex.invert };
}

function say(text) {
  curl.note = text;
  curl.noteUntil = performance.now() + NOTE_MS;
}

function speak(text) {
  if (!opt.voice.checked || DAEMON || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(String(text));
  u.lang = 'ru-RU';
  u.rate = 1.1;
  window.speechSynthesis.cancel();          // очередь не копим, счёт должен успевать
  window.speechSynthesis.speak(u);
}

function loadPose() {
  if (poseLandmarker) return Promise.resolve(poseLandmarker);
  if (poseLoading) return poseLoading;
  poseLoading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const make = delegate => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/pose_landmarker_lite.task', delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    try {
      poseLandmarker = await make(DAEMON ? 'CPU' : 'GPU');
    } catch (e) {
      console.warn('скелет на GPU не пошёл, беру CPU', e);
      poseLandmarker = await make('CPU');
    }
    return poseLandmarker;
  })();
  return poseLoading;
}

// угол в вершине b, в градусах
function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (!n1 || !n2) return 180;
  const cos = Math.min(Math.max((v1x * v2x + v1y * v2y) / (n1 * n2), -1), 1);
  return Math.acos(cos) * 180 / Math.PI;
}

const visible = lm => lm && (lm.visibility === undefined || lm.visibility > 0.5);

// снаряд в руке напрямую не разглядеть: моделей на гантели нет.
// Признак — сжатый кулак у того же запястья, что и рука на скелете.
function markGrips(hands, pose) {
  if (!pose) return;
  const now = performance.now();
  for (const lms of hands) {
    if (gestureOf(lms).seqPose !== 'fist') continue;
    const w = lms[0];
    const dl = d2(w, pose[POSE.LW]), dr = d2(w, pose[POSE.RW]);
    const near = Math.min(dl, dr);
    if (near > 0.2) continue;                         // кисть не у запястья скелета
    // запястья рядом — не гадаем, какой руке засчитать хват, засчитываем обеим
    if (Math.abs(dl - dr) < near * 0.5) {
      curl.left.gripAt = curl.right.gripAt = now;
    } else {
      curl[dl < dr ? 'left' : 'right'].gripAt = now;
    }
  }
}

// читаем угол в суставе, если кадр вообще заслуживает доверия
function readAngle(side, pose) {
  const [A, B, C] = EXERCISES[exercise].joints[side];
  if (!visible(pose[A]) || !visible(pose[B]) || !visible(pose[C])) return null;
  // Звено вышло из кадра или смотрит в объектив — точки схлопываются,
  // и угол превращается в мусор. Такому кадру не верим вовсе.
  if (d2(pose[A], pose[B]) < MIN_LIMB || d2(pose[B], pose[C]) < MIN_LIMB) return null;
  return angleAt(pose[A], pose[B], pose[C]);
}

function countArm(side, pose) {
  const ex = EXERCISES[exercise];
  const arm = curl[side];
  const angle = readAngle(side, pose);
  if (angle === null) { arm.cand = 0; return null; }

  const now = performance.now();
  arm.angle = angle;
  if (calibration.stage) return angle;      // во время калибровки не считаем

  // Залипнуть в рабочей фазе нельзя: если возврата так и не увидели,
  // сбрасываем, иначе счётчик молчит до конца тренировки.
  if (arm.phase === 'work' && now - arm.workAt > STUCK_MS) {
    arm.phase = 'rest';
    arm.cand = 0;
    arm.cheat = false;
    say('потерял возврат, начинаю заново');
  }

  if (ex.form) {
    const [A, B] = ex.joints[side];
    const upper = d2(pose[A], pose[B]) || 1e-6;
    // одиночный выброс координат — это шум, а не раскачка: ждём несколько подряд
    if (Math.abs(pose[B].x - pose[A].x) / upper > ELBOW_DRIFT) {
      if (++arm.bad >= CHEAT_FRAMES) arm.cheat = true;
    } else {
      arm.bad = 0;
    }
  }

  // Точки скелета дрожат, поэтому порог засчитывается не мгновенно:
  // угол должен продержаться за ним DWELL_MS, иначе это шум.
  const lim = limits();
  const wantWork = arm.phase === 'rest';
  const crossed = wantWork
    ? (lim.invert ? angle > lim.work : angle < lim.work)
    : (lim.invert ? angle < lim.rest : angle > lim.rest);
  if (!crossed) { arm.cand = 0; return angle; }

  if (!arm.cand) {
    arm.cand = now;
    // порог 0 — включаем сразу, как пошло движение, не дожидаясь зачёта
    if (wantWork && cfg.laid.mediaAfter <= 0) startMedia();
  }
  if (now - arm.cand < DWELL_MS) return angle;
  arm.cand = 0;

  if (wantWork) {
    arm.phase = 'work';
    arm.workAt = now;
    return angle;
  }

  arm.phase = 'rest';
  const spent = now - arm.workAt;
  const gripOk = !opt.grip.checked || !ex.grip || now - arm.gripAt < GRIP_TTL;
  const formOk = !opt.strict.checked || !ex.form || !arm.cheat;
  arm.cheat = false;
  arm.bad = 0;

  if (spent < MIN_REP_MS) say('слишком быстро, это рывок');
  else if (!gripOk) say('не вижу снаряда в кулаке');
  else if (!formOk) say('читинг: локоть гуляет');
  else {
    arm.reps++;
    // обе стороны работают вместе — это одно повторение, а не два
    const together = curl.lastRepSide && curl.lastRepSide !== side
                     && now - curl.lastRepAt < MERGE_MS;
    if (!together) curl.total++;
    if (!curl.setStartAt) curl.setStartAt = now;
    curl.lastRepAt = now;
    curl.lastRepSide = side;
    onRep(side, together);
    if (cfg.laid.mediaAfter > 0 && curl.total >= cfg.laid.mediaAfter) startMedia();
  }
  return angle;
}

// Показываем живые цифры: так сразу видно, до какого угла доходит движение
// и что мешает засчитать повторение.
function statusLine(angles) {
  const part = (label, side) => {
    const a = angles[side];
    if (a == null) return `${label} не вижу`;
    const arm = curl[side];
    const flag = arm.cheat ? ' локоть!' : '';
    return `${label} ${Math.round(a)}° ${arm.phase === 'work' ? 'вверх' : 'вниз'}${flag}`;
  };
  return `${part('л', 'left')} · ${part('п', 'right')}`;
}

function onRep(side, together) {
  say(together ? 'обе стороны, зачтено'
               : (side === 'left' ? 'левая, зачтено' : 'правая, зачтено'));
  speak(curl.total);
  counterEl.classList.add('hit');
  setTimeout(() => counterEl.classList.remove('hit'), 130);
  if (curl.total % 5 === 0) osdSay(`${curl.total} повторений`);
}

function osdSay(text) {
  // подсказка на экране идёт через мост: видно на любом столе
  fetch('/osd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

// --- подход, отдых, история ------------------------------------------------
const rest = { until: 0, announced: false };

function finishSet() {
  const reps = curl.total;
  if (!reps) return;
  const sec = curl.setStartAt ? Math.round((curl.lastRepAt - curl.setStartAt) / 1000) : 0;
  fetch('/workout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      exercise, reps, sec,
      left: curl.left.reps, right: curl.right.reps,
    }),
  }).then(refreshToday).catch(() => {});

  const pause = parseInt(opt.rest.value, 10) || 0;
  if (pause) {
    rest.until = performance.now() + pause * 1000;
    rest.announced = false;
  }
  speak(`подход закончен, ${reps}`);
  osdSay(`Подход: ${reps} повторений`);
  resetReps(true);
}

function tickRest() {
  if (!rest.until) { restEl.hidden = true; return; }
  const left = Math.ceil((rest.until - performance.now()) / 1000);
  if (left > 0) {
    restEl.hidden = false;
    restEl.textContent = `отдых ${left} с`;
    return;
  }
  rest.until = 0;
  restEl.hidden = true;
  if (!rest.announced) {
    rest.announced = true;
    speak('поехали');
    osdSay('Отдых закончен');
  }
}

async function refreshToday() {
  try {
    const h = await (await fetch('/history', { cache: 'no-store' })).json();
    const mine = h.todayBy?.[exercise];
    todayEl.textContent = h.todayReps
      ? `${h.todayReps}${mine ? ` (${mine} тут)` : ''}`
      : '—';
  } catch { todayEl.textContent = '—'; }
}

// --- калибровка ------------------------------------------------------------
const calibration = { stage: null, until: 0, min: 180, max: 0 };

function startCalibration() {
  calibration.stage = 'rest';
  calibration.until = performance.now() + CALIB_MS;
  calibration.min = 180;
  calibration.max = 0;
  counterEl.classList.add('calib');
  speak('выпрями до конца и держи');
}

function tickCalibration(angles) {
  const now = performance.now();
  const vals = [angles.left, angles.right].filter(a => a != null);
  for (const a of vals) {
    calibration.min = Math.min(calibration.min, a);
    calibration.max = Math.max(calibration.max, a);
  }
  const left = Math.ceil((calibration.until - now) / 1000);

  if (calibration.stage === 'rest') {
    repsEl.textContent = String(Math.max(left, 0));
    curl.note = vals.length ? 'выпрями до конца и держи' : 'встань в кадр';
    if (now < calibration.until) return;
    calibration.restAngle = vals.length ? calibration.max : null;
    calibration.stage = 'work';
    calibration.until = now + CALIB_MS;
    calibration.min = 180;
    calibration.max = 0;
    speak('согни до упора и держи');
    return;
  }

  repsEl.textContent = String(Math.max(left, 0));
  curl.note = vals.length ? 'согни до упора и держи' : 'встань в кадр';
  if (now < calibration.until) return;

  const workAngle = vals.length ? calibration.min : null;
  calibration.stage = null;
  counterEl.classList.remove('calib');

  if (calibration.restAngle == null || workAngle == null
      || Math.abs(calibration.restAngle - workAngle) < 25) {
    say('калибровка не удалась, амплитуда слишком мала');
    speak('не получилось');
    return;
  }
  const ex = EXERCISES[exercise];
  const lo = Math.min(workAngle, calibration.restAngle);
  const hi = Math.max(workAngle, calibration.restAngle);
  const span = hi - lo;
  // Пороги ставим с запасом внутрь диапазона: до самых краёв человек
  // на каждом повторении не доходит.
  const limitsNow = ex.invert
    ? { work: hi - span * 0.3, rest: lo + span * 0.25 }
    : { work: lo + span * 0.3, rest: hi - span * 0.25 };
  calib[exercise] = { work: Math.round(limitsNow.work), rest: Math.round(limitsNow.rest) };
  try { localStorage.setItem('yeahtrack.calib', JSON.stringify(calib)); } catch { /* приватный режим */ }
  say(`готово: рабочий ${calib[exercise].work}°, исходный ${calib[exercise].rest}°`);
  speak('готово');
  resetReps(true);
}

function resetReps(keepNote) {
  curl.left = freshArm();
  curl.right = freshArm();
  curl.total = 0;
  curl.lastRepAt = 0;
  curl.lastRepSide = null;
  curl.setStartAt = 0;
  if (!keepNote) say('счёт обнулён');
  paintCounter();
}

function paintCounter() {
  if (!calibration.stage) repsEl.textContent = String(curl.total);
  repsLeftEl.textContent = String(curl.left.reps);
  repsRightEl.textContent = String(curl.right.reps);
  phaseEl.textContent = curl.note;
}

function drawArms(pose, angles) {
  const dpr = canvas.width / parseFloat(canvas.style.width);
  const lw = parseFloat(opt.width.value) * dpr;
  const px = lm => [(opt.mirror.checked ? 1 - lm.x : lm.x) * canvas.width,
                    lm.y * canvas.height];

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (visible(pose[POSE.LS]) && visible(pose[POSE.RS])) {
    ctx.beginPath();
    ctx.moveTo(...px(pose[POSE.LS]));
    ctx.lineTo(...px(pose[POSE.RS]));
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.lineWidth = lw * 0.7;
    ctx.stroke();
  }

  for (const side of ['left', 'right']) {
    const [A, B, C] = EXERCISES[exercise].joints[side];
    if (!visible(pose[A]) || !visible(pose[B]) || !visible(pose[C])) continue;

    const work = curl[side].phase === 'work';
    ctx.strokeStyle = work ? '#5ce1e6' : 'rgba(255,255,255,.82)';
    ctx.shadowColor = work ? '#5ce1e6' : 'transparent';
    ctx.shadowBlur = work ? lw * 2.4 : 0;
    ctx.lineWidth = lw * 1.15;
    ctx.beginPath();
    ctx.moveTo(...px(pose[A]));
    ctx.lineTo(...px(pose[B]));
    ctx.lineTo(...px(pose[C]));
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const i of [A, B, C]) {
      ctx.beginPath();
      ctx.arc(...px(pose[i]), lw * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }

    const a = angles[side];
    if (a != null) {
      const [ex, ey] = px(pose[B]);
      ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = curl[side].cheat ? '#ff9d9d' : 'rgba(255,255,255,.9)';
      ctx.fillText(`${Math.round(a)}°`, ex + lw * 1.6, ey);
    }
  }
}

function runLaid(drawing) {
  if (!poseLandmarker) { loadPose(); return; }

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastPose = poseLandmarker.detectForVideo(video, performance.now());
    poseFrame++;
  }
  const pose = lastPose?.landmarks?.[0] ?? null;
  if (!pose) {
    if (performance.now() > curl.noteUntil) curl.note = 'встань в кадр целиком';
    paintCounter();
    handsEl.textContent = 'скелет: нет';
    return;
  }

  // кисти нужны только для проверки хвата, поэтому смотрим их через кадр
  if (opt.grip.checked && EXERCISES[exercise].grip && landmarker && poseFrame % 3 === 0) {
    const hres = landmarker.detectForVideo(video, performance.now() + 0.5);
    markGrips(hres?.landmarks ?? [], pose);
  }

  const angles = { left: countArm('left', pose), right: countArm('right', pose) };

  if (calibration.stage) {
    tickCalibration(angles);
    paintCounter();
  } else {
    // тишина после повторений — подход закончился, пора записать и отдохнуть
    if (curl.total && performance.now() - curl.lastRepAt > SET_GAP_MS) finishSet();
    if (performance.now() > curl.noteUntil) curl.note = statusLine(angles);
    paintCounter();
    tickRest();
  }
  if (drawing) drawArms(pose, angles);

  lastHandAt = performance.now();           // в этом режиме дремать нельзя
  handsEl.textContent = `угол ${[angles.left, angles.right]
    .filter(a => a != null).map(a => Math.round(a) + '°').join(' / ') || '—'}`;
  gestEl.textContent = `${EXERCISES[exercise].name}: ${curl.total}`;
}

// --- видео и музыка на время подхода ---------------------------------------
let mediaOn = false;

function youtubeEmbed(url) {
  // принимаем и полную ссылку, и короткую youtu.be, и готовый id
  const m = String(url).match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/);
  const id = m ? m[1] : String(url);
  const mute = opt.media && cfg.laid.muteVideo ? '&mute=1' : '';
  return `https://www.youtube.com/embed/${id}?autoplay=1${mute}&playsinline=1&rel=0`;
}

function soundcloudEmbed(url) {
  const q = encodeURIComponent(url);
  return `https://w.soundcloud.com/player/?url=${q}&auto_play=true`
       + '&hide_related=true&show_comments=false&show_user=false&visual=false';
}

const popups = { video: null, audio: null };

function openPopups() {
  const sw = screen.availWidth, sh = screen.availHeight;
  const vw = Math.min(760, Math.round(sw * 0.36));
  const vh = Math.round(vw * 9 / 16) + 40;
  const aw = Math.min(560, Math.round(sw * 0.28));
  const ah = 320;
  const geo = (w, h, left) => `popup=yes,noopener=no,width=${w},height=${h},`
    + `left=${left},top=${Math.max(Math.round((sh - h) / 2), 0)}`;

  popups.video = window.open(youtubeEmbed(cfg.laid.video), 'yeahtrack-video',
                             geo(vw, vh, 8));
  popups.audio = window.open(soundcloudEmbed(cfg.laid.playlist), 'yeahtrack-audio',
                             geo(aw, ah, Math.max(sw - aw - 8, 0)));
  return !!(popups.video && popups.audio);
}

function closePopups() {
  for (const key of ['video', 'audio']) {
    try { popups[key]?.close(); } catch { /* окно уже закрыли руками */ }
    popups[key] = null;
  }
}

function showPanels() {
  mediaLeft.hidden = false;
  mediaRight.hidden = false;
  panel.classList.add('hidden');           // панель настроек стоит ровно на плеере
  // src ставим только сейчас: иначе плеер грузится и играет до начала подхода
  mediaVideo.src = youtubeEmbed(cfg.laid.video);
  mediaAudio.src = soundcloudEmbed(cfg.laid.playlist);
}

function startMedia() {
  if (mediaOn || DAEMON || !opt.media.checked || !cfg.laid.media) return;
  mediaOn = true;
  if (!opt.windows.checked) return showPanels();
  // всплывающее окно без свежего клика браузер может не пустить
  if (!openPopups()) {
    closePopups();
    showPanels();
    toast('окна заблокированы, показал по краям', true);
  }
}

function stopMedia() {
  if (!mediaOn) return;
  mediaOn = false;
  closePopups();
  mediaLeft.hidden = true;
  mediaRight.hidden = true;
  mediaVideo.src = 'about:blank';                    // так плеер точно замолкает
  mediaAudio.src = 'about:blank';
}

// --- режим осанки ----------------------------------------------------------
// Следим за двумя вещами: не просела ли шея (сутулость) и не перекошены ли
// плечи. Норму берём не из книжки, а из твоей же ровной посадки.
const NOSE = 0;

const posture = {
  base: 0,          // отношение «шея / ширина плеч» в ровной посадке
  neck: 0,
  tilt: 0,
  badSince: 0,
  lastWarn: 0,
  warns: 0,
  calibUntil: 0,
  samples: [],
};

try {
  const saved = parseFloat(localStorage.getItem('yeahtrack.posture') || '');
  if (saved > 0) posture.base = saved;
} catch { /* приватный режим */ }

function postureMetrics(pose) {
  const ls = pose[POSE.LS], rs = pose[POSE.RS], nose = pose[NOSE];
  if (!visible(ls) || !visible(rs) || !visible(nose)) return null;
  const width = d2(ls, rs);
  if (width < 0.08) return null;                  // отвернулся или ушёл далеко
  const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  return {
    neck: d2(nose, mid) / width,                  // чем ниже голова, тем меньше
    tilt: Math.abs(Math.atan2(rs.y - ls.y, rs.x - ls.x) * 180 / Math.PI),
    width,
  };
}

function startPostureCalib() {
  posture.calibUntil = performance.now() + 3000;
  posture.samples = [];
  say('сядь ровно и держи');
  speak('сядь ровно');
}

function runPosture(drawing) {
  if (!poseLandmarker) { loadPose(); return; }

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastPose = poseLandmarker.detectForVideo(video, performance.now());
  }
  const pose = lastPose?.landmarks?.[0] ?? null;
  const m = pose ? postureMetrics(pose) : null;
  const now = performance.now();

  if (!m) {
    posture.badSince = 0;
    curl.note = 'не вижу плечи и голову';
    repsEl.textContent = '—';
    counterEl.classList.remove('bad', 'warn');
    handsEl.textContent = 'осанка: нет кадра';
    if (drawing && pose) drawPosture(pose, null);
    return;
  }

  posture.neck = m.neck;
  posture.tilt = m.tilt;

  if (posture.calibUntil) {
    posture.samples.push(m.neck);
    const left = Math.ceil((posture.calibUntil - now) / 1000);
    repsEl.textContent = String(Math.max(left, 0));
    curl.note = 'сядь ровно и держи';
    if (now >= posture.calibUntil) {
      posture.calibUntil = 0;
      const sorted = posture.samples.slice().sort((a, b) => a - b);
      posture.base = sorted[Math.floor(sorted.length / 2)] || 0;   // медиана устойчивее среднего
      try { localStorage.setItem('yeahtrack.posture', String(posture.base)); } catch { /* ок */ }
      say(`норма запомнена: ${posture.base.toFixed(2)}`);
      speak('запомнил');
    }
    if (drawing) drawPosture(pose, m);
    return;
  }

  if (!posture.base) {
    curl.note = 'нажми «Запомнить ровную посадку»';
    repsEl.textContent = '—';
    if (drawing) drawPosture(pose, m);
    return;
  }

  const slouch = parseFloat(opt.slouch.value);
  const holdMs = parseFloat(opt.hold.value) * 1000;
  const badNeck = m.neck < posture.base * (1 - slouch);
  const badTilt = m.tilt > (cfg.posture.tiltDeg || 8);
  const bad = badNeck || badTilt;

  if (bad) {
    if (!posture.badSince) posture.badSince = now;
  } else {
    posture.badSince = 0;
  }

  const held = posture.badSince ? now - posture.badSince : 0;
  const cool = (cfg.posture.cooldownSec || 600) * 1000;
  if (held > holdMs && now - posture.lastWarn > cool) {
    posture.lastWarn = now;
    posture.warns++;
    const what = badNeck ? 'сутулишься' : 'плечи перекошены';
    osdSay(`Осанка: ${what}`);
    if (opt.postureVoice.checked) speak(what);
    say(`замечание: ${what}`);
  }

  // процент от нормы: 100 — как при калибровке, ниже — голова опустилась
  const score = Math.round(Math.min(m.neck / posture.base, 1.5) * 100);
  repsEl.textContent = `${score}`;
  counterEl.classList.toggle('bad', bad && held > holdMs);
  counterEl.classList.toggle('warn', bad && held <= holdMs);
  if (performance.now() > curl.noteUntil) {
    curl.note = bad
      ? `${badNeck ? 'сутулишься' : 'перекос плеч'} ${Math.round(held / 1000)} с`
      : 'посадка ровная';
  }
  repsLeftEl.textContent = String(posture.warns);
  repsRightEl.textContent = `${Math.round(m.tilt)}°`;
  phaseEl.textContent = curl.note;
  postureWarnsEl.textContent = String(posture.warns);
  handsEl.textContent = `шея ${m.neck.toFixed(2)} · перекос ${Math.round(m.tilt)}°`;
  gestEl.textContent = `осанка ${score}%`;
  if (drawing) drawPosture(pose, m);
}

function drawPosture(pose, m) {
  const dpr = canvas.width / parseFloat(canvas.style.width);
  const lw = parseFloat(opt.width.value) * dpr;
  const px = lm => [(opt.mirror.checked ? 1 - lm.x : lm.x) * canvas.width,
                    lm.y * canvas.height];
  const ls = pose[POSE.LS], rs = pose[POSE.RS], nose = pose[NOSE];
  if (!visible(ls) || !visible(rs)) return;

  const bad = counterEl.classList.contains('bad') || counterEl.classList.contains('warn');
  ctx.lineCap = 'round';
  ctx.lineWidth = lw * 1.1;
  ctx.strokeStyle = bad ? '#ff9d9d' : '#5ce1e6';
  ctx.beginPath();
  ctx.moveTo(...px(ls));
  ctx.lineTo(...px(rs));
  ctx.stroke();

  if (m && visible(nose)) {
    const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(...px(mid));
    ctx.lineTo(...px(nose));
    ctx.strokeStyle = bad ? '#ff9d9d' : 'rgba(255,255,255,.85)';
    ctx.stroke();
  }
  for (const lm of [ls, rs, nose]) {
    if (!visible(lm)) continue;
    ctx.beginPath();
    ctx.arc(...px(lm), lw * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

// --- режим охраны ----------------------------------------------------------
// Движение ловим сравнением кадров на маленьком холсте: это дёшево и работает
// без всяких моделей. Силуэт человека, если он нужен, подтверждает скелет.
const GUARD_W = 64, GUARD_H = 48;
const guardCanvas = document.createElement('canvas');
guardCanvas.width = GUARD_W;
guardCanvas.height = GUARD_H;
const guardCtx = guardCanvas.getContext('2d', { willReadFrequently: true });
const shotCanvas = document.createElement('canvas');

const guard = { prev: null, armAt: 0, lastShot: 0, alarms: 0, busy: false, diff: 0 };

function armGuard() {
  guard.armAt = performance.now() + (cfg.guard.armSec || 15) * 1000;
  guard.prev = null;
  say('охрана включится, уходи из кадра');
}

function frameDiff() {
  guardCtx.drawImage(video, 0, 0, GUARD_W, GUARD_H);
  const cur = guardCtx.getImageData(0, 0, GUARD_W, GUARD_H).data;
  if (!guard.prev) { guard.prev = cur.slice(); return 0; }
  let sum = 0;
  for (let i = 0; i < cur.length; i += 4) {
    // яркость дешевле и устойчивее к шуму цветности
    const a = (cur[i] + cur[i + 1] + cur[i + 2]) / 3;
    const b = (guard.prev[i] + guard.prev[i + 1] + guard.prev[i + 2]) / 3;
    sum += Math.abs(a - b);
  }
  guard.prev = cur.slice();
  return sum / (cur.length / 4);
}

function grabShot() {
  shotCanvas.width = video.videoWidth || 640;
  shotCanvas.height = video.videoHeight || 480;
  shotCanvas.getContext('2d').drawImage(video, 0, 0, shotCanvas.width, shotCanvas.height);
  return shotCanvas.toDataURL('image/jpeg', 0.7);
}

function raiseAlarm(reason) {
  if (guard.busy) return;
  guard.busy = true;
  guard.alarms++;
  guard.lastShot = performance.now();
  const body = { reason };
  if (opt.shots.checked) {
    try { body.image = grabShot(); } catch (e) { console.warn('кадр не снялся', e); }
  }
  fetch('/guard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {}).finally(() => { guard.busy = false; });
  say(`тревога: ${reason}`);
}

function runGuard(drawing) {
  const now = performance.now();
  const arming = now < guard.armAt;
  const wantPerson = opt.person.checked;

  if (wantPerson && !poseLandmarker) { loadPose(); }

  let person = false;
  if (wantPerson && poseLandmarker && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastPose = poseLandmarker.detectForVideo(video, now);
  }
  if (wantPerson) {
    const pose = lastPose?.landmarks?.[0] ?? null;
    person = !!pose && visible(pose[POSE.LS]) && visible(pose[POSE.RS]);
  }

  guard.diff = video.readyState >= 2 ? frameDiff() : 0;
  const moved = guard.diff > parseFloat(opt.sens.value);

  if (arming) {
    repsEl.textContent = String(Math.ceil((guard.armAt - now) / 1000));
    curl.note = 'уходи из кадра';
    counterEl.classList.remove('bad', 'warn');
  } else {
    const cool = (cfg.guard.cooldownSec || 30) * 1000;
    const triggered = wantPerson ? (person && moved) : moved;
    if (triggered && now - guard.lastShot > cool) {
      raiseAlarm(person ? 'человек в кадре' : 'движение');
    }
    repsEl.textContent = String(guard.alarms);
    counterEl.classList.toggle('bad', triggered);
    counterEl.classList.remove('warn');
    if (performance.now() > curl.noteUntil) {
      curl.note = triggered ? 'вижу движение' : 'тихо';
    }
  }

  repsLeftEl.textContent = String(Math.round(guard.diff));
  repsRightEl.textContent = person ? 'человек' : '—';
  phaseEl.textContent = curl.note;
  guardCountEl.textContent = String(guard.alarms);
  handsEl.textContent = `движение ${guard.diff.toFixed(1)}`;
  gestEl.textContent = `тревог: ${guard.alarms}`;
  lastHandAt = now;                       // дремать нельзя, иначе пропустим гостя

  if (drawing && lastPose?.landmarks?.[0]) drawPosture(lastPose.landmarks[0], null);
}

// --- генератор эдитов ------------------------------------------------------
// Лицо держим в кадре моделью лица, биты берём из трека, эффекты бьют по битам.
// Всё рисуется в отдельный холст 1080×1920, он же и пишется в файл.
const PRESETS = {
  gym:    { name: 'Качалка',       filter: 'contrast(1.25) saturate(1.15)', split: 5,  flash: 0.22, shake: 6,  zoom: 0.10, grain: 0.05, vignette: 0.5 },
  neon:   { name: 'Неон',          filter: 'contrast(1.2) saturate(1.6) hue-rotate(-12deg)', split: 9, flash: 0.18, shake: 4, zoom: 0.08, grain: 0.04, vignette: 0.55 },
  film:   { name: 'Плёнка',        filter: 'contrast(1.1) saturate(0.85) sepia(0.18)', split: 2, flash: 0.08, shake: 2, zoom: 0.05, grain: 0.22, vignette: 0.7 },
  bw:     { name: 'Чёрно-белый',   filter: 'grayscale(1) contrast(1.35)', split: 3, flash: 0.25, shake: 5, zoom: 0.09, grain: 0.12, vignette: 0.65 },
  glitch: { name: 'Глитч',         filter: 'contrast(1.3) saturate(1.3)', split: 18, flash: 0.3, shake: 14, zoom: 0.13, grain: 0.08, vignette: 0.45 },
};

const BEAT_GAP = 220;      // мс: чаще этого бит не бывает даже в быстром треке
const BEAT_RISE = 1.35;    // во сколько раз бас должен превысить свою же среднюю
const NO_MUSIC_BPM = 120;  // без трека бьём ровным темпом

const edit = {
  preset: 'gym',
  face: null,              // сглаженная рамка лица
  pulse: 0,                // затухает после каждого бита
  beats: 0,
  lastBeat: 0,
  energy: 0,
  avg: 0,
  recorder: null,
  recSource: null,
  recBtn: null,
  recLink: null,
  chunks: [],
  stopAt: 0,
  url: null,
};

let faceLandmarker = null;
let faceLoading = null;
let lastFace = null;
let lastFxHands = [];
let fxLastAt = 0;
let audioCtx = null, analyser = null, musicEl = null, musicDest = null, freqData = null;

const renderCanvas = document.createElement('canvas');
const rctx = renderCanvas.getContext('2d');
const grainCanvas = document.createElement('canvas');

function makeGrain() {
  grainCanvas.width = grainCanvas.height = 220;
  const g = grainCanvas.getContext('2d');
  const img = g.createImageData(220, 220);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + Math.random() * 130;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
makeGrain();

function loadFace() {
  if (faceLandmarker) return Promise.resolve(faceLandmarker);
  if (faceLoading) return faceLoading;
  faceLoading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const make = delegate => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,        // мимика: рот, брови, моргание
    });
    try {
      faceLandmarker = await make(DAEMON ? 'CPU' : 'GPU');
    } catch (e) {
      console.warn('лицо на GPU не пошло, беру CPU', e);
      faceLandmarker = await make('CPU');
    }
    return faceLandmarker;
  })();
  return faceLoading;
}

// --- музыка и биты ---------------------------------------------------------
async function loadMusic(file) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.loop = true;
    const src = audioCtx.createMediaElementSource(musicEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    musicDest = audioCtx.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(audioCtx.destination);   // слышим
    analyser.connect(musicDest);              // и пишем в ролик
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  musicEl.src = URL.createObjectURL(file);
  await audioCtx.resume();
  say(`трек: ${file.name}`);
}

function detectBeat(now) {
  if (!analyser || musicEl?.paused) {
    // без музыки — ровный метроном, чтобы эдит всё равно дышал
    if (now - edit.lastBeat > 60000 / NO_MUSIC_BPM) { edit.lastBeat = now; edit.beats++; return true; }
    return false;
  }
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 1; i <= 8; i++) sum += freqData[i];      // низ спектра — бочка
  edit.energy = sum / 8;
  edit.avg = edit.avg ? edit.avg * 0.94 + edit.energy * 0.06 : edit.energy;
  if (edit.energy > edit.avg * BEAT_RISE && now - edit.lastBeat > BEAT_GAP) {
    edit.lastBeat = now;
    edit.beats++;
    return true;
  }
  return false;
}

// --- кадрирование по лицу --------------------------------------------------
function faceBox(res) {
  const lm = res?.faceLandmarks?.[0];
  if (!lm || !lm.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

function cropFor(vw, vh, aspect) {
  // без лица берём центр кадра, с лицом — рамку вокруг него с запасом
  const f = edit.face;
  let cx = 0.5, cy = 0.5, height = 1;
  if (f && opt.faceTrack.checked) {
    cx = f.cx;
    cy = f.cy + f.h * 0.35;            // лицо смотрится лучше выше центра
    height = Math.min(f.h * 4.2, 1);
  }
  let ch = height * vh;
  let cw = ch * aspect;
  if (cw > vw) { cw = vw; ch = cw / aspect; }
  const x = Math.min(Math.max(cx * vw - cw / 2, 0), vw - cw);
  const y = Math.min(Math.max(cy * vh - ch / 2, 0), vh - ch);
  return { x, y, w: cw, h: ch };
}

// --- отрисовка кадра эдита -------------------------------------------------
function renderEdit(now) {
  const p = PRESETS[edit.preset] || PRESETS.gym;
  const vertical = opt.vertical.checked;
  const W = vertical ? 1080 : 1280;
  const H = vertical ? 1920 : 720;
  if (renderCanvas.width !== W) { renderCanvas.width = W; renderCanvas.height = H; }

  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const crop = cropFor(vw, vh, W / H);

  // удар: рывок зума, тряска и вспышка затухают к следующему биту
  const k = edit.pulse;
  const zoom = 1 + p.zoom * k;
  const sw = crop.w / zoom, sh = crop.h / zoom;
  const jitter = p.shake * k;
  const sx = crop.x + (crop.w - sw) / 2 + (Math.random() - 0.5) * jitter;
  const sy = crop.y + (crop.h - sh) / 2 + (Math.random() - 0.5) * jitter;

  Object.assign(view, { sx, sy, sw, sh, W, H, vw, vh, mirror: opt.mirror.checked });

  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.globalAlpha = 1;
  rctx.globalCompositeOperation = 'source-over';
  rctx.filter = 'none';

  const person = (fxOn.has('matrix') || fxOn.has('dust')) ? cutPerson() : null;
  const dustK = dustEnvelope(now);

  if (fxOn.has('matrix') && maskReady) {
    // фон в чёрный, тело — падающий код
    rctx.fillStyle = '#000';
    rctx.fillRect(0, 0, W, H);
    if (fxOn.has('echo')) drawEcho(rctx);
    rctx.globalAlpha = 0.25;
    if (person) rctx.drawImage(person, 0, 0);
    rctx.globalAlpha = 1;
    drawMatrix(rctx);
  } else {
    if (fxOn.has('echo')) {
      rctx.fillStyle = '#07080c';
      rctx.fillRect(0, 0, W, H);
      drawEcho(rctx);
    }
    rctx.filter = p.filter;
    rctx.save();
    if (opt.mirror.checked) rctx.setTransform(-1, 0, 0, 1, W, 0);
    // на рассыпании тело растворяется, его заменяют частицы
    rctx.globalAlpha = fxOn.has('dust') ? 1 - dustK * 0.92 : 1;
    rctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    rctx.restore();
    rctx.globalAlpha = 1;
  }

  // цветной развод по краям: два смещённых слоя поверх основного
  const split = p.split * (0.35 + k);
  if (split > 0.5 && !fxOn.has('matrix')) {
    rctx.globalCompositeOperation = 'lighter';
    rctx.globalAlpha = 0.22 + k * 0.18;
    rctx.filter = `${p.filter} hue-rotate(120deg)`;
    rctx.drawImage(video, sx, sy, sw, sh, -split, 0, W, H);
    rctx.filter = `${p.filter} hue-rotate(-120deg)`;
    rctx.drawImage(video, sx, sy, sw, sh, split, 0, W, H);
  }

  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.filter = 'none';
  rctx.globalCompositeOperation = 'source-over';
  rctx.globalAlpha = 1;

  // порядок важен: сначала мир вокруг, потом руки, лицо и частицы поверх
  if (fxOn.has('echo')) pushEcho(person || renderCanvas);
  if (fxOn.size) {
    if (fxOn.has('faceMask') && lastFace) faceEffects(rctx, lastFace, now);
    if (fxOn.has('sparks') || fxOn.has('lightning')) handEffects(rctx, lastFxHands, now);
    stepParticles(Math.min(now - (fxLastAt || now), 60));
    fxLastAt = now;
    drawParticles(rctx);
  }

  if (p.grain > 0) {
    rctx.globalAlpha = p.grain;
    rctx.globalCompositeOperation = 'overlay';
    const gx = -Math.random() * 200, gy = -Math.random() * 200;
    for (let x = gx; x < W; x += 220) {
      for (let y = gy; y < H; y += 220) rctx.drawImage(grainCanvas, x, y);
    }
    rctx.globalCompositeOperation = 'source-over';
    rctx.globalAlpha = 1;
  }

  if (p.vignette > 0) {
    const g = rctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${p.vignette})`);
    rctx.fillStyle = g;
    rctx.fillRect(0, 0, W, H);
  }

  if (k > 0.02 && p.flash > 0) {
    rctx.fillStyle = `rgba(255,255,255,${p.flash * k})`;
    rctx.fillRect(0, 0, W, H);
  }
  return { W, H };
}

// --- эффекты эдита ---------------------------------------------------------
// Каждый эффект — отдельный слой. Модели грузим только те, что нужны
// включённым слоям: лишняя сегментация или лицо стоят кадров.
const FX = {
  echo:      { name: 'Эхо-двойники',        needs: [] },
  matrix:    { name: 'Матрица по силуэту',  needs: ['seg'] },
  dust:      { name: 'Рассыпание в пыль',   needs: ['seg'] },
  sparks:    { name: 'Искры с рук',         needs: ['hands'] },
  lightning: { name: 'Молния между ладоней', needs: ['hands'] },
  faceMask:  { name: 'Маска по лицу',       needs: ['face'] },
};
const fxOn = new Set();

let segmenter = null, segLoading = null;
let maskReady = false;
const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d');
const personCanvas = document.createElement('canvas');
const pctx = personCanvas.getContext('2d');
const fxCanvas = document.createElement('canvas');
const fctx = fxCanvas.getContext('2d');

// система координат кадра: из нормализованных координат модели в пиксели холста
const view = { sx: 0, sy: 0, sw: 1, sh: 1, W: 1, H: 1, vw: 1, vh: 1, mirror: false };
function vx(u) {
  const x = (u * view.vw - view.sx) / view.sw * view.W;
  return view.mirror ? view.W - x : x;
}
const vy = v => (v * view.vh - view.sy) / view.sh * view.H;

function loadSeg() {
  if (segmenter) return Promise.resolve(segmenter);
  if (segLoading) return segLoading;
  segLoading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const make = delegate => ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/selfie_segmenter.tflite', delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    try {
      segmenter = await make(DAEMON ? 'CPU' : 'GPU');
    } catch (e) {
      console.warn('силуэт на GPU не пошёл, беру CPU', e);
      segmenter = await make('CPU');
    }
    return segmenter;
  })();
  return segLoading;
}

// маска приходит в разрешении модели: раскладываем её в альфу отдельного холста
function updateMask(result) {
  const m = result?.categoryMask;
  if (!m) return;
  const mw = m.width, mh = m.height;
  const data = m.getAsUint8Array();
  if (maskCanvas.width !== mw) { maskCanvas.width = mw; maskCanvas.height = mh; }
  const img = mctx.createImageData(mw, mh);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const person = data[i] > 0 ? 255 : 0;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
    img.data[j + 3] = person;
  }
  mctx.putImageData(img, 0, 0);
  maskReady = true;
  m.close?.();
}

// маска и кадр обрезаны одинаково, иначе силуэт разъедется с картинкой
function drawAligned(target, source, w, h) {
  const mx = view.sx / view.vw * w, my = view.sy / view.vh * h;
  const mw = view.sw / view.vw * w, mh = view.sh / view.vh * h;
  target.save();
  if (view.mirror) target.setTransform(-1, 0, 0, 1, view.W, 0);
  target.drawImage(source, mx, my, mw, mh, 0, 0, view.W, view.H);
  target.restore();
}

// вырезаем человека из кадра по маске
function cutPerson() {
  if (!maskReady) return null;
  if (personCanvas.width !== view.W) {
    personCanvas.width = view.W; personCanvas.height = view.H;
  }
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, view.W, view.H);
  pctx.save();
  if (view.mirror) pctx.setTransform(-1, 0, 0, 1, view.W, 0);
  pctx.drawImage(video, view.sx, view.sy, view.sw, view.sh, 0, 0, view.W, view.H);
  pctx.restore();
  pctx.globalCompositeOperation = 'destination-in';
  drawAligned(pctx, maskCanvas, maskCanvas.width, maskCanvas.height);
  pctx.globalCompositeOperation = 'source-over';
  return personCanvas;
}

// --- частицы ---------------------------------------------------------------
const MAX_PARTS = 6000;
const parts = [];

function spawn(x, y, vxp, vyp, opts = {}) {
  if (parts.length >= MAX_PARTS) return;
  parts.push({
    x, y, ox: x, oy: y, vx: vxp, vy: vyp,
    life: 0, max: opts.max ?? 700,
    size: opts.size ?? 2.4, hue: opts.hue ?? 185,
    back: !!opts.back,                    // вернуться в исходную точку
    grav: opts.grav ?? 0,
  });
}

function stepParticles(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life += dt;
    if (p.life >= p.max) { parts.splice(i, 1); continue; }
    const t = p.life / p.max;
    if (p.back) {
      // разлетелся и вернулся: синус даёт ровный вылет и сбор
      const k = Math.sin(Math.PI * t);
      p.x = p.ox + p.vx * k;
      p.y = p.oy + p.vy * k;
    } else {
      p.x += p.vx * dt / 1000;
      p.y += p.vy * dt / 1000;
      p.vy += p.grav * dt / 1000;
    }
  }
}

function drawParticles(target) {
  target.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    const t = p.life / p.max;
    const a = p.back ? Math.sin(Math.PI * t) : 1 - t;
    target.fillStyle = `hsla(${p.hue}, 100%, ${60 + 25 * a}%, ${a})`;
    const sz = p.size * (0.6 + a * 0.8);
    target.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
  }
  target.globalCompositeOperation = 'source-over';
}

// --- рассыпание в пыль -----------------------------------------------------
const dust = { at: 0, dur: 1100 };

function burstDust() {
  if (!maskReady) return;
  const mw = maskCanvas.width, mh = maskCanvas.height;
  const data = mctx.getImageData(0, 0, mw, mh).data;
  const step = 3;
  let cx = 0, cy = 0, n = 0;
  for (let y = 0; y < mh; y += step) {
    for (let x = 0; x < mw; x += step) {
      if (data[(y * mw + x) * 4 + 3] > 0) { cx += x; cy += y; n++; }
    }
  }
  if (!n) return;
  cx /= n; cy /= n;
  for (let y = 0; y < mh; y += step) {
    for (let x = 0; x < mw; x += step) {
      if (data[(y * mw + x) * 4 + 3] === 0) continue;
      if (Math.random() > 0.55) continue;             // прореживаем, чтобы не задохнуться
      const px = vx(x / mw), py = vy(y / mh);
      const dx = x - cx, dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const amp = 90 + Math.random() * 260;
      spawn(px, py, (dx / len) * amp + (Math.random() - 0.5) * 60,
            (dy / len) * amp + (Math.random() - 0.5) * 60,
            { max: dust.dur, size: 2 + Math.random() * 2, hue: 190 + Math.random() * 40, back: true });
    }
  }
  dust.at = performance.now();
}

const dustEnvelope = now => {
  if (!dust.at) return 0;
  const t = (now - dust.at) / dust.dur;
  return t >= 1 ? 0 : Math.sin(Math.PI * t);
};

// --- матрица по силуэту ----------------------------------------------------
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789<>/\\|[]{}=+*';
const matrix = { cols: [], cell: 22, w: 0 };

function drawMatrix(target) {
  const W = view.W, H = view.H;
  if (fxCanvas.width !== W) { fxCanvas.width = W; fxCanvas.height = H; }
  if (matrix.w !== W) {
    matrix.w = W;
    matrix.cell = Math.max(Math.round(W / 46), 14);
    matrix.cols = Array.from({ length: Math.ceil(W / matrix.cell) }, () => ({
      y: Math.random() * H,
      speed: 180 + Math.random() * 420,
    }));
  }
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, W, H);
  fctx.font = `${matrix.cell}px monospace`;
  fctx.textBaseline = 'top';
  const dt = 1 / 30;
  for (let i = 0; i < matrix.cols.length; i++) {
    const c = matrix.cols[i];
    c.y += c.speed * dt;
    if (c.y > H + matrix.cell * 8) c.y = -matrix.cell * (2 + Math.random() * 8);
    const x = i * matrix.cell;
    for (let k = 0; k < 9; k++) {
      const y = c.y - k * matrix.cell;
      if (y < -matrix.cell || y > H) continue;
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      fctx.fillStyle = k === 0 ? 'rgba(210,255,220,.95)'
                               : `rgba(40,255,120,${0.75 - k * 0.08})`;
      fctx.fillText(ch, x, y);
    }
  }
  // код живёт только внутри силуэта
  fctx.globalCompositeOperation = 'destination-in';
  drawAligned(fctx, maskCanvas, maskCanvas.width, maskCanvas.height);
  fctx.globalCompositeOperation = 'source-over';
  target.drawImage(fxCanvas, 0, 0);
}

// --- эхо-двойники ----------------------------------------------------------
const echo = { frames: [], every: 3, tick: 0, keep: 6 };

function pushEcho(source) {
  if (++echo.tick % echo.every) return;
  const w = Math.round(view.W / 3), h = Math.round(view.H / 3);
  let c = echo.frames.length >= echo.keep ? echo.frames.shift() : document.createElement('canvas');
  if (c.width !== w) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.drawImage(source, 0, 0, w, h);
  echo.frames.push(c);
}

function drawEcho(target) {
  target.globalCompositeOperation = 'lighter';
  echo.frames.forEach((c, i) => {
    const a = 0.06 + i * 0.05;
    target.globalAlpha = a;
    target.filter = `hue-rotate(${(echo.frames.length - i) * 22}deg) saturate(1.6)`;
    const off = (echo.frames.length - i) * 6;
    target.drawImage(c, -off, 0, view.W, view.H);
  });
  target.globalAlpha = 1;
  target.filter = 'none';
  target.globalCompositeOperation = 'source-over';
}

// --- искры с рук и молния --------------------------------------------------
const fxHands = { list: [], snap: { armed: false, at: 0, gap: 0, wrist: null }, clapAt: 0 };
const TIPS_FX = [4, 8, 12, 16, 20];

function snapSignalFx(lms, now) {
  const size = d2(lms[0], lms[9]) || 1e-6;
  const gap = d2(lms[4], lms[12]) / size;
  const st = fxHands.snap;
  if (gap < 0.45 && d2(lms[8], lms[0]) > d2(lms[6], lms[0]) * 1.05) {
    if (!st.armed) st.gap = gap; else st.gap = Math.min(st.gap, gap);
    st.armed = true; st.at = now; st.wrist = { x: lms[0].x, y: lms[0].y };
    return false;
  }
  if (!st.armed) return false;
  if (now - st.at > 220) { st.armed = false; return false; }
  const grow = gap - st.gap;
  if (grow < 0.3 || grow / ((now - st.at) / 1000 || 1) < 3) return false;
  st.armed = false;
  if (st.wrist && d2(lms[0], st.wrist) > 0.05) return false;   // это свайп, а не щелчок
  return true;
}

function handEffects(target, hands, now) {
  if (!hands.length) return;

  for (const lms of hands) {
    for (const i of TIPS_FX) {
      const x = vx(lms[i].x), y = vy(lms[i].y);
      if (fxOn.has('sparks')) {
        for (let k = 0; k < 2; k++) {
          spawn(x, y, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120 - 40,
                { max: 520, size: 1.8 + Math.random() * 2.2, hue: 180 + Math.random() * 60, grav: 260 });
        }
      }
    }
    if (fxOn.has('sparks') && snapSignalFx(lms, now)) {
      const x = vx(lms[4].x), y = vy(lms[4].y);
      for (let k = 0; k < 420; k++) {
        const a = Math.random() * Math.PI * 2, sp = 200 + Math.random() * 900;
        spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
              { max: 700, size: 2 + Math.random() * 3, hue: 40 + Math.random() * 40, grav: 320 });
      }
      target.fillStyle = 'rgba(255,240,200,.35)';
      target.fillRect(0, 0, view.W, view.H);
    }
  }

  if (fxOn.has('lightning') && hands.length >= 2) {
    const a = { x: vx(hands[0][9].x), y: vy(hands[0][9].y) };
    const b = { x: vx(hands[1][9].x), y: vy(hands[1][9].y) };
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    drawBolt(target, a, b, 1);
    // ладони сошлись — хлопок, вспышка на весь кадр
    if (dist < view.W * 0.12 && now - fxHands.clapAt > 600) {
      fxHands.clapAt = now;
      for (let k = 0; k < 500; k++) {
        const ang = Math.random() * Math.PI * 2, sp = 300 + Math.random() * 1100;
        spawn((a.x + b.x) / 2, (a.y + b.y) / 2, Math.cos(ang) * sp, Math.sin(ang) * sp,
              { max: 620, size: 2 + Math.random() * 3, hue: 190 + Math.random() * 50, grav: 200 });
      }
    }
    if (now - fxHands.clapAt < 120) {
      target.fillStyle = `rgba(220,245,255,${0.5 * (1 - (now - fxHands.clapAt) / 120)})`;
      target.fillRect(0, 0, view.W, view.H);
    }
  }
}

// ломаная с ветвлением: дёшево, а читается как разряд
function drawBolt(target, a, b, depth) {
  const segs = 14;
  target.save();
  target.globalCompositeOperation = 'lighter';
  target.strokeStyle = depth === 1 ? 'rgba(190,235,255,.95)' : 'rgba(140,210,255,.6)';
  target.lineWidth = depth === 1 ? 3.5 : 1.6;
  target.shadowColor = '#7fd8ff';
  target.shadowBlur = depth === 1 ? 26 : 10;
  target.beginPath();
  target.moveTo(a.x, a.y);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const j = (Math.random() - 0.5) * len * 0.18 * Math.sin(Math.PI * t);
    const px = a.x + (b.x - a.x) * t + nx * j;
    const py = a.y + (b.y - a.y) * t + ny * j;
    target.lineTo(px, py);
    if (depth === 1 && Math.random() < 0.18) {
      const end = { x: px + (Math.random() - 0.5) * len * 0.4,
                    y: py + (Math.random() - 0.5) * len * 0.4 };
      drawBolt(target, { x: px, y: py }, end, 2);
    }
  }
  target.stroke();
  target.restore();
}

// --- маска по лицу ---------------------------------------------------------
const EYE_L = [33, 133, 159, 145], EYE_R = [362, 263, 386, 374];
const MOUTH = [13, 14, 78, 308];
const blend = {};

function faceEffects(target, res, now) {
  const lm = res?.faceLandmarks?.[0];
  if (!lm) return;
  for (const c of res.faceBlendshapes?.[0]?.categories ?? []) blend[c.categoryName] = c.score;

  const tess = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  if (tess) {
    target.save();
    target.globalCompositeOperation = 'lighter';
    target.strokeStyle = 'rgba(120,230,255,.22)';
    target.lineWidth = 1;
    target.beginPath();
    for (const c of tess) {
      const a = lm[c.start], b = lm[c.end];
      if (!a || !b) continue;
      target.moveTo(vx(a.x), vy(a.y));
      target.lineTo(vx(b.x), vy(b.y));
    }
    target.stroke();
    target.restore();
  }

  const mid = idx => {
    let x = 0, y = 0;
    for (const i of idx) { x += lm[i].x; y += lm[i].y; }
    return { x: vx(x / idx.length), y: vy(y / idx.length) };
  };

  // брови вверх — глаза загораются
  const brow = Math.max(blend.browInnerUp ?? 0, blend.browOuterUpLeft ?? 0);
  if (brow > 0.3) {
    for (const eye of [mid(EYE_L), mid(EYE_R)]) {
      const r = view.W * 0.05 * (0.6 + brow);
      const g = target.createRadialGradient(eye.x, eye.y, 1, eye.x, eye.y, r);
      g.addColorStop(0, `rgba(255,240,180,${0.85 * brow})`);
      g.addColorStop(1, 'rgba(255,180,40,0)');
      target.globalCompositeOperation = 'lighter';
      target.fillStyle = g;
      target.beginPath();
      target.arc(eye.x, eye.y, r, 0, Math.PI * 2);
      target.fill();
      target.globalCompositeOperation = 'source-over';
    }
  }

  // открыл рот — оттуда идёт огонь
  const jaw = blend.jawOpen ?? 0;
  if (jaw > 0.3) {
    const m = mid(MOUTH);
    const count = Math.round(jaw * 18);
    for (let k = 0; k < count; k++) {
      spawn(m.x + (Math.random() - 0.5) * view.W * 0.05, m.y,
            (Math.random() - 0.5) * 120, -160 - Math.random() * 420,
            { max: 620, size: 2.5 + Math.random() * 3.5, hue: 20 + Math.random() * 35, grav: 120 });
    }
  }
}

// --- запись ----------------------------------------------------------------
function pickMime() {
  const want = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return want.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

function startEditRec(source, btn, link) {
  if (edit.recorder) return stopEditRec();
  if (!window.MediaRecorder) { say('браузер не умеет запись'); return; }
  edit.recSource = source || renderCanvas;
  edit.recBtn = btn || editRecBtn;
  edit.recLink = link || editSaveEl;
  if (edit.recSource === renderCanvas) renderEdit(performance.now());  // холст должен быть готов
  const stream = edit.recSource.captureStream(30);
  if (musicDest) for (const t of musicDest.stream.getAudioTracks()) stream.addTrack(t);
  const mime = pickMime();
  try {
    edit.recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
  } catch (e) {
    say(`запись не пошла: ${e.message}`);
    return;
  }
  edit.chunks = [];
  edit.recorder.ondataavailable = e => { if (e.data.size) edit.chunks.push(e.data); };
  edit.recorder.onstop = finishEditRec;
  edit.recorder.start(500);
  edit.stopAt = performance.now() + parseFloat(opt.editSec.value) * 1000;
  if (musicEl?.src) { musicEl.currentTime = 0; musicEl.play().catch(() => {}); }
  edit.recBtn.textContent = 'Стоп';
  counterEl.classList.add('rec');
  say('пишу, работай на камеру');
}

function stopEditRec() {
  if (!edit.recorder) return;
  try { edit.recorder.stop(); } catch { /* уже остановлен */ }
  edit.recorder = null;
  edit.stopAt = 0;
  musicEl?.pause();
  if (edit.recBtn) {
    edit.recBtn.textContent = edit.recBtn === editRecBtn ? 'Записать эдит' : 'Записать';
  }
  counterEl.classList.remove('rec');
}

function finishEditRec() {
  const blob = new Blob(edit.chunks, { type: 'video/webm' });
  edit.chunks = [];
  if (edit.url) URL.revokeObjectURL(edit.url);
  edit.url = URL.createObjectURL(blob);
  const link = edit.recLink || editSaveEl;
  link.href = edit.url;
  const tag = link === wowSaveEl ? 'wow' : link === tonySaveEl ? 'tony' : `edit-${edit.preset}`;
  link.download = `${tag}-${Date.now()}.webm`;
  link.hidden = false;
  link.textContent = `Скачать ролик (${(blob.size / 1048576).toFixed(1)} МБ)`;
  say('готово, ролик можно скачать');
  osdSay('Эдит готов');
}

// --- цикл режима -----------------------------------------------------------
function fxNeeds(kind) {
  if (kind === 'face') return true;                 // рамка лица нужна всегда
  for (const key of fxOn) if (FX[key].needs.includes(kind)) return true;
  return false;
}

function runEdit(drawing) {
  if (!faceLandmarker) { loadFace(); return; }
  const now = performance.now();

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = faceLandmarker.detectForVideo(video, now);
    lastFace = res;

    if (fxNeeds('hands') && landmarker) {
      lastFxHands = landmarker.detectForVideo(video, now + 0.3)?.landmarks ?? [];
    } else {
      lastFxHands = [];
    }
    if (fxNeeds('seg')) {
      if (!segmenter) loadSeg();
      else updateMask(segmenter.segmentForVideo(video, now + 0.6));
    }

    const box = faceBox(res);
    if (box) {
      // рамку сглаживаем, иначе кадр дёргается на каждом кадре модели
      edit.face = edit.face
        ? { cx: edit.face.cx * 0.8 + box.cx * 0.2, cy: edit.face.cy * 0.8 + box.cy * 0.2,
            w: edit.face.w * 0.8 + box.w * 0.2, h: edit.face.h * 0.8 + box.h * 0.2 }
        : box;
    }
  }

  if (detectBeat(now)) {
    edit.pulse = 1;
    if (fxOn.has('dust') && maskReady && now - dust.at > dust.dur) burstDust();
  }
  edit.pulse *= 0.86;                             // затухание удара
  if (edit.pulse < 0.01) edit.pulse = 0;

  const { W, H } = renderEdit(now);

  if (drawing) {
    // показываем результат как есть, вписывая его в холст страницы
    const scale = Math.min(canvas.width / W, canvas.height / H);
    const dw = W * scale, dh = H * scale;
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(renderCanvas, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  if (edit.recorder && now > edit.stopAt) stopEditRec();

  const left = edit.recorder ? Math.ceil((edit.stopAt - now) / 1000) : 0;
  repsEl.textContent = edit.recorder ? String(left) : String(edit.beats);
  repsLeftEl.textContent = edit.face ? 'лицо' : 'нет лица';
  repsRightEl.textContent = `${edit.beats} битов`;
  if (performance.now() > curl.noteUntil) {
    curl.note = edit.recorder ? 'идёт запись' : (musicEl?.src ? 'трек заряжен' : 'можно без музыки');
  }
  phaseEl.textContent = curl.note;
  handsEl.textContent = `${edit.face ? 'лицо' : 'нет лица'} · частиц ${parts.length}`;
  gestEl.textContent = `${PRESETS[edit.preset].name} · ${edit.beats}`;
  lastHandAt = now;
}

// --- вау-режим: фигуры из воздуха ------------------------------------------
// Рисуешь пальцем — штрих распознаётся и превращается в ровную фигуру.
// Фигуры живые: падают, сталкиваются, их можно схватить кулаком и бросить.
const SHAPE_MIN_PTS = 12;
const SHAPE_MIN_SIZE = 46;      // px: меньше — случайный тык, а не фигура
const FRAME_HOLD = 450;         // мс удержания «уголков» до прямоугольника
const GRAB_RADIUS = 1.25;       // радиусы фигуры, в пределах которых кулак хватает
const CLAP_DIST = 0.13;         // доля ширины кадра между ладонями

const wow = {
  shapes: [],
  stroke: [],
  drawing: false,
  frameSince: 0,
  framePreview: null,
  clapAt: 0,
  grabbed: new Map(),           // рука → фигура
  lastAt: 0,
  hint: '',
};

const SHAPE_HUES = { circle: 190, rect: 275, tri: 45, line: 140, poly: 320 };

// --- распознавание штриха --------------------------------------------------
function strokeBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// Рамер-Дуглас-Пекер: выкидываем точки, которые почти лежат на хорде.
// Сколько вершин осталось — столько углов у фигуры.
function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let far = 0, idx = -1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
    if (d > far) { far = d; idx = i; }
  }
  if (far <= eps || idx < 0) return [a, b];
  return simplify(pts.slice(0, idx + 1), eps)
    .slice(0, -1)
    .concat(simplify(pts.slice(idx), eps));
}

// На замкнутом штрихе первая и последняя точки совпадают, хорда нулевая,
// и обычный Дуглас-Пекер выкидывает вообще все вершины. Поэтому рвём контур
// в самой дальней от начала точке и упрощаем две половины по отдельности.
function simplifyClosed(pts, eps) {
  const a = pts[0];
  let idx = 1, far = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - a.x, pts[i].y - a.y);
    if (d > far) { far = d; idx = i; }
  }
  const head = simplify(pts.slice(0, idx + 1), eps);
  const tail = simplify(pts.slice(idx), eps);
  return head.slice(0, -1).concat(tail);
}

// Точка разрыва сама попадает в вершины, хотя углом не является.
// Выкидываем всё, где поворот слишком мал.
function dropStraight(poly, minTurn = 32) {
  const closed = poly.length > 2;
  const v = closed ? poly.slice(0, -1) : poly.slice();
  if (v.length < 4) return v;
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[(i - 1 + v.length) % v.length], c = v[i], n = v[(i + 1) % v.length];
    const a1 = Math.atan2(c.y - p.y, c.x - p.x);
    const a2 = Math.atan2(n.y - c.y, n.x - c.x);
    let turn = Math.abs((a2 - a1) * 180 / Math.PI) % 360;
    if (turn > 180) turn = 360 - turn;
    if (turn >= minTurn) out.push(c);
  }
  return out.length >= 3 ? out : v;
}

function recognize(pts) {
  const box = strokeBox(pts);
  const diag = Math.hypot(box.w, box.h);
  if (pts.length < SHAPE_MIN_PTS || Math.max(box.w, box.h) < SHAPE_MIN_SIZE) return null;

  const first = pts[0], last = pts[pts.length - 1];
  const closed = Math.hypot(last.x - first.x, last.y - first.y) < diag * 0.38;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;

  if (!closed) {
    // почти прямая — это линия, а не кривая
    const dev = pts.reduce((m, p) => {
      const dxl = last.x - first.x, dyl = last.y - first.y;
      const l = Math.hypot(dxl, dyl) || 1;
      return Math.max(m, Math.abs((p.x - first.x) * dyl - (p.y - first.y) * dxl) / l);
    }, 0);
    if (dev < diag * 0.16) {
      return { kind: 'line', x: cx, y: cy, r: Math.hypot(last.x - first.x, last.y - first.y) / 2,
               ax: first.x - cx, ay: first.y - cy, bx: last.x - cx, by: last.y - cy };
    }
  }

  // Круг: все точки примерно на одном расстоянии от центра. Порог взят
  // из замеров: круг от руки даёт разброс до 0.05, квадрат 0.115,
  // прямоугольник 0.26, треугольник 0.31.
  const rs = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const dev = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length) / (mean || 1);
  if (closed && dev < 0.075) return { kind: 'circle', x: cx, y: cy, r: mean };

  const rough = closed ? simplifyClosed(pts, diag * 0.075) : simplify(pts, diag * 0.075);
  const corners = dropStraight(rough);
  const n = corners.length;
  if (closed && n === 3) {
    return { kind: 'tri', x: cx, y: cy, r: Math.max(box.w, box.h) / 2,
             pts: corners.map(p => ({ x: p.x - cx, y: p.y - cy })) };
  }
  if (closed && n >= 4 && n <= 6) {
    return { kind: 'rect', x: cx, y: cy, w: box.w, h: box.h,
             r: Math.hypot(box.w, box.h) / 2 };
  }
  if (closed) return { kind: 'circle', x: cx, y: cy, r: mean };
  return null;
}

function addShape(def) {
  const hue = SHAPE_HUES[def.kind] ?? 200;
  wow.shapes.push({
    angle: 0, va: (Math.random() - 0.5) * 1.2, vx: 0, vy: 0,
    hue, born: performance.now(), ...def,
  });
  if (wow.shapes.length > 40) wow.shapes.shift();
  for (let k = 0; k < 90; k++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
    spawn(def.x, def.y, Math.cos(a) * sp, Math.sin(a) * sp,
          { max: 620, size: 2 + Math.random() * 2, hue, grav: 200 });
  }
  wow.hint = { circle: 'круг', rect: 'прямоугольник', tri: 'треугольник',
               line: 'линия', poly: 'фигура' }[def.kind] + ' готов';
}

// --- физика ----------------------------------------------------------------
function stepShapes(dt, W, H) {
  const g = parseFloat(opt.gravity.value);
  const bounce = parseFloat(opt.bounce.value);
  const s = dt / 1000;

  for (const sh of wow.shapes) {
    if (sh.held) continue;                       // в руке физика не нужна
    sh.vy += g * s;
    sh.x += sh.vx * s;
    sh.y += sh.vy * s;
    sh.angle += sh.va * s;

    if (sh.y + sh.r > H) { sh.y = H - sh.r; sh.vy = -sh.vy * bounce; sh.vx *= 0.92; sh.va *= 0.9; }
    if (sh.y - sh.r < 0) { sh.y = sh.r; sh.vy = -sh.vy * bounce; }
    if (sh.x - sh.r < 0) { sh.x = sh.r; sh.vx = -sh.vx * bounce; }
    if (sh.x + sh.r > W) { sh.x = W - sh.r; sh.vx = -sh.vx * bounce; }
  }

  // столкновения считаем по описанным окружностям: дёшево и выглядит честно
  for (let i = 0; i < wow.shapes.length; i++) {
    for (let j = i + 1; j < wow.shapes.length; j++) {
      const a = wow.shapes[i], b = wow.shapes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const overlap = a.r + b.r - dist;
      if (overlap <= 0) continue;
      const nx = dx / dist, ny = dy / dist;
      const push = overlap / 2;
      if (!a.held) { a.x -= nx * push; a.y -= ny * push; }
      if (!b.held) { b.x += nx * push; b.y += ny * push; }
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel > 0) continue;
      const imp = -rel * (0.5 + bounce / 2);
      if (!a.held) { a.vx -= imp * nx; a.vy -= imp * ny; }
      if (!b.held) { b.vx += imp * nx; b.vy += imp * ny; }
      a.va += (Math.random() - 0.5) * 0.4;
      b.va += (Math.random() - 0.5) * 0.4;
    }
  }
}

function shockwave(x, y, W) {
  for (const sh of wow.shapes) {
    const dx = sh.x - x, dy = sh.y - y;
    const d = Math.hypot(dx, dy) || 1;
    const power = Math.max(1 - d / (W * 0.9), 0.15) * 1700;
    sh.vx += (dx / d) * power;
    sh.vy += (dy / d) * power - 220;
    sh.va += (Math.random() - 0.5) * 6;
    sh.held = false;
  }
  for (let k = 0; k < 320; k++) {
    const a = Math.random() * Math.PI * 2, sp = 300 + Math.random() * 900;
    spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
          { max: 620, size: 2 + Math.random() * 3, hue: 190 + Math.random() * 60, grav: 300 });
  }
}

// --- отрисовка -------------------------------------------------------------
function drawShape(sh) {
  ctx.save();
  ctx.translate(sh.x, sh.y);
  ctx.rotate(sh.angle);
  const col = `hsl(${sh.hue}, 100%, 65%)`;
  ctx.strokeStyle = col;
  ctx.fillStyle = `hsla(${sh.hue}, 100%, 60%, ${sh.held ? 0.28 : 0.14})`;
  ctx.lineWidth = sh.held ? 5 : 3.2;
  ctx.shadowColor = col;
  ctx.shadowBlur = sh.held ? 34 : 20;
  ctx.beginPath();
  if (sh.kind === 'circle') {
    ctx.arc(0, 0, sh.r, 0, Math.PI * 2);
  } else if (sh.kind === 'rect') {
    ctx.rect(-sh.w / 2, -sh.h / 2, sh.w, sh.h);
  } else if (sh.kind === 'tri') {
    sh.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  } else if (sh.kind === 'line') {
    ctx.moveTo(sh.ax, sh.ay);
    ctx.lineTo(sh.bx, sh.by);
  }
  if (sh.kind !== 'line') ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawStroke() {
  if (wow.stroke.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#5ce1e6';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#5ce1e6';
  ctx.shadowBlur = 26;
  ctx.beginPath();
  wow.stroke.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  ctx.restore();
}

// --- жесты режима ----------------------------------------------------------
const isL = g => g.thumb && g.ext[0] && !g.ext[1] && !g.ext[2] && !g.ext[3];
const isPointer = g => g.ext[0] && !g.ext[1] && !g.ext[2] && !g.ext[3];

function runWow(drawing) {
  const now = performance.now();
  const dt = Math.min(now - (wow.lastAt || now), 60);
  wow.lastAt = now;

  if (!landmarker || video.readyState < 2 || !syncCanvas()) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  video.classList.toggle('hidden', !opt.video.checked);
  video.style.transform = opt.mirror.checked
    ? 'translate(-50%,-50%) scaleX(-1)'
    : 'translate(-50%,-50%)';
  if (!opt.video.checked) {
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    window.__last = landmarker.detectForVideo(video, now);
  }
  const hands = window.__last?.landmarks ?? [];
  const W = canvas.width, H = canvas.height;
  const px = lm => [(opt.mirror.checked ? 1 - lm.x : lm.x) * W, lm.y * H];

  let pointerHand = null;
  const ls = [];

  hands.forEach((lms, i) => {
    const g = gestureOf(lms);
    const [palmX, palmY] = px(lms[9]);

    if (isPointer(g)) pointerHand = lms;
    if (isL(g)) ls.push({ corner: px(lms[5]) });

    // кулак хватает ближайшую фигуру и таскает её за собой
    if (g.seqPose === 'fist') {
      let held = wow.grabbed.get(i);
      if (!held) {
        let best = null, bestD = Infinity;
        for (const sh of wow.shapes) {
          if (sh.held) continue;
          const d = Math.hypot(sh.x - palmX, sh.y - palmY);
          if (d < sh.r * GRAB_RADIUS && d < bestD) { best = sh; bestD = d; }
        }
        if (best) {
          best.held = true;
          best.grabX = palmX; best.grabY = palmY;
          wow.grabbed.set(i, best);
          held = best;
          wow.hint = 'схватил';
        }
      }
      if (held) {
        held.vx = (palmX - held.grabX) / (dt / 1000 || 1);
        held.vy = (palmY - held.grabY) / (dt / 1000 || 1);
        held.grabX = palmX; held.grabY = palmY;
        held.x = palmX; held.y = palmY;
        held.va = held.vx / 400;
      }
    } else {
      const held = wow.grabbed.get(i);
      if (held) {
        held.held = false;                 // раскрыл руку — бросок с той же скоростью
        wow.grabbed.delete(i);
        wow.hint = 'бросок';
      }
    }

    // искры с кончиков, чтобы руки читались в кадре
    for (const t of [4, 8, 12, 16, 20]) {
      if (Math.random() > 0.35) continue;
      const [tx, ty] = px(lms[t]);
      spawn(tx, ty, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60,
            { max: 360, size: 1.6, hue: 185, grav: 120 });
    }
  });

  // рисование указательным
  if (pointerHand) {
    const [tx, ty] = px(pointerHand[8]);
    const last = wow.stroke[wow.stroke.length - 1];
    if (!last || Math.hypot(tx - last.x, ty - last.y) > 4) wow.stroke.push({ x: tx, y: ty });
    if (wow.stroke.length > 400) wow.stroke.shift();
    wow.drawing = true;
    wow.hint = 'рисуешь';
  } else if (wow.drawing) {
    wow.drawing = false;
    const def = recognize(wow.stroke);
    if (def) addShape(def);
    else if (wow.stroke.length > 4) wow.hint = 'не понял фигуру';
    wow.stroke = [];
  }

  // два уголка — прямоугольник по диагонали между ними
  if (ls.length >= 2) {
    const [a, b] = ls;
    const rect = { x: (a.corner[0] + b.corner[0]) / 2, y: (a.corner[1] + b.corner[1]) / 2,
                   w: Math.abs(a.corner[0] - b.corner[0]), h: Math.abs(a.corner[1] - b.corner[1]) };
    if (!wow.frameSince) wow.frameSince = now;
    wow.framePreview = rect;
    wow.hint = 'держи уголки…';
    if (now - wow.frameSince > FRAME_HOLD && Math.min(rect.w, rect.h) > SHAPE_MIN_SIZE) {
      addShape({ kind: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h,
                 r: Math.hypot(rect.w, rect.h) / 2 });
      wow.frameSince = 0;
      wow.framePreview = null;
    }
  } else {
    wow.frameSince = 0;
    wow.framePreview = null;
  }

  // хлопок — ударная волна
  if (hands.length >= 2) {
    const [a, b] = [px(hands[0][9]), px(hands[1][9])];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < W * CLAP_DIST && now - wow.clapAt > 700) {
      wow.clapAt = now;
      shockwave((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, W);
      wow.hint = 'хлопок';
    }
  }

  stepShapes(dt, W, H);
  stepParticles(dt);

  for (const sh of wow.shapes) drawShape(sh);
  if (wow.framePreview) {
    const r = wow.framePreview;
    ctx.save();
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x - r.w / 2, r.y - r.h / 2, r.w, r.h);
    ctx.restore();
  }
  drawStroke();
  drawParticles(ctx);

  if (now - wow.clapAt < 130) {
    ctx.fillStyle = `rgba(220,245,255,${0.45 * (1 - (now - wow.clapAt) / 130)})`;
    ctx.fillRect(0, 0, W, H);
  }

  shapeCountEl.textContent = String(wow.shapes.length);
  repsEl.textContent = String(wow.shapes.length);
  repsLeftEl.textContent = `${hands.length} рук`;
  repsRightEl.textContent = `${parts.length} частиц`;
  phaseEl.textContent = wow.hint || 'рисуй указательным';
  handsEl.textContent = `фигур ${wow.shapes.length}`;
  gestEl.textContent = wow.hint || 'вау-режим';
  lastHandAt = now;
}

function clearShapes() {
  for (const sh of wow.shapes) {
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2, sp = 100 + Math.random() * 400;
      spawn(sh.x, sh.y, Math.cos(a) * sp, Math.sin(a) * sp,
            { max: 560, size: 2, hue: sh.hue, grav: 260 });
    }
  }
  wow.shapes = [];
  wow.grabbed.clear();
  wow.hint = 'чисто';
}

// --- режим Тони: голограмма в руках -----------------------------------------
// Каркасные модели считаются на месте, никаких файлов. Каждая вершина знает
// свой слой: по слоям объект и разлетается, когда разводишь ладони.
function ring(r, z, segs, layer, tilt = 0) {
  const verts = [], edges = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * Math.cos(tilt), z: z + Math.sin(a) * r * Math.sin(tilt), layer });
    edges.push([i, (i + 1) % segs]);
  }
  return { verts, edges };
}

function merge(parts) {
  const verts = [], edges = [];
  for (const p of parts) {
    const off = verts.length;
    verts.push(...p.verts);
    for (const [a, b] of p.edges) edges.push([a + off, b + off]);
  }
  return { verts, edges, layers: Math.max(...verts.map(v => v.layer)) + 1 };
}

function buildReactor() {
  const parts = [ring(1, 0, 40, 0), ring(0.72, 0.12, 32, 1), ring(0.44, 0.24, 24, 2),
                  ring(0.18, 0.36, 16, 3)];
  // спицы между внешним и вторым кольцом
  const spokes = { verts: [], edges: [] };
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    spokes.verts.push({ x: Math.cos(a), y: Math.sin(a), z: 0, layer: 0 });
    spokes.verts.push({ x: Math.cos(a) * 0.72, y: Math.sin(a) * 0.72, z: 0.12, layer: 1 });
    spokes.edges.push([spokes.verts.length - 2, spokes.verts.length - 1]);
  }
  parts.push(spokes);
  return { name: 'Арк-реактор', ...merge(parts) };
}

function buildGlobe() {
  const parts = [];
  for (let k = -3; k <= 3; k++) {
    const lat = (k / 4) * (Math.PI / 2);
    parts.push(ring(Math.cos(lat), Math.sin(lat), 28, Math.abs(k)));
  }
  const meridians = { verts: [], edges: [] };
  for (let m = 0; m < 8; m++) {
    const lon = (m / 8) * Math.PI * 2;
    const start = meridians.verts.length;
    for (let i = 0; i <= 16; i++) {
      const t = (i / 16) * Math.PI - Math.PI / 2;
      meridians.verts.push({ x: Math.cos(t) * Math.cos(lon), y: Math.sin(t),
                             z: Math.cos(t) * Math.sin(lon), layer: 0 });
      if (i) meridians.edges.push([start + i - 1, start + i]);
    }
  }
  parts.push(meridians);
  return { name: 'Глобус', ...merge(parts) };
}

function buildCore() {
  const parts = [];
  const sizes = [1, 0.68, 0.38];
  sizes.forEach((sz, layer) => {
    const v = [], e = [];
    const c = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
               [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    for (const [x, y, z] of c) v.push({ x: x * sz, y: y * sz, z: z * sz, layer });
    const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    e.push(...pairs);
    parts.push({ verts: v, edges: e });
  });
  return { name: 'Ядро', ...merge(parts) };
}

const HOLOS = { reactor: buildReactor(), globe: buildGlobe(), core: buildCore() };

const tony = {
  model: 'reactor',
  yaw: 0.4, pitch: -0.25, roll: 0,
  vyaw: 0.25, vpitch: 0,
  scale: 1, explode: 0,
  pinch: null,          // рука, что тащит вращение
  twoBase: 0,
  openBase: 0,
  lastAt: 0,
  scan: 0,
  hint: 'щепоть вращает',
  nextAt: 0,
};

// поворот вокруг трёх осей и перспектива
function project(v, cx, cy, unit) {
  const { yaw, pitch, roll } = tony;
  const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
  let x = v.x * cy1 + v.z * sy1;
  let z = -v.x * sy1 + v.z * cy1;
  let y = v.y;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp - z * sp;
  z = y * sp + z * cp;
  y = y2;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const x2 = x * cr - y * sr;
  y = x * sr + y * cr;
  x = x2;
  // слои расходятся вдоль оси взгляда, поэтому объект «раскрывается»
  z += (v.layer - 1) * tony.explode * 1.5;
  const d = 4.2 + z;
  const f = 3.4 / (d || 0.01);
  return { x: cx + x * unit * f, y: cy + y * unit * f, depth: d };
}

function drawHolo(cx, cy, unit) {
  const m = HOLOS[tony.model];
  const pts = m.verts.map(v => project(v, cx, cy, unit));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1.6;
  for (const [a, b] of m.edges) {
    const p = pts[a], q = pts[b];
    const far = Math.max(p.depth, q.depth);
    const alpha = Math.max(0.18, Math.min(1.1 - (far - 3.4) * 0.42, 1));
    ctx.strokeStyle = `rgba(120,226,255,${alpha})`;
    ctx.shadowColor = '#6fe3ff';
    ctx.shadowBlur = 14 * alpha;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  // узлы поярче, так каркас читается
  for (const p of pts) {
    const a = Math.max(0.15, Math.min(1.1 - (p.depth - 3.4) * 0.42, 1));
    ctx.fillStyle = `rgba(210,245,255,${a * 0.8})`;
    ctx.fillRect(p.x - 1.4, p.y - 1.4, 2.8, 2.8);
  }
  ctx.restore();
}

// --- интерфейс как в фильме -------------------------------------------------
function drawReticle(x, y, r, label, on) {
  const t = performance.now() / 1000;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = on ? 'rgba(255,214,120,.95)' : 'rgba(120,226,255,.75)';
  ctx.shadowColor = on ? '#ffd678' : '#6fe3ff';
  ctx.shadowBlur = 16;
  ctx.lineWidth = 2;

  for (let k = 0; k < 3; k++) {
    const rr = r * (0.6 + k * 0.22);
    const from = t * (k % 2 ? -1.2 : 1.6) + k;
    ctx.beginPath();
    ctx.arc(x, y, rr, from, from + Math.PI * (0.5 + k * 0.15));
    ctx.stroke();
  }
  // угловые скобки
  const c = r * 1.15, len = r * 0.3;
  ctx.lineWidth = 2.4;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x + sx * c, y + sy * c - sy * len);
    ctx.lineTo(x + sx * c, y + sy * c);
    ctx.lineTo(x + sx * c - sx * len, y + sy * c);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.font = '11px monospace';
  ctx.fillStyle = on ? 'rgba(255,214,120,.95)' : 'rgba(160,235,255,.8)';
  ctx.fillText(label, x + c + 8, y - c + 12);
  ctx.restore();
}

function drawHud(W, H) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // сетка
  ctx.strokeStyle = 'rgba(90,190,230,.10)';
  ctx.lineWidth = 1;
  const step = Math.round(W / 26);
  ctx.beginPath();
  for (let x = 0; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // рамка по углам
  ctx.strokeStyle = 'rgba(120,226,255,.55)';
  ctx.lineWidth = 2;
  const m = Math.round(W * 0.03), L = Math.round(W * 0.06);
  for (const [sx, sy, ox, oy] of [[1, 1, m, m], [-1, 1, W - m, m],
                                  [1, -1, m, H - m], [-1, -1, W - m, H - m]]) {
    ctx.beginPath();
    ctx.moveTo(ox + sx * L, oy);
    ctx.lineTo(ox, oy);
    ctx.lineTo(ox, oy + sy * L);
    ctx.stroke();
  }

  // сканирующая линия
  tony.scan = (tony.scan + 0.004) % 1;
  const sy = tony.scan * H;
  const g = ctx.createLinearGradient(0, sy - 60, 0, sy + 60);
  g.addColorStop(0, 'rgba(110,220,255,0)');
  g.addColorStop(0.5, 'rgba(110,220,255,.22)');
  g.addColorStop(1, 'rgba(110,220,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, sy - 60, W, 120);
  ctx.restore();
}

function drawTelemetry(W, H, hands) {
  const lines = [
    `ОБЪЕКТ    ${HOLOS[tony.model].name}`,
    `МАСШТАБ   ${tony.scale.toFixed(2)}`,
    `РАЗЛЁТ    ${(tony.explode * 100).toFixed(0)}%`,
    `КУРС      ${(tony.yaw * 57.3 % 360).toFixed(0)}°`,
    `НАКЛОН    ${(tony.pitch * 57.3).toFixed(0)}°`,
    `СЛОЁВ     ${HOLOS[tony.model].layers}`,
    `РУК       ${hands.length}`,
    `КАДРЫ     ${fpsSmoothed.toFixed(0)}`,
  ];
  ctx.save();
  ctx.font = '12px monospace';
  ctx.fillStyle = 'rgba(150,232,255,.85)';
  ctx.shadowColor = '#6fe3ff';
  ctx.shadowBlur = 8;
  lines.forEach((l, i) => ctx.fillText(l, Math.round(W * 0.045), Math.round(H * 0.12) + i * 18));

  // столбик уровней справа, просто для вида
  const bx = Math.round(W * 0.93), by = Math.round(H * 0.2);
  for (let i = 0; i < 14; i++) {
    const v = (Math.sin(performance.now() / 380 + i) + 1) / 2;
    ctx.fillStyle = `rgba(120,226,255,${0.25 + v * 0.6})`;
    ctx.fillRect(bx, by + i * 14, 4 + v * 34, 7);
  }
  ctx.restore();
}

// --- цикл режима -----------------------------------------------------------
const tonySnap = { armed: false, at: 0, gap: 0, wrist: null };

function runTony(drawing) {
  const now = performance.now();
  const dt = Math.min(now - (tony.lastAt || now), 60);
  tony.lastAt = now;

  if (!landmarker || video.readyState < 2 || !syncCanvas()) return;

  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  video.classList.toggle('hidden', !opt.video.checked);
  video.style.transform = opt.mirror.checked
    ? 'translate(-50%,-50%) scaleX(-1)'
    : 'translate(-50%,-50%)';
  // затемняем картинку: голограмма должна быть светлее мира
  ctx.fillStyle = opt.video.checked ? 'rgba(4,10,18,.55)' : '#040a12';
  ctx.fillRect(0, 0, W, H);

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    window.__last = landmarker.detectForVideo(video, now);
  }
  const hands = window.__last?.landmarks ?? [];
  const px = lm => [(opt.mirror.checked ? 1 - lm.x : lm.x) * W, lm.y * H];

  const pinches = [];
  const opens = [];
  let fist = false;
  hands.forEach((lms, i) => {
    const g = gestureOf(lms);
    const size = d2(lms[0], lms[9]) || 1e-6;
    const isPinch = d2(lms[4], lms[8]) / size < 0.55;
    const [hx, hy] = px(lms[9]);
    if (isPinch) pinches.push({ x: hx, y: hy, i });
    if (g.pose === 'palm') opens.push({ x: hx, y: hy });
    if (g.seqPose === 'fist') fist = true;
    if (drawing) drawReticle(hx, hy, Math.max(W, H) * 0.055, isPinch ? 'ЗАХВАТ' : `РУКА ${i + 1}`, isPinch);
    if (snapSignalFx(lms, now) && now > tony.nextAt) {
      const keys = Object.keys(HOLOS);
      tony.model = keys[(keys.indexOf(tony.model) + 1) % keys.length];
      tony.nextAt = now + 600;
      tony.hint = `объект: ${HOLOS[tony.model].name}`;
      holoSel.value = tony.model;
    }
  });

  if (pinches.length === 1) {
    // одна щепоть — вращаем объект, как будто он в руке
    const p = pinches[0];
    if (tony.pinch) {
      tony.vyaw = (p.x - tony.pinch.x) * 0.012;
      tony.vpitch = (p.y - tony.pinch.y) * 0.012;
    }
    tony.pinch = p;
    tony.twoBase = 0;
    tony.hint = 'вращаю';
  } else if (pinches.length >= 2) {
    // две щепоти — масштаб по расстоянию и наклон по углу между руками
    const [a, b] = pinches;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (tony.twoBase) {
      tony.scale = Math.min(Math.max(tony.scale * (dist / tony.twoBase), 0.35), 3.2);
      tony.roll += ang - tony.twoAng;
    }
    tony.twoBase = dist;
    tony.twoAng = ang;
    tony.pinch = null;
    tony.hint = 'масштаб и наклон';
  } else {
    tony.pinch = null;
    tony.twoBase = 0;
  }

  // открытые ладони разводишь — объект раскрывается на слои
  if (opens.length >= 2 && pinches.length === 0) {
    const d = Math.hypot(opens[0].x - opens[1].x, opens[0].y - opens[1].y);
    if (!tony.openBase) tony.openBase = d;
    tony.explode = Math.min(Math.max((d - tony.openBase) / (W * 0.42), 0), 1);
    if (tony.explode > 0.05) tony.hint = 'разлёт на слои';
  } else {
    tony.openBase = 0;
    tony.explode *= 0.9;
    if (tony.explode < 0.01) tony.explode = 0;
  }

  if (fist) {
    tony.explode *= 0.75;
    tony.scale += (1 - tony.scale) * 0.12;
    tony.hint = 'собираю';
  }

  // инерция: объект продолжает крутиться после отпускания
  if (!pinches.length && opt.spin.checked) tony.vyaw += (0.25 - tony.vyaw) * 0.02;
  tony.yaw += tony.vyaw * dt / 1000 * 2.4;
  tony.pitch = Math.min(Math.max(tony.pitch + tony.vpitch * dt / 1000 * 2.4, -1.2), 1.2);
  if (!pinches.length) { tony.vpitch *= 0.94; }

  if (drawing) {
    if (opt.hud.checked) drawHud(W, H);
    drawHolo(W / 2, H / 2, Math.min(W, H) * 0.22 * tony.scale);
    if (opt.telemetry.checked) drawTelemetry(W, H, hands);
  }

  holoScaleEl.textContent = tony.scale.toFixed(2);
  repsEl.textContent = HOLOS[tony.model].layers > 0 ? String(Math.round(tony.explode * 100)) : '0';
  repsLeftEl.textContent = HOLOS[tony.model].name;
  repsRightEl.textContent = `×${tony.scale.toFixed(2)}`;
  phaseEl.textContent = tony.hint;
  handsEl.textContent = `рук ${hands.length}`;
  gestEl.textContent = `Тони · ${HOLOS[tony.model].name}`;
  lastHandAt = now;
}

function resetTony() {
  tony.scale = 1;
  tony.explode = 0;
  tony.roll = 0;
  tony.pitch = -0.25;
  tony.vpitch = 0;
  tony.vyaw = 0.25;
  tony.hint = 'собрано';
}

// --- главный цикл ----------------------------------------------------------
let mode = 'gestures';
let lastHandAt = 0;
function nextFrame() {
  // пустой кадр не стоит тридцати проверок в секунду: дремлем, пока рук нет
  if (mode === 'posture') {
    // осанка меняется медленно, тридцать кадров в секунду тут ни к чему
    return void setTimeout(loop, Math.round(1000 / Math.max(cfg.posture.fps, 1)));
  }
  const quiet = lastHandAt && (performance.now() - lastHandAt) / 1000 > cfg.idle.afterSec;
  if (quiet) return void setTimeout(loop, Math.round(1000 / Math.max(cfg.idle.fps, 1)));
  // в демоне и на скрытом окне rAF ненадёжен — держим таймером
  if (DAEMON || document.hidden) setTimeout(loop, DAEMON ? 33 : 40);
  else requestAnimationFrame(loop);
}

function loop() {
  nextFrame();
  if (!landmarker || video.readyState < 2) return;
  const drawing = !DAEMON && syncCanvas();
  if (!DAEMON && !drawing) return;

  if (drawing) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    video.classList.toggle('hidden', !opt.video.checked);
    video.style.transform = opt.mirror.checked
      ? 'translate(-50%,-50%) scaleX(-1)'
      : 'translate(-50%,-50%)';
    if (!opt.video.checked) {
      ctx.fillStyle = '#07080c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  if (mode === 'laid') { runLaid(drawing); tickFps(); return; }
  if (mode === 'posture') { runPosture(drawing); tickFps(); return; }
  if (mode === 'guard') { runGuard(drawing); tickFps(); return; }
  if (mode === 'edit') { runEdit(drawing); tickFps(); return; }
  if (mode === 'wow') { runWow(drawing); tickFps(); return; }
  if (mode === 'tony') { runTony(drawing); tickFps(); return; }

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    window.__last = res;
  }
  const res = window.__last;

  const hands = res?.landmarks ?? [];
  const gestures = [];
  let swipeCandidate = null;
  let seqPose = null;
  let primary = null;
  hands.forEach((lms, i) => {
    const cat = res.handedness?.[i]?.[0]?.categoryName ?? '';
    // MediaPipe отдаёт сторону для не зеркального кадра
    let side = cat === 'Left' ? 'Левая' : cat === 'Right' ? 'Правая' : '';
    if (opt.mirror.checked) side = side === 'Левая' ? 'Правая' : side === 'Правая' ? 'Левая' : side;
    const g = gestureOf(lms);
    gestures.push(g.name);
    if (g.swipeReady) swipeCandidate = { lms, pose: g.pose };
    if (seqPose === null || seqPose === 'other') seqPose = g.seqPose;
    if (!primary) primary = g;
    if (drawing) drawHand(lms, i, `${side} · ${g.name}`);
  });
  for (let i = hands.length; i < trails.length; i++) trails[i] = [];
  if (hands.length) lastHandAt = performance.now();
  trackSwipe(swipeCandidate);
  trackSequence(seqPose);
  trackSnap(hands[0] || null);
  trackMouse(hands[0] || null, primary);

  lastHands = hands.length;
  handsEl.textContent = `рук: ${hands.length}`;
  gestEl.textContent = gestures.length ? gestures.join(' + ') : '—';
  tickFps();
}

function tickFps() {
  const now = performance.now();
  // таймер в headless бывает грубым: без нижней границы dt даёт бесконечность
  const dt = Math.max(now - lastFrameTs, 1);
  lastFrameTs = now;
  const inst = 1000 / dt;
  fpsSmoothed = Number.isFinite(fpsSmoothed) && fpsSmoothed
    ? fpsSmoothed * 0.9 + inst * 0.1
    : inst;
  fpsEl.textContent = `${fpsSmoothed.toFixed(0)} FPS`;
  frameCount++;
}

// --- события ---------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await startCamera(cameraSelect.value || undefined);
    splash.classList.add('hidden');
  } catch (e) {
    fail(`Не удалось открыть камеру: ${e.message}`);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Переключить камеру';
  }
});
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value).catch(console.error));

compactBtn.addEventListener('click', async () => {
  await fireAction('unmaximize', 'окно свёрнуто из максимума');
  await fireAction('window-above', 'поверх всех окон переключено');
});

const modeBtns = Array.from(document.querySelectorAll('.mode'));
const MODE_NAMES = {
  gestures: 'режим жестов',
  edit: 'генератор эдитов',
  wow: 'вау-режим',
  tony: 'режим Тони',
  laid: 'режим Дэвида Лэйда',
  posture: 'режим осанки',
  guard: 'режим охраны',
};

async function setMode(next) {
  if (mode === next) return;
  mode = next;
  for (const name of ['laid', 'posture', 'guard', 'edit', 'wow', 'tony']) {
    document.body.classList.toggle(`mode-${name}`, mode === name);
  }
  counterEl.hidden = mode === 'gestures';
  counterEl.classList.remove('bad', 'warn');
  modeBtns.forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  lastVideoTime = -1;                       // модели считают кадры по времени
  toast(MODE_NAMES[mode] || mode);

  if (mode === 'gestures') {
    stopMedia();
    return;
  }
  mouseRelease();                           // вне жестов мышь не нужна
  resetSwipe();
  if (mode !== 'laid') stopMedia();

  if (mode !== 'edit' && mode !== 'wow' && mode !== 'tony') stopEditRec();

  if (mode === 'tony') {
    tony.lastAt = 0;
    say('щепоть вращает, две щепоти масштабируют');
    return;
  }

  if (mode === 'wow') {
    wow.stroke = [];
    wow.lastAt = 0;
    say('рисуй указательным в воздухе');
    return;
  }

  if (mode === 'edit') {
    curl.note = 'гружу модель лица…';
    paintCounter();
    try {
      await loadFace();
      curl.note = 'выбери пресет и жми запись';
    } catch (e) {
      curl.note = `лицо не загрузилось: ${e.message}`;
    }
    paintCounter();
    return;
  }

  if (mode === 'guard') {
    armGuard();
    paintCounter();
    if (opt.person.checked) loadPose().catch(e => say(`скелет не загрузился: ${e.message}`));
    return;
  }

  curl.note = 'гружу скелет…';
  paintCounter();
  if (mode === 'laid') refreshToday();
  try {
    await loadPose();
    curl.note = mode === 'laid' ? 'встань в кадр целиком' : 'сядь как обычно';
  } catch (e) {
    curl.note = `скелет не загрузился: ${e.message}`;
  }
  paintCounter();
}

modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.getElementById('resetReps').addEventListener('click', () => resetReps());
document.getElementById('calibBtn').addEventListener('click', startCalibration);
document.getElementById('postureCalib').addEventListener('click', startPostureCalib);

for (const [key, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = p.name;
  editPresetSel.appendChild(o);
}
editPresetSel.value = edit.preset;
editPresetSel.addEventListener('change', () => {
  edit.preset = editPresetSel.value;
  say(`пресет: ${PRESETS[edit.preset].name}`);
});
// список эффектов строим из реестра: добавить новый — одна строка в FX
const fxListEl = document.getElementById('fxList');
for (const [key, f] of Object.entries(FX)) {
  const row = document.createElement('label');
  row.className = 'row';
  const span = document.createElement('span');
  span.textContent = f.name;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => {
    if (box.checked) {
      fxOn.add(key);
      if (f.needs.includes('seg')) loadSeg().catch(e => say(`силуэт не загрузился: ${e.message}`));
      say(`${f.name}: включён`);
    } else {
      fxOn.delete(key);
      if (key === 'echo') echo.frames.length = 0;
      say(`${f.name}: выключен`);
    }
  });
  row.append(span, box);
  fxListEl.appendChild(row);
  f.box = box;
}

editRecBtn.addEventListener('click', () => (edit.recorder ? stopEditRec() : startEditRec()));
document.getElementById('wowClear').addEventListener('click', clearShapes);
document.getElementById('tonyReset').addEventListener('click', resetTony);
tonyRecBtn.addEventListener('click', () => (edit.recorder
  ? stopEditRec()
  : startEditRec(canvas, tonyRecBtn, tonySaveEl)));

for (const [key, m] of Object.entries(HOLOS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = m.name;
  holoSel.appendChild(o);
}
holoSel.value = tony.model;
holoSel.addEventListener('change', () => {
  tony.model = holoSel.value;
  tony.hint = `объект: ${HOLOS[tony.model].name}`;
});
wowRecBtn.addEventListener('click', () => (edit.recorder
  ? stopEditRec()
  : startEditRec(canvas, wowRecBtn, wowSaveEl)));
editMusicEl.addEventListener('change', () => {
  const f = editMusicEl.files?.[0];
  if (f) loadMusic(f).catch(e => say(`трек не открылся: ${e.message}`));
});

for (const [key, ex] of Object.entries(EXERCISES)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = ex.name;
  exerciseSel.appendChild(o);
}
exerciseSel.value = exercise;
exerciseSel.addEventListener('change', () => {
  exercise = exerciseSel.value;
  resetReps();
  const own = calib[exercise];
  say(own ? `${EXERCISES[exercise].name}: по твоей калибровке`
          : `${EXERCISES[exercise].name}: пороги по умолчанию`);
  refreshToday();
});
document.querySelectorAll('.media-close')
  .forEach(b => b.addEventListener('click', () => {
    stopMedia();
    panel.classList.remove('hidden');
  }));
opt.media.addEventListener('change', () => { if (!opt.media.checked) stopMedia(); });
opt.windows.addEventListener('change', () => {
  cfg.laid.window = opt.windows.checked;
  stopMedia();                             // следующий подход откроет уже по-новому
});

opt.mouse.addEventListener('change', () => {
  cfg.mouse.enabled = opt.mouse.checked;
  if (!cfg.mouse.enabled) mouseRelease();             // не оставляем кнопку зажатой
  toast(cfg.mouse.enabled ? 'мышь рукой включена' : 'мышь рукой выключена');
});

pinBtn.addEventListener('click', () => {
  // действие-переключатель: тем же нажатием окно и открепляется
  fireAction('pin-window', 'закрепление окна переключено');
});

// если страницу успели спрятать, жесты стояли на паузе — честно об этом скажем
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenSince = performance.now(); return; }
  if (hiddenSince && performance.now() - hiddenSince > 1200 && opt.swipe.checked) {
    toast('жесты стояли: окно было скрыто', true);
  }
  hiddenSince = 0;
});

window.addEventListener('pagehide', closePopups);

document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'h' || e.key === 'р') panel.classList.toggle('hidden');
});

function fail(msg) {
  lastError = msg;
  splash.classList.remove('hidden');
  splash.classList.add('error');
  splashText.textContent = msg;
}

// --- признак жизни фонового режима -----------------------------------------
function startHeartbeat() {
  setInterval(() => {
    fetch('/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: PAGE_ID,
        frames: frameCount,
        fps: Math.round(fpsSmoothed),
        hands: lastHands,
        camera: !!(stream && stream.getVideoTracks()[0]?.readyState === 'live'),
        note: lastError,
      }),
    }).then(() => { if (!bridgeOk) setBridge(true); })
      .catch(() => setBridge(false, 'мост не отвечает'));
  }, 2000);
}

// --- старт -----------------------------------------------------------------
(async () => {
  checkBridge();
  await loadConfig();
  lastHandAt = performance.now();
  if (DAEMON) startHeartbeat();          // хотим видеть даже неудачный старт
  try {
    landmarker = await loadModel();
    splashText.textContent = 'Разрешите доступ к камере';
    await startCamera();
    splash.classList.add('hidden');
    startBtn.textContent = 'Переключить камеру';
    if (DAEMON) opt.swipe.checked = true;
  } catch (e) {
    console.error(e);
    fail(`${e.message} — нажмите «Включить камеру» справа, чтобы повторить.`);
    if (DAEMON) retryCamera();
  }
})();

let retryTimer = 0;
function retryCamera() {
  // камеру одновременно стримит только один процесс: ждём, пока отпустят
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    try {
      await startCamera();
      clearInterval(retryTimer);
      retryTimer = 0;
      lastError = '';
      opt.swipe.checked = true;
      splash.classList.add('hidden');
    } catch (e) {
      lastError = `жду камеру: ${e.message}`;
    }
  }, 3000);
}
