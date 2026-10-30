// Vista 3D de la Oficina Bosio (Three.js): salas de vidrio con borde de neón, escritorios, bots sentados y luz de estado.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const cont = document.getElementById("v3d");
const W = () => cont.clientWidth || 800, H = () => cont.clientHeight || 600;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W(), H());
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
cont.append(renderer.domElement);
const labels = document.createElement("div"); labels.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden"; cont.append(labels);
const tip = document.createElement("div"); tip.className = "tip3"; tip.hidden = true; cont.append(tip);
const hint = document.createElement("div"); hint.className = "hint3"; hint.textContent = "Arrastrá para girar · pellizcá o rueda para acercar · tocá un bot"; cont.append(hint);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d14);
scene.fog = new THREE.Fog(0x0b0d14, 60, 140);
const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.1, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.44; controls.minDistance = 8; controls.maxDistance = 110; controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight(0xbcc8ff, 0x1a1408, 0.75));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6); sun.position.set(25, 45, 18); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 140 }); sun.shadow.bias = -0.0005;
scene.add(sun);

// piso de madera procedural
function texMadera() {
  const c = document.createElement("canvas"); c.width = c.height = 512; const g = c.getContext("2d");
  for (let i = 0; i < 16; i++) { const y = i * 32; const base = 150 + Math.random() * 30; g.fillStyle = `rgb(${base + 40},${base},${base - 50})`; g.fillRect(0, y, 512, 32);
    for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(80,50,20,${Math.random() * 0.12})`; g.beginPath(); const yy = y + Math.random() * 32; g.moveTo(0, yy); g.bezierCurveTo(170, yy + 3, 340, yy - 3, 512, yy); g.stroke(); }
    g.fillStyle = "rgba(40,25,10,.35)"; g.fillRect(0, y + 31, 512, 1); g.fillRect((i * 137) % 512, y, 1, 32); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(14, 14); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const piso = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ map: texMadera(), roughness: 0.75, metalness: 0.02, color: 0xc9b8a0 }));
piso.rotation.x = -Math.PI / 2; piso.receiveShadow = true; scene.add(piso);

const M = {
  vidrio: new THREE.MeshPhysicalMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, transmission: 0.6, depthWrite: false }),
  mesa: new THREE.MeshStandardMaterial({ color: 0xd9b37a, roughness: 0.55 }),
  pata: new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.4, metalness: 0.6 }),
  monitor: new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.3, metalness: 0.4 }),
  piel: new THREE.MeshStandardMaterial({ color: 0xe9bf98, roughness: 0.7 }),
  silla: new THREE.MeshStandardMaterial({ color: 0x23262f, roughness: 0.6 }),
  oro: new THREE.MeshStandardMaterial({ color: 0xf5b942, roughness: 0.3, metalness: 0.8, emissive: 0x3a2500 })
};
const COL = { ok: 0x3ddc84, run: 0x5cc8ff, wait: 0xf0b04a, bad: 0xff5c5c, pause: 0x6b7290, idle: 0x3a3f55, off: 0x3a3f55 };
const G = { mesa: new THREE.BoxGeometry(2.2, 0.12, 1.1), pata: new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), monitor: new THREE.BoxGeometry(0.9, 0.55, 0.06), pantalla: new THREE.PlaneGeometry(0.82, 0.47), cuerpo: new THREE.CapsuleGeometry(0.32, 0.5, 6, 12), cabeza: new THREE.SphereGeometry(0.28, 20, 16), pelo: new THREE.SphereGeometry(0.29, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.1), aro: new THREE.TorusGeometry(0.62, 0.05, 8, 40), silla: new THREE.BoxGeometry(0.75, 0.1, 0.75), respaldo: new THREE.BoxGeometry(0.75, 0.8, 0.1) };

let raiz = new THREE.Group(); scene.add(raiz);
const clickables = []; const animados = []; const etiquetas = [];
let salas = [];
const tmp = new THREE.Vector3();

function puesto(b, color, estado, x, z, esJefe) {
  const g = new THREE.Group(); g.position.set(x, 0, z);
  const mesa = new THREE.Mesh(G.mesa, M.mesa); mesa.position.y = 0.95; mesa.castShadow = mesa.receiveShadow = true; g.add(mesa);
  for (const [px, pz] of [[-1, -0.45], [1, -0.45], [-1, 0.45], [1, 0.45]]) { const p = new THREE.Mesh(G.pata, M.pata); p.position.set(px, 0.45, pz); g.add(p); }
  const mon = new THREE.Mesh(G.monitor, M.monitor); mon.position.set(0, 1.35, -0.32); mon.castShadow = true; g.add(mon);
  const on = estado === "ok" || estado === "run";
  const scr = new THREE.Mesh(G.pantalla, new THREE.MeshStandardMaterial({ color: 0x0a0c10, emissive: estado === "bad" ? 0x7a1010 : on ? 0x1d6b52 : 0x101420, emissiveIntensity: on ? 1.6 : 0.7 }));
  scr.position.set(0, 1.35, -0.285); g.add(scr);
  const silla = new THREE.Mesh(G.silla, M.silla); silla.position.set(0, 0.55, 0.75); g.add(silla);
  const resp = new THREE.Mesh(G.respaldo, M.silla); resp.position.set(0, 0.95, 1.1); g.add(resp);
  const persona = new THREE.Group(); persona.position.set(0, 0, 0.72);
  const cuerpo = new THREE.Mesh(G.cuerpo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 })); cuerpo.position.y = 1.05; cuerpo.castShadow = true; persona.add(cuerpo);
  const cab = new THREE.Mesh(G.cabeza, M.piel); cab.position.y = 1.72; cab.castShadow = true; persona.add(cab);
  const pelo = new THREE.Mesh(G.pelo, new THREE.MeshStandardMaterial({ color: [0x2a1a10, 0x5a3418, 0x111111, 0x8a5a2a][Math.abs(hash(b.id)) % 4], roughness: 0.9 })); pelo.position.y = 1.74; pelo.rotation.x = -0.25; persona.add(pelo);
  if (esJefe) { const corona = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.16, 6, 1, true), M.oro); corona.position.y = 2.06; persona.add(corona); }
  if (estado === "pause" || estado === "off") persona.visible = estado !== "off" ? true : false;
  if (estado === "pause") { cuerpo.material.color.multiplyScalar(0.45); }
  g.add(persona);
  const aro = new THREE.Mesh(G.aro, new THREE.MeshBasicMaterial({ color: COL[estado] || COL.idle, transparent: true, opacity: 0.9 })); aro.rotation.x = -Math.PI / 2; aro.position.set(0, 0.03, 0.72); g.add(aro);
  if (on) animados.push({ persona, fase: Math.random() * 6, aro });
  if (estado === "bad") animados.push({ aro, alerta: true, fase: Math.random() * 6 });
  g.userData = { bot: b }; persona.userData = { bot: b }; cuerpo.userData = { bot: b }; cab.userData = { bot: b }; mesa.userData = { bot: b };
  clickables.push(cuerpo, cab, mesa);
  return g;
}
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
function sala(a, bs, ox, oz, w, d) {
  const color = new THREE.Color(a.color);
  const g = new THREE.Group(); g.position.set(ox, 0, oz);
  const alfombra = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, d - 0.2), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.35), roughness: 0.95, transparent: true, opacity: 0.55 }));
  alfombra.rotation.x = -Math.PI / 2; alfombra.position.y = 0.01; alfombra.receiveShadow = true; g.add(alfombra);
  const hgt = 2.4; const t = 0.06;
  for (const [px, pz, sx, sz] of [[0, -d / 2, w, t], [0, d / 2, w, t], [-w / 2, 0, t, d], [w / 2, 0, t, d]]) {
    const muro = new THREE.Mesh(new THREE.BoxGeometry(sx, hgt, sz), M.vidrio); muro.position.set(px, hgt / 2, pz); g.add(muro);
    const borde = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.02, 0.06, sz + 0.02), new THREE.MeshBasicMaterial({ color })); borde.position.set(px, hgt, pz); g.add(borde);
    const zocalo = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.02, 0.05, sz + 0.02), new THREE.MeshBasicMaterial({ color })); zocalo.position.set(px, 0.03, pz); g.add(zocalo);
  }
  const luz = new THREE.PointLight(color, 6, Math.max(w, d) * 1.1, 2); luz.position.set(0, 3.2, 0); g.add(luz);
  const cols = Math.max(1, Math.floor((w - 1) / 3));
  const lista = [{ jefe: true, b: { id: "gte_" + a.id, nombre: "Gerente de " + a.nombre, area: a.id, jefe: true } }, ...(window.OF.filtro === "jefes" ? [] : bs.map(b => ({ b })))];
  lista.forEach((it, i) => { const cx = (i % cols) - (cols - 1) / 2; const cz = Math.floor(i / cols); const estado = it.jefe ? "ok" : window.__st(it.b).k; g.add(puesto(it.b, it.jefe ? 0xf5b942 : a.color, estado, cx * 3, -d / 2 + 1.6 + cz * 2.9, it.jefe)); });
  raiz.add(g);
  const anchor = new THREE.Vector3(ox, hgt + 0.6, oz - d / 2);
  const el = document.createElement("div"); el.className = "lab3"; el.style.setProperty("--c", a.color); el.innerHTML = `${a.icono || "📁"} ${esc(a.nombre)}<span class="n">${bs.length}</span>`; labels.append(el);
  etiquetas.push({ el, anchor });
  salas.push({ a, cx: ox, cz: oz, w, d });
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function construir() {
  scene.remove(raiz); raiz.traverse(o => { if (o.isMesh && o.material && o.material.map == null && !Object.values(M).includes(o.material)) o.material.dispose?.(); });
  raiz = new THREE.Group(); scene.add(raiz); clickables.length = 0; animados.length = 0; salas = []; etiquetas.length = 0; labels.innerHTML = "";
  const ORG = window.OF.ORG; if (!ORG) return;
  let lista = ORG.areas.map((a, i) => ({ a, i, bs: ORG.bots.filter(b => b.area === a.id) }));
  if (window.OF.filtro === "area") lista = lista.filter(x => x.i === window.OF.areaIdx % ORG.areas.length);
  const dims = lista.map(x => { const n = (window.OF.filtro === "jefes" ? 0 : x.bs.length) + 1; const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n)))); const rows = Math.ceil(n / cols); return { ...x, w: cols * 3 + 1.2, d: rows * 2.9 + 1.8 }; });
  const porFila = Math.max(1, Math.ceil(Math.sqrt(dims.length * 1.4)));
  let z = 0, i = 0; const filas = [];
  while (i < dims.length) { const fila = dims.slice(i, i + porFila); i += porFila; filas.push(fila); }
  const anchoMax = Math.max(...filas.map(f => f.reduce((s, x) => s + x.w + 2, 0)));
  for (const fila of filas) { const ancho = fila.reduce((s, x) => s + x.w + 4, 0); let x = -ancho / 2; const prof = Math.max(...fila.map(f => f.d)); for (const it of fila) { sala(it.a, it.bs, x + it.w / 2, z + it.d / 2, it.w, it.d); x += it.w + 4; } z += prof + 4.5; }
  // escritorio del gerente general al frente
  const gg = puesto({ id: "gerente", nombre: "Gerente general", jefe: true }, 0xf5b942, "ok", 0, -4, true); gg.scale.setScalar(1.35); raiz.add(gg);
  const el = document.createElement("div"); el.className = "lab3"; el.style.setProperty("--c", "#f5b942"); el.textContent = "🎯 Gerente general"; labels.append(el); etiquetas.push({ el, anchor: new THREE.Vector3(0, 3.6, -4) });
  raiz.position.z = -(z) / 2 + 2;
  const tam = Math.max(anchoMax, z + 6);
  const objetivo = new THREE.Vector3(0, 0, 0);
  if (!construir.hecho || window.OF.filtro === "area") { camera.position.set(tam * 0.1, tam * 0.5 + 4, tam * 0.55 + 4); controls.target.copy(objetivo); construir.hecho = true; }
  controls.update();
}
window.__st = b => { const S = window.st || null; return S ? S(b) : { k: "idle" }; };
// exponer el cálculo de estado de la página
try { window.st = st; } catch (e) { /* st está en el script de la página */ }

const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2(); let abajo = null;
function pick(ev) { const r = renderer.domElement.getBoundingClientRect(); ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1; ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1; ray.setFromCamera(ptr, camera); const hit = ray.intersectObjects(clickables, false)[0]; return hit && hit.object.userData.bot; }
renderer.domElement.addEventListener("pointerdown", e => { abajo = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", e => { if (!abajo || Math.hypot(e.clientX - abajo[0], e.clientY - abajo[1]) > 6) return; const b = pick(e); if (!b) return; if (b.jefe) { const a = window.OF.ORG.areas.find(x => x.id === b.area); if (a) window.verArea(a); } else window.verBot(b); });
renderer.domElement.addEventListener("pointermove", e => { if (e.pointerType !== "mouse") return; const b = pick(e); const r = renderer.domElement.getBoundingClientRect(); if (b) { tip.hidden = false; tip.textContent = b.jefe ? b.nombre : `${b.nombre} · ${window.__st(b).t}`; tip.style.left = (e.clientX - r.left) + "px"; tip.style.top = (e.clientY - r.top) + "px"; renderer.domElement.style.cursor = "pointer"; } else { tip.hidden = true; renderer.domElement.style.cursor = ""; } });

const reloj = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  if (cont.hidden) return;
  const t = reloj.getElapsedTime();
  for (const a of animados) { if (a.persona) a.persona.position.y = Math.abs(Math.sin(t * 6 + a.fase)) * 0.04; if (a.aro) a.aro.material.opacity = a.alerta ? 0.4 + 0.6 * Math.abs(Math.sin(t * 3 + a.fase)) : 0.75 + 0.25 * Math.sin(t * 2 + a.fase); }
  controls.update(); renderer.render(scene, camera);
  const w = W(), h = H();
  for (const { el, anchor } of etiquetas) { tmp.copy(anchor); tmp.z += raiz.position.z; tmp.project(camera); const vis = tmp.z < 1 && tmp.x > -1.1 && tmp.x < 1.1 && tmp.y > -1.1 && tmp.y < 1.1; el.style.display = vis ? "" : "none"; if (vis) { el.style.left = ((tmp.x + 1) / 2 * w) + "px"; el.style.top = ((1 - tmp.y) / 2 * h) + "px"; } }
}
function redimensionar() { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }
new ResizeObserver(redimensionar).observe(cont);
window.OF3D = { actualizar: construir, enfocar: () => { construir.hecho = false; construir(); } };
construir(); loop();
