// Oficina Bosio v2 — corre sola en GitHub Actions, gratis.
// Dueño → Gerente general → áreas → bots. Bots SIN IA (código, gratis 24/7), bots CON IA (rotan entre muchas IA gratis)
// y bots EXTERNOS (el celular bot reporta su estado). Control de calidad + entrenamiento diario.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(ROOT, "data");
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, "bots.json"), "utf8"));
const ENV = process.env;
const TG_TOKEN = ENV.TELEGRAM_TOKEN || "";
const MODO = (ENV.MODO || "auto").trim();
const NOW = ENV.FAKE_NOW ? new Date(ENV.FAKE_NOW) : new Date();
const URLS = { gemini: ENV.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta", tg: ENV.TG_BASE || "https://api.telegram.org", dolar: ENV.DOLAR_URL || "https://dolarapi.com/v1/dolares", rss: ENV.RSS_BASE || "https://news.google.com/rss/search", clima: ENV.CLIMA_URL || "https://api.open-meteo.com/v1/forecast" };

/* ---------- utilidades ---------- */
const ar = (d = NOW) => new Date(d.getTime() - 3 * 3600e3);
const fechaAR = (d = NOW) => ar(d).toISOString().slice(0, 10);
const horaAR = (d = NOW) => ar(d).toISOString().slice(11, 16);
const diaAR = (d = NOW) => ar(d).getUTCDay();
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS3 = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const escribir = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const limpiar = s => String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim();
const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "bot";
async function traer(url, opt = {}, ms = 20000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await fetch(url, { ...opt, signal: c.signal, headers: { "user-agent": "OficinaBosio/2.0 (+github.com/uwuubuntu83-dotcom/oficina-bosio)", ...(opt.headers || {}) } }); } finally { clearTimeout(t); } }

/* ---------- organigrama: base + lo que Jonathan agrega por Telegram ---------- */
const FEXTRA = path.join(DATA, "oficina.json");
const extra = leer(FEXTRA, { areas: [], bots: [], quitados: [], cambios: {} });
extra.areas ||= []; extra.bots ||= []; extra.quitados ||= []; extra.cambios ||= {}; extra.areasPausadas ||= []; extra.areasQuitadas ||= [];
const CFG = { ...BASE };
CFG.areas = [...BASE.areas, ...extra.areas].filter(a => !extra.areasQuitadas.includes(a.id)).map(a => ({ ...a, pausada: extra.areasPausadas.includes(a.id) }));
CFG.bots = [...BASE.bots, ...extra.bots].filter(b => !extra.quitados.includes(b.id) && CFG.areas.some(a => a.id === b.area)).map(b => ({ ...b, ...(extra.cambios[b.id] || {}) }));
const areaPausada = b => extra.areasPausadas.includes(b.area);
const bots = () => CFG.bots;
const botPorId = id => CFG.bots.find(b => b.id === id);
const areaDe = b => CFG.areas.find(a => a.id === b.area) || { id: b.area, nombre: b.area, icono: "📁", color: "#666" };

/* ---------- estado ---------- */
const FEST = path.join(DATA, "estado.json");
const est = leer(FEST, {});
est.version = 2; est.bots ||= {}; est.log ||= []; est.pendientes ||= []; est.mensajes ||= {}; est.tgOffset ||= 0; est.hechos ||= {}; est.ia ||= {};
if (!est.consumo || est.consumo.fecha !== fechaAR()) est.consumo = { fecha: fechaAR(), consultas: 0, busquedas: 0, por: {} };
est.consumo.por ||= {};
const huellaClaves = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "SAMBANOVA_API_KEY", "NVIDIA_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_API_TOKEN", "COHERE_API_KEY", "HF_TOKEN"].map(k => (ENV[k] || "").slice(-4)).join("");
if (est.ia.fecha !== fechaAR() || est.ia.huella !== huellaClaves) est.ia = { fecha: fechaAR(), agotado: {}, huella: huellaClaves }; // clave nueva = cupo nuevo
const nuevoBot = () => ({ estado: "esperando", corridas: 0, fallas: 0, fallasSeguidas: 0, puntaje: null, historial: [], likes: 0, dislikes: 0, nivel: 1, ultimaFecha: null, ultimaCorrida: null, resumen: "", informe: null, pausado: false, memoria: {} });
for (const b of bots()) { const nuevo = !est.bots[b.id]; est.bots[b.id] = Object.assign(nuevoBot(), est.bots[b.id]); if (nuevo && b.pausado) est.bots[b.id].pausado = true; }
est.bots.gerente = Object.assign({ estado: "esperando", resumen: "" }, est.bots.gerente);
let consultasCorrida = 0;
function log(quien, que) { est.log.unshift({ t: NOW.toISOString(), quien, que: String(que).slice(0, 300) }); est.log = est.log.slice(0, 300); console.log(`[${quien}] ${que}`); }

/* ==========================================================================================
   IA: rotación entre muchos proveedores gratis. Cualquiera que tenga su clave en los secretos entra en la rueda.
   ========================================================================================== */
const claves = pref => [ENV[pref], ...Array.from({ length: 9 }, (_, i) => ENV[`${pref}_${i + 2}`]), ...(ENV[pref + "S"] || "").split(",")].map(s => (s || "").trim()).filter(Boolean);
const PROV = [];
claves("GEMINI_API_KEY").forEach((k, i) => PROV.push({ id: "gemini" + (i ? i + 1 : ""), nombre: "Google Gemini" + (i ? " #" + (i + 1) : ""), tipo: "gemini", key: k, buscar: true, modelos: null }));
if (ENV.GITHUB_TOKEN) PROV.push({ id: "github", nombre: "GitHub Models", tipo: "openai", base: "https://models.github.ai/inference", key: ENV.GITHUB_TOKEN, modelos: ["openai/gpt-4.1-mini", "openai/gpt-4o-mini", "meta/Llama-3.3-70B-Instruct", "mistral-ai/mistral-small-2503"] });
claves("GROQ_API_KEY").forEach((k, i) => PROV.push({ id: "groq" + (i ? i + 1 : ""), nombre: "Groq", tipo: "openai", base: "https://api.groq.com/openai/v1", key: k, modelos: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3-32b", "openai/gpt-oss-20b", "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.1-8b-instant"], buscarModelo: "groq/compound" }));
claves("OPENROUTER_API_KEY").forEach((k, i) => PROV.push({ id: "openrouter" + (i ? i + 1 : ""), nombre: "OpenRouter", tipo: "openai", base: "https://openrouter.ai/api/v1", key: k, modelos: null, gratis: true }));
claves("CEREBRAS_API_KEY").forEach(k => PROV.push({ id: "cerebras", nombre: "Cerebras", tipo: "openai", base: "https://api.cerebras.ai/v1", key: k, modelos: ["gpt-oss-120b", "zai-glm-4.7", "llama-3.3-70b", "qwen-3-32b"] }));
claves("MISTRAL_API_KEY").forEach(k => PROV.push({ id: "mistral", nombre: "Mistral", tipo: "openai", base: "https://api.mistral.ai/v1", key: k, modelos: ["mistral-small-latest", "mistral-medium-latest", "magistral-small-latest"] }));
claves("SAMBANOVA_API_KEY").forEach(k => PROV.push({ id: "sambanova", nombre: "SambaNova", tipo: "openai", base: "https://api.sambanova.ai/v1", key: k, modelos: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-V3.1", "gpt-oss-120b", "Llama-4-Maverick-17B-128E-Instruct"] }));
claves("NVIDIA_API_KEY").forEach(k => PROV.push({ id: "nvidia", nombre: "NVIDIA", tipo: "openai", base: "https://integrate.api.nvidia.com/v1", key: k, modelos: ["meta/llama-3.3-70b-instruct", "openai/gpt-oss-120b", "qwen/qwen3-next-80b-a3b-instruct", "mistralai/mistral-small-3.1-24b-instruct-2503"] }));
if (ENV.CLOUDFLARE_API_TOKEN && ENV.CLOUDFLARE_ACCOUNT_ID) PROV.push({ id: "cloudflare", nombre: "Cloudflare Workers AI", tipo: "openai", base: `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, key: ENV.CLOUDFLARE_API_TOKEN, modelos: ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/mistralai/mistral-small-3.1-24b-instruct"] });
claves("COHERE_API_KEY").forEach(k => PROV.push({ id: "cohere", nombre: "Cohere", tipo: "openai", base: "https://api.cohere.ai/compatibility/v1", key: k, modelos: ["command-a-03-2025", "command-r-plus-08-2024"], tope: 30 }));
claves("HF_TOKEN").forEach(k => PROV.push({ id: "huggingface", nombre: "Hugging Face", tipo: "openai", base: "https://router.huggingface.co/v1", key: k, modelos: ["openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen3-32B"], tope: 30 }));
if (ENV.LLM_EXTRA_BASE && ENV.LLM_EXTRA_KEY) PROV.push({ id: "extra", nombre: "IA extra", tipo: "openai", base: ENV.LLM_EXTRA_BASE.replace(/\/+$/, ""), key: ENV.LLM_EXTRA_KEY, modelos: (ENV.LLM_EXTRA_MODELS || "").split(",").map(s => s.trim()).filter(Boolean) });
if (ENV.MOCK_PROVIDERS) for (const id of ENV.MOCK_PROVIDERS.split(",")) PROV.push({ id, nombre: id, tipo: "openai", base: ENV.MOCK_OPENAI_BASE, key: "x", modelos: ["m1", "m2"] });

const agotado = clave => est.ia.agotado[clave] === true || (typeof est.ia.agotado[clave] === "number" && est.ia.agotado[clave] > Date.now());
const marcar = (clave, hastaMs) => { est.ia.agotado[clave] = hastaMs ? Date.now() + hastaMs : true; };
const usar = id => { est.consumo.por[id] = (est.consumo.por[id] || 0) + 1; };
const ultimaLlamada = {};
async function pausa(prov) { const min = prov.tipo === "gemini" ? 6500 : 2500; const t = ultimaLlamada[prov.id] || 0; const espera = t + min - Date.now(); if (espera > 0) await sleep(espera); ultimaLlamada[prov.id] = Date.now(); }
let rueda = Math.floor(Math.random() * 1000);

async function modelosGemini(p) {
  if (p.modelos) return p.modelos;
  if (ENV.GEMINI_MODEL) return (p.modelos = [ENV.GEMINI_MODEL]);
  try {
    const j = await (await traer(`${URLS.gemini}/models?pageSize=200&key=${encodeURIComponent(p.key)}`)).json();
    const ms = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini|gemma/.test(m.name) && !/(embed|tts|image|live|audio|vision|aqa|learnlm|robotics|computer|thinking)/i.test(m.name)).map(m => m.name.replace(/^models\//, ""));
    const score = n => { const v = parseFloat((n.match(/(?:gemini|gemma)-(\d+(?:\.\d+)?)/) || [])[1] || 0); return (/gemini/.test(n) ? 100 : 0) + v * 10 + (/flash/.test(n) && !/lite/.test(n) ? 3 : /lite/.test(n) ? 2 : /pro/.test(n) ? 1 : 0) - (/(preview|exp|\d{3,}$)/.test(n) ? 0.5 : 0); };
    p.todos = ms.sort((a, b) => score(b) - score(a)); p.modelos = p.todos.slice(0, 6);
  } catch { p.modelos = []; }
  if (!p.modelos.length) p.modelos = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  return p.modelos;
}
async function modelosOpenRouter(p) {
  if (p.modelos) return p.modelos;
  try {
    const j = await (await traer("https://openrouter.ai/api/v1/models")).json();
    const ids = (j.data || []).map(m => m.id).filter(id => /:free$/.test(id));
    const pref = [/gpt-oss-120b/, /deepseek/, /qwen.*(coder|235|80b)/, /kimi|moonshot/, /glm/, /llama-?4|llama-3\.3-70b/, /gemma/, /mistral/];
    const rank = id => { const i = pref.findIndex(r => r.test(id)); return i < 0 ? 99 : i; };
    p.modelos = ids.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  } catch { p.modelos = []; }
  return p.modelos;
}
function retryDe(j) { const d = ((j && j.error && j.error.details) || []); const ri = d.find(x => /RetryInfo/.test(x["@type"] || "")); const s = ri && parseFloat(ri.retryDelay); const qf = d.find(x => /QuotaFailure/.test(x["@type"] || "")); const porDia = qf && (qf.violations || []).some(v => /PerDay/i.test(v.quotaId || "")); return { segundos: s || 0, porDia: !!porDia }; }

async function llamarGemini(p, modelo, prompt, { buscar, json }) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: json ? 0.2 : 0.5, maxOutputTokens: 8192 } };
  if (buscar) body.tools = [{ google_search: {} }]; else if (json) body.generationConfig.responseMimeType = "application/json";
  await pausa(p); usar(p.id);
  const r = await traer(`${URLS.gemini}/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(p.key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 120000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: true, status: r.status, j, msg: (j.error && j.error.message) || String(r.status) };
  const c = (j.candidates || [])[0] || {};
  const texto = ((c.content && c.content.parts) || []).filter(x => x.text && !x.thought).map(x => x.text).join("").trim();
  const fuentes = []; const vistos = new Set();
  for (const ch of (c.groundingMetadata || {}).groundingChunks || []) { const w = ch.web || {}; if (w.uri && !vistos.has(w.uri)) { vistos.add(w.uri); fuentes.push({ titulo: w.title || w.uri, url: w.uri }); } }
  if (!texto) return { error: true, status: 200, msg: "respuesta vacía" };
  return { texto, fuentes };
}
async function llamarOpenAI(p, modelo, prompt, { json }) {
  await pausa(p); usar(p.id);
  const headers = { "content-type": "application/json", authorization: "Bearer " + p.key };
  if (p.id.startsWith("openrouter")) { headers["X-Title"] = "Oficina Bosio"; headers["HTTP-Referer"] = "https://uwuubuntu83-dotcom.github.io/oficina-bosio/"; }
  const body = { model: modelo, messages: [{ role: "user", content: prompt }], temperature: json ? 0.2 : 0.5, max_tokens: 4096 };
  const r = await traer(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) }, 120000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: true, status: r.status, j, msg: (j.error && (j.error.message || j.error)) || j.message || String(r.status) };
  const m = ((j.choices || [])[0] || {}).message || {};
  let texto = String(m.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fuentes = [];
  for (const t of m.executed_tools || []) for (const x of ((t.search_results && t.search_results.results) || [])) if (x.url) fuentes.push({ titulo: x.title || x.url, url: x.url });
  if (!texto) return { error: true, status: 200, msg: "respuesta vacía" };
  return { texto, fuentes: fuentes.slice(0, 10) };
}
// ia(): buscar=true → solo proveedores que buscan en internet (Gemini, y Groq compound de respaldo).
// buscar=false → rota primero entre los que NO son Gemini, para guardar Gemini para las búsquedas.
async function ia(prompt, { buscar = false, json = false } = {}) {
  if (est.consumo.consultas >= CFG.limites.consultasPorDia || consultasCorrida >= CFG.limites.consultasPorCorrida) throw Object.assign(new Error("se llegó al tope de consultas de hoy"), { cupo: true });
  if (buscar && est.consumo.busquedas >= CFG.limites.busquedasPorDia) throw Object.assign(new Error("se llegó al tope de búsquedas de hoy"), { cupo: true });
  let lista;
  if (buscar) lista = [...PROV.filter(p => p.buscar), ...PROV.filter(p => p.buscarModelo)];
  else { const otros = PROV.filter(p => p.tipo !== "gemini"); const gem = PROV.filter(p => p.tipo === "gemini"); rueda++; lista = [...otros.slice(rueda % (otros.length || 1)), ...otros.slice(0, rueda % (otros.length || 1)), ...gem]; }
  if (!lista.length) throw Object.assign(new Error(buscar ? "no hay ninguna IA con búsqueda conectada (falta GEMINI_API_KEY)" : "no hay ninguna IA conectada"), { cupo: true });
  const errores = [];
  for (const p of lista) {
    if (agotado(p.id)) continue;
    let modelos;
    if (buscar && p.buscarModelo) modelos = [p.buscarModelo];
    else if (p.tipo === "gemini") { modelos = await modelosGemini(p); if (buscar) { const todos = p.todos || modelos; const pref = [/^gemini-2\.5-flash$/, /^gemini-2\.5-flash-lite$/, /^gemini-2\.0-flash$/, /^gemini-flash-latest$/, /^gemini-2\.5-pro$/]; const prim = pref.flatMap(r => todos.filter(m => r.test(m))); modelos = [...new Set([...prim, "gemini-2.5-flash", "gemini-2.5-flash-lite", ...modelos])].slice(0, 7); } }
    else if (p.gratis) modelos = await modelosOpenRouter(p);
    else modelos = p.modelos || [];
    let fallasProv = 0;
    for (const modelo of modelos) {
      const clave = p.id + ":" + modelo;
      if (agotado(clave)) continue;
      let r;
      for (let reintento = 0; reintento < 2; reintento++) {
        consultasCorrida++; est.consumo.consultas++;
        try { r = p.tipo === "gemini" ? await llamarGemini(p, modelo, prompt, { buscar, json }) : await llamarOpenAI(p, modelo, prompt, { json }); }
        catch (e) { r = { error: true, status: 0, msg: e.name === "AbortError" ? "tardó demasiado" : "sin conexión" }; }
        if (r.error && r.status === 429 && reintento === 0) { const rd = retryDe(r.j); if (!rd.porDia && rd.segundos > 0 && rd.segundos <= 45) { await sleep(rd.segundos * 1000 + 800); continue; } }
        break;
      }
      if (!r.error) { if (buscar) est.consumo.busquedas++; est.ia.ultimo = { prov: p.nombre, modelo, t: NOW.toISOString() }; return { ...r, modelo: `${p.nombre} · ${modelo}` }; }
      errores.push(`${p.nombre}/${modelo}: ${r.status} ${String(r.msg).slice(0, 90)}`);
      if (r.status === 429) { const rd = retryDe(r.j); marcar(clave, rd.porDia ? 0 : Math.min(Math.max(rd.segundos, 30), 3600) * 1000); if (rd.porDia) log("IA", `${p.nombre} ${modelo}: cupo diario agotado, sigo con otra`); }
      else if (r.status === 401 || r.status === 403) { marcar(p.id, 0); log("IA", `${p.nombre}: la clave no es válida o no tiene permiso`); break; }
      else if (r.status === 404 || r.status === 400 || r.status === 422) marcar(clave, 0);
      else marcar(clave, 10 * 60e3);
      if (++fallasProv >= 3) break;
    }
  }
  throw Object.assign(new Error(errores.length ? "ninguna IA respondió (" + errores.slice(-2).join(" | ") + ")" : (buscar ? "las IA que buscan en internet están sin cupo por ahora" : "todas las IA están sin cupo por ahora")), { cupo: true });
}
function parsearJSON(t) { const s = String(t || "").replace(/```(?:json)?/g, ""); try { return JSON.parse(s); } catch {} const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} } return null; }

/* ---------- Telegram ---------- */
async function tg(metodo, datos) {
  if (!TG_TOKEN) return null;
  try { const r = await traer(`${URLS.tg}/bot${TG_TOKEN}/${metodo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(datos || {}) }, 30000); const j = await r.json(); if (!j.ok) { console.log("Telegram:", metodo, j.description); tg.error = `${metodo}: ${j.description}`; } return j.ok ? j.result : null; }
  catch (e) { console.log("Telegram sin conexión:", e.message); tg.error = `${metodo}: sin conexión (${e.message})`; return null; }
}
async function enviar(texto, botId) {
  if (!est.dueno) return null;
  const partes = []; let t = limpiar(texto);
  while (t.length > 3900) { let c = t.lastIndexOf("\n", 3900); if (c < 1000) c = 3900; partes.push(t.slice(0, c)); t = t.slice(c).trim(); }
  partes.push(t);
  let ult = null;
  for (const p of partes) { ult = await tg("sendMessage", { chat_id: est.dueno, text: p, disable_web_page_preview: true }); if (ult && botId) est.mensajes[ult.message_id] = botId; }
  const ks = Object.keys(est.mensajes); if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete est.mensajes[k];
  return ult;
}

/* ==========================================================================================
   BOTS SIN IA (recetas de código)
   ========================================================================================== */
const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
const RECETAS = {
  async dolar(b, sb, { resumen }) {
    const r = await traer(URLS.dolar); if (!r.ok) throw new Error("dolarapi respondió " + r.status);
    const lista = await r.json(); if (!Array.isArray(lista) || !lista.length) throw new Error("dolarapi sin datos");
    const ant = sb.memoria.dolar || {}; const alertas = []; const hoy = {};
    const lineas = lista.map(d => { const k = d.casa || d.nombre; hoy[k] = d.venta; const prev = ant[k]; let var_ = ""; if (prev && d.venta) { const pc = (d.venta - prev) / prev * 100; var_ = ` (${pc >= 0 ? "+" : ""}${pc.toFixed(1)}%)`; if (Math.abs(pc) >= (b.receta.alertaPorcentaje || 2)) alertas.push(`${d.nombre}: ${pc >= 0 ? "subió" : "bajó"} ${Math.abs(pc).toFixed(1)}% → $${d.venta}`); } return `• ${d.nombre}: compra $${d.compra ?? "-"} · venta $${d.venta ?? "-"}${var_}`; });
    if (resumen || !sb.memoria.dolarBase || sb.memoria.dolarFecha !== fechaAR()) { sb.memoria.dolarBase = hoy; sb.memoria.dolarFecha = fechaAR(); }
    sb.memoria.dolar = sb.memoria.dolarBase;
    const texto = `💵 Dólar hoy (${horaAR()} hs)\n${lineas.join("\n")}\n\nFuente: dolarapi.com`;
    if (resumen) return { texto, enviar: true };
    if (alertas.length) { const k = alertas.join("|"); if (sb.memoria.ultimaAlerta === k) return { texto, enviar: false }; sb.memoria.ultimaAlerta = k; return { texto: `🚨 Movimiento fuerte del dólar\n${alertas.join("\n")}\n\n${texto}`, enviar: true }; }
    return { texto, enviar: false };
  },
  async rss(b, sb) {
    const vistos = new Set(sb.memoria.vistos || []); const items = [];
    for (const q of b.receta.busquedas || []) {
      const url = `${URLS.rss}?q=${encodeURIComponent(q + " when:3d")}&hl=es-419&gl=AR&ceid=AR:es-419`;
      try {
        const xml = await (await traer(url)).text();
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const it = m[1]; const titulo = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]); const link = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]); const fuente = decode((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]); const fecha = decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
          const clave = titulo.toLowerCase().replace(/\s+-\s+[^-]+$/, "").slice(0, 90);
          if (!titulo || !link || vistos.has(clave) || items.some(x => x.clave === clave)) continue;
          items.push({ titulo: titulo.replace(/\s+-\s+[^-]+$/, ""), link, fuente, fecha: fecha ? new Date(fecha) : null, clave });
        }
      } catch (e) { log(b.nombre, `no pude leer «${q}»: ${e.message}`); }
    }
    items.sort((a, z) => (z.fecha || 0) - (a.fecha || 0));
    const nuevos = items.slice(0, b.receta.max || 8);
    sb.memoria.vistos = [...nuevos.map(x => x.clave), ...(sb.memoria.vistos || [])].slice(0, 400);
    if (!nuevos.length) return { texto: "Sin novedades desde la última vez.", enviar: false };
    return { texto: `${areaDe(b).icono} ${b.nombre}\n\n` + nuevos.map(x => `• ${x.titulo}${x.fuente ? " (" + x.fuente + ")" : ""}\n  ${x.link}`).join("\n"), enviar: true };
  },
  async clima(b) {
    const u = CFG.ubicacion; const url = `${URLS.clima}?latitude=${u.lat}&longitude=${u.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&timezone=America%2FArgentina%2FCordoba&forecast_days=3`;
    const r = await traer(url); if (!r.ok) throw new Error("open-meteo respondió " + r.status); const d = (await r.json()).daily;
    const nom = ["Hoy", "Mañana", "Pasado"]; const avisos = [];
    const lineas = d.time.map((t, i) => { const ll = d.precipitation_probability_max[i]; const v = d.wind_speed_10m_max[i]; if (ll >= 60) avisos.push(`${nom[i]}: ${ll}% de lluvia (${d.precipitation_sum[i]} mm)`); if (v >= 40) avisos.push(`${nom[i]}: viento fuerte (${Math.round(v)} km/h)`); return `• ${nom[i]} ${t.slice(8, 10)}/${t.slice(5, 7)}: ${Math.round(d.temperature_2m_min[i])}° a ${Math.round(d.temperature_2m_max[i])}° · lluvia ${ll}% · viento ${Math.round(v)} km/h`; });
    return { texto: `🌤️ Clima en ${u.lugar}\n${lineas.join("\n")}${avisos.length ? "\n\n⚠️ Para la obra:\n" + avisos.join("\n") : "\n\n✅ Sin lluvias fuertes ni viento para la obra."}\n\nFuente: open-meteo.com`, enviar: true };
  },
  async web_estado(b, sb) {
    const antes = sb.memoria.caidas || {}; const ahora = {}; const cambios = []; const lineas = [];
    for (const u of b.receta.urls || []) { let ok = false, det = ""; try { const r = await traer(u, {}, 20000); ok = r.status < 500 && r.status !== 404; det = String(r.status); /* 401/403 = la página responde pero protege contra robots: está viva */ } catch (e) { det = e.name === "AbortError" ? "no responde" : "error de conexión"; } ahora[u] = !ok; lineas.push(`${ok ? "✅" : "❌"} ${u} (${det})`); if (!ok && !antes[u]) cambios.push(`❌ Se cayó: ${u} (${det})`); if (ok && antes[u]) cambios.push(`✅ Volvió: ${u}`); }
    sb.memoria.caidas = ahora;
    return { texto: lineas.join("\n"), enviar: cambios.length > 0, alerta: cambios.join("\n") };
  },
  async recordatorio(b) { return { texto: `⏰ ${b.receta.texto || b.mision}`, enviar: true }; },
  async salud() {
    const l = []; const fallaron = bots().filter(x => est.bots[x.id]?.estado === "falló"); const pausados = bots().filter(x => est.bots[x.id]?.pausado);
    const ext = bots().filter(x => x.tipo === "externo").map(x => ({ b: x, hb: leer(path.join(DATA, "externos", x.id + ".json"), null) }));
    l.push(`🛠️ Salud de la oficina · ${fechaAR()}`);
    l.push(`Bots: ${bots().length} · trabajaron hoy: ${bots().filter(x => est.bots[x.id]?.ultimaFecha === fechaAR()).length}`);
    if (fallaron.length) l.push("❌ Fallaron: " + fallaron.map(x => `${x.nombre} (${(est.bots[x.id].resumen || "").replace(/^Falló: /, "").slice(0, 60)})`).join("; "));
    if (pausados.length) l.push("⏸ En pausa: " + pausados.map(x => x.nombre).join(", ") + ". Para reactivar: «activar ID».");
    for (const { b: x, hb } of ext) l.push(hb ? `📱 ${x.nombre}: última señal ${new Date(hb.t).toLocaleString("es-AR", { timeZone: "America/Argentina/Cordoba" })} (${hb.estado})` : `📱 ${x.nombre}: todavía no está conectado (ver reportar.py).`);
    l.push(`🤖 IA hoy: ${est.consumo.consultas} consultas (${est.consumo.busquedas} con búsqueda) · ${Object.entries(est.consumo.por).map(([k, v]) => `${k}: ${v}`).join(", ") || "ninguna"}`);
    l.push(`🔌 IA conectadas: ${PROV.length ? [...new Set(PROV.map(p => p.nombre))].join(", ") : "ninguna"}`);
    if (!fallaron.length && !pausados.length) l.push("✅ Todo en orden.");
    return { texto: l.join("\n"), enviar: true };
  }
};

/* ---------- trabajo de un bot ---------- */
const FLECC = id => path.join(DATA, "lecciones", id + ".md");
const FFEED = id => path.join(DATA, "feedback", id + ".json");
function promptBot(b, orden, critica) {
  const lecc = fs.existsSync(FLECC(b.id)) ? fs.readFileSync(FLECC(b.id), "utf8").trim() : "";
  return `Sos "${b.nombre}", empleado de la ${CFG.oficina} (área ${areaDe(b).nombre}). Tu ÚNICA tarea es esta y tenés que hacerla muy bien.
SOBRE TU JEFE: ${CFG.contexto}
HOY ES: ${DIAS[diaAR()]} ${fechaAR()}, ${horaAR()} hs (Argentina).
TU MISIÓN: ${b.mision}
QUÉ ENTREGAR: ${b.entregable || "Un resultado concreto y listo para usar."}
CÓMO TE EVALÚAN: ${(b.criterios || ["Concreto", "Útil", "Sin relleno"]).join("; ")}.
${orden ? `\nORDEN ESPECIAL DE TU JEFE (tiene prioridad): ${orden}\n` : ""}${lecc ? `\nLO QUE APRENDISTE (aplicalo siempre):\n${lecc}\n` : ""}${critica ? `\nEL CONTROL DE CALIDAD RECHAZÓ TU VERSIÓN ANTERIOR POR ESTO, CORREGILO:\n${critica}\n` : ""}
REGLAS:
${b.buscar ? "- Buscá en internet información ACTUAL y usá solo datos que encontraste, con su fuente (sitio y link).\n- Si un dato no lo encontraste, decilo en vez de inventarlo." : "- No inventes datos concretos como precios, fechas o nombres de lugares que no puedas saber; si hace falta, dalos como orientativos."}
- Español rioplatense, directo, sin saludos ni relleno. Empezá con el entregable. Máximo 2500 caracteres.`;
}
async function evaluar(b, texto, fuentes) {
  const r = await ia(`Sos el CONTROL DE CALIDAD de una oficina. Evaluá con rigor este trabajo.
TAREA: ${b.mision}
ENTREGABLE: ${b.entregable || "-"}
CRITERIOS: ${(b.criterios || []).join("; ")}; concreto; sin relleno; sin inventar.
FECHA: ${fechaAR()}.
${b.buscar ? `FUENTES REALES QUE USÓ (verificadas por el buscador): ${fuentes.length ? fuentes.map(f => f.url).slice(0, 10).join(" , ") : "NINGUNA"}` : "Este bot no necesita fuentes de internet."}
TRABAJO:
"""${texto.slice(0, 6000)}"""
Respondé SOLO un JSON: {"puntaje": 1 a 10, "problemas": ["..."], "mejorar": "instrucción concreta para la próxima"}.
8 o más = el jefe lo puede usar tal cual.${b.buscar ? " Sin fuentes reales o con datos que parecen inventados o viejos: máximo 4." : ""}`, { json: true });
  const j = parsearJSON(r.texto) || {}; let p = Number(j.puntaje); if (!(p >= 1 && p <= 10)) p = 6;
  return { puntaje: Math.round(p), problemas: Array.isArray(j.problemas) ? j.problemas.slice(0, 5).map(String) : [], mejorar: String(j.mejorar || "") };
}
function guardarInforme(b, texto, extraMd, orden) {
  const rel = `data/informes/${b.id}/${fechaAR()}-${horaAR().replace(":", "")}.md`;
  escribir(path.join(ROOT, rel), `# ${b.nombre} · ${fechaAR()} ${horaAR()}\n\n${orden ? `**Orden:** ${orden}\n\n` : ""}${texto}\n${extraMd || ""}`);
  return rel;
}
async function trabajar(b, { orden = "", origen = "agenda", resumen = false } = {}) {
  const sb = est.bots[b.id] ||= nuevoBot();
  sb.estado = "trabajando"; sb.ultimaCorrida = NOW.toISOString();
  try {
    if (b.tipo === "codigo") {
      const fn = RECETAS[(b.receta || {}).tipo]; if (!fn) throw new Error("receta desconocida: " + (b.receta || {}).tipo);
      const r = await fn(b, sb, { resumen: resumen || origen !== "agenda" || !b.horario.cada });
      sb.memoria.ultimoChequeo = NOW.toISOString();
      const mandar = r.enviar || origen !== "agenda";
      if (mandar) { const rel = guardarInforme(b, r.alerta ? r.alerta + "\n\n" + r.texto : r.texto, "\n---\n_Bot sin IA (código): no gasta cupo._\n", orden); sb.informe = rel; sb.resumen = limpiar(r.alerta || r.texto).slice(0, 220); await enviar(r.alerta ? `${r.alerta}\n\n${r.texto}` : r.texto, b.id); log(b.nombre, "entregó (sin IA)"); }
      else { sb.resumen = sb.resumen || limpiar(r.texto).slice(0, 220); }
      Object.assign(sb, { estado: "listo", corridas: sb.corridas + 1, fallasSeguidas: 0, puntaje: null });
      if (!b.horario.cada || resumen) sb.ultimaFecha = fechaAR();
      if (b.horario.cada && resumen) sb.memoria.resumenFecha = fechaAR();
      return true;
    }
    log(b.nombre, orden ? `empezó la orden: ${orden}` : "empezó su tarea");
    let mejor = null, critica = "";
    for (let intento = 1; intento <= 2; intento++) {
      const r = await ia(promptBot(b, orden, critica), { buscar: !!b.buscar });
      let ev; try { ev = await evaluar(b, r.texto, r.fuentes); } catch (e) { ev = { puntaje: 6, problemas: ["no se pudo evaluar: " + e.message], mejorar: "" }; }
      if (!mejor || ev.puntaje > mejor.ev.puntaje) mejor = { ...r, ev };
      log("Control de calidad", `${b.nombre}: ${ev.puntaje}/10${ev.problemas[0] ? " · " + ev.problemas[0] : ""}`);
      if (ev.puntaje >= 7) break;
      critica = [...ev.problemas, ev.mejorar].filter(Boolean).join("\n- ");
      if (intento === 1) log(b.nombre, "lo mandaron a rehacer");
    }
    const rel = guardarInforme(b, mejor.texto, `\n---\n**Control de calidad:** ${mejor.ev.puntaje}/10${mejor.ev.problemas.length ? "\n- " + mejor.ev.problemas.join("\n- ") : ""}\n\n**IA usada:** ${mejor.modelo}\n${b.buscar ? "\n**Fuentes verificadas:**\n" + (mejor.fuentes.length ? mejor.fuentes.slice(0, 10).map(f => `- [${f.titulo}](${f.url})`).join("\n") : "- (el buscador no devolvió fuentes)") : ""}\n`, orden);
    const feed = leer(FFEED(b.id), []); feed.push({ t: NOW.toISOString(), tipo: "calidad", puntaje: mejor.ev.puntaje, problemas: mejor.ev.problemas, mejorar: mejor.ev.mejorar }); escribir(FFEED(b.id), feed.slice(-40));
    Object.assign(sb, { estado: "listo", corridas: sb.corridas + 1, fallasSeguidas: 0, puntaje: mejor.ev.puntaje, resumen: limpiar(mejor.texto).slice(0, 220), informe: rel, modelo: mejor.modelo });
    if (!orden) sb.ultimaFecha = fechaAR();
    sb.historial.push({ f: NOW.toISOString(), p: mejor.ev.puntaje, orden: !!orden }); sb.historial = sb.historial.slice(-30);
    log(b.nombre, `entregó (${mejor.ev.puntaje}/10 · ${mejor.modelo})`);
    const f = (mejor.fuentes || []).slice(0, 5).map(x => "• " + x.url).join("\n");
    await enviar(`📊 ${b.nombre} · ${areaDe(b).nombre} · calidad ${mejor.ev.puntaje}/10${orden ? "\n📌 Tu orden: " + orden : ""}\n\n${mejor.texto}${f ? "\n\nFuentes:\n" + f : ""}\n\n(Respondé con 👍, 👎 o un comentario y ${b.nombre} aprende.)`, b.id);
    return true;
  } catch (e) {
    if (e.cupo) { sb.estado = "postergado"; sb.resumen = "Esperando cupo de IA: " + e.message; log(b.nombre, "lo posterga: " + e.message); if (origen === "orden") await enviar(`⏳ ${b.nombre} no tiene IA disponible ahora (${e.message}). Lo hace apenas se libere cupo.`); return false; }
    Object.assign(sb, { estado: "falló", fallas: sb.fallas + 1, fallasSeguidas: sb.fallasSeguidas + 1, resumen: "Falló: " + e.message });
    if (!orden && !b.horario?.cada) sb.ultimaFecha = fechaAR();
    log(b.nombre, "falló: " + e.message);
    if (sb.fallasSeguidas >= 3) { sb.pausado = true; await enviar(`⚠️ Pausé a ${b.nombre}: falló 3 veces seguidas (${e.message}). Escribí «activar ${b.id}» para que vuelva.`); }
    else if (origen === "orden") await enviar(`⚠️ ${b.nombre} no pudo con tu orden: ${e.message}`);
    return false;
  }
}

/* ==========================================================================================
   EL GERENTE
   ========================================================================================== */
const horarioTxt = b => { const h = b.horario || {}; if (b.tipo === "externo") return "trabaja en el celular"; if (h.apedido) return "a pedido (solo cuando se lo pedís)"; const d = !h.dias || h.dias === "todos" ? "todos los días" : h.dias.map(x => DIAS3[x]).join(", "); return h.cada ? `${d}, cada ${h.cada} min de ${h.desde} a ${h.hasta}${h.resumen ? ` (resumen ${h.resumen})` : ""}` : `${d} ${h.hora}`; };
const tipoTxt = b => b.tipo === "codigo" ? "⚙️ sin IA" : b.tipo === "externo" ? "📱 celular" : b.buscar ? "🧠 IA + internet" : "🧠 IA";
function tablero() {
  const l = [`🏢 ${CFG.oficina} · ${fechaAR()} ${horaAR()}`, `IA hoy: ${est.consumo.consultas} consultas · ${PROV.length} IA conectadas`, ""];
  for (const a of CFG.areas) { const bs = bots().filter(x => x.area === a.id); if (!bs.length) continue; l.push(`${a.icono} ${a.nombre}`); for (const b of bs) { const s = est.bots[b.id] || {}; const ic = s.pausado ? "⏸" : s.estado === "falló" ? "❌" : s.estado === "postergado" ? "⏳" : s.ultimaFecha === fechaAR() ? "✅" : "💤"; l.push(`  ${ic} ${b.nombre} (${b.id}) · ${tipoTxt(b)}${s.puntaje ? ` · ${s.puntaje}/10` : ""}`); } }
  return l.join("\n");
}
const AYUDA = () => `Soy el Gerente general de la ${CFG.oficina}. Escribime:
• Una orden normal: «averiguá el precio del cemento en Villa María». Se la paso al bot que corresponde.
• estado — cómo está cada bot.  • bots — organigrama con horarios.
• correr ID — que un bot trabaje ahora (ej: correr dolar).
• pausar ID / activar ID.
• crear area Nombre — abre una oficina nueva.
• contratar: lo que querés que haga — diseño un bot nuevo (ej: «contratar: que todos los días a las 9 me avise el precio del gasoil en Córdoba»).
• contratar en pausa: ... — queda armado pero sin trabajar hasta que lo actives.
• pausar area Nombre / activar area Nombre / eliminar area Nombre.
• eliminar ID (o despedir ID) — lo saco de la oficina.
• horario ID 09:00 lun,jue — le cambio el horario.
• Respondé un informe con 👍, 👎 o un comentario: ese bot se entrena con eso esa noche.
Oficina visual: https://uwuubuntu83-dotcom.github.io/oficina-bosio/`;
const COLORES = ["#c2417a", "#2f7d4f", "#b5651d", "#2f5fa8", "#7a4fa8", "#0e8a8a", "#a0522d", "#4a5bbf", "#8a6d2f", "#5f5f5f"];
function guardarExtra() { escribir(FEXTRA, extra); }
async function contratar(pedido) {
  const areas = CFG.areas.map(a => `${a.id}: ${a.nombre}`).join("\n");
  const r = await ia(`Diseñá un bot nuevo para la ${CFG.oficina}. Pedido del jefe: "${pedido}".
Áreas existentes:\n${areas}
Hay dos tipos de bot:
- "codigo": SIN IA, gratis. Usalo SIEMPRE que se pueda. Recetas disponibles:
  · rss: noticias/novedades de Google Noticias. Parámetros: {"tipo":"rss","busquedas":["consulta 1","consulta 2"],"max":8}
  · dolar: cotizaciones del dólar. {"tipo":"dolar","alertaPorcentaje":2}
  · clima: pronóstico de Villa María. {"tipo":"clima"}
  · web_estado: revisar que páginas estén online. {"tipo":"web_estado","urls":["https://..."]}
  · recordatorio: mandar un aviso fijo. {"tipo":"recordatorio","texto":"..."}
- "ia": cuando hace falta pensar, redactar o buscar y analizar en internet. "buscar": true solo si necesita datos actuales de internet.
Respondé SOLO un JSON:
{"id":"corto_sin_espacios","nombre":"Nombre visible","area":"id de área existente o nombre de un área nueva","tipo":"codigo|ia","receta":{...solo si es codigo},"buscar":true|false,"horario":{"apedido":true} si el jefe NO dijo cada cuánto ni cuándo, o {"dias":"todos" o [0-6 con 0=domingo],"hora":"HH:MM"} si lo dijo,"mision":"qué hace","entregable":"qué entrega (si es ia)","criterios":["...","..."]}`, { json: true });
  const j = parsearJSON(r.texto); if (!j || !j.nombre || !j.mision) throw new Error("no pude diseñar el bot, probá describirlo de otra forma");
  let id = slug(j.id || j.nombre); while (botPorId(id)) id += "2";
  let area = CFG.areas.find(a => a.id === j.area || a.nombre.toLowerCase() === String(j.area || "").toLowerCase());
  if (!area) { area = { id: slug(j.area || "nueva_area"), nombre: String(j.area || "Nueva área").slice(0, 40), icono: "📁", color: COLORES[extra.areas.length % COLORES.length] }; extra.areas.push(area); CFG.areas.push(area); }
  const tipo = j.tipo === "codigo" && j.receta && RECETAS[j.receta.tipo] ? "codigo" : "ia";
  const dijoCuando = /(todos los d[ií]as|cada |lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}(:\d{2})?\s*(hs|h\b|am|pm)|a la mañana|a la noche|semanal|diari|mensual)/i.test(pedido);
  const horario = dijoCuando && j.horario && (j.horario.hora || j.horario.cada) ? j.horario : { apedido: true };
  if (horario.hora && !/^\d{2}:\d{2}$/.test(horario.hora)) horario.hora = "09:00";
  const bot = { id, nombre: String(j.nombre).slice(0, 50), area: area.id, tipo, horario, mision: String(j.mision).slice(0, 500), creado: NOW.toISOString() };
  if (tipo === "codigo") bot.receta = j.receta; else { bot.buscar = !!j.buscar; bot.entregable = String(j.entregable || "Un resultado concreto y listo para usar.").slice(0, 400); bot.criterios = Array.isArray(j.criterios) && j.criterios.length ? j.criterios.slice(0, 5).map(String) : ["Concreto", "Útil", "Sin relleno"]; }
  extra.bots.push(bot); CFG.bots.push(bot); est.bots[id] = nuevoBot(); guardarExtra();
  log("Gerente general", `contrató a ${bot.nombre} (${tipoTxt(bot)}) en ${area.nombre}`);
  await enviar(`🤝 Contraté a «${bot.nombre}» en ${area.icono} ${area.nombre}\nTipo: ${tipoTxt(bot)}\nTarea: ${bot.mision}\nHorario: ${horarioTxt(bot)}\n\n${horario.apedido ? "No corre solo: trabaja cuando le pidas algo o escribas «correr " + id + "»." : "Para probarlo ya: «correr " + id + "»."} Si ya no lo necesitás: «pausar ${id}» o «eliminar ${id}».`);
  return bot;
}
async function procesarMensajes() {
  if (!TG_TOKEN) return;
  let ups = await tg("getUpdates", { offset: est.tgOffset, timeout: 0, allowed_updates: ["message", "edited_message"] });
  if (ups === null) {
    const info = await tg("getWebhookInfo", {});
    log("Mesa de entrada", `Telegram no entregó mensajes (${tg.error || "sin detalle"})${info && info.url ? " · tenía un webhook: " + info.url : ""}`);
    if (info && info.url) { await tg("deleteWebhook", { drop_pending_updates: false }); ups = await tg("getUpdates", { offset: est.tgOffset, timeout: 0 }); }
  }
  ups = ups || [];
  log("Mesa de entrada", ups.length ? `llegaron ${ups.length} mensajes de Telegram` : `sin mensajes nuevos${est.dueno ? "" : " (todavía no hay dueño vinculado: mandale cualquier mensaje al bot)"}`);
  for (const u of ups) {
    est.tgOffset = u.update_id + 1;
    const m = u.message || u.edited_message; if (!m || !m.text) continue;
    const chat = m.chat.id; const txt = m.text.trim();
    if (!est.dueno) { if (m.chat.type === "private") { est.dueno = chat; log("Gerente general", `quedó vinculado el Telegram de ${m.from && m.from.first_name || "el dueño"}`); await enviar(`✅ Listo, ${m.from && m.from.first_name || "jefe"}: quedaste como dueño de la oficina. Solo te obedezco a vos.\n\n${AYUDA()}`); } continue; }
    if (chat !== est.dueno) continue;
    const resp = m.reply_to_message && est.mensajes[m.reply_to_message.message_id];
    if (resp && botPorId(resp)) {
      const b = botPorId(resp); const sb = est.bots[b.id];
      const pos = /👍|bien|genial|excelente|perfecto|buenísimo|sirve|me gusta/i.test(txt), neg = /👎|mal|no sirve|inventad|viejo|equivocad|no me gusta/i.test(txt);
      if (pos) sb.likes++; if (neg) sb.dislikes++;
      const feed = leer(FFEED(b.id), []); feed.push({ t: NOW.toISOString(), tipo: "jefe", texto: txt.slice(0, 500), valor: pos ? 1 : neg ? -1 : 0 }); escribir(FFEED(b.id), feed.slice(-40));
      log("Jonathan", `opinó sobre ${b.nombre}: ${txt.slice(0, 80)}`); await enviar(`📝 Anotado para ${b.nombre}. Lo aplica desde el entrenamiento de esta noche.`); continue;
    }
    const low = txt.toLowerCase().replace(/^\//, "").trim(); let mm;
    if (/^(start|ayuda|help|hola|menu|menú)$/.test(low)) { await enviar(AYUDA()); continue; }
    if (/^(estado|tablero|novedades)$/.test(low)) { await enviar(tablero()); continue; }
    if (/^(bots|organigrama)$/.test(low)) { await enviar(`👑 ${CFG.dueno} (dueño)\n🎯 ${CFG.gerente.nombre}: ${CFG.gerente.mision}\n\n` + CFG.areas.map(a => { const bs = bots().filter(b => b.area === a.id); return `${a.icono} Gerente de ${a.nombre}\n` + (bs.length ? bs.map(b => `  • ${b.nombre} (${b.id}) · ${tipoTxt(b)} · ${horarioTxt(b)}`).join("\n") : "  (sin empleados)"); }).join("\n\n")); continue; }
    if ((mm = txt.match(/^\/?crear\s+(?:area|área|oficina)\s+(.+)/i))) { const nombre = mm[1].trim().slice(0, 40); const id = slug(nombre); if (CFG.areas.some(a => a.id === id)) { await enviar("Esa área ya existe."); continue; } const a = { id, nombre, icono: "📁", color: COLORES[extra.areas.length % COLORES.length] }; extra.areas.push(a); CFG.areas.push(a); guardarExtra(); log("Jonathan", `abrió el área ${nombre}`); await enviar(`🏢 Abrí el área «${nombre}». Ahora contratale bots: «contratar: ...».`); continue; }
    if ((mm = txt.match(/^\/?contrat(?:ar|á|a)\s*(en pausa|pausado)?\s*:?\s*(.+)/is))) { est.pendientes.push({ tipo: "contratar", orden: mm[2].trim().slice(0, 600), pausa: !!mm[1] || /\ben pausa\b/i.test(mm[2]), t: NOW.toISOString() }); log("Jonathan", "pidió contratar: " + mm[2].slice(0, 100)); continue; }
    if ((mm = txt.match(/^\/?(pausar|activar|eliminar|borrar)\s+(?:el\s+)?(?:area|área|oficina)\s+(.+)/i))) {
      const q = slug(mm[2]); const a = CFG.areas.find(x => x.id === q || slug(x.nombre) === q || slug(x.nombre).includes(q));
      if (!a) { await enviar("No encontré esa área. Escribí «bots» para ver las áreas."); continue; }
      const acc = mm[1].toLowerCase();
      if (acc === "pausar") { if (!extra.areasPausadas.includes(a.id)) extra.areasPausadas.push(a.id); await enviar(`⏸ Área ${a.nombre} en pausa: sus bots no trabajan ni gastan hasta que escribas «activar area ${a.nombre}».`); }
      else if (acc === "activar") { extra.areasPausadas = extra.areasPausadas.filter(x => x !== a.id); await enviar(`▶️ Área ${a.nombre} activa otra vez.`); }
      else { extra.areasQuitadas.push(a.id); extra.bots = extra.bots.filter(b => b.area !== a.id); CFG.areas = CFG.areas.filter(x => x.id !== a.id); CFG.bots = CFG.bots.filter(b => b.area !== a.id); await enviar(`🗑️ Eliminé el área ${a.nombre} con sus bots.`); }
      guardarExtra(); log("Jonathan", `${acc} el área ${a.nombre}`); continue;
    }
    if ((mm = low.match(/^(despedir|echar|eliminar|borrar)\s+(\S+)/))) { const b = botPorId(mm[2]); if (!b) { await enviar("No encontré ese bot. Escribí «bots» para ver los ID."); continue; } if (extra.bots.some(x => x.id === b.id)) extra.bots = extra.bots.filter(x => x.id !== b.id); else extra.quitados.push(b.id); guardarExtra(); CFG.bots = CFG.bots.filter(x => x.id !== b.id); log("Jonathan", `despidió a ${b.nombre}`); await enviar(`👋 ${b.nombre} ya no trabaja en la oficina.`); continue; }
    if ((mm = low.match(/^horario\s+(\S+)\s+(\d{1,2}:\d{2})\s*(.*)$/))) { const b = botPorId(mm[1]); if (!b) { await enviar("No encontré ese bot."); continue; } const hora = mm[2].padStart(5, "0"); const ds = mm[3].trim(); let dias = "todos"; if (ds && !/todos/.test(ds)) dias = ds.split(/[ ,]+/).map(x => DIAS3.indexOf(x.slice(0, 3).replace("mié", "mie").replace("sáb", "sab"))).filter(x => x >= 0); extra.cambios[b.id] = { ...(extra.cambios[b.id] || {}), horario: { dias, hora } }; b.horario = { dias, hora }; guardarExtra(); await enviar(`🕘 ${b.nombre}: ${horarioTxt(b)}.`); continue; }
    if ((mm = low.match(/^(correr|pausar|activar)\s+(\S+)/))) {
      const b = botPorId(mm[2]) || bots().find(x => x.nombre.toLowerCase().includes(mm[2]));
      if (!b) { await enviar("No encontré ese bot. Escribí «bots» para ver los ID."); continue; }
      if (mm[1] === "pausar") { est.bots[b.id].pausado = true; await enviar(`⏸ ${b.nombre} en pausa.`); }
      else if (mm[1] === "activar") { Object.assign(est.bots[b.id], { pausado: false, fallasSeguidas: 0, estado: "esperando" }); await enviar(`▶️ ${b.nombre} vuelve a trabajar.`); }
      else { est.pendientes.push({ bot: b.id, orden: "", t: NOW.toISOString(), origen: "orden" }); await enviar(`🏃 ${b.nombre} arranca ahora.`); }
      log("Jonathan", `${mm[1]} ${b.nombre}`); continue;
    }
    est.pendientes.push({ bot: null, orden: txt.slice(0, 600), t: NOW.toISOString(), origen: "orden" });
    log("Jonathan", "ordenó: " + txt.slice(0, 120));
  }
}
async function repartir(p) {
  const g = est.bots.gerente; g.estado = "trabajando";
  const lista = bots().filter(b => b.tipo !== "externo").map(b => `- ${b.id}: ${b.nombre} (${areaDe(b).nombre}, ${tipoTxt(b)}) — ${b.mision}`).join("\n");
  const r = await ia(`Sos el Gerente general de una oficina de bots. Tu jefe ordenó: "${p.orden}"
Empleados:\n${lista}
Elegí el empleado que mejor la cumple. Si ninguno encaja, elegí "gerente" (la hacés vos).
Respondé SOLO un JSON: {"bot":"id o gerente","instruccion":"la orden clara para ese empleado","aviso":"frase corta para el jefe diciendo a quién se la pasaste","buscar":true si hace falta buscar en internet}`, { json: true });
  const j = parsearJSON(r.texto) || {}; const b = botPorId(j.bot);
  if (b && b.tipo !== "externo") {
    log("Gerente general", `le pasó la orden a ${b.nombre}`); await enviar(`📥 ${j.aviso || `Se la paso a ${b.nombre}.`}`);
    // los bots sin IA hacen su tarea tal cual (gratis); los de IA reciben la orden concreta
    await trabajar(b, { orden: b.tipo === "codigo" ? "" : (j.instruccion || p.orden), origen: "orden" });
  } else {
    log("Gerente general", "hace la orden él mismo");
    const gen = { id: "gerente", nombre: "Gerente general", area: "direccion", buscar: j.buscar !== false, mision: "Cumplir la orden del jefe con información real y actual.", entregable: "La respuesta completa y lista para usar.", criterios: ["Responde exactamente lo pedido", "Datos reales con fuente", "Claro y breve"] };
    const res = await ia(promptBot(gen, j.instruccion || p.orden), { buscar: gen.buscar });
    const f = (res.fuentes || []).slice(0, 5).map(x => "• " + x.url).join("\n");
    await enviar(`🎯 Gerente general\n📌 Tu orden: ${p.orden}\n\n${res.texto}${f ? "\n\nFuentes:\n" + f : ""}`);
    g.resumen = "Respondió: " + p.orden.slice(0, 120);
  }
  g.estado = "listo";
}
async function parteDiario() {
  const hoy = bots().filter(b => est.bots[b.id]?.ultimaFecha === fechaAR()); const fallas = bots().filter(b => est.bots[b.id]?.estado === "falló");
  const textos = hoy.filter(b => b.tipo === "ia").map(b => { try { return `${b.nombre}: ` + fs.readFileSync(path.join(ROOT, est.bots[b.id].informe), "utf8").slice(0, 1000); } catch { return ""; } }).filter(Boolean).join("\n\n");
  let destacado = ""; if (textos) { try { destacado = (await ia(`Sos el Gerente general. Con estos informes de hoy escribí las 3 a 5 cosas MÁS importantes o accionables para tu jefe, una línea cada una, sin inventar nada:\n\n${textos.slice(0, 9000)}`)).texto; } catch {} }
  est.bots.gerente.resumen = "Mandó el parte diario"; log("Gerente general", "mandó el parte diario");
  await enviar(`🧾 Parte diario · ${DIAS[diaAR()]} ${fechaAR()}\n\n✅ Trabajaron hoy (${hoy.length}): ${hoy.map(b => b.nombre + (est.bots[b.id].puntaje ? ` ${est.bots[b.id].puntaje}/10` : "")).join(", ") || "nadie"}\n${fallas.length ? "❌ Con problemas: " + fallas.map(b => b.nombre).join(", ") + "\n" : ""}🤖 IA usada: ${est.consumo.consultas} consultas entre ${Object.keys(est.consumo.por).length} IA\n${destacado ? "\n⭐ Lo más importante:\n" + destacado : ""}`);
}
async function entrenar() {
  const aprendieron = [];
  for (const b of bots().filter(x => x.tipo === "ia")) {
    const rec = leer(FFEED(b.id), []).filter(x => new Date(x.t).getTime() > Date.now() - 8 * 86400e3); if (!rec.length) continue;
    const actuales = fs.existsSync(FLECC(b.id)) ? fs.readFileSync(FLECC(b.id), "utf8") : "(todavía ninguna)";
    try {
      const r = await ia(`Sos el entrenador de "${b.nombre}", un bot cuya tarea es: ${b.mision}\nEntregable: ${b.entregable}\nSUS LECCIONES ACTUALES:\n${actuales}\nNOTAS RECIENTES (las del jefe valen el doble):\n${rec.map(x => x.tipo === "jefe" ? `JEFE (${x.valor > 0 ? "positivo" : x.valor < 0 ? "negativo" : "comentario"}): ${x.texto}` : `CALIDAD ${x.puntaje}/10: ${(x.problemas || []).join("; ")} → ${x.mejorar}`).join("\n").slice(0, 6000)}\nReescribí sus lecciones: máximo 8 viñetas cortas y accionables (qué hacer y qué evitar), conservando las que sirven. Respondé SOLO las viñetas empezando con "- ".`);
      const nuevas = r.texto.split("\n").map(s => s.trim()).filter(s => /^[-•*]/.test(s)).map(s => "- " + s.replace(/^[-•*]\s*/, "")).slice(0, 8).join("\n");
      if (nuevas) { escribir(FLECC(b.id), nuevas + "\n"); est.bots[b.id].nivel++; aprendieron.push(b.nombre); log("Entrenador", `${b.nombre} subió a nivel ${est.bots[b.id].nivel}`); }
    } catch (e) { log("Entrenador", `${b.nombre}: no pude entrenarlo (${e.message})`); if (e.cupo) break; }
  }
  if (aprendieron.length) await enviar(`🎓 Entrenamiento: ${aprendieron.join(", ")} aprendieron de sus notas y mañana trabajan mejor.`);
}
async function revisarExternos() {
  for (const b of bots().filter(x => x.tipo === "externo")) {
    const sb = est.bots[b.id]; const hb = leer(path.join(DATA, "externos", b.id + ".json"), null);
    if (!hb) { sb.estado = "sin conectar"; continue; }
    const min = (Date.now() - new Date(hb.t).getTime()) / 60000;
    sb.ultimaCorrida = hb.t; sb.resumen = hb.detalle || hb.estado; sb.estado = min > (b.alertaMin || 90) ? "sin señal" : hb.estado === "error" ? "falló" : "listo";
    if (sb.estado !== "sin conectar" && min <= (b.alertaMin || 90)) sb.ultimaFecha = fechaAR(hb.t ? new Date(hb.t) : NOW);
    if (sb.estado === "sin señal" && sb.memoria.avisoSinSenal !== hb.t) { sb.memoria.avisoSinSenal = hb.t; log("Mantenimiento", `${b.nombre} no da señales hace ${Math.round(min)} min`); await enviar(`📵 ${b.nombre} no da señales hace ${Math.round(min)} minutos. Revisá el celu: batería, Wi-Fi y que Termux esté abierto.`); }
  }
}

/* ---------- ciclo ---------- */
function toca(b) {
  const s = est.bots[b.id]; if (!s || s.pausado || areaPausada(b) || b.tipo === "externo") return null;
  const h = b.horario || {}; if (h.apedido) return null; const diasOk = !h.dias || h.dias === "todos" || h.dias.includes(diaAR()); if (!diasOk) return null;
  const hh = horaAR();
  if (h.cada) {
    if (h.resumen && hh >= h.resumen && s.memoria.resumenFecha !== fechaAR()) return { resumen: true };
    if (hh < (h.desde || "00:00") || hh > (h.hasta || "23:59")) return null;
    const ult = s.memoria.ultimoChequeo ? (NOW - new Date(s.memoria.ultimoChequeo)) / 60000 : 1e9;
    return ult >= h.cada - 5 ? { resumen: false } : null;
  }
  if (s.estado === "postergado" && s.ultimaFecha !== fechaAR() && hh >= h.hora) return { resumen: false };
  return hh >= h.hora && s.ultimaFecha !== fechaAR() ? { resumen: false } : null;
}
async function main() {
  log("Oficina", `abre (${MODO}) · IA conectadas: ${PROV.map(p => p.id).join(", ") || "ninguna"}`);
  for (const id of Object.keys(est.bots)) if (est.bots[id].estado === "trabajando") est.bots[id].estado = "esperando";
  if (TG_TOKEN && !est.botUsuario) { const me = await tg("getMe", {}); if (me && me.username) est.botUsuario = me.username; }
  await procesarMensajes();
  await revisarExternos();
  if (MODO.startsWith("correr:")) est.pendientes.push({ bot: MODO.slice(7), orden: "", origen: "manual" });
  const quedan = [];
  for (const p of est.pendientes) {
    try {
      if (p.tipo === "contratar") { const nb = await contratar(p.orden); if (p.pausa && nb) { est.bots[nb.id].pausado = true; await enviar(`⏸ «${nb.nombre}» queda en pausa hasta que escribas «activar ${nb.id}».`); } }
      else if (p.bot) { const b = botPorId(p.bot); if (b) { const ok = await trabajar(b, { orden: p.orden, origen: p.origen || "orden" }); if (!ok && est.bots[b.id].estado === "postergado") quedan.push(p); } }
      else await repartir(p);
    } catch (e) { if (e.cupo) { quedan.push(p); log("Gerente general", "orden en espera por cupo: " + e.message); } else { log("Gerente general", "no pude con la orden: " + e.message); await enviar(`⚠️ No pude cumplir «${String(p.orden || p.bot).slice(0, 80)}»: ${e.message}`); } }
  }
  est.pendientes = quedan.slice(0, 30);
  if (MODO === "auto" || MODO === "todos" || MODO === "sinIA") {
    for (const b of bots()) {
      const t = MODO === "todos" ? (b.tipo !== "externo" && !est.bots[b.id].pausado ? { resumen: true } : null) : MODO === "sinIA" ? (b.tipo === "codigo" ? { resumen: true } : null) : toca(b);
      if (!t) continue;
      await trabajar(b, { origen: "agenda", resumen: t.resumen });
    }
  }
  if ((MODO === "auto" && horaAR() >= CFG.gerente.parteDiario && est.hechos.parte !== fechaAR()) || MODO === "parte") { est.hechos.parte = fechaAR(); try { await parteDiario(); } catch (e) { log("Gerente general", "parte: " + e.message); } }
  if ((MODO === "auto" && horaAR() >= CFG.gerente.entrenamiento && est.hechos.entrenamiento !== fechaAR()) || MODO === "entrenar") { est.hechos.entrenamiento = fechaAR(); await entrenar(); }
  est.bots.gerente.estado = est.pendientes.length ? "trabajando" : "esperando";
  est.actualizado = NOW.toISOString();
  est.config = { telegram: !!TG_TOKEN, gemini: PROV.some(p => p.tipo === "gemini"), dueno: !!est.dueno, ias: [...new Set(PROV.map(p => p.nombre))] };
  escribir(FEST, est);
  escribir(path.join(DATA, "organigrama.json"), { oficina: CFG.oficina, dueno: CFG.dueno, gerente: CFG.gerente, areas: CFG.areas, bots: CFG.bots.map(b => ({ ...b, tipoTxt: tipoTxt(b), horarioTxt: horarioTxt(b) })), limites: CFG.limites });
  console.log(`Listo. Consultas de IA en esta corrida: ${consultasCorrida}. Hoy: ${est.consumo.consultas}.`);
}
main().catch(e => { console.error(e); log("Oficina", "error general: " + e.message); est.actualizado = NOW.toISOString(); escribir(FEST, est); });
