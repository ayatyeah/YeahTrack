#!/usr/bin/env python3
"""YeahTrack bridge: раздаёт страницу и превращает жесты в действия системы.

Ввод идёт через org.gnome.Mutter.RemoteDesktop — штатный путь GNOME Wayland,
без root и без ydotool. Оттуда же берутся мышь и колесо прокрутки.
"""
import base64
import json
import os
import shlex
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / 'config.json'
# История живёт рядом с настройками пользователя, а не в репозитории
DATA_DIR = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'yeahtrack'
HISTORY_PATH = DATA_DIR / 'workouts.json'
GUARD_DIR = DATA_DIR / 'guard'
MAX_SHOT = 6 * 1024 * 1024        # снимок больше шести мегабайт не принимаем
GESTURES_PATH = DATA_DIR / 'gestures.json'
MAX_GESTURES_BODY = 24 * 1024 * 1024
MAX_GESTURES = 30
MAX_SAMPLES = 900                  # образцов на жест
MAX_DIMS = 128                     # длина одного образца
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8010

# --- клавиши ---------------------------------------------------------------
SUPER_L, PAGE_UP, PAGE_DOWN, ESCAPE = 0xFFEB, 0xFF55, 0xFF56, 0xFF1B
CTRL_L, ALT_L, HOME, END = 0xFFE3, 0xFFE9, 0xFF50, 0xFF57
DOWN, UP, KEY_W = 0xFF54, 0xFF52, 0x0077
VOL_UP, VOL_DOWN, VOL_MUTE = 0x1008FF13, 0x1008FF11, 0x1008FF12
PLAY, NEXT, PREV = 0x1008FF14, 0x1008FF17, 0x1008FF16

# Закрепить окно или поднять поверх всех штатным D-Bus нельзя, а Shell.Eval
# выключен. Зато у GNOME есть действия без горячей клавиши: вешаем на них
# свободное сочетание и нажимаем его сами.
WM_SCHEMA = 'org.gnome.desktop.wm.keybindings'
PIN_KEY, PIN_ACCEL = 'toggle-on-all-workspaces', '<Control><Alt><Super>Home'
ABOVE_KEY, ABOVE_ACCEL = 'toggle-above', '<Control><Alt><Super>End'
PIN_KEYSYMS = [CTRL_L, ALT_L, SUPER_L, HOME]
ABOVE_KEYSYMS = [CTRL_L, ALT_L, SUPER_L, END]

# действие → клавиши и сколько раз нажать
ACTIONS = {
    'workspace-left':  ([SUPER_L, PAGE_UP], 1),
    'workspace-right': ([SUPER_L, PAGE_DOWN], 1),
    'overview':        ([SUPER_L], 1),
    'escape':          ([ESCAPE], 1),
    'close-tab':       ([CTRL_L, KEY_W], 1),
    'pin-window':      (PIN_KEYSYMS, 1),
    'window-above':    (ABOVE_KEYSYMS, 1),
    'unmaximize':      ([SUPER_L, DOWN], 1),
    'maximize':        ([SUPER_L, UP], 1),
    'volume-up':       ([VOL_UP], 3),
    'volume-down':     ([VOL_DOWN], 3),
    'volume-mute':     ([VOL_MUTE], 1),
    'media-play':      ([PLAY], 1),
    'media-next':      ([NEXT], 1),
    'media-prev':      ([PREV], 1),
    'nothing':         ([], 0),
}

NEEDS_BINDING = {
    'pin-window':   (PIN_KEY, PIN_ACCEL),
    'window-above': (ABOVE_KEY, ABOVE_ACCEL),
}

# человеческие подписи для подсказки на экране
LABELS = {
    'workspace-left': 'Рабочий стол ←', 'workspace-right': 'Рабочий стол →',
    'overview': 'Обзор', 'escape': 'Escape', 'close-tab': 'Закрыть вкладку',
    'pin-window': 'Окно на все столы', 'window-above': 'Поверх всех окон',
    'unmaximize': 'Свернуть из максимума', 'maximize': 'Развернуть',
    'volume-up': 'Громче', 'volume-down': 'Тише', 'volume-mute': 'Звук выключен',
    'media-play': 'Пауза / играть', 'media-next': 'Следующий трек',
    'media-prev': 'Предыдущий трек',
}

BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BUTTONS = {'left': BTN_LEFT, 'right': BTN_RIGHT, 'middle': BTN_MIDDLE}
AXIS_VERTICAL, AXIS_HORIZONTAL = 0, 1

# --- конфигурация ----------------------------------------------------------
DEFAULT_CONFIG = {
    'osd': True,
    'mode': 'gestures',                                # или 'laid' — счёт подъёмов
    'gestures': {
        # ключ — движение кисти, значение — действие из ACTIONS
        'swipe-left':  'workspace-right',
        'swipe-right': 'workspace-left',
        'swipe-up':    'volume-up',
        'swipe-down':  'volume-down',
        'fist-palm':   'overview',
        'snap':        'close-tab',
    },
    'mouse': {'enabled': False, 'gain': 1700, 'scrollGain': 1.0, 'smooth': 0.45},
    'idle': {'afterSec': 5, 'fps': 4},
    'posture': {
        'fps': 3,               # осанке хватает трёх кадров в секунду
        'slouch': 0.12,         # на столько может просесть шея от твоей нормы
        'tiltDeg': 8,           # перекос плеч в градусах
        'holdSec': 8,           # столько надо просидеть криво, прежде чем скажем
        'cooldownSec': 600,     # и не чаще раза в десять минут
        'voice': False,
    },
    'edit': {
        'preset': 'gym',        # gym, neon, film, bw, glitch
        'seconds': 15,
        'vertical': True,
        'faceTrack': True,
        # какие слои включены при старте: echo, matrix, dust, sparks,
        # lightning, faceMask
        'fx': [],
    },
    'wow': {
        'gravity': 1400,        # сила тяжести для фигур
        'bounce': 0.45,         # упругость отскока
    },
    'tony': {
        'model': 'reactor',     # reactor, globe, core
    },
    'xray': {
        'panelH': 0.42,         # высота рамки в долях её ширины
        'density': 1300,        # сколько точек в облаке
        'style': 'shadow',      # shadow — тень с белыми глазами, cloud — просвет
    },
    'guard': {
        'armSec': 15,           # столько на то, чтобы уйти из кадра
        'sensitivity': 12,      # порог различия кадров, меньше — чувствительнее
        'cooldownSec': 30,      # пауза между снимками
        'person': True,         # требовать силуэт человека, а не любое движение
        'shots': True,          # сохранять кадр на диск
    },
    'laid': {
        'media': True,
        'mediaAfter': 0,            # 0 — по первому сгибанию, иначе столько повторений
        'window': False,            # True — отдельные окна браузера вместо панелей
        'exercise': 'curl',         # curl, press, pushup, squat, raise
        'restSec': 60,              # отдых между подходами, 0 — без таймера
        'muteVideo': True,          # звук отдаём плейлисту, иначе всё смешается
        'video': 'https://www.youtube.com/watch?v=M0HEVK6dlGI',
        'playlist': 'https://soundcloud.com/dewakii/sets/david-laid',
    },
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))       # глубокая копия
    try:
        user = json.loads(CONFIG_PATH.read_text())
    except FileNotFoundError:
        return cfg, None
    except Exception as e:                             # noqa: BLE001
        return cfg, f'config.json не разобран: {e}'
    for key, val in user.items():
        if isinstance(val, dict) and isinstance(cfg.get(key), dict):
            cfg[key].update(val)
        else:
            cfg[key] = val
    bad = [g for g, a in cfg['gestures'].items() if a not in ACTIONS]
    if bad:
        return cfg, f'неизвестные действия в config.json: {", ".join(bad)}'
    return cfg, None


config, config_error = load_config()


def ensure_binding(key, accel):
    """Ставит сочетание на действие GNOME, чужое не затирает."""
    try:
        cur = subprocess.run(['gsettings', 'get', WM_SCHEMA, key],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception as e:                             # noqa: BLE001
        return False, f'gsettings недоступен: {e}'
    if accel in cur:
        return True, None
    if cur not in ('@as []', '[]', "['']"):
        return False, f'{key} уже занят ({cur}) — нажми это сочетание сам'
    try:
        subprocess.run(['gsettings', 'set', WM_SCHEMA, key, f"['{accel}']"],
                       check=True, capture_output=True, timeout=5)
    except Exception as e:                             # noqa: BLE001
        return False, f'не смог записать сочетание: {e}'
    return True, None


# --- подсказка на экране ---------------------------------------------------
class Osd:
    """GNOME не пускает нас к своей плашке, поэтому берём уведомления.

    Одно и то же уведомление переписывается по id, так что очередь не растёт.
    """

    def __init__(self, bus, dbus_mod):
        self.lock = threading.Lock()
        self.id = 0
        self.iface = None
        if bus is None:
            return
        try:
            self.iface = dbus_mod.Interface(
                bus.get_object('org.freedesktop.Notifications',
                               '/org/freedesktop/Notifications'),
                'org.freedesktop.Notifications')
        except Exception:                              # noqa: BLE001
            self.iface = None

    def show(self, text):
        if self.iface is None or not config.get('osd'):
            return
        with self.lock:
            try:
                self.id = int(self.iface.Notify(
                    'YeahTrack', self.id, 'input-touchpad-symbolic',
                    'YeahTrack', text, [],
                    {'transient': True, 'urgency': 0}, 900))
            except Exception:                          # noqa: BLE001
                pass


# --- ввод ------------------------------------------------------------------
class Injector:
    """Одна переиспользуемая сессия RemoteDesktop с ленивым переподключением."""

    def __init__(self):
        self.lock = threading.Lock()
        self.session = None
        self.error = None
        self.bus = None
        try:
            import dbus
            self.dbus = dbus
            self.bus = dbus.SessionBus()
        except Exception as e:                         # noqa: BLE001
            self.dbus = None
            self.error = f'python3-dbus недоступен: {e}'
        self.osd = Osd(self.bus, self.dbus)

    def _open(self):
        rd = self.bus.get_object('org.gnome.Mutter.RemoteDesktop',
                                 '/org/gnome/Mutter/RemoteDesktop')
        path = self.dbus.Interface(rd, 'org.gnome.Mutter.RemoteDesktop').CreateSession()
        sess = self.dbus.Interface(
            self.bus.get_object('org.gnome.Mutter.RemoteDesktop', path),
            'org.gnome.Mutter.RemoteDesktop.Session')
        sess.Start()
        return sess

    def _with_session(self, fn):
        """Выполняет действие, при обрыве сессии пересоздаёт её и повторяет."""
        if self.dbus is None:
            return False, self.error
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.session is None:
                        self.session = self._open()
                    fn(self.session)
                    return True, None
                except Exception as e:                 # noqa: BLE001
                    self.session = None
                    if attempt == 2:
                        return False, str(e)
        return False, 'не удалось отправить'

    def send(self, action):
        entry = ACTIONS.get(action)
        if entry is None:
            return False, f'неизвестное действие: {action}'
        keysyms, repeat = entry
        if not keysyms:
            return True, None                          # 'nothing' — жест отключён

        def tap(sess):
            for _ in range(repeat):
                for k in keysyms:
                    sess.NotifyKeyboardKeysym(k, True)
                time.sleep(0.04)
                for k in reversed(keysyms):
                    sess.NotifyKeyboardKeysym(k, False)
                if repeat > 1:
                    time.sleep(0.03)

        if action in NEEDS_BINDING:
            ok, reason = ensure_binding(*NEEDS_BINDING[action])
            if not ok:
                return False, reason
        ok, reason = self._with_session(tap)
        if ok and action in LABELS:
            self.osd.show(LABELS[action])
        return ok, reason

    def tap_keys(self, keysyms):
        def tap(sess):
            for k in keysyms:
                sess.NotifyKeyboardKeysym(k, True)
            time.sleep(0.04)
            for k in reversed(keysyms):
                sess.NotifyKeyboardKeysym(k, False)
        return self._with_session(tap)

    def pointer(self, move=None, button=None, down=None, scroll=None, hscroll=None):
        def act(sess):
            if move:
                sess.NotifyPointerMotionRelative(float(move[0]), float(move[1]))
            if button is not None:
                sess.NotifyPointerButton(BUTTONS[button], bool(down))
            if scroll:
                sess.NotifyPointerAxisDiscrete(AXIS_VERTICAL, int(scroll))
            if hscroll:
                sess.NotifyPointerAxisDiscrete(AXIS_HORIZONTAL, int(hscroll))
        return self._with_session(act)

    def status(self):
        if self.dbus is None:
            return {'ok': False, 'reason': self.error}
        return {'ok': True, 'session': self.session is not None,
                'actions': sorted(ACTIONS), 'pinAccel': PIN_ACCEL,
                'osd': self.osd.iface is not None}

    def close(self):
        with self.lock:
            if self.session is not None:
                try:
                    self.session.Stop()
                except Exception:                      # noqa: BLE001
                    pass
                self.session = None


# --- история тренировок ----------------------------------------------------
history_lock = threading.Lock()


def read_history():
    try:
        data = json.loads(HISTORY_PATH.read_text())
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:                                  # noqa: BLE001
        return []                                      # битый файл не роняет мост


def add_set(entry):
    with history_lock:
        data = read_history()
        data.append(entry)
        del data[:-2000]                               # больше двух тысяч подходов не храним
        HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = HISTORY_PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(HISTORY_PATH)                      # запись целиком или никак
        return len(data)


def history_summary():
    data = read_history()
    today = time.strftime('%Y-%m-%d')
    by_exercise = {}
    today_reps = 0
    for row in data:
        if str(row.get('date')) == today:
            reps = int(row.get('reps') or 0)
            today_reps += reps
            key = str(row.get('exercise') or '?')
            by_exercise[key] = by_exercise.get(key, 0) + reps
    return {'sets': len(data), 'todayReps': today_reps, 'todayBy': by_exercise,
            'last': data[-12:]}


# --- охрана ----------------------------------------------------------------
guard_lock = threading.Lock()
guard_events = []


def save_shot(data_url):
    """Кладёт кадр из data:URL в файл, возвращает имя или None."""
    if not data_url or not data_url.startswith('data:image/'):
        return None
    try:
        head, b64 = data_url.split(',', 1)
        ext = 'jpg' if 'jpeg' in head else 'png'
        raw = base64.b64decode(b64, validate=True)
    except Exception:                                  # noqa: BLE001
        return None
    if len(raw) > MAX_SHOT:
        return None
    GUARD_DIR.mkdir(parents=True, exist_ok=True)
    name = time.strftime('%Y%m%d-%H%M%S') + f'.{ext}'
    (GUARD_DIR / name).write_bytes(raw)
    return name


# --- свои жесты -------------------------------------------------------------
# Образцы и задачи живут на стороне моста: так их видит и фоновый трекер,
# и страница. Команда задачи хранится только здесь, страница её не присылает
# при срабатывании, а лишь называет жест.
gestures_lock = threading.Lock()

KEY_NAMES = {
    'ctrl': 0xFFE3, 'control': 0xFFE3, 'alt': 0xFFE9, 'shift': 0xFFE1,
    'super': 0xFFEB, 'win': 0xFFEB, 'meta': 0xFFEB,
    'enter': 0xFF0D, 'return': 0xFF0D, 'tab': 0xFF09, 'space': 0x0020,
    'esc': 0xFF1B, 'escape': 0xFF1B, 'backspace': 0xFF08, 'delete': 0xFFFF,
    'left': 0xFF51, 'up': 0xFF52, 'right': 0xFF53, 'down': 0xFF54,
    'home': 0xFF50, 'end': 0xFF57, 'pageup': 0xFF55, 'pagedown': 0xFF56,
    'print': 0xFF61, 'insert': 0xFF63,
    'volumeup': VOL_UP, 'volumedown': VOL_DOWN, 'mute': VOL_MUTE,
    'play': PLAY, 'next': NEXT, 'prev': PREV,
}


def parse_keys(combo):
    """«ctrl+alt+t» → список кейсимов, или None, если что-то непонятно."""
    out = []
    for part in str(combo).lower().replace(' ', '').split('+'):
        if not part:
            return None
        if part in KEY_NAMES:
            out.append(KEY_NAMES[part])
        elif len(part) == 1 and part.isprintable():
            out.append(ord(part))
        elif part[0] == 'f' and part[1:].isdigit() and 1 <= int(part[1:]) <= 12:
            out.append(0xFFBE + int(part[1:]) - 1)
        else:
            return None
    return out or None


def read_gestures():
    try:
        data = json.loads(GESTURES_PATH.read_text())
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:                                  # noqa: BLE001
        return []


def clean_gestures(raw):
    """Проверяет присланный набор жестов и отрезает всё лишнее."""
    if not isinstance(raw, list):
        raise ValueError('ожидался список жестов')
    out = []
    for g in raw[:MAX_GESTURES]:
        if not isinstance(g, dict):
            continue
        name = str(g.get('name') or '').strip()[:40]
        kind = g.get('kind')
        if not name or kind not in ('pose', 'motion', 'none'):
            continue
        samples = []
        for smp in (g.get('samples') or [])[:MAX_SAMPLES]:
            if isinstance(smp, list) and 0 < len(smp) <= MAX_DIMS \
                    and all(isinstance(v, (int, float)) for v in smp):
                samples.append([round(float(v), 4) for v in smp])
        task = g.get('task') or {}
        ttype = task.get('type')
        clean_task = {'type': 'none'}
        if ttype == 'action' and task.get('action') in ACTIONS:
            clean_task = {'type': 'action', 'action': task['action']}
        elif ttype == 'keys' and parse_keys(task.get('keys')):
            clean_task = {'type': 'keys', 'keys': str(task['keys'])[:60]}
        elif ttype == 'url' and str(task.get('url', '')).startswith(('http://', 'https://')):
            clean_task = {'type': 'url', 'url': str(task['url'])[:500]}
        elif ttype == 'command' and str(task.get('command') or '').strip():
            clean_task = {'type': 'command', 'command': str(task['command'])[:1000]}
        try:
            sens = float(g.get('sensitivity') or 1)
        except (TypeError, ValueError):
            sens = 1.0
        out.append({
            'name': name, 'kind': kind, 'samples': samples,
            'task': clean_task,
            'enabled': g.get('enabled', True) is not False,
            'sensitivity': min(max(sens, 0.5), 2.0),
            'createdAt': str(g.get('createdAt') or '')[:40],
            'updatedAt': str(g.get('updatedAt') or '')[:40],
        })
    # два жеста с одним именем мост путал бы при срабатывании
    seen, unique = set(), []
    for g in out:
        if g['name'] in seen:
            continue
        seen.add(g['name'])
        unique.append(g)
    out = unique
    return out


def save_gestures(items):
    with gestures_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = GESTURES_PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(items, ensure_ascii=False))
        tmp.replace(GESTURES_PATH)


def run_task(task):
    ttype = task.get('type')
    if ttype == 'action':
        return injector.send(task['action'])
    if ttype == 'keys':
        keys = parse_keys(task.get('keys'))
        if not keys:
            return False, 'непонятное сочетание'
        return injector.tap_keys(keys)
    if ttype == 'url':
        try:
            subprocess.Popen(['xdg-open', task['url']], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return True, None
        except Exception as e:                         # noqa: BLE001
            return False, str(e)
    if ttype == 'command':
        try:
            # без оболочки: никаких подстановок и цепочек команд
            subprocess.Popen(shlex.split(task['command']), stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return True, None
        except Exception as e:                         # noqa: BLE001
            return False, str(e)
    return False, 'у жеста нет задачи'


def describe_task(task):
    t = task.get('type')
    return {
        'action': lambda: LABELS.get(task.get('action'), task.get('action')),
        'keys': lambda: task.get('keys'),
        'url': lambda: task.get('url'),
        'command': lambda: task.get('command'),
    }.get(t, lambda: 'без задачи')()


injector = Injector()

heartbeat = {'t': 0.0, 'fps': 0, 'hands': 0, 'camera': False, 'note': ''}
pages = {}


class Handler(SimpleHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit=4096):
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            raise ValueError('слишком большое тело')
        return json.loads(self.rfile.read(length) or b'{}')

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            st = injector.status()
            age = time.time() - heartbeat['t'] if heartbeat['t'] else None
            st['daemon'] = {
                'alive': age is not None and age < 6,
                'ageSec': None if age is None else round(age, 1),
                'fps': heartbeat['fps'], 'hands': heartbeat['hands'],
                'camera': heartbeat['camera'], 'note': heartbeat['note'],
                'pages': {k: v[1] for k, v in pages.items()},
            }
            return self._json(200, st)
        if path == '/history':
            return self._json(200, history_summary())
        if path == '/gestures':
            items = read_gestures()
            for g in items:
                g['taskLabel'] = describe_task(g.get('task') or {})
            return self._json(200, {'gestures': items, 'actions': sorted(ACTIONS)})
        if path == '/guard':
            with guard_lock:
                return self._json(200, {'events': guard_events[-40:],
                                        'dir': str(GUARD_DIR)})
        if path == '/config':
            return self._json(200, {'config': config, 'error': config_error})
        return super().do_GET()

    def _trusted(self):
        """Пускаем только свою страницу и локальные утилиты вроде curl.

        Мост слушает только 127.0.0.1, но любой открытый в браузере сайт может
        отправить запрос на localhost. Браузер при этом ставит заголовок Origin
        с адресом того сайта, по нему и отсекаем. Тело — только JSON: форма
        с другим типом не пройдёт, а JSON с чужого сайта браузер не отправит
        без предварительного запроса, на который мы не отвечаем.
        """
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'):
            return False, 'чужой источник'
        if int(self.headers.get('Content-Length') or 0) > 0:
            ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip()
            if ctype != 'application/json':
                return False, 'тело только в JSON'
        return True, None

    def do_POST(self):
        path = self.path.split('?')[0]
        ok, reason = self._trusted()
        if not ok:
            print(f'× отклонён запрос {path}: {reason}', flush=True)
            return self._json(403, {'ok': False, 'reason': reason})
        try:
            if path == '/guard':
                data = self._body(MAX_SHOT * 2)        # base64 раздувает примерно на треть
            elif path == '/gestures':
                data = self._body(MAX_GESTURES_BODY)
            elif path in ('/action', '/pointer', '/heartbeat', '/osd', '/workout',
                          '/gesture-fire'):
                data = self._body()
            else:
                data = {}
        except Exception as e:                         # noqa: BLE001
            return self._json(400, {'ok': False, 'reason': str(e)})

        if path == '/heartbeat':
            now = time.time()
            page = str(data.get('page') or '?')[:12]
            pages[page] = (now, int(data.get('frames') or 0))
            for k, (seen, _) in list(pages.items()):
                if now - seen > 15:
                    del pages[k]
            heartbeat.update(t=now, fps=int(data.get('fps') or 0),
                             hands=int(data.get('hands') or 0),
                             camera=bool(data.get('camera')),
                             note=str(data.get('note') or '')[:200])
            return self._json(200, {'ok': True})

        if path == '/gestures':
            try:
                items = clean_gestures(data.get('gestures'))
            except ValueError as e:
                return self._json(400, {'ok': False, 'reason': str(e)})
            save_gestures(items)
            print(f'✓ жестов сохранено: {len(items)}', flush=True)
            return self._json(200, {'ok': True, 'count': len(items)})

        if path == '/gesture-fire':
            name = str(data.get('name') or '')
            match = next((g for g in read_gestures()
                          if g.get('name') == name and g.get('enabled', True)), None)
            if not match:
                return self._json(404, {'ok': False, 'reason': 'нет такого жеста'})
            task = match.get('task') or {}
            ok, reason = run_task(task)
            if ok:
                injector.osd.show(f'{name}: {describe_task(task)}')
            print(f'{"→" if ok else "×"} жест «{name}»: {describe_task(task)}'
                  + ('' if ok else f'  ({reason})'), flush=True)
            return self._json(200 if ok else 500, {'ok': ok, 'reason': reason})

        if path == '/workout':
            reps = int(data.get('reps') or 0)
            if reps <= 0:
                return self._json(400, {'ok': False, 'reason': 'пустой подход'})
            entry = {
                'date': time.strftime('%Y-%m-%d'),
                'time': time.strftime('%H:%M'),
                'exercise': str(data.get('exercise') or 'curl')[:32],
                'reps': reps,
                'left': int(data.get('left') or 0),
                'right': int(data.get('right') or 0),
                'sec': int(data.get('sec') or 0),
            }
            total = add_set(entry)
            print(f'✓ подход: {entry["exercise"]} × {reps}  (всего записей {total})',
                  flush=True)
            return self._json(200, {'ok': True, 'saved': entry})

        if path == '/guard':
            reason = str(data.get('reason') or 'движение')[:60]
            shot = save_shot(data.get('image'))
            event = {'at': time.strftime('%Y-%m-%d %H:%M:%S'),
                     'reason': reason, 'shot': shot}
            with guard_lock:
                guard_events.append(event)
                del guard_events[:-200]
            injector.osd.show(f'Охрана: {reason}')
            print(f'! охрана: {reason}' + (f'  → {shot}' if shot else ''), flush=True)
            return self._json(200, {'ok': True, 'event': event})

        if path == '/osd':
            text = str(data.get('text') or '')[:120]
            injector.osd.show(text)
            return self._json(200, {'ok': True})

        if path == '/pointer':
            ok, reason = injector.pointer(
                move=data.get('move'), button=data.get('button'),
                down=data.get('down'), scroll=data.get('scroll'),
                hscroll=data.get('hscroll'))
            return self._json(200 if ok else 500, {'ok': ok, 'reason': reason})

        if path == '/action':
            action = str(data.get('action') or '')
            ok, reason = injector.send(action)
            print(f'{"→" if ok else "×"} {action}' + ('' if ok else f'  ({reason})'),
                  flush=True)
            return self._json(200 if ok else 500,
                              {'ok': ok, 'action': action, 'reason': reason})

        if path == '/reload-config':
            global config, config_error
            config, config_error = load_config()
            print(f'конфиг перечитан{"" if not config_error else ": " + config_error}',
                  flush=True)
            return self._json(200, {'ok': True, 'config': config, 'error': config_error})

        return self._json(404, {'ok': False, 'reason': 'нет такого пути'})

    def end_headers(self):
        if self.path.endswith(('.html', '.js', '.css', '/')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    st = injector.status()
    print(f'YeahTrack → http://localhost:{PORT}')
    print('мост ввода: ' + ('готов (GNOME RemoteDesktop)' if st['ok']
                            else f'НЕ работает — {st["reason"]}'))
    if config_error:
        print(f'конфиг: {config_error}')
    server = ThreadingHTTPServer(('127.0.0.1', PORT),
                                 partial(Handler, directory=str(ROOT)))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nостановка')
    finally:
        injector.close()
        server.server_close()


if __name__ == '__main__':
    main()
