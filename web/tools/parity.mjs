/* Полная сверка расчётного ядра с эталоном организаторов «Расчетный модуль/geometry.py».
   Гоняет эталон на всех сценариях папки «Данные» в нескольких моментах времени и сравнивает
   позиции, признак active, множество ISL-рёбер и видимость с наземных пунктов.

   Запуск из папки web:  node tools/parity.mjs        (нужны python3 и numpy)

   Внимание: `edges` в выводе geometry.py — это ISL ПЛЮС наземные линии видимости
   (на t=0 полной группировки 86 = 76 ISL + 10 наземных), поэтому пары фильтруются по satIds.
*/
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as sim from '../src/sim.js';
const dir = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');   // корень репозитория
let bad = 0;
for (const f of ['01_full_constellation','02_first_launch','03_satellite_outages','04_link_range']) {
  const path = `${dir}/Данные/${f}.json`;
  const s = JSON.parse(readFileSync(path,'utf8'));
  const satIds = new Set(s.design.satellites.map(x=>x.id));
  for (const t of [0, 12000, 43200, 60000, 86280]) {
    const py = JSON.parse(execFileSync('python3', [`${dir}/Расчетный модуль/geometry.py`, path, String(t)], {maxBuffer: 1<<28}).toString());
    const js = sim.snapshot(s, t);
    let maxdp = 0, actDiff = 0;
    py.satellites.forEach((p,i)=>{ maxdp=Math.max(maxdp,Math.hypot(p.x_km-js.pos[i].x,p.y_km-js.pos[i].y,p.z_km-js.pos[i].z)); if(p.active!==js.active[i]) actDiff++; });
    const pyIsl = new Set(py.edges.filter(e=>satIds.has(e[0])&&satIds.has(e[1])).map(e=>[e[0],e[1]].sort().join('-')));
    const pyGnd = new Set(py.edges.filter(e=>!(satIds.has(e[0])&&satIds.has(e[1]))).map(e=>e[0]+'-'+e[1]));
    const jsIsl = new Set(js.isl.map(([i,j])=>[s.design.satellites[i].id,s.design.satellites[j].id].sort().join('-')));
    const jsGnd = new Set();
    for (const g of s.ground_sites) for (const k of js.ground[g.id].visible) jsGnd.add(g.id+'-'+s.design.satellites[k].id);
    const dIsl = [...pyIsl].filter(x=>!jsIsl.has(x)).length + [...jsIsl].filter(x=>!pyIsl.has(x)).length;
    const dGnd = [...pyGnd].filter(x=>!jsGnd.has(x)).length + [...jsGnd].filter(x=>!pyGnd.has(x)).length;
    bad += actDiff + dIsl + dGnd;
    console.log(`${f.padEnd(22)} t=${String(t).padStart(5)}  Δpos=${maxdp.toExponential(1)}  ISL ${pyIsl.size}/${jsIsl.size} расх=${dIsl}  назем. ${pyGnd.size}/${jsGnd.size} расх=${dGnd}  active расх=${actDiff}`);
  }
}
console.log(bad === 0 ? '\nВСЁ СОВПАДАЕТ с geometry.py' : `\nРАСХОЖДЕНИЙ: ${bad}`);
