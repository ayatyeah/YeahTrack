import { FilesetResolver, HandLandmarker, PoseLandmarker } from './vendor/vision_bundle.mjs';

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
  laid: 'режим Дэвида Лэйда',
  posture: 'режим осанки',
  guard: 'режим охраны',
};

async function setMode(next) {
  if (mode === next) return;
  mode = next;
  for (const name of ['laid', 'posture', 'guard']) {
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
