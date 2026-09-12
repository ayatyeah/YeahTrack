#!/usr/bin/env python3
"""Короткая сводка: жив ли трекер, сколько он ест процессора и памяти."""
import json, os, subprocess, sys, urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else '8010'
PAT = '/app/extra/chrome.*yeahtrack[-]daemon'


def pids():
    out = subprocess.run(['pgrep', '-f', PAT], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def read_pss(pid):
    """PSS честнее RSS: общая память делится между процессами браузера."""
    try:
        with open(f'/proc/{pid}/smaps_rollup') as f:
            for line in f:
                if line.startswith('Pss:'):
                    return int(line.split()[1])          # кБ
    except OSError:
        pass
    return 0


def read_cpu(ps_pids):
    if not ps_pids:
        return 0.0
    out = subprocess.run(['ps', '-o', 'pcpu=', '-p', ','.join(map(str, ps_pids))],
                         capture_output=True, text=True).stdout
    return sum(float(x) for x in out.split() or ['0'])


try:
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=3) as r:
        h = json.load(r)
except Exception as e:                                   # noqa: BLE001
    print(f'мост не отвечает на порту {PORT}: {e}')
    sys.exit(1)

d = h['daemon']
print(f"мост:    {'готов' if h['ok'] else 'НЕ работает'}")
print(f"трекер:  {'жив' if d['alive'] else 'молчит'}  "
      f"кадров/с {d['fps']}  рук {d['hands']}  "
      f"камера {'взята' if d['camera'] else 'нет'}"
      + (f"  [{d['note']}]" if d['note'] else ''))

ps_pids = pids()
if ps_pids:
    pss = sum(read_pss(p) for p in ps_pids)
    print(f"браузер: {len(ps_pids)} процессов, "
          f"память {pss / 1024:.0f} МБ, процессор {read_cpu(ps_pids):.0f}%")
else:
    print('браузер: не запущен')

bridge = subprocess.run(['pgrep', '-f', 'bridge[.]py'], capture_output=True, text=True).stdout.split()
if bridge:
    pss = sum(read_pss(int(p)) for p in bridge)
    print(f"мост:    память {pss / 1024:.0f} МБ, процессор {read_cpu([int(p) for p in bridge]):.0f}%")
