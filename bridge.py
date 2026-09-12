#!/usr/bin/env python3
"""YeahTrack bridge: раздаёт страницу и превращает жесты в действия системы.

Ввод идёт через org.gnome.Mutter.RemoteDesktop — штатный путь GNOME Wayland,
без root и без ydotool. Оттуда же берутся мышь и колесо прокрутки.
"""
import json
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / 'config.json'
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

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 4096:
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
        if path == '/config':
            return self._json(200, {'config': config, 'error': config_error})
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            data = self._body() if path in ('/action', '/pointer', '/heartbeat') else {}
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
