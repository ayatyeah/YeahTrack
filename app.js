import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';

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
};

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
const SNAP_DELTA  = 0.45;  // на столько должен разъехаться зазор
const SNAP_WINDOW = 220;   // мс на срыв, медленнее — это просто разжимание
const SNAP_COOLDOWN = 2000;
const snap = { armed: false, at: 0, gap: 0, lastFire: 0 };

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
    return;
  }
  if (!snap.armed) return;
  if (now - snap.at > SNAP_WINDOW) { snap.armed = false; return; }
  if (gap - snap.gap >= SNAP_DELTA) {
    snap.armed = false;
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

// --- главный цикл ----------------------------------------------------------
let lastHandAt = 0;
function nextFrame() {
  // пустой кадр не стоит тридцати проверок в секунду: дремлем, пока рук нет
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
  lastHands = hands.length;
  handsEl.textContent = `рук: ${hands.length}`;
  gestEl.textContent = gestures.length ? gestures.join(' + ') : '—';
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
