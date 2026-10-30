// Oficina Bosio: motor que corre solo en GitHub Actions.
// Gerente general + bots con una tarea cada uno + control de calidad + entrenamiento diario.
// Sin dependencias: Node 20+ (fetch nativo). Modelo: Gemini (clave gratis). Canal: Telegram.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(ROOT, "data");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "bots.json"), "utf8"));
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const TG_TOKEN = process.env.TELEGRAM_TOKEN || "";
const MODO = (process.env.MODO || "auto").trim();
const GEMINI_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta";
const TG_BASE = process.env.TG_BASE || "https://api.telegram.org";
const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();

/* ---------- utilidades ---------- */
const ar = (d = NOW) => new Date(d.getTime() - 3 * 3600 * 1000); // hora de Argentina (UTC-3)
const fechaAR = (d = NOW) => ar(d).toISOString().slice(0, 10);
const horaAR = (d = NOW) => ar(d).toISOString().slice(11, 16);
const diaAR = (d = NOW) => ar(d).getUTCDay(); // 0 domingo
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const escribir = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const limpiar = s => String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim();
const bots = CFG.bots;
const botPorId = id => bots.find(b => b.id === id);
const areaDe = b => CFG.areas.find(a => a.id === b.area) || { nombre: b.area };

/* ---------- estado ---------- */
const FEST = path.join(DATA, "estado.json");
const est = leer(FEST, {});
est.version = 1;
est.bots = est.bots || {};
est.log = est.log || [];
est.pendientes = est.pendientes || [];
est.mensajes = est.mensajes || {};
est.tgOffset = est.tgOffset || 0;
est.hechos = est.hechos || {}; // tareas diarias del gerente ya hechas: { parte: "2026-10-29", entrenamiento: "..." }
if (!est.consumo || est.consumo.fecha !== fechaAR()) est.consumo = { fecha: fechaAR(), consultas: 0 };
for (const b of bots) {
  est.bots[b.id] = Object.assign({ estado: "esperando", corridas: 0, fallas: 0, fallasSeguidas: 0, puntaje: null, historial: [], likes: 0, dislikes: 0, nivel: 1, ultimaFecha: null, ultimaCorrida: null, resumen: "", informe: null, pausado: false }, est.bots[b.id]);
}
est.bots.gerente = Object.assign({ estado: "esperando", resumen: "", ultimaCorrida: null }, est.bots.gerente);
let consultasCorrida = 0;
function log(quien, que) { est.log.unshift({ t: NOW.toISOString(), quien, que: String(que).slice(0, 300) }); est.log = est.log.slice(0, 250); console.log(`[${quien}] ${que}`); }
const hayCupo = (n = 1) => est.consumo.consultas + n <= CFG.limites.consultasPorDia && consultasCorrida + n <= CFG.limites.consultasPorCorrida;

/* ---------- Gemini ---------- */
let MODELOS = null;
async function modelos() {
  if (MODELOS) return MODELOS;
  if (process.env.GEMINI_MODEL) return (MODELOS = [process.env.GEMINI_MODEL]);
  try {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=200&key=${encodeURIComponent(GEMINI_KEY)}`);
    const j = await r.json();
    const ms = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/.test(m.name) && !/(embed|tts|image|live|audio|vision|aqa|learnlm|robotics|computer)/i.test(m.name)).map(m => m.name.replace(/^models\//, ""));
    const score = n => { const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0); return v * 10 + (/flash/.test(n) && !/lite/.test(n) ? 3 : /lite/.test(n) ? 2 : /pro/.test(n) ? 1 : 0) - (/(preview|exp|\d{3,}$)/.test(n) ? 0.5 : 0); };
    MODELOS = ms.sort((a, b) => score(b) - score(a)).slice(0, 4);
  } catch (e) { MODELOS = []; }
  if (!MODELOS.length) MODELOS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  return MODELOS;
}
async function gemini(prompt, { buscar = false, json = false } = {}) {
  if (!GEMINI_KEY) throw new Error("Falta la clave GEMINI_API_KEY en los secretos del repositorio.");
  if (!hayCupo()) throw new Error("Se llegó al cupo de consultas de hoy. Sigo mañana.");
  const lista = await modelos();
  let ultimoError = "";
  for (const modelo of lista) {
    for (let intento = 0; intento < 2; intento++) {
      const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: json ? 0.2 : 0.5, maxOutputTokens: 8192 } };
      if (buscar) body.tools = [{ google_search: {} }];
      if (json) body.generationConfig.responseMimeType = "application/json";
      if (buscar && json) delete body.generationConfig.responseMimeType;
      est.consumo.consultas++; consultasCorrida++;
      let r, j;
      try { r = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); j = await r.json().catch(() => ({})); }
      catch (e) { ultimoError = "sin conexión con Gemini"; await sleep(2000); continue; }
      if (r.ok) {
        const c = (j.candidates || [])[0] || {};
        const texto = ((c.content && c.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
        const gm = c.groundingMetadata || {};
        const fuentes = []; const vistos = new Set();
        for (const ch of gm.groundingChunks || []) { const w = ch.web || {}; if (w.uri && !vistos.has(w.uri)) { vistos.add(w.uri); fuentes.push({ titulo: w.title || w.uri, url: w.uri }); } }
        if (!texto) { ultimoError = "respuesta vacía (" + (c.finishReason || "?") + ")"; break; }
        return { texto, fuentes, modelo };
      }
      const msg = (j.error && j.error.message) || r.status;
      ultimoError = `${modelo}: ${r.status} ${String(msg).slice(0, 160)}`;
      if (r.status === 429 || r.status >= 500) { await sleep(intento ? 8000 : 3000); continue; }
      if (r.status === 400 && buscar && /search|tool/i.test(String(msg))) { buscar = false; continue; }
      break; // 400/403/404: probar el siguiente modelo
    }
  }
  throw new Error("Gemini no respondió: " + ultimoError);
}
function parsearJSON(t) {
  const s = String(t || "").replace(/```(?:json)?/g, "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

/* ---------- Telegram ---------- */
async function tg(metodo, datos) {
  if (!TG_TOKEN) return null;
  try {
    const r = await fetch(`${TG_BASE}/bot${TG_TOKEN}/${metodo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(datos || {}) });
    const j = await r.json(); if (!j.ok) console.log("Telegram:", metodo, j.description); return j.ok ? j.result : null;
  } catch (e) { console.log("Telegram sin conexión:", e.message); return null; }
}
async function enviar(texto, botId) {
  if (!est.dueno) return null;
  const partes = []; let t = limpiar(texto);
  while (t.length > 3900) { let corte = t.lastIndexOf("\n", 3900); if (corte < 1000) corte = 3900; partes.push(t.slice(0, corte)); t = t.slice(corte).trim(); }
  partes.push(t);
  let ultimo = null;
  for (const p of partes) { ultimo = await tg("sendMessage", { chat_id: est.dueno, text: p, disable_web_page_preview: true }); if (ultimo && botId) est.mensajes[ultimo.message_id] = botId; }
  const ks = Object.keys(est.mensajes); if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) delete est.mensajes[k];
  return ultimo;
}

/* ---------- trabajo de un bot ---------- */
const FLECC = id => path.join(DATA, "lecciones", id + ".md");
const FFEED = id => path.join(DATA, "feedback", id + ".json");
function promptBot(b, orden, critica) {
  const lecc = fs.existsSync(FLECC(b.id)) ? fs.readFileSync(FLECC(b.id), "utf8").trim() : "";
  return `Sos "${b.nombre}", un empleado de la ${CFG.oficina} (área ${areaDe(b).nombre}). Tu ÚNICA tarea es la siguiente y tenés que hacerla muy bien.
SOBRE TU JEFE: ${CFG.contexto}
HOY ES: ${DIAS[diaAR()]} ${fechaAR()}, ${horaAR()} hs (hora de Argentina).

TU MISIÓN: ${b.mision}
QUÉ TENÉS QUE ENTREGAR: ${b.entregable}
CÓMO TE VAN A EVALUAR: ${b.criterios.join("; ")}.
${orden ? `\nORDEN ESPECIAL DE TU JEFE PARA ESTA VEZ (tiene prioridad): ${orden}\n` : ""}${lecc ? `\nLO QUE APRENDISTE DE TRABAJOS ANTERIORES (aplicalo siempre):\n${lecc}\n` : ""}${critica ? `\nEL CONTROL DE CALIDAD RECHAZÓ TU VERSIÓN ANTERIOR POR ESTO, CORREGILO:\n${critica}\n` : ""}
REGLAS:
- Buscá en internet información ACTUAL. Usá solo datos que encontraste, con su fuente (nombre del sitio y link).
- Si un dato no lo encontraste, decilo claramente en vez de inventarlo.
- Español rioplatense, directo, sin saludos ni relleno. Empezá directamente con el entregable.
- Máximo 2500 caracteres.`;
}
async function evaluar(b, texto, fuentes) {
  const r = await gemini(`Sos el CONTROL DE CALIDAD de una oficina. Evaluá con rigor este trabajo.
TAREA DEL BOT: ${b.mision}
ENTREGABLE PEDIDO: ${b.entregable}
CRITERIOS: ${b.criterios.join("; ")}; datos concretos y actuales; sin inventar; sin relleno.
FECHA DE HOY: ${fechaAR()}.
FUENTES REALES QUE USÓ EL BOT (verificadas por el buscador): ${fuentes.length ? fuentes.map(f => f.url).slice(0, 10).join(" , ") : "NINGUNA"}

TRABAJO ENTREGADO:
"""${texto.slice(0, 6000)}"""

Respondé SOLO un JSON: {"puntaje": número del 1 al 10, "problemas": ["..."], "mejorar": "una instrucción concreta para hacerlo mejor la próxima vez"}.
Un 8 o más es un trabajo que el jefe puede usar tal cual. Si no hay fuentes reales o los datos parecen inventados o viejos, el puntaje no puede pasar de 4.`, { json: true });
  const j = parsearJSON(r.texto) || {};
  let p = Number(j.puntaje); if (!(p >= 1 && p <= 10)) p = 5;
  return { puntaje: Math.round(p), problemas: Array.isArray(j.problemas) ? j.problemas.slice(0, 5).map(String) : [], mejorar: String(j.mejorar || "") };
}
async function trabajar(b, orden, origen) {
  const sb = est.bots[b.id];
  sb.estado = "trabajando"; sb.ultimaCorrida = NOW.toISOString();
  log(b.nombre, orden ? `empezó la orden: ${orden}` : "empezó su tarea programada");
  try {
    let mejor = null; let critica = "";
    for (let intento = 1; intento <= 2; intento++) {
      if (!hayCupo(2)) { if (mejor) break; throw new Error("sin cupo de IA por hoy"); }
      const r = await gemini(promptBot(b, orden, critica), { buscar: true });
      const ev = await evaluar(b, r.texto, r.fuentes);
      const cand = { ...r, ev, intento };
      if (!mejor || ev.puntaje > mejor.ev.puntaje) mejor = cand;
      log("Control de calidad", `${b.nombre}: ${ev.puntaje}/10${ev.problemas[0] ? " · " + ev.problemas[0] : ""}`);
      if (ev.puntaje >= 7) break;
      critica = [...ev.problemas, ev.mejorar].filter(Boolean).join("\n- ");
      if (intento === 1) log(b.nombre, "lo mandaron a rehacer");
    }
    const stamp = fechaAR() + "-" + horaAR().replace(":", "");
    const rel = `data/informes/${b.id}/${stamp}.md`;
    const md = `# ${b.nombre} · ${fechaAR()} ${horaAR()}\n\n${orden ? `**Orden:** ${orden}\n\n` : ""}${mejor.texto}\n\n---\n**Control de calidad:** ${mejor.ev.puntaje}/10${mejor.ev.problemas.length ? "\n- " + mejor.ev.problemas.join("\n- ") : ""}\n\n**Fuentes verificadas:**\n${mejor.fuentes.length ? mejor.fuentes.slice(0, 10).map(f => `- [${f.titulo}](${f.url})`).join("\n") : "- (el buscador no devolvió fuentes)"}\n`;
    escribir(path.join(ROOT, rel), md);
    const feed = leer(FFEED(b.id), []); feed.push({ t: NOW.toISOString(), tipo: "calidad", puntaje: mejor.ev.puntaje, problemas: mejor.ev.problemas, mejorar: mejor.ev.mejorar }); escribir(FFEED(b.id), feed.slice(-40));
    Object.assign(sb, { estado: "listo", corridas: sb.corridas + 1, fallasSeguidas: 0, puntaje: mejor.ev.puntaje, resumen: limpiar(mejor.texto).slice(0, 220), informe: rel, ultimaFecha: orden ? sb.ultimaFecha : fechaAR(), modelo: mejor.modelo });
    sb.historial.push({ f: NOW.toISOString(), p: mejor.ev.puntaje, orden: !!orden }); sb.historial = sb.historial.slice(-30);
    log(b.nombre, `entregó (${mejor.ev.puntaje}/10)`);
    const fuentesTxt = mejor.fuentes.slice(0, 5).map(f => "• " + f.url).join("\n");
    await enviar(`📊 ${b.nombre} · ${areaDe(b).nombre} · calidad ${mejor.ev.puntaje}/10${orden ? "\n📌 Tu orden: " + orden : ""}\n\n${mejor.texto}${fuentesTxt ? "\n\nFuentes:\n" + fuentesTxt : ""}\n\n(Respondé a este mensaje con 👍, 👎 o un comentario y ${b.nombre} aprende.)`, b.id);
    return mejor;
  } catch (e) {
    Object.assign(sb, { estado: "falló", fallas: sb.fallas + 1, fallasSeguidas: sb.fallasSeguidas + 1, resumen: "Falló: " + e.message });
    if (!orden) sb.ultimaFecha = fechaAR(); // no reintentar en loop la tarea del día
    log(b.nombre, "falló: " + e.message);
    if (sb.fallasSeguidas >= 3) { sb.pausado = true; log("Gerente general", `pausé a ${b.nombre} porque falló 3 veces seguidas`); await enviar(`⚠️ Pausé a ${b.nombre}: falló 3 veces seguidas (${e.message}). Escribí «activar ${b.id}» para que vuelva.`); }
    else if (origen === "orden") await enviar(`⚠️ ${b.nombre} no pudo con tu orden: ${e.message}`);
    return null;
  }
}

/* ---------- el gerente ---------- */
function tablero() {
  const l = [`🏢 ${CFG.oficina} · ${fechaAR()} ${horaAR()}`, `IA usada hoy: ${est.consumo.consultas}/${CFG.limites.consultasPorDia} consultas`, ""];
  for (const a of CFG.areas) {
    l.push(`▸ ${a.nombre}`);
    for (const b of bots.filter(x => x.area === a.id)) { const s = est.bots[b.id]; const ic = s.pausado ? "⏸" : s.estado === "falló" ? "❌" : s.ultimaFecha === fechaAR() ? "✅" : "💤"; l.push(`  ${ic} ${b.nombre}${s.puntaje ? ` · ${s.puntaje}/10` : ""} · nivel ${s.nivel} · ${horarioTxt(b)}`); }
  }
  return l.join("\n");
}
function horarioTxt(b) { const d = b.horario.dias === "todos" ? "todos los días" : b.horario.dias.map(x => DIAS[x].slice(0, 3)).join(", "); return `${d} ${b.horario.hora}`; }
const AYUDA = `Soy el Gerente general de la ${CFG.oficina}. Podés escribirme:
• Una orden en palabras normales: «averiguá el precio del cemento en Villa María», «buscame terrenos de menos de 15 millones». Se la paso al bot que corresponde y te traigo el resultado.
• estado — cómo está cada bot.
• bots — el organigrama con horarios.
• correr dolar — que un bot haga su tarea ahora.
• pausar inmuebles / activar inmuebles.
• Respondé a cualquier informe con 👍, 👎 o un comentario: ese bot lo usa para entrenarse esa noche.`;
async function procesarMensajes() {
  if (!TG_TOKEN) return;
  const ups = await tg("getUpdates", { offset: est.tgOffset, timeout: 0, allowed_updates: ["message"] }) || [];
  for (const u of ups) {
    est.tgOffset = u.update_id + 1;
    const m = u.message; if (!m || !m.text) continue;
    const chat = m.chat.id; const txt = m.text.trim();
    if (!est.dueno) {
      if (m.chat.type === "private" && /^\/start/.test(txt)) { est.dueno = chat; log("Gerente general", "quedó vinculado el Telegram del dueño"); await enviar(`✅ Listo, ${m.from.first_name || "jefe"}: quedaste como dueño de la oficina. Solo te obedezco a vos.\n\n${AYUDA}`); }
      continue;
    }
    if (chat !== est.dueno) continue;
    // feedback a un informe
    const resp = m.reply_to_message && est.mensajes[m.reply_to_message.message_id];
    if (resp && botPorId(resp)) {
      const b = botPorId(resp); const sb = est.bots[b.id];
      const pos = /👍|bien|genial|excelente|perfecto|buenísimo|sirve/i.test(txt), neg = /👎|mal|no sirve|inventad|viejo|equivocad/i.test(txt);
      if (pos) sb.likes++; if (neg) sb.dislikes++;
      const feed = leer(FFEED(b.id), []); feed.push({ t: NOW.toISOString(), tipo: "jefe", texto: txt.slice(0, 500), valor: pos ? 1 : neg ? -1 : 0 }); escribir(FFEED(b.id), feed.slice(-40));
      log("Jonathan", `opinó sobre ${b.nombre}: ${txt.slice(0, 80)}`);
      await enviar(`📝 Anotado para ${b.nombre}. Lo aplica desde el entrenamiento de esta noche.`);
      continue;
    }
    const low = txt.toLowerCase().replace(/^\//, "");
    if (/^(start|ayuda|help|hola)$/.test(low)) { await enviar(AYUDA); continue; }
    if (/^(estado|tablero|novedades)$/.test(low)) { await enviar(tablero()); continue; }
    if (/^(bots|organigrama)$/.test(low)) { await enviar(`👔 ${CFG.gerente.nombre}: ${CFG.gerente.mision}\n\n` + CFG.areas.map(a => `▸ ${a.nombre}\n` + bots.filter(b => b.area === a.id).map(b => `  • ${b.nombre} (${b.id}) — ${horarioTxt(b)}\n    ${b.mision}`).join("\n")).join("\n\n")); continue; }
    let mm;
    if ((mm = low.match(/^(correr|pausar|activar)\s+(\S+)/))) {
      const b = botPorId(mm[2]) || bots.find(x => x.nombre.toLowerCase().includes(mm[2]));
      if (!b) { await enviar("No encontré ese bot. Escribí «bots» para ver los nombres."); continue; }
      if (mm[1] === "pausar") { est.bots[b.id].pausado = true; log("Jonathan", `pausó a ${b.nombre}`); await enviar(`⏸ ${b.nombre} en pausa.`); }
      else if (mm[1] === "activar") { Object.assign(est.bots[b.id], { pausado: false, fallasSeguidas: 0, estado: "esperando" }); log("Jonathan", `activó a ${b.nombre}`); await enviar(`▶️ ${b.nombre} vuelve a trabajar.`); }
      else { est.pendientes.push({ bot: b.id, orden: "", t: NOW.toISOString(), origen: "orden" }); await enviar(`🏃 ${b.nombre} arranca ahora.`); }
      continue;
    }
    // orden libre: el gerente decide a quién
    est.pendientes.push({ bot: null, orden: txt.slice(0, 600), t: NOW.toISOString(), origen: "orden" });
    log("Jonathan", "ordenó: " + txt.slice(0, 120));
  }
}
async function repartir(p) {
  const g = est.bots.gerente; g.estado = "trabajando"; g.ultimaCorrida = NOW.toISOString();
  const lista = bots.map(b => `- ${b.id}: ${b.nombre} (${areaDe(b).nombre}) — ${b.mision}`).join("\n");
  const r = await gemini(`Sos el Gerente general de una oficina de bots. Tu jefe te dio esta orden:
"${p.orden}"
Estos son tus empleados:
${lista}
Elegí el empleado que mejor puede cumplirla. Si ninguno encaja bien, elegí "gerente" (la hacés vos).
Respondé SOLO un JSON: {"bot": "id elegido o gerente", "instruccion": "la orden reescrita, clara y concreta para ese empleado", "aviso": "una frase corta para el jefe diciendo a quién se la pasaste"}`, { json: true });
  const j = parsearJSON(r.texto) || {};
  const b = botPorId(j.bot);
  if (b && !est.bots[b.id].pausado) {
    log("Gerente general", `le pasó la orden a ${b.nombre}`);
    await enviar(`📥 ${j.aviso || `Se la paso a ${b.nombre}.`}`);
    await trabajar(b, j.instruccion || p.orden, "orden");
  } else {
    log("Gerente general", "hace la orden él mismo");
    const gen = { id: "gerente", nombre: "Gerente general", area: "direccion", mision: "Cumplir la orden del jefe con información real y actual.", entregable: "La respuesta completa y lista para usar.", criterios: ["Responde exactamente lo pedido", "Datos reales con fuente", "Claro y breve"] };
    const res = await gemini(promptBot(gen, j.instruccion || p.orden), { buscar: true });
    const f = res.fuentes.slice(0, 5).map(x => "• " + x.url).join("\n");
    await enviar(`👔 Gerente general\n📌 Tu orden: ${p.orden}\n\n${res.texto}${f ? "\n\nFuentes:\n" + f : ""}`);
    g.resumen = "Respondió: " + p.orden.slice(0, 120);
  }
  g.estado = "listo";
}
async function parteDiario() {
  const hoy = bots.filter(b => est.bots[b.id].ultimaFecha === fechaAR());
  const fallas = bots.filter(b => est.bots[b.id].estado === "falló");
  let destacado = "";
  const textos = hoy.map(b => { const s = est.bots[b.id]; try { return `${b.nombre}: ` + fs.readFileSync(path.join(ROOT, s.informe), "utf8").slice(0, 1200); } catch { return ""; } }).filter(Boolean).join("\n\n");
  if (textos && hayCupo()) { try { destacado = (await gemini(`Sos el Gerente general. Con estos informes de hoy, escribí para tu jefe las 3 a 5 cosas MÁS importantes o accionables, una línea cada una, sin inventar nada que no esté en los informes:\n\n${textos.slice(0, 9000)}`)).texto; } catch (e) { destacado = ""; } }
  const msg = `🧾 Parte diario · ${DIAS[diaAR()]} ${fechaAR()}\n\n✅ Trabajaron hoy: ${hoy.length ? hoy.map(b => `${b.nombre} (${est.bots[b.id].puntaje}/10)`).join(", ") : "nadie"}\n${fallas.length ? "❌ Con problemas: " + fallas.map(b => b.nombre).join(", ") + "\n" : ""}🤖 IA usada: ${est.consumo.consultas} consultas\n${destacado ? "\n⭐ Lo más importante:\n" + destacado : ""}\n\nEsta noche a las ${CFG.gerente.entrenamiento} cada bot se entrena con las notas del día.`;
  est.bots.gerente.resumen = "Mandó el parte diario"; log("Gerente general", "mandó el parte diario");
  await enviar(msg);
}
async function entrenar() {
  const aprendieron = [];
  for (const b of bots) {
    const feed = leer(FFEED(b.id), []);
    const desde = Date.now() - 8 * 86400 * 1000;
    const recientes = feed.filter(x => new Date(x.t).getTime() > desde);
    if (!recientes.length || !hayCupo()) continue;
    const actuales = fs.existsSync(FLECC(b.id)) ? fs.readFileSync(FLECC(b.id), "utf8") : "(todavía ninguna)";
    try {
      const r = await gemini(`Sos el entrenador de "${b.nombre}", un bot cuya tarea es: ${b.mision}
Entregable: ${b.entregable}
SUS LECCIONES ACTUALES:
${actuales}
NOTAS DE LOS ÚLTIMOS DÍAS (control de calidad y opiniones del jefe; las del jefe valen el doble):
${recientes.map(x => x.tipo === "jefe" ? `JEFE (${x.valor > 0 ? "positivo" : x.valor < 0 ? "negativo" : "comentario"}): ${x.texto}` : `CALIDAD ${x.puntaje}/10: ${(x.problemas || []).join("; ")} → ${x.mejorar}`).join("\n").slice(0, 6000)}
Reescribí sus lecciones: máximo 8 viñetas cortas, concretas y accionables (qué hacer y qué evitar), conservando las que siguen sirviendo. Respondé SOLO las viñetas, cada una empezando con "- ".`);
      const nuevas = r.texto.split("\n").map(s => s.trim()).filter(s => /^[-•*]/.test(s)).map(s => "- " + s.replace(/^[-•*]\s*/, "")).slice(0, 8).join("\n");
      if (nuevas) { escribir(FLECC(b.id), nuevas + "\n"); est.bots[b.id].nivel++; aprendieron.push(b.nombre); log("Entrenador", `${b.nombre} subió a nivel ${est.bots[b.id].nivel}`); }
    } catch (e) { log("Entrenador", `${b.nombre}: no pude entrenarlo (${e.message})`); }
  }
  if (aprendieron.length) await enviar(`🎓 Entrenamiento de la noche: ${aprendieron.join(", ")} aprendieron de sus notas y mañana trabajan mejor.`);
}

/* ---------- ciclo principal ---------- */
function toca(b) {
  const s = est.bots[b.id]; if (s.pausado) return false;
  const h = b.horario; const diasOk = h.dias === "todos" || h.dias.includes(diaAR());
  return diasOk && horaAR() >= h.hora && s.ultimaFecha !== fechaAR();
}
async function main() {
  log("Oficina", `abre (${MODO})`);
  for (const b of bots) if (est.bots[b.id].estado === "trabajando") est.bots[b.id].estado = "esperando";
  if (TG_TOKEN && !est.botUsuario) { const me = await tg("getMe", {}); if (me && me.username) est.botUsuario = me.username; }
  await procesarMensajes();
  if (MODO.startsWith("correr:")) { const b = botPorId(MODO.slice(7)); if (b) est.pendientes.push({ bot: b.id, orden: "", origen: "manual" }); }
  // 1) órdenes del jefe primero
  while (est.pendientes.length && hayCupo(3)) {
    const p = est.pendientes.shift();
    try { if (p.bot) { const b = botPorId(p.bot); if (b) await trabajar(b, p.orden, p.origen); } else await repartir(p); }
    catch (e) { log("Gerente general", "no pude con la orden: " + e.message); await enviar(`⚠️ No pude cumplir «${(p.orden || p.bot).slice(0, 80)}»: ${e.message}`); }
  }
  // 2) tareas programadas
  if (MODO === "auto" || MODO === "todos") for (const b of bots) { if ((MODO === "todos" && !est.bots[b.id].pausado) || toca(b)) { if (!hayCupo(2)) { log("Oficina", "sin cupo de IA para seguir hoy"); break; } await trabajar(b, "", "agenda"); } }
  // 3) parte diario y entrenamiento
  if ((MODO === "auto" && horaAR() >= CFG.gerente.parteDiario && est.hechos.parte !== fechaAR()) || MODO === "parte") { est.hechos.parte = fechaAR(); await parteDiario(); }
  if ((MODO === "auto" && horaAR() >= CFG.gerente.entrenamiento && est.hechos.entrenamiento !== fechaAR()) || MODO === "entrenar") { est.hechos.entrenamiento = fechaAR(); await entrenar(); }
  est.bots.gerente.estado = est.pendientes.length ? "trabajando" : "esperando";
  est.actualizado = NOW.toISOString();
  est.modelo = (MODELOS || [])[0] || est.modelo || null;
  est.config = { telegram: !!TG_TOKEN, gemini: !!GEMINI_KEY, dueno: !!est.dueno };
  escribir(FEST, est);
  console.log(`Listo. Consultas en esta corrida: ${consultasCorrida}. Hoy: ${est.consumo.consultas}.`);
}
main().catch(e => { console.error(e); log("Oficina", "error general: " + e.message); est.actualizado = NOW.toISOString(); escribir(FEST, est); process.exitCode = 0; });
