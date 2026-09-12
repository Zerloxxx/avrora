/* Общие ресурсы 3D-глобуса: текстуры Земли, звёзды, модель аппарата, перевод координат.
   Ни DOM, ни state — только фабрики объектов Three.js. Используется основной сценой (scene.js)
   и страницей абонента (subscriber.js), чтобы глобус был один и тот же, а не две копии.

   Пути к ресурсам считаются от этого модуля (import.meta.url), а не от страницы:
   иначе /abonent/index.html искал бы текстуры в /abonent/vendor/. */
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';

const VENDOR = new URL('../vendor/', import.meta.url);
const asset = name => new URL(name, VENDOR).href;

// ECEF (ось Z — север, как в geometry.py) → Three.js (ось Y — вверх)
export const toThree = p => new THREE.Vector3(p.x, p.z, -p.y);

// орбита визуально приподнята: реальные 550 км сливались бы с поверхностью (ADR-0004)
export const ORBIT_VISUAL = 1.42;

// звёзды: «оболочка» из точек заданного радиуса
export function makeStars(count, size, radius, opacity) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([radius * r * Math.cos(phi), radius * u, radius * r * Math.sin(phi)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size, color: 0xffffff, transparent: true, opacity, sizeAttenuation: true, depthWrite: false });
  return new THREE.Points(geo, mat);
}

export const makeStarfield = () => [makeStars(2500, 0.06, 60, 0.85), makeStars(600, 0.13, 55, 1)];

// текстуры NASA Blue Marble (скопированы из репозитория three.js в vendor/)
function textureLoader(renderer) {
  const loader = new THREE.TextureLoader();
  return (name, srgb = true) => {
    const t = loader.load(asset('textures/' + name));
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  };
}

/* Земля единичного радиуса с атмосферой. Возвращает { meshes, earth, clouds }:
   meshes — всё, что надо добавить во вращающуюся с Землёй группу;
   earth — для raycast'а по поверхности; clouds — их слой медленно крутят в цикле кадров.
   sunDirUniform — Vector3, который владелец обновляет каждый кадр (терминатор и ночные огни). */
export function makeEarth(renderer, sunDirUniform, { lowDetail = false } = {}) {
  const tex = textureLoader(renderer);
  const seg = lowDetail ? 64 : 128;
  const segAtmo = lowDetail ? 48 : 96;

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, seg, seg),
    new THREE.MeshPhongMaterial({
      map: tex(lowDetail ? 'earth_atmos_2048.jpg' : 'earth_atmos_4096.jpg'),
      specularMap: tex('earth_specular_2048.jpg', false),
      normalMap: tex('earth_normal_2048.jpg', false),
      normalScale: new THREE.Vector2(0.55, 0.55),
      specular: new THREE.Color(0x3a4a66),
      shininess: 22,
    })
  );

  // ночные огни городов — только на тёмной стороне
  const nightLights = new THREE.Mesh(
    new THREE.SphereGeometry(1.002, segAtmo, segAtmo),
    new THREE.ShaderMaterial({
      uniforms: { lights: { value: tex('earth_lights_2048.png') }, sunDir: { value: sunDirUniform } },
      vertexShader: `varying vec3 vN; varying vec2 vUv;
        void main(){ vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D lights; uniform vec3 sunDir; varying vec3 vN; varying vec2 vUv;
        void main(){ float night = smoothstep(0.12, -0.2, dot(vN, sunDir)); vec3 c = texture2D(lights, vUv).rgb; gl_FragColor = vec4(c * night * 1.4, 1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    })
  );

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.008, segAtmo, segAtmo),
    new THREE.MeshPhongMaterial({ map: tex('earth_clouds_2048.png'), transparent: true, opacity: 0.95, depthWrite: false })
  );

  // атмосфера: внутренний обод + внешнее свечение
  const rimMat = new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vN; varying vec3 vP;
      void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vP;
      void main(){ float f = 1.0 - max(dot(vN, normalize(-vP)), 0.0); float i = pow(f, 4.0) * 0.9; gl_FragColor = vec4(vec3(0.45, 0.7, 1.0) * i, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const rim = new THREE.Mesh(new THREE.SphereGeometry(1.001, segAtmo, segAtmo), rimMat);

  const glowMat = new THREE.ShaderMaterial({
    vertexShader: rimMat.vertexShader,
    fragmentShader: `varying vec3 vN; varying vec3 vP;
      void main(){ float a = clamp(-dot(vN, normalize(-vP)), 0.0, 1.0); float t = clamp(a / 0.42, 0.0, 1.0); float i = t * t * 1.3; gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * i, 1.0); }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.1, segAtmo, segAtmo), glowMat);

  return { meshes: [earth, nightLights, clouds, rim, glow], earth, clouds };
}

// свечение для спутников — спрайт с радиальным градиентом
export const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

// ---------- модель спутника ----------
// Процедурная модель: корпус в золотой ЭВТИ, две панели солнечных батарей, антенна-тарелка в надир.

// текстура солнечных батарей: ячейки с тонкой серебристой сеткой и лёгким бликом
const solarTex = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1f52'; g.fillRect(0, 0, 512, 192);
  const grad = g.createLinearGradient(0, 0, 512, 192);
  grad.addColorStop(0, 'rgba(90,130,255,0.35)'); grad.addColorStop(0.45, 'rgba(20,30,80,0)'); grad.addColorStop(1, 'rgba(120,90,220,0.3)');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 192);
  // ячейки со скошенными углами
  for (let y = 0; y < 192; y += 24) for (let x = 0; x < 512; x += 24) {
    g.fillStyle = `rgba(${10 + Math.random() * 10}, ${30 + Math.random() * 14}, ${90 + Math.random() * 30}, 0.9)`;
    g.beginPath(); g.moveTo(x + 3, y + 1); g.lineTo(x + 21, y + 1); g.lineTo(x + 23, y + 3); g.lineTo(x + 23, y + 21);
    g.lineTo(x + 21, y + 23); g.lineTo(x + 3, y + 23); g.lineTo(x + 1, y + 21); g.lineTo(x + 1, y + 3); g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(210,225,255,0.7)'; g.lineWidth = 1.2;
  for (let x = 0; x <= 512; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 192); g.stroke(); }
  for (let y = 0; y <= 192; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
})();

// мятая ЭВТИ: шумовая карта рельефа
const foilBump = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = 120 + Math.random() * 120; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.5; g.drawImage(c, 1, 0); g.drawImage(c, 0, 1); g.drawImage(c, -1, 0);   // лёгкое сглаживание
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); return t;
})();

// серая решётка антенной решётки на надирной грани
const arrayTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#b9c0c9'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(40,45,55,0.6)'; g.lineWidth = 1;
  for (let v = 0; v <= 128; v += 16) { g.beginPath(); g.moveTo(v, 0); g.lineTo(v, 128); g.stroke(); g.beginPath(); g.moveTo(0, v); g.lineTo(128, v); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

const SAT_MAT = {
  foil: new THREE.MeshStandardMaterial({ color: 0xe0b44c, metalness: 0.85, roughness: 0.42, bumpMap: foilBump, bumpScale: 0.0006, emissive: 0x2a1c05, emissiveIntensity: 0.35 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, metalness: 0.15, roughness: 0.55, emissive: 0x15181f, emissiveIntensity: 0.5 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23272f, metalness: 0.7, roughness: 0.45, emissive: 0x07080b, emissiveIntensity: 0.5 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xaab2bd, metalness: 0.9, roughness: 0.3 }),
  panel: new THREE.MeshStandardMaterial({ map: solarTex, metalness: 0.35, roughness: 0.32, emissive: 0x081a44, emissiveIntensity: 0.4, side: THREE.DoubleSide }),
  panelBack: new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.4, roughness: 0.7, emissive: 0x08090c, emissiveIntensity: 0.5 }),
  array: new THREE.MeshStandardMaterial({ map: arrayTex, metalness: 0.4, roughness: 0.5, emissive: 0x101216, emissiveIntensity: 0.4 }),
};

// Процедурная модель связного аппарата. Локальные оси: +Z — надир (на Землю), X — размах крыльев.
export function buildProceduralSatellite() {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
  };
  const rod = (len, r = 0.0004) => new THREE.CylinderGeometry(r, r, len, 6);

  // --- корпус ---
  add(new THREE.BoxGeometry(0.018, 0.018, 0.026), SAT_MAT.foil);
  add(new THREE.BoxGeometry(0.0184, 0.0012, 0.0236), SAT_MAT.white, 0, 0.0092, 0);     // радиатор сверху
  add(new THREE.BoxGeometry(0.0184, 0.0012, 0.0236), SAT_MAT.white, 0, -0.0092, 0);    // радиатор снизу
  add(new THREE.BoxGeometry(0.0006, 0.0184, 0.0264), SAT_MAT.dark, 0.0092, 0, 0);       // рёбра по бокам
  add(new THREE.BoxGeometry(0.0006, 0.0184, 0.0264), SAT_MAT.dark, -0.0092, 0, 0);
  // надирная грань: плоская антенная решётка
  add(new THREE.BoxGeometry(0.0152, 0.0152, 0.0012), SAT_MAT.array, 0, 0, 0.0135);
  // задняя часть: переходник, двигатель, звёздный датчик
  add(new THREE.CylinderGeometry(0.0072, 0.0078, 0.003, 32, 1, true), SAT_MAT.dark, 0, 0, -0.0145, Math.PI / 2, 0, 0);
  add(new THREE.CylinderGeometry(0.0012, 0.0032, 0.0034, 24, 1, true), SAT_MAT.steel, 0, 0, -0.0175, -Math.PI / 2, 0, 0);
  add(new THREE.CylinderGeometry(0.0014, 0.0016, 0.004, 12), SAT_MAT.dark, 0.0055, 0.0055, -0.014, Math.PI / 2, 0, 0);

  // --- параболическая антенна на кронштейне, направлена в надир ---
  const dish = new THREE.Group();
  dish.position.set(0, 0.0125, 0.012);
  const prof = []; for (let i = 0; i <= 12; i++) { const r = 0.0085 * i / 12; prof.push(new THREE.Vector2(r, 0.09 * r * r / 0.0085)); }
  const dishMesh = add(new THREE.LatheGeometry(prof, 40), new THREE.MeshStandardMaterial({ color: 0xf5f6f8, metalness: 0.2, roughness: 0.4, side: THREE.DoubleSide, emissive: 0x15181f, emissiveIntensity: 0.4 }), 0, 0, 0, Math.PI / 2, 0, 0, dish);
  dishMesh.position.z = 0.002;
  add(new THREE.TorusGeometry(0.0085, 0.0003, 6, 40), SAT_MAT.steel, 0, 0, 0.0028, 0, 0, 0, dish);         // обод
  add(new THREE.SphereGeometry(0.0009, 10, 10), SAT_MAT.dark, 0, 0, 0.0075, 0, 0, 0, dish);                  // облучатель
  for (let k = 0; k < 3; k++) {                                                                               // тренога облучателя
    const a = k / 3 * Math.PI * 2, x = Math.cos(a) * 0.0075, y = Math.sin(a) * 0.0075;
    const strut = add(rod(0.0089, 0.00025), SAT_MAT.steel, x / 2, y / 2, 0.005, 0, 0, 0, dish);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-x, -y, 0.0047).normalize());
  }
  add(rod(0.006, 0.0006), SAT_MAT.dark, 0, -0.004, -0.004, Math.PI / 2, 0, 0, dish);                          // кронштейн
  g.add(dish);

  // --- крылья солнечных батарей: штанга + 3 секции с рамками и шарнирами ---
  for (const sgn of [-1, 1]) {
    add(new THREE.BoxGeometry(0.014, 0.0022, 0.0022), SAT_MAT.dark, sgn * 0.016, 0, 0);                       // штанга
    add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.004, 16), SAT_MAT.steel, sgn * 0.0225, 0, 0, 0, 0, Math.PI / 2); // привод
    for (let i = 0; i < 3; i++) {
      const cx = sgn * (0.0245 + 0.0136 + i * 0.0282);
      add(new THREE.BoxGeometry(0.0272, 0.0206, 0.0006), SAT_MAT.panel, cx, 0, 0.0004);
      add(new THREE.BoxGeometry(0.0272, 0.0206, 0.0004), SAT_MAT.panelBack, cx, 0, -0.0003);
      add(new THREE.BoxGeometry(0.0276, 0.0009, 0.0012), SAT_MAT.dark, cx, 0.0106, 0);                       // рамка
      add(new THREE.BoxGeometry(0.0276, 0.0009, 0.0012), SAT_MAT.dark, cx, -0.0106, 0);
      if (i < 2) add(new THREE.CylinderGeometry(0.0007, 0.0007, 0.0212, 8), SAT_MAT.steel, cx + sgn * 0.0141, 0, 0); // шарнир
    }
    add(new THREE.BoxGeometry(0.0009, 0.0212, 0.0012), SAT_MAT.dark, sgn * (0.0245 + 0.0846), 0, 0);        // торец крыла
  }

  // --- антенны и мелочи ---
  add(rod(0.016), SAT_MAT.white, 0.007, 0.0135, -0.006);
  add(rod(0.011), SAT_MAT.white, -0.006, -0.0125, -0.003);
  add(new THREE.SphereGeometry(0.0007, 8, 8), SAT_MAT.steel, 0.007, 0.0215, -0.006);
  add(new THREE.BoxGeometry(0.004, 0.004, 0.0008), SAT_MAT.dark, -0.005, 0.0096, 0.006);                    // датчик
  return g;
}

/* Необязательная «настоящая» модель: положить glTF в vendor/satellite.glb.
   Файла нет — остаёмся на процедурной; onReady зовётся только при успехе. */
export function loadSatelliteGltf(onReady) {
  new GLTFLoader().load(asset('satellite.glb'), gltf => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(0.11 / Math.max(size.x, size.y, size.z));   // размах ~0.11 радиуса Земли
    onReady(wrap);
  }, undefined, () => { /* файла нет — остаёмся на процедурной модели */ });
}

/* Проекция мировой точки на экран + признак «спрятана за Землёй».
   Фабрика, потому что переиспользует три вектора между вызовами (кадр зовёт её десятки раз). */
export function makeProjector(camera) {
  const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
  return function project(world, W, H) {
    _d.copy(world).sub(camera.position);
    const t = Math.min(1, Math.max(0, -camera.position.dot(_d) / Math.max(_d.lengthSq(), 1e-9)));
    _c.copy(camera.position).addScaledVector(_d, t);
    const hidden = t < 1 && _c.length() < 0.999;
    _v.copy(world).project(camera);
    return { sx: (_v.x + 1) / 2 * W, sy: (1 - _v.y) / 2 * H, hidden: hidden || _v.z > 1 };
  };
}
