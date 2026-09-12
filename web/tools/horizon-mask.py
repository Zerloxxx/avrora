"""Маска горизонта по реальному рельефу (ASTER GDEM 30 м через OpenTopoData).

Для каждого пункта строим 36 лучей по азимутам, на каждом — высоты рельефа на расстояниях
0.25…30 км (лог-шаг), угол закрытия = max по лучу atan((h − h0 − антенна − d²/2R) / d).
Формула та же, что maskFromProfiles() в src/sim.js — расхождение считается багом.

Запуск (нужен интернет, ~1 запрос/с, ~8 запросов на пункт):
    python web/tools/horizon-mask.py                 # пункты кейса + города из index.html → web/data/terrain.js
    python web/tools/horizon-mask.py 71.64 128.87     # маска одной точки в stdout (JSON)
"""
import json, math, re, sys, time, urllib.request, urllib.parse, os

R_KM = 6371.0
ANT_M = 2.0
SECTORS = 36
DISTS_KM = [0.25, 0.4, 0.6, 0.9, 1.3, 1.8, 2.5, 3.5, 5, 7, 9, 12, 15, 19, 24, 30]
API = 'https://api.opentopodata.org/v1/aster30m'
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)


def dest(lat, lon, az_deg, d_km):
    """Точка на расстоянии d_km по азимуту az_deg (сфера)."""
    la, lo, az, dr = map(math.radians, (lat, lon, az_deg, 0))
    dr = d_km / R_KM
    la2 = math.asin(math.sin(la) * math.cos(dr) + math.cos(la) * math.sin(dr) * math.cos(az))
    lo2 = lo + math.atan2(math.sin(az) * math.sin(dr) * math.cos(la), math.cos(dr) - math.sin(la) * math.sin(la2))
    return math.degrees(la2), (math.degrees(lo2) + 540) % 360 - 180


def elevations(points):
    out = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        q = '|'.join(f'{la:.5f},{lo:.5f}' for la, lo in chunk)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(API + '?locations=' + urllib.parse.quote(q, safe='|,'), timeout=30) as r:
                    data = json.load(r)
                if data.get('status') != 'OK':
                    raise RuntimeError(data)
                out += [x['elevation'] if x['elevation'] is not None else 0.0 for x in data['results']]
                break
            except Exception as e:  # лимит 1 запрос/с — подождать и повторить
                if attempt == 3:
                    raise
                time.sleep(2 + attempt)
        time.sleep(1.05)
    return out


def horizon_mask(lat, lon):
    pts = [(lat, lon)] + [dest(lat, lon, (k + 0.5) * 360 / SECTORS, d) for k in range(SECTORS) for d in DISTS_KM]
    h = elevations(pts)
    h0 = h[0]
    mask = []
    i = 1
    for k in range(SECTORS):
        best = 0.0
        for d in DISTS_KM:
            drop = d * d / (2 * R_KM) * 1000
            ang = math.degrees(math.atan2(h[i] - h0 - ANT_M - drop, d * 1000))
            best = max(best, ang)
            i += 1
        mask.append(round(best, 2))
    return h0, mask


def case_sites():
    sites = {}
    for f in sorted(os.listdir(os.path.join(WEB, '..', 'Данные'))):
        if f.endswith('.json'):
            s = json.load(open(os.path.join(WEB, '..', 'Данные', f), encoding='utf-8'))
            for g in s['ground_sites']:
                sites[g['id']] = (g['lat_deg'], g['lon_deg'], g.get('name', g['id']))
    html = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()
    for sid, name, la, lo in re.findall(r'<option value="(G_\w+)\|([^|]+)\|([\d.\-]+)\|([\d.\-]+)"', html):
        sites[sid] = (float(la), float(lo), name)
    return sites


if __name__ == '__main__':
    if len(sys.argv) == 3:
        h0, m = horizon_mask(float(sys.argv[1]), float(sys.argv[2]))
        print(json.dumps({'h0_m': h0, 'horizon_mask': m}))
        sys.exit()
    out = {}
    for sid, (la, lo, name) in case_sites().items():
        h0, m = horizon_mask(la, lo)
        out[f'{la:.2f},{lo:.2f}'] = {'id': sid, 'name': name, 'h0_m': h0, 'horizon_mask': m, 'source': 'ASTER GDEM 30m (OpenTopoData)'}
        print(f'{sid:6} {name:40} h0={h0:6.1f} м  max={max(m):5.1f}°  mean={sum(m)/len(m):4.1f}°', flush=True)
    path = os.path.join(WEB, 'data', 'terrain.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('// Маски горизонта по реальному рельефу; сгенерировано tools/horizon-mask.py. Ключ — "lat,lon" с двумя знаками.\n')
        f.write('window.TERRAIN = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n')
    print('->', path)
