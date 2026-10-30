// Oficina Bosio v2 — corre sola en GitHub Actions, gratis.
// Dueño → Gerente general → áreas → bots. Bots SIN IA (código, gratis 24/7), bots CON IA (rotan entre muchas IA gratis)
// y bots EXTERNOS (el celular bot reporta su estado). Control de calidad + entrenamiento diario.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
est.consumo.por ||= {}; est.consumo.busquedas ||= 0;
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
if (ENV.GITHUB_TOKEN) PROV.push({ id: "github", nombre: "GitHub Models", tipo: "openai", base: "https://models.github.ai/inference", key: ENV.GITHUB_TOKEN, modelos: ["openai/gpt-4.1-mini", "openai/gpt-4o-mini", "meta/Llama-3.3-70B-Instruct", "deepseek/DeepSeek-V3-0324", "openai/gpt-4.1", "openai/gpt-4o", "mistral-ai/mistral-small-2503", "xai/grok-3-mini", "meta/Llama-4-Scout-17B-16E-Instruct", "cohere/cohere-command-a", "microsoft/Phi-4", "openai/gpt-4.1-nano"], maxFallas: 6 });
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
if ((ENV.BUZON_URL || BASE.buzon) && (ENV.OFICINA_PIN || TG_TOKEN)) PROV.push({ id: "cfai", nombre: "Cloudflare Workers AI", tipo: "buzon", key: "-", modelos: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/qwen/qwen2.5-coder-32b-instruct"], maxFallas: 4 });
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

async function llamarGemini(p, modelo, prompt, { buscar, json, imagen }) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }, ...(imagen ? [{ inline_data: { mime_type: imagen.mime, data: imagen.b64 } }] : [])] }], generationConfig: { temperature: json ? 0.2 : 0.5, maxOutputTokens: 8192 } };
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
async function llamarBuzon(p, modelo, prompt, { json }) {
  await pausa(p); usar(p.id);
  const base = (ENV.BUZON_URL || BASE.buzon || "").replace(/\/+$/, "");
  const pin = ENV.OFICINA_PIN || (TG_TOKEN ? String(parseInt(crypto.createHash("sha256").update("pin:" + TG_TOKEN).digest("hex").slice(0, 12), 16) % 1e8).padStart(8, "0") : "");
  const r = await traer(base + "/oficina/ia", { method: "POST", headers: { "content-type": "application/json", "x-pin": pin }, body: JSON.stringify({ modelo, prompt, json }) }, 120000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: true, status: r.status, j, msg: j.error || String(r.status) };
  if (j.error) return { error: true, status: j.status || 500, j: {}, msg: j.msg || "error" };
  return { texto: j.texto, fuentes: [] };
}
async function llamarOpenAI(p, modelo, prompt, { json, imagen }) {
  await pausa(p); usar(p.id);
  const headers = { "content-type": "application/json", authorization: "Bearer " + p.key };
  if (p.id.startsWith("openrouter")) { headers["X-Title"] = "Oficina Bosio"; headers["HTTP-Referer"] = "https://uwuubuntu83-dotcom.github.io/oficina-bosio/"; }
  const body = { model: modelo, messages: [{ role: "user", content: imagen ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${imagen.mime};base64,${imagen.b64}` } }] : prompt }], temperature: json ? 0.2 : 0.5, max_tokens: 4096 };
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
async function ia(prompt, { buscar = false, json = false, imagen = null } = {}) {
  if (est.consumo.consultas >= CFG.limites.consultasPorDia || consultasCorrida >= CFG.limites.consultasPorCorrida) throw Object.assign(new Error("se llegó al tope de consultas de hoy"), { cupo: true });
  if (buscar && est.consumo.busquedas >= CFG.limites.busquedasPorDia) throw Object.assign(new Error("se llegó al tope de búsquedas de hoy"), { cupo: true });
  let lista;
  if (imagen) lista = [...PROV.filter(p => p.tipo === "gemini"), ...PROV.filter(p => p.id === "github")]; // las que pueden ver fotos
  else if (buscar) lista = [...PROV.filter(p => p.buscar), ...PROV.filter(p => p.buscarModelo)];
  else { const otros = PROV.filter(p => p.tipo !== "gemini"); const gem = PROV.filter(p => p.tipo === "gemini"); rueda++; lista = [...otros.slice(rueda % (otros.length || 1)), ...otros.slice(0, rueda % (otros.length || 1)), ...gem]; }
  if (!lista.length) throw Object.assign(new Error(imagen ? "no hay ninguna IA que pueda ver fotos conectada" : buscar ? "no hay ninguna IA con búsqueda conectada (falta GEMINI_API_KEY)" : "no hay ninguna IA conectada"), { cupo: true });
  const errores = [];
  for (const p of lista) {
    if (agotado(p.id)) continue;
    let modelos;
    if (buscar && p.buscarModelo) modelos = [p.buscarModelo];
    else if (p.tipo === "gemini") { modelos = await modelosGemini(p); if (buscar || imagen) { const todos = p.todos || modelos; const pref = [/^gemini-2\.5-flash$/, /^gemini-2\.5-flash-lite$/, /^gemini-2\.0-flash$/, /^gemini-flash-latest$/, /^gemini-2\.5-pro$/]; const prim = pref.flatMap(r => todos.filter(m => r.test(m))); modelos = [...new Set([...prim, "gemini-2.5-flash", "gemini-2.5-flash-lite", ...modelos])].slice(0, 7); } }
    else if (p.gratis) modelos = await modelosOpenRouter(p);
    else if (imagen && p.id === "github") modelos = ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"];
    else modelos = p.modelos || [];
    let fallasProv = 0;
    for (const modelo of modelos) {
      const clave = p.id + ":" + modelo;
      if (agotado(clave)) continue;
      let r;
      for (let reintento = 0; reintento < 2; reintento++) {
        consultasCorrida++; est.consumo.consultas++;
        try { r = p.tipo === "gemini" ? await llamarGemini(p, modelo, prompt, { buscar, json, imagen }) : p.tipo === "buzon" ? await llamarBuzon(p, modelo, prompt, { json }) : await llamarOpenAI(p, modelo, prompt, { json, imagen }); }
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
      if (++fallasProv >= (p.maxFallas || 3)) break;
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
/* ---------- buzón en Cloudflare: celu bot + órdenes desde la página ---------- */
const BUZON = (ENV.BUZON_URL || BASE.buzon || "").replace(/\/+$/, "");
// Si Jonathan no cargó CELU_KEY / OFICINA_PIN, salen solos de la clave de Telegram (el instalador del buzón calcula lo mismo).
const derivar = pre => crypto.createHash("sha256").update(pre + ":" + TG_TOKEN).digest("hex");
const PIN = ENV.OFICINA_PIN || (TG_TOKEN ? String(parseInt(derivar("pin").slice(0, 12), 16) % 1e8).padStart(8, "0") : "");
const CELU_KEY = ENV.CELU_KEY || (TG_TOKEN ? derivar("celu").slice(0, 32) : "");
async function avisarBuzonListo() {
  if (!BUZON || !PIN || !est.dueno || est.hechos.buzonAvisado) return;
  try { const r = await traer(BUZON + "/", {}, 10000); if (!r.ok) return; } catch { return; }
  const cmd = `echo '{"url": "${BUZON}", "celu_key": "${CELU_KEY}", "mudado": "si"}' > ~/celu_solo/nube.json && pkill -f vigia_celu.py; nohup python ~/celu_solo/vigia_celu.py >/dev/null 2>&1 &`;
  const ok = await enviar(`✅ El buzón ya está instalado en Cloudflare.\n\n1️⃣ En el celu del bot, abrí Termux, pegá este mensaje de abajo (es un solo comando) y tocá Enter. Eso conecta el celu con la oficina.\n\n2️⃣ Tu PIN de la página es: ${PIN}\nTe lo pide una sola vez al tocar 📱 Celu.\n\nDespués escribime «celu» para ver si quedó andando.`);
  if (ok && await enviar(cmd)) { est.hechos.buzonAvisado = NOW.toISOString(); log("Gerente general", "avisó que el buzón está listo"); }
}
async function buzon(ruta, cuerpo) {
  if (!BUZON || !PIN) throw new Error("el buzón del celu todavía no está instalado");
  const r = await traer(BUZON + ruta, cuerpo ? { method: "POST", headers: { "content-type": "application/json", "x-pin": PIN }, body: JSON.stringify(cuerpo) } : { headers: { "x-pin": PIN } }, 20000);
  if (!r.ok) throw new Error("el buzón respondió " + r.status); return r.json();
}
async function alCelu(orden) { return buzon("/oficina/orden", { ...orden, origen: "telegram" }); }
function textoCelu(e) {
  const E = e && e.estado; if (!E || !E.t) return "📱 El celu todavía no mandó señales al buzón. Falta cambiar el link en ~/celu_solo/nube.json y reiniciar el vigía.";
  const x = E.estado || {}, rh = x.redes_hoy || {}, min = Math.round((Date.now() - E.t) / 60000);
  return `📱 Celu bot · ${min <= 10 ? "🟢 andando" : "🔴 no responde hace " + min + " min (revisá la depuración inalámbrica)"}\nBot de Instagram: ${x.pausa ? "⏸ en pausa" : x.bot_vivo ? "trabajando" : "parado"}${x.bateria != null ? " · batería " + (typeof x.bateria === "object" ? (x.bateria.porcentaje ?? x.bateria.percentage ?? JSON.stringify(x.bateria)) : x.bateria) + "%" : ""}${x.calor ? " · 🔥 pausado por calor" : ""}\n\nHoy: ${rh.publicaciones || 0} publicaciones · ${rh.historias || 0} historias · ${rh.reels || 0} reels/reposts · ${rh.seguidos || 0} seguidos · ${rh.gringo || 0} dejados de seguir (gringo) · ${rh.errores || 0} errores · ${rh.reinicios || 0} reinicios${(rh.ultimas || []).length ? "\n\nÚltimo que hizo:\n" + rh.ultimas.slice(-6).map(l => "• " + l).join("\n") : ""}`;
}
const TAREAS_IG = { historia: "📸 Historia de Instagram", repost: "🔁 Repost", publicar: "🖼️ Publicación", reel: "🎬 Reel", reel_ia: "🤖 Reel hecho con IA", seguir: "➕ Seguir cuentas", fb_compartir: "📘 Compartir en Facebook", fb_historia: "📘 Historia de Facebook", fb_seguir: "📘 Seguir en Facebook", ofertas: "🏷️ Oferta", grin_unfollow: "➖ Gringo: dejar de seguir", obra_seguir: "🧱 Obra: seguir cuentas", obra_publicar: "🧱 Obra: publicación", obra_historia: "🧱 Obra: historia", memes: "😂 Meme" };
const ACC_IG = { historia: "historia", reel: "reel", repost: "repost", seguir: "seguir cuentas", publicar: "publicación" };
const nombreTarea = t => TAREAS_IG[t] || (/^memes_/.test(t) ? "😂 Memes: " + (ACC_IG[t.slice(6)] || t.slice(6)) : /^obra_/.test(t) ? "🧱 Obra: " + (ACC_IG[t.slice(5)] || t.slice(5)) : "• " + t.replace(/_/g, " "));
function textoPlan(e) {
  const pl = e && e.estado && e.estado.estado && e.estado.estado.plan_hoy;
  if (!pl || !pl.tareas) return "📅 El celu todavía no manda su plan a la oficina. Falta pegar en Termux el comando del parche (te lo pasé por el chat con Claude).";
  if (pl.fecha !== fechaAR()) return `📅 El plan que tiene el celu es del ${pl.fecha}: todavía no armó el de hoy (lo arma cuando arranca el día o al reiniciar).`;
  const hh = horaAR(); const quedan = pl.tareas.filter(t => t[0] >= hh), hechas = pl.tareas.length - quedan.length;
  const por = {}; for (const t of quedan) por[t[1]] = (por[t[1]] || 0) + 1;
  return `📅 Programa de hoy del celu bot (Instagram y Facebook)\nTotal: ${pl.tareas.length} tareas · ya pasaron ${hechas} · quedan ${quedan.length}\n\n${Object.entries(por).sort((a, z) => z[1] - a[1]).map(([k, v]) => `${nombreTarea(k)}: ${v}`).join("\n") || "No le quedan tareas por hoy."}${quedan.length ? "\n\n⏭️ Próximas:\n" + quedan.slice(0, 15).map(t => `${t[0]}  ${nombreTarea(t[1])}${t[2] ? " ×" + t[2] : ""}`).join("\n") + (quedan.length > 15 ? `\n… y ${quedan.length - 15} más` : "") : ""}`;
}
const RX_CELU = /^\/?celu(?:\s*bot)?\b[\s:,.-]*(.*)$/is;
const RX_CELU_AUTO = /^(programa de hoy|(sub[ií]|public[aá]|compart[ií]|hac[eé]|mand[aá])(?=\s).{0,40}\b(historia|reel|publicaci[oó]n|posteo|repost)|paus[aá] (el )?(instagram|celu)|reinici[aá] (el )?(instagram|celu|bot de instagram))/i;
async function ordenCelu(t) {
  const q = t.trim(); const low = q.toLowerCase();
  if (!q || /^(estado|c[oó]mo (est[aá]|and[aá])|anda\??)$/.test(low)) { await enviar(textoCelu(await buzon("/oficina/celu"))); return; }
  if (/^(programa|plan|agenda|tareas|qu[eé] (tiene|hace|le toca))/.test(low)) { await enviar(textoPlan(await buzon("/oficina/celu"))); return; }
  if (/^(informe|reporte|resumen)/.test(low)) { await enviar("🧾 Informe del celu de hoy\n\n" + textoCelu(await buzon("/oficina/celu"))); return; }
  let o;
  const QUE = "(\\s+(con\\s+)?(el\\s+|los\\s+)?(instagram|celu|bot|bots|todo|redes))?\\s*[.!]*$";
  if (new RegExp("^(paus[a-záéíóú]*|fren[a-záéíóú]*|par[aá])" + QUE).test(low)) o = { tipo: "accion", accion: "pausa_ig" };
  else if (new RegExp("^(segu[ií]|seguir|sigue|activ[a-záéíóú]*|arranc[a-záéíóú]*|continu[a-záéíóú]*)" + QUE).test(low)) o = { tipo: "accion", accion: "seguir_ig" };
  else if (/^reinici/.test(low)) o = { tipo: "accion", accion: "reiniciar_ig" };
  else if (/^(avisos|telegram) (on|si|sí|prend)/.test(low)) o = { tipo: "ajuste", telegram: true };
  else if (/^(avisos|telegram) (off|no|apag)/.test(low)) o = { tipo: "ajuste", telegram: false };
  else o = { tipo: "chat", texto: q };
  await alCelu(o); log("Redes sociales", "le pasó una orden al celu bot");
  await enviar(`📱 Se lo pasé al celu bot${o.tipo === "chat" ? ": «" + q.slice(0, 80) + "»" : ""}. Lo agarra en 15 segundos y te contesta acá.`);
}
const escHTML = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
async function enviar(texto, botId, opt = {}) {
  if (!est.dueno) return null;
  const partes = []; let t = opt.html ? String(texto) : limpiar(texto);
  while (t.length > 3900) { let c = t.lastIndexOf("\n", 3900); if (c < 1000) c = 3900; partes.push(t.slice(0, c)); t = t.slice(c).trim(); }
  partes.push(t);
  let ult = null;
  for (const p of partes) { ult = await tg("sendMessage", { chat_id: est.dueno, text: p, disable_web_page_preview: true, ...(opt.html ? { parse_mode: "HTML" } : {}) }); if (!ult && opt.html) ult = await tg("sendMessage", { chat_id: est.dueno, text: p.replace(/<[^>]+>/g, ""), disable_web_page_preview: true }); if (ult && botId) est.mensajes[ult.message_id] = botId; }
  const ks = Object.keys(est.mensajes); if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete est.mensajes[k];
  return ult;
}

/* ==========================================================================================
   BOTS SIN IA (recetas de código)
   ========================================================================================== */
const MEDIOS_FUERA = /(diario c[oó]rdoba|el d[ií]a de c[oó]rdoba|cord[oó]polis|abc c[oó]rdoba|c[oó]rdoba buenas noticias|europa press|20minutos|el pa[ií]s\b|el mundo\b|la vanguardia|eldiario\.es|cadena ser|andaluc|sevilla|espa[ñn]a)/i;
const TITULOS_FUERA = /(guadalc[aá]zar|montilla|lucena|priego|andaluc|junta de andaluc|euros\b|€)/i;
/* ---------- datos PRIVADOS (comidas, ejercicio, gastos): se guardan cifrados, el repo es público ---------- */
const CLAVE_PRIV = crypto.createHash("sha256").update("oficina-bosio-privado:" + (ENV.OFICINA_CLAVE || TG_TOKEN || "sin-clave")).digest();
const FPRIV = id => path.join(DATA, "privado", id + ".enc");
function leerPriv(id, def) {
  if (!fs.existsSync(FPRIV(id))) return def;
  const buf = Buffer.from(fs.readFileSync(FPRIV(id), "utf8"), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", CLAVE_PRIV, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")); // si la clave no coincide, tira error y NO se pisa nada
}
const leerPrivSeguro = (id, def) => { try { return leerPriv(id, def); } catch { return def; } };
function escribirPriv(id, v) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", CLAVE_PRIV, iv); const data = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]); escribir(FPRIV(id), Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")); }
function anotar(id, e) { const r = leerPriv(id, []); r.push({ t: NOW.toISOString(), f: fechaAR(), h: horaAR(), ...e }); escribirPriv(id, r.slice(-4000)); return r; }
const pesos = n => "$" + Math.round(n).toLocaleString("es-AR");
function leerMonto(s) { let t = String(s); let a; do { a = t; t = t.replace(/(\d)\.(\d{3})(?!\d)/, "$1$2"); } while (t !== a); const m = t.match(/\$?\s*(\d+(?:,\d+)?)\s*(k\b|mil\b|lucas\b|luca\b)?/i); if (!m) return null; let v = parseFloat(m[1].replace(",", ".")); if (m[2]) v *= 1000; return v > 0 ? v : null; }
const CATS = [["Auto y combustible", /(nafta|gasoil|combustible|ypf|shell|axion|estacionamiento|peaje|mec[aá]nic|gomer|lavadero|repuesto)/i], ["Comida y súper", /(s[uú]per|\bpan\b|carne|fruta|verdura|leche|caf[eé]|gaseosa|almac[eé]n|carnicer|verduler|panader|comida|delivery|rotiser|pizza|empanada|kiosco|mercado|fiambrer|helad)/i], ["Salud", /(farmacia|remedio|m[eé]dic|dentista|odont|an[aá]lisis|kinesi|psic[oó]log|nutricion)/i], ["Ropa e imagen", /(ropa|zapatilla|remera|pantal[oó]n|peluquer|barber|perfume|corte de pelo)/i], ["Salidas", /(bar\b|cerveza|birra|boliche|cine|salida|restaurant|resto|asado|fernet|cumple|regalo)/i], ["Obra y herramientas", /(herramienta|corral[oó]n|ferreter|material|cemento|pintur|pinceleta)/i], ["Tecnología y suscripciones", /(celular|cargador|auricular|app\b|suscripci|netflix|spotify|youtube|google|chatgpt|disney|steam)/i], ["Deporte", /(gimnasio|gym|club|suplement|prote[ií]na|creatina|paleta|f[uú]tbol)/i]];
const categoria = t => (CATS.find(([, r]) => r.test(t)) || ["Otros"])[0];
const RX_SERV = /\b(luz|epec|gas|ecogas|agua|cooperativa|internet|wifi|fibra|cable|directv|flow|tel[eé]fono|alquiler|expensas|municipal(idad)?|tasa|rentas|inmobiliario|seguro|prepaga|obra social|patente)\b/i;
function resumenGastos(desde, hasta, titulo) {
  const g = leerPriv("gastos", []).filter(x => x.f >= desde && x.f <= hasta); const serv = leerPriv("pagos_casa", []).filter(x => x.f >= desde && x.f <= hasta);
  const por = {}; for (const x of g) por[x.cat] = (por[x.cat] || 0) + x.monto;
  const tg_ = g.reduce((a, x) => a + x.monto, 0), ts = serv.reduce((a, x) => a + x.monto, 0);
  return `🧾 ${titulo}\n\n👤 Gastos personales: ${pesos(tg_)} (${g.length} gastos)\n${Object.entries(por).sort((a, z) => z[1] - a[1]).map(([k, v]) => `  • ${k}: ${pesos(v)} (${Math.round(v / tg_ * 100)}%)`).join("\n") || "  (sin gastos anotados)"}\n\n🏠 Servicios de la casa pagados: ${pesos(ts)}\n${serv.map(x => `  • ${x.servicio}: ${pesos(x.monto)} (${x.f.slice(8, 10)}/${x.f.slice(5, 7)})`).join("\n") || "  (ninguno anotado)"}\n\n💰 Total: ${pesos(tg_ + ts)}`;
}
const hace = dias => new Date(NOW.getTime() - dias * 86400e3).toISOString();
function listaComidas(dias) { const r = leerPrivSeguro("comidas", []).filter(x => dias === 1 ? x.f === fechaAR() : x.t >= hace(dias)); return r.length ? r.map(x => `• ${dias > 1 ? x.f.slice(8, 10) + "/" + x.f.slice(5, 7) + " " : ""}${x.h} ${x.momento ? x.momento + ": " : ""}${x.texto}`).join("\n") : "(no anotaste comidas)"; }
function resumenEjercicio(dias) { const r = leerPrivSeguro("ejercicio", []).filter(x => x.t >= hace(dias)); const si = new Set(r.filter(x => x.hizo).map(x => x.f)); return `💪 Actividad de los últimos ${dias} días: entrenaste o caminaste ${si.size} de ${dias} días.\n${r.map(x => `${x.hizo ? "✅" : "▫️"} ${x.f.slice(8, 10)}/${x.f.slice(5, 7)}: ${x.texto}`).join("\n") || "(no anotaste nada todavía)"}`; }
function parseItems(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) { const it = m[1]; out.push({ titulo: decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]), link: decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]), fuente: decode((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]), fecha: decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]) }); }
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) { const it = m[1]; out.push({ titulo: decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]), link: ((it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ""), fuente: "", fecha: decode((it.match(/<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/) || [])[1]) }); }
  return out;
}
const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
const RECETAS = {
  async dolar(b, sb, { resumen }) {
    const r = await traer(URLS.dolar); if (!r.ok) throw new Error("dolarapi respondió " + r.status);
    const lista = await r.json(); if (!Array.isArray(lista) || !lista.length) throw new Error("dolarapi sin datos");
    const ant = sb.memoria.dolar || {}; const alertas = []; const hoy = {};
    const lineas = lista.map(d => { const k = d.casa || d.nombre; hoy[k] = d.venta; const prev = ant[k]; let var_ = ""; if (prev && d.venta) { const pc = (d.venta - prev) / prev * 100; var_ = Math.abs(pc) >= 0.05 ? ` (${pc >= 0 ? "+" : ""}${pc.toFixed(1)}%)` : ""; if (Math.abs(pc) >= (b.receta.alertaPorcentaje || 2)) alertas.push(`${d.nombre}: ${pc >= 0 ? "subió" : "bajó"} ${Math.abs(pc).toFixed(1)}% → $${d.venta}`); } return `• ${d.nombre}: compra $${d.compra ?? "-"} · venta $${d.venta ?? "-"}${var_}`; });
    if (resumen || !sb.memoria.dolarBase || sb.memoria.dolarFecha !== fechaAR()) { sb.memoria.dolarBase = hoy; sb.memoria.dolarFecha = fechaAR(); }
    sb.memoria.dolar = sb.memoria.dolarBase;
    const texto = `💵 Dólar hoy (${horaAR()} hs)\n${lineas.join("\n")}\n\nFuente: dolarapi.com`;
    if (resumen) return { texto, enviar: true };
    if (alertas.length) { const k = alertas.join("|"); if (sb.memoria.ultimaAlerta === k) return { texto, enviar: false }; sb.memoria.ultimaAlerta = k; return { texto: `🚨 Movimiento fuerte del dólar\n${alertas.join("\n")}\n\n${texto}`, enviar: true }; }
    return { texto, enviar: false };
  },
  async rss(b, sb, { resumen } = {}) {
    const vistos = new Set(sb.memoria.vistos || []); const items = [];
    const fuentesUrl = [...(b.receta.busquedas || []).map(q => ({ q, url: `${URLS.rss}?q=${encodeURIComponent(q + " when:" + (b.receta.dias || 3) + "d")}&hl=es-419&gl=AR&ceid=AR:es-419` })), ...(b.receta.feeds || []).map(u => ({ q: u, url: u, feed: true }))];
    for (const { q, url, feed } of fuentesUrl) {
      try {
        const r0 = await traer(url); if (!r0.ok) throw new Error("respondió " + r0.status); const xml = await r0.text();
        for (const it0 of parseItems(xml)) {
          const { titulo, link } = it0; const fuente = it0.fuente || (feed ? new URL(url).hostname.replace(/^www\./, "") : ""); const fecha = it0.fecha;
          if (feed && fecha && Date.now() - new Date(fecha) > (b.receta.dias || 3) * 86400e3 && sb.memoria.vistos) continue;
          const clave = titulo.toLowerCase().replace(/\s+-\s+[^-]+$/, "").slice(0, 90);
          if (!titulo || !link || vistos.has(clave) || items.some(x => x.clave === clave)) continue;
          if (MEDIOS_FUERA.test(fuente) || TITULOS_FUERA.test(titulo)) continue;
          if (b.receta.requiere && !b.receta.requiere.some(w => titulo.toLowerCase().includes(w))) continue;
          if (b.receta.excluir && b.receta.excluir.some(w => (titulo + " " + fuente).toLowerCase().includes(w))) continue;
          const pr = (b.receta.prioridad || []).some(w => (fuente + " " + link).toLowerCase().includes(w)) ? 1 : 0;
          items.push({ titulo: titulo.replace(/\s+-\s+[^-]+$/, ""), link, fuente, fecha: fecha ? new Date(fecha) : null, clave, pr });
        }
      } catch (e) { log(b.nombre, `no pude leer «${q}»: ${e.message}`); }
    }
    items.sort((a, z) => (z.pr - a.pr) || ((z.fecha || 0) - (a.fecha || 0)));
    let nuevos = items.slice(0, b.receta.max || 8);
    sb.memoria.vistos = [...nuevos.map(x => x.clave), ...(sb.memoria.vistos || [])].slice(0, 600);
    const entrega = b.receta.entrega; // horarios fijos para mandar lo juntado (si no hay, avisa al instante)
    if (entrega && entrega.length && !resumen) {
      sb.memoria.bandeja = [...(sb.memoria.bandeja || []), ...nuevos.map(x => ({ titulo: x.titulo, link: x.link, fuente: x.fuente }))].slice(-30);
      const ent = sb.memoria.entregas && sb.memoria.entregas.fecha === fechaAR() ? sb.memoria.entregas : (sb.memoria.entregas = { fecha: fechaAR(), hechas: [] });
      const toca = entrega.filter(h => horaAR() >= h && !ent.hechas.includes(h));
      if (!toca.length) return { texto: `Guardé ${sb.memoria.bandeja.length} novedades para la próxima entrega (${entrega.find(h => h > horaAR()) || entrega[0]}).`, enviar: false };
      ent.hechas.push(...toca);
      nuevos = sb.memoria.bandeja.slice(-(b.receta.max || 8)); sb.memoria.bandeja = [];
    } else if (resumen && sb.memoria.bandeja && sb.memoria.bandeja.length) { nuevos = [...sb.memoria.bandeja, ...nuevos].slice(-(b.receta.max || 8)); sb.memoria.bandeja = []; }
    if (!nuevos.length) return { texto: "Sin novedades desde la última vez.", enviar: false };
    return { texto: `${areaDe(b).icono} ${b.nombre}\n\n` + nuevos.map(x => `• ${x.titulo}${x.fuente ? " (" + x.fuente + ")" : ""}\n  ${x.link}`).join("\n"), html: `<b>${escHTML(areaDe(b).icono + " " + b.nombre)}</b>\n\n` + nuevos.map(x => `• <a href="${escHTML(x.link)}">${escHTML(x.titulo)}</a>${x.fuente ? " <i>(" + escHTML(x.fuente) + ")</i>" : ""}`).join("\n\n"), enviar: true };
  },
  async clima(b, sb, { resumen } = {}) {
    const u = CFG.ubicacion; const url = `${URLS.clima}?latitude=${u.lat}&longitude=${u.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&timezone=America%2FArgentina%2FCordoba&forecast_days=3`;
    const r = await traer(url); if (!r.ok) throw new Error("open-meteo respondió " + r.status); const d = (await r.json()).daily;
    const nom = ["Hoy", "Mañana", "Pasado"]; const avisos = [];
    const lineas = d.time.map((t, i) => { const ll = d.precipitation_probability_max[i]; const v = d.wind_speed_10m_max[i]; if (ll >= 60 && d.precipitation_sum[i] >= 2) avisos.push(`${nom[i]}: ${ll}% de lluvia (${d.precipitation_sum[i]} mm)`); if (v >= 40) avisos.push(`${nom[i]}: viento fuerte (${Math.round(v)} km/h)`); return `• ${nom[i]} ${t.slice(8, 10)}/${t.slice(5, 7)}: ${Math.round(d.temperature_2m_min[i])}° a ${Math.round(d.temperature_2m_max[i])}° · lluvia ${ll}% · viento ${Math.round(v)} km/h`; });
    const texto = `🌤️ Clima en ${u.lugar}\n${lineas.join("\n")}${avisos.length ? "\n\n⚠️ Para la obra:\n" + avisos.join("\n") : "\n\n✅ Sin lluvias fuertes ni viento para la obra."}\n\nFuente: open-meteo.com`;
    const clave = avisos.join("|");
    if (resumen) { sb.memoria.ultimoAviso = clave; return { texto, enviar: true }; }
    if (clave && clave !== sb.memoria.ultimoAviso) { sb.memoria.ultimoAviso = clave; return { texto: "⚠️ Cambió el pronóstico para la obra\n\n" + texto, enviar: true }; }
    return { texto, enviar: false };
  },
  async web_estado(b, sb) {
    const antes = sb.memoria.caidas || {}; const ahora = {}; const cambios = []; const lineas = [];
    for (const u of b.receta.urls || []) { let ok = false, det = ""; try { const r = await traer(u, {}, 20000); ok = r.status < 500 && r.status !== 404; det = String(r.status); /* 401/403 = la página responde pero protege contra robots: está viva */ } catch (e) { det = e.name === "AbortError" ? "no responde" : "error de conexión"; } ahora[u] = !ok; lineas.push(`${ok ? "✅" : "❌"} ${u} (${det})`); if (!ok && !antes[u]) cambios.push(`❌ Se cayó: ${u} (${det})`); if (ok && antes[u]) cambios.push(`✅ Volvió: ${u}`); }
    sb.memoria.caidas = ahora;
    return { texto: lineas.join("\n"), enviar: cambios.length > 0, alerta: cambios.join("\n") };
  },
  async celu_informe(b, sb) {
    const e = await buzon("/oficina/celu"); return { texto: "🧾 Informe del día del celu bot\n\n" + textoCelu(e) + "\n\n" + textoPlan(e), enviar: true };
  },
  async recordatorio(b) { return { texto: `⏰ ${b.receta.texto || b.mision}`, enviar: true }; },
  // pregunta: te pregunta a horario fijo (sin IA). Lo que respondas se anota en su registro privado.
  async pregunta(b, sb, { hora } = {}) {
    const ps = b.receta.preguntas || {}; const hs = Object.keys(ps).sort(); const h = hora && ps[hora] ? hora : (hs.filter(x => x <= horaAR()).pop() || hs[0]);
    let t = ps[h] || b.receta.texto || b.mision;
    if (b.receta.registro === "comidas" && h === hs[hs.length - 1]) t += `\n\n📋 Hoy anotaste:\n${listaComidas(1)}`;
    if (b.receta.registro === "ejercicio" && diaAR() === 0) t += `\n\n${resumenEjercicio(7)}`;
    return { texto: `${t}\n\n(Respondé este mensaje y lo anoto.)`, enviar: true };
  },
  // servicios: vencimientos de los servicios de la casa (sin IA)
  async servicios(b, sb) {
    const lista = leerPriv("servicios", []); const mes = fechaAR().slice(0, 7); const dia = Number(fechaAR().slice(8, 10));
    if (!lista.length) { if (sb.memoria.instruido) return { texto: "Todavía no cargaste servicios.", enviar: false }; sb.memoria.instruido = true; return { texto: "🏠 Gastos de la casa\nTodavía no me cargaste los servicios. Mandame uno por mensaje, así:\n• servicio luz vence 10 35000\n• servicio internet vence 15 18000\n• servicio alquiler vence 5\nY cuando pagues: «pagué luz 34800». Yo te aviso antes de cada vencimiento.", enviar: true }; }
    const pend = lista.filter(x => !(x.pagos || {})[mes]);
    const vencidos = pend.filter(x => x.dia < dia), proximos = pend.filter(x => x.dia >= dia && x.dia - dia <= 3);
    const pagados = lista.filter(x => (x.pagos || {})[mes]);
    const texto = `🏠 Servicios de la casa · ${mes.slice(5)}/${mes.slice(0, 4)}\n${vencidos.length ? "🔴 Vencidos sin pagar:\n" + vencidos.map(x => `  • ${x.nombre} (vencía el ${x.dia})${x.monto ? " ~" + pesos(x.monto) : ""}`).join("\n") + "\n" : ""}${proximos.length ? "🟡 Vencen pronto:\n" + proximos.map(x => `  • ${x.nombre}: ${x.dia === dia ? "HOY" : "el " + x.dia}${x.monto ? " ~" + pesos(x.monto) : ""}`).join("\n") + "\n" : ""}✅ Pagados: ${pagados.map(x => `${x.nombre} ${pesos(x.pagos[mes])}`).join(", ") || "ninguno"}\n⏳ Pendientes este mes: ${pend.map(x => `${x.nombre} (${x.dia})`).join(", ") || "nada"}\n\nCuando pagues: «pagué ${(pend[0] || lista[0]).nombre} 25000».`;
    return { texto, enviar: dia === 1 || vencidos.length > 0 || proximos.length > 0 };
  },
  // gastos: resumen de tus gastos personales (sin IA). Domingo: semana. Día 1: el mes anterior.
  async gastos(b, sb, { resumen } = {}) {
    const hoy = fechaAR(); const d = Number(hoy.slice(8, 10));
    if (d === 1) { const prev = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7); return { texto: resumenGastos(prev + "-01", prev + "-31", `Gastos de ${prev.slice(5)}/${prev.slice(0, 4)}`), enviar: true }; }
    if (diaAR() === 0) return { texto: resumenGastos(fechaAR(new Date(NOW - 6 * 86400e3)), hoy, "Gastos de la semana"), enviar: true };
    return { texto: resumenGastos(hoy.slice(0, 8) + "01", hoy, "Gastos del mes hasta hoy"), enviar: false };
  },
  async salud() {
    const l = []; const fallaron = bots().filter(x => est.bots[x.id]?.estado === "falló"); const pausados = bots().filter(x => est.bots[x.id]?.pausado);
    const ext = bots().filter(x => x.tipo === "externo").map(x => ({ b: x, hb: leer(path.join(DATA, "externos", x.id + ".json"), null) }));
    l.push(`🛠️ Salud de la oficina · ${fechaAR()}`);
    l.push(`Bots: ${bots().length} · trabajaron hoy: ${bots().filter(x => est.bots[x.id]?.ultimaFecha === fechaAR()).length}`);
    if (fallaron.length) l.push("❌ Fallaron: " + fallaron.map(x => `${x.nombre} (${(est.bots[x.id].resumen || "").replace(/^Falló: /, "").slice(0, 60)})`).join("; "));
    if (pausados.length) l.push("⏸ En pausa: " + pausados.map(x => x.nombre).join(", ") + ". Para reactivar: «activar ID».");
    for (const { b: x, hb } of ext) l.push(x.id === "celular_bot" && est.bots[x.id].memoria.celu ? `📱 ${x.nombre}: última señal ${new Date(est.bots[x.id].memoria.celu.t).toLocaleString("es-AR", { timeZone: "America/Argentina/Cordoba" })} (por el buzón)` : hb ? `📱 ${x.nombre}: última señal ${new Date(hb.t).toLocaleString("es-AR", { timeZone: "America/Argentina/Cordoba" })} (${hb.estado})` : `📱 ${x.nombre}: todavía no está conectado al buzón.`);
    l.push(`🤖 IA hoy: ${est.consumo.consultas} consultas (${est.consumo.busquedas} con búsqueda) · ${Object.entries(est.consumo.por).map(([k, v]) => `${k}: ${v}`).join(", ") || "ninguna"}`);
    l.push(`🔌 IA conectadas: ${PROV.length ? [...new Set(PROV.map(p => p.nombre))].join(", ") : "ninguna"}`);
    if (!fallaron.length && !pausados.length) l.push("✅ Todo en orden.");
    return { texto: l.join("\n"), enviar: true };
  }
};

/* ---------- trabajo de un bot ---------- */
const FLECC = id => path.join(DATA, "lecciones", id + ".md");
const FFEED = id => path.join(DATA, "feedback", id + ".json");
const leerFeed = b => b.privado ? leerPrivSeguro("feed_" + b.id, []) : leer(FFEED(b.id), []);
const guardarFeed = (b, v) => b.privado ? escribirPriv("feed_" + b.id, v) : escribir(FFEED(b.id), v);
const leerLecc = b => b.privado ? leerPrivSeguro("lecc_" + b.id, "") : (fs.existsSync(FLECC(b.id)) ? fs.readFileSync(FLECC(b.id), "utf8") : "");
const guardarLecc = (b, t) => b.privado ? escribirPriv("lecc_" + b.id, t) : escribir(FLECC(b.id), t);
function registrosDe(b) { return (b.registros || []).map(id => { const r = leerPrivSeguro(id, []).filter(x => x.t >= hace(14)); return r.length ? `${id.toUpperCase()} (últimos 14 días):\n` + r.slice(-80).map(x => `${x.f} ${x.h} ${x.momento ? x.momento + ": " : ""}${x.texto}${x.monto ? " " + pesos(x.monto) : ""}`).join("\n") : `${id.toUpperCase()}: todavía no hay nada anotado.`; }).join("\n\n"); }
function promptBot(b, orden, critica) {
  const lecc = leerLecc(b).trim(); const reg = registrosDe(b);
  return `Sos "${b.nombre}", empleado de la ${CFG.oficina} (área ${areaDe(b).nombre}). Tu ÚNICA tarea es esta y tenés que hacerla muy bien.
SOBRE TU JEFE: ${CFG.contexto}
HOY ES: ${DIAS[diaAR()]} ${fechaAR()}, ${horaAR()} hs (Argentina).
TU MISIÓN: ${b.mision}
QUÉ ENTREGAR: ${b.entregable || "Un resultado concreto y listo para usar."}
CÓMO TE EVALÚAN: ${(b.criterios || ["Concreto", "Útil", "Sin relleno"]).join("; ")}.
${orden ? `\nORDEN ESPECIAL DE TU JEFE (tiene prioridad): ${orden}\n` : ""}${reg ? `\nLO QUE TU JEFE FUE ANOTANDO (usalo, es real):\n${reg.slice(0, 7000)}\n` : ""}${lecc ? `\nLO QUE APRENDISTE (aplicalo siempre):\n${lecc}\n` : ""}${critica ? `\nEL CONTROL DE CALIDAD RECHAZÓ TU VERSIÓN ANTERIOR POR ESTO, CORREGILO:\n${critica}\n` : ""}
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
async function trabajar(b, { orden = "", origen = "agenda", resumen = false, hora = null, foto = null } = {}) {
  const sb = est.bots[b.id] ||= nuevoBot();
  sb.estado = "trabajando"; sb.ultimaCorrida = NOW.toISOString();
  try {
    if (b.tipo === "codigo") {
      const fn = RECETAS[(b.receta || {}).tipo]; if (!fn) throw new Error("receta desconocida: " + (b.receta || {}).tipo);
      const r = await fn(b, sb, { resumen: resumen || origen !== "agenda" || !b.horario.cada, hora });
      sb.memoria.ultimoChequeo = NOW.toISOString();
      const mandar = r.enviar || origen !== "agenda";
      if (mandar) { if (b.privado) { sb.informe = null; sb.resumen = "🔒 Privado: te lo mandó por Telegram."; } else { const rel = guardarInforme(b, r.alerta ? r.alerta + "\n\n" + r.texto : r.texto, "\n---\n_Bot sin IA (código): no gasta cupo._\n", orden); sb.informe = rel; sb.resumen = limpiar(r.alerta || r.texto).slice(0, 220); } if (r.html) await enviar(r.html, b.id, { html: true }); else await enviar(r.alerta ? `${r.alerta}\n\n${r.texto}` : r.texto, b.id); log(b.nombre, "entregó (sin IA)"); }
      else { sb.resumen = b.privado ? "🔒 Privado" : (sb.resumen || limpiar(r.texto).slice(0, 220)); }
      Object.assign(sb, { estado: "listo", corridas: sb.corridas + 1, fallasSeguidas: 0, puntaje: null });
      if (!b.horario.cada || resumen) sb.ultimaFecha = fechaAR();
      if (b.horario.cada && resumen) sb.memoria.resumenFecha = fechaAR();
      return true;
    }
    log(b.nombre, orden ? (b.privado ? "empezó tu orden (privada)" : `empezó la orden: ${orden}`) : "empezó su tarea");
    let mejor = null, critica = ""; const imagen = foto ? await bajarFoto(foto) : null;
    for (let intento = 1; intento <= 2; intento++) {
      const r = await ia(promptBot(b, orden, critica) + (imagen ? "\n\nTU JEFE TE MANDÓ UNA FOTO: mirala con atención y basá tu respuesta en lo que ves." : ""), { buscar: !!b.buscar && !imagen, imagen });
      let ev; try { ev = await evaluar(b, r.texto, r.fuentes); } catch (e) { ev = { puntaje: 6, problemas: ["no se pudo evaluar: " + e.message], mejorar: "" }; }
      if (!mejor || ev.puntaje > mejor.ev.puntaje) mejor = { ...r, ev };
      log("Control de calidad", `${b.nombre}: ${ev.puntaje}/10${ev.problemas[0] ? " · " + ev.problemas[0] : ""}`);
      if (ev.puntaje >= 7) break;
      critica = [...ev.problemas, ev.mejorar].filter(Boolean).join("\n- ");
      if (intento === 1) log(b.nombre, "lo mandaron a rehacer");
    }
    const rel = b.privado ? null : guardarInforme(b, mejor.texto, `\n---\n**Control de calidad:** ${mejor.ev.puntaje}/10${mejor.ev.problemas.length ? "\n- " + mejor.ev.problemas.join("\n- ") : ""}\n\n**IA usada:** ${mejor.modelo}\n${b.buscar ? "\n**Fuentes verificadas:**\n" + (mejor.fuentes.length ? mejor.fuentes.slice(0, 10).map(f => `- [${f.titulo}](${f.url})`).join("\n") : "- (el buscador no devolvió fuentes)") : ""}\n`, orden);
    const feed = leerFeed(b); feed.push({ t: NOW.toISOString(), tipo: "calidad", puntaje: mejor.ev.puntaje, problemas: mejor.ev.problemas, mejorar: mejor.ev.mejorar }); guardarFeed(b, feed.slice(-40));
    Object.assign(sb, { estado: "listo", corridas: sb.corridas + 1, fallasSeguidas: 0, puntaje: mejor.ev.puntaje, resumen: b.privado ? "🔒 Privado: te lo mandó por Telegram." : limpiar(mejor.texto).slice(0, 220), informe: rel, modelo: mejor.modelo });
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
const horarioTxt = b => { const h = b.horario || {}; if (b.tipo === "externo") return "trabaja en el celular"; if (h.apedido) return "a pedido (solo cuando se lo pedís)"; const d = !h.dias || h.dias === "todos" ? "todos los días" : h.dias.map(x => DIAS3[x]).join(", "); return h.horas ? `${d} a las ${h.horas.join(", ")}` : h.cada ? `${d}, cada ${h.cada} min de ${h.desde} a ${h.hasta}${h.resumen ? ` (resumen ${h.resumen})` : ""}` : `${d} ${h.hora}`; };
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
• celu ... — órdenes al celu bot: «celu programa de hoy», «celu subí una historia», «celu pausa», «celu seguí», «celu reiniciar», «celu informe», «celu» (cómo anda).
• Respondé un informe con 👍, 👎 o un comentario: ese bot se entrena con eso esa noche.

📒 Anotar (sin IA, privado):
• «desayuné café con tostadas», «almorcé milanesa» — tus comidas.
• «caminé 40 minutos», «hice pesas», «no entrené» — tu actividad.
• «gasté 5000 en nafta» — gasto personal. «pagué luz 34800» — servicio de la casa.
• «servicio luz vence 10 35000» — te aviso antes de cada vencimiento.
• gastos · gastos semana · servicios · comidas · comidas semana · ejercicio · borrar último gasto
• 📸 Foto de un ticket con la palabra «comprobante»: lo leo y lo anoto. Otra foto tuya: el asesor de imagen te da su opinión.
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
async function bajarFoto(fileId) {
  const f = await tg("getFile", { file_id: fileId }); if (!f || !f.file_path) throw new Error("no pude bajar la foto de Telegram");
  const r = await traer(`${URLS.tg}/file/bot${TG_TOKEN}/${f.file_path}`, {}, 60000); if (!r.ok) throw new Error("Telegram no dio la foto (" + r.status + ")");
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64"); return { mime: /\.png$/i.test(f.file_path) ? "image/png" : "image/jpeg", b64 }; // la foto NO se guarda en ningún lado
}
function pagarServicio(nombre, monto, detalle) {
  const lista = leerPriv("servicios", []); const q = slug(nombre); const mes = fechaAR().slice(0, 7);
  const sv = lista.find(x => slug(x.nombre) === q || q.includes(slug(x.nombre)) || slug(x.nombre).includes(q));
  if (sv) { sv.pagos ||= {}; sv.pagos[mes] = monto || sv.monto || 0; escribirPriv("servicios", lista); }
  const nom = sv ? sv.nombre : nombre;
  if (monto) { const r = leerPriv("pagos_casa", []); r.push({ t: NOW.toISOString(), f: fechaAR(), h: horaAR(), servicio: nom, monto, detalle }); escribirPriv("pagos_casa", r.slice(-2000)); }
  return { nom, conocido: !!sv };
}
async function leerComprobante(p) {
  const imagen = await bajarFoto(p.foto);
  const r = await ia(`Es la foto de un comprobante de gasto de Argentina (ticket, factura, transferencia o recibo).${p.orden ? " Nota del dueño: " + p.orden : ""}
Respondé SOLO un JSON: {"monto": total en pesos como número sin símbolos ni puntos de miles, "comercio": "nombre del comercio o empresa", "fecha": "AAAA-MM-DD o vacío", "detalle": "qué se pagó o compró en pocas palabras", "servicio": "si es una factura de un servicio de la casa (luz, gas, agua, internet, alquiler, expensas, tasas, seguro, prepaga), cuál; si no, vacío"}`, { json: true, imagen });
  const j = parsearJSON(r.texto) || {}; const monto = typeof j.monto === "number" ? j.monto : leerMonto(String(j.monto || ""));
  if (!(monto > 0)) { await enviar("🧾 No pude leer el monto del comprobante. Mandámelo escrito, así: «gasté 5000 en nafta»."); return; }
  const det = [j.detalle, j.comercio].filter(Boolean).join(" · ") || "comprobante";
  if (j.servicio) { const { nom } = pagarServicio(String(j.servicio), monto, det); await enviar(`🏠 Leí la factura y la anoté como pago de ${nom}: ${pesos(monto)} (${det}).\nSi está mal, escribí «borrar último gasto».`); }
  else { const cat = categoria(det + " " + (p.orden || "")); anotar("gastos", { texto: det, monto, cat, origen: "comprobante" }); await enviar(`🧾 Leí el comprobante y lo anoté: ${pesos(monto)} · ${det} · ${cat}.\nSi está mal, escribí «borrar último gasto».`); }
  log("Contaduría", "anotó un comprobante (privado)");
}
const MOMENTO = () => { const h = horaAR(); return h < "11:00" ? "desayuno" : h < "15:30" ? "almuerzo" : h < "19:30" ? "merienda" : "cena"; };
const RX_COMIDA = /^(desayun|almorc|almuerzo|merend|merienda|cen[eé]\b|cena\b|com[ií]\b|tom[eé]\b|picote|comida:)/i;
const RX_EJER = /^(camin[eé]|corr[ií]|trot[eé]|entren[eé]|hice\s+(ejercicio|gimnasio|gym|pesas|abdominales|flexiones|cardio|bici|rutina)|fui\s+al\s+(gym|gimnasio|club)|nad[eé]|anduve en bici|no\s+(hice|entren[eé]|camin[eé])|ejercicio:)/i;
const RX_GASTO = /^(gast[eé]|gasto\b|compr[eé]|pagu[eé]|pago\b)/i;
// Anotaciones SIN IA: comidas, ejercicio, gastos y servicios. Devuelve true si lo manejó.
async function registrar(txt, desdeBot) {
  const reg = desdeBot && desdeBot.receta && desdeBot.receta.registro; let mm;
  if (reg === "comidas" || (!desdeBot && RX_COMIDA.test(txt))) { const mo = (txt.match(/^(desayun|almorc|almuerzo|merend|merienda|cen)/i) || [])[1]; const momento = mo ? { desayun: "desayuno", almorc: "almuerzo", almuerzo: "almuerzo", merend: "merienda", merienda: "merienda", cen: "cena" }[mo.toLowerCase()] : MOMENTO(); anotar("comidas", { texto: txt.slice(0, 400), momento }); await enviar(`🍽️ Anotado (${momento}). El nutricionista lo usa cuando le pidas consejo.`); return true; }
  if (reg === "ejercicio" || (!desdeBot && RX_EJER.test(txt))) { const hizo = !/^(no\b|nada|hoy no|ni\b)/i.test(txt); anotar("ejercicio", { texto: txt.slice(0, 400), hizo }); const sem = new Set(leerPriv("ejercicio", []).filter(x => x.hizo && x.t >= hace(7)).map(x => x.f)).size; await enviar(hizo ? `💪 ¡Bien! Anotado. Esta semana llevás ${sem} día(s) activo(s).` : `📝 Anotado. Mañana arrancamos: aunque sea 20 minutos de caminata.`); return true; }
  if ((mm = txt.match(/^servicio\s+(.+?)\s+vence\s+(?:el\s+)?(?:d[ií]a\s+)?(\d{1,2})\b\s*(.*)$/i))) { const lista = leerPriv("servicios", []); const nombre = mm[1].trim().slice(0, 30); const ant = lista.find(x => slug(x.nombre) === slug(nombre)); const monto = leerMonto(mm[3]); if (ant) Object.assign(ant, { dia: Number(mm[2]), monto: monto || ant.monto }); else lista.push({ nombre, dia: Number(mm[2]), monto, pagos: {} }); escribirPriv("servicios", lista); await enviar(`🏠 ${ant ? "Actualicé" : "Agregué"} ${nombre}: vence el ${mm[2]} de cada mes${monto ? ", aprox. " + pesos(monto) : ""}. Te aviso 3 días antes.`); return true; }
  if ((mm = txt.match(/^(?:borrar|quitar|sacar)\s+servicio\s+(.+)$/i))) { const lista = leerPriv("servicios", []); const n = lista.length; const q = slug(mm[1]); escribirPriv("servicios", lista.filter(x => slug(x.nombre) !== q)); await enviar(n !== lista.filter(x => slug(x.nombre) !== q).length ? "🗑️ Listo, lo saqué." : "No encontré ese servicio. Escribí «servicios»."); return true; }
  if (/^(mis\s+)?servicios$/i.test(txt)) { const r = await RECETAS.servicios(botPorId("gastos_casa") || {}, { memoria: {} }); await enviar(r.texto); return true; }
  if (/^(mis\s+)?gastos(\s+del\s+mes)?$|^resumen\s+(de\s+)?gastos$/i.test(txt)) { await enviar(resumenGastos(fechaAR().slice(0, 8) + "01", fechaAR(), "Gastos del mes hasta hoy")); return true; }
  if (/^gastos\s+(de\s+la\s+)?semana$/i.test(txt)) { await enviar(resumenGastos(fechaAR(new Date(NOW - 6 * 86400e3)), fechaAR(), "Gastos de la semana")); return true; }
  if (/^borrar\s+(el\s+)?[uú]ltimo\s+gasto$/i.test(txt)) { const g = leerPriv("gastos", []), c = leerPriv("pagos_casa", []); const ug = g[g.length - 1], uc = c[c.length - 1]; if (!ug && !uc) { await enviar("No hay gastos para borrar."); return true; } if (!uc || (ug && ug.t > uc.t)) { g.pop(); escribirPriv("gastos", g); await enviar(`🗑️ Borré: ${pesos(ug.monto)} · ${ug.texto}`); } else { c.pop(); escribirPriv("pagos_casa", c); const lista = leerPriv("servicios", []); const sv = lista.find(x => x.nombre === uc.servicio); if (sv && sv.pagos) { delete sv.pagos[uc.f.slice(0, 7)]; escribirPriv("servicios", lista); } await enviar(`🗑️ Borré el pago de ${uc.servicio}: ${pesos(uc.monto)}`); } return true; }
  if (/^(qu[eé]\s+com[ií](\s+hoy)?|comidas(\s+de)?\s+hoy|mis\s+comidas|comidas)$/i.test(txt)) { await enviar(`🍽️ Hoy anotaste:\n${listaComidas(1)}`); return true; }
  if (/^comidas(\s+de\s+la)?\s+semana$/i.test(txt)) { await enviar(`🍽️ Últimos 7 días:\n${listaComidas(7)}`); return true; }
  if (/^(mi\s+)?(ejercicio|actividad)(\s+(de\s+la\s+)?semana)?$/i.test(txt)) { await enviar(resumenEjercicio(7)); return true; }
  if (reg === "gastos" || reg === "casa" || (!desdeBot && RX_GASTO.test(txt))) {
    const monto = leerMonto(txt); if (!monto) { await enviar("💸 No vi el monto. Mandámelo así: «gasté 5000 en nafta» o «pagué luz 34800»."); return true; }
    const det = txt.replace(RX_GASTO, "").replace(/\$?\s*\d[\d.,]*\s*(k|mil|lucas?)?/i, "").replace(/^\s*(en|de|la|el|por)\s+/i, "").trim() || "sin detalle";
    if (reg === "casa" || RX_SERV.test(txt)) { const serv = (txt.match(RX_SERV) || [det])[0]; const { nom, conocido } = pagarServicio(serv, monto, det); await enviar(`🏠 Pago de ${nom} anotado: ${pesos(monto)}.${conocido ? "" : `\n(Para que te avise los vencimientos: «servicio ${nom} vence 10».)`}`); return true; }
    const cat = categoria(det); anotar("gastos", { texto: det.slice(0, 200), monto, cat }); const mes = leerPriv("gastos", []).filter(x => x.f.slice(0, 7) === fechaAR().slice(0, 7)).reduce((a, x) => a + x.monto, 0);
    await enviar(`💸 Anotado: ${pesos(monto)} · ${det} · ${cat}\nEn el mes llevás ${pesos(mes)} en gastos personales.`); return true;
  }
  return false;
}
// Varias anotaciones juntas («gasté 5000 en nafta, 3000 en súper y 1200 en pan»): una por renglón o separadas por coma / «y».
async function registrarLote(txt, b) {
  const reg = b.receta.registro; let partes = String(txt).split(/\n|;|,(?!\d{3}\b)|\s+y\s+(?=[^\n]*\d)/i).map(s => s.trim()).filter(Boolean);
  if (reg === "gastos" || reg === "casa") { const pref = (String(txt).match(/^(gast[eé]|gasto|compr[eé]|pagu[eé])/i) || [""])[0]; partes = partes.filter(s => leerMonto(s)).map(s => /^(gast|compr|pagu|pago)/i.test(s) || !pref ? s : pref + " " + s); }
  let n = 0; for (const s of partes) { try { if (await registrar(s, b)) n++; } catch (e) { log(b.nombre, "no pude anotar: " + e.message); } }
  return n;
}
async function procesarMensajes() {
  if (!TG_TOKEN) return;
  let ups = await tg("getUpdates", { offset: est.tgOffset, timeout: 0, allowed_updates: ["message", "edited_message"] });
  if (ups === null) {
    const info = await tg("getWebhookInfo", {});
    log("Mesa de entrada", `Telegram no entregó mensajes (${tg.error || "sin detalle"})${info && info.url ? " · tenía un webhook: " + info.url : ""}`);
    if (info && info.url) { await tg("deleteWebhook", { drop_pending_updates: false }); ups = await tg("getUpdates", { offset: est.tgOffset, timeout: 0 }); }
  }
  ups = ups || []; const reales = ups.length;
  if (BUZON && PIN) { try { const w = await buzon("/oficina/gerente?sacar=1"); for (const o of w.ordenes || []) ups.push({ update_id: null, web: true, message: { chat: { id: est.dueno, type: "private" }, text: o.texto } }); if ((w.ordenes || []).length) log("Mesa de entrada", `llegaron ${w.ordenes.length} órdenes desde la página`); } catch (e) { if (!/no está instalado/.test(e.message)) log("Mesa de entrada", "no pude leer el buzón: " + e.message); } }
  log("Mesa de entrada", ups.length ? `llegaron ${ups.length} mensajes de Telegram` : `sin mensajes nuevos${est.dueno ? "" : " (todavía no hay dueño vinculado: mandale cualquier mensaje al bot)"}`);
  for (const u of ups) {
    if (u.update_id != null) est.tgOffset = u.update_id + 1;
    const m = u.message || u.edited_message; if (!m || (!m.text && !m.photo)) continue;
    const chat = m.chat.id; const txt = (m.text || m.caption || "").trim();
    if (!est.dueno) { if (m.chat.type === "private") { est.dueno = chat; log("Gerente general", `quedó vinculado el Telegram de ${m.from && m.from.first_name || "el dueño"}`); await enviar(`✅ Listo, ${m.from && m.from.first_name || "jefe"}: quedaste como dueño de la oficina. Solo te obedezco a vos.\n\n${AYUDA()}`); } continue; }
    if (chat !== est.dueno) continue;
    const resp = m.reply_to_message && est.mensajes[m.reply_to_message.message_id];
    if (m.photo) {
      const foto = m.photo[m.photo.length - 1].file_id; const rb = resp && botPorId(resp);
      if ((rb && /gastos|casa/.test(rb.receta?.registro || "")) || /(comprobante|ticket|factura|recibo|gast|pagu|compr|transferencia)/i.test(txt)) { est.pendientes.push({ tipo: "comprobante", foto, orden: txt.slice(0, 300), t: NOW.toISOString() }); await enviar("🧾 Recibí el comprobante. Lo leo y lo anoto en la próxima vuelta (usa 1 consulta de IA)."); }
      else { const destino = rb && rb.tipo === "ia" ? rb : /(comida|plato|com[ií]|almuerzo|cena|desayuno|merienda|dieta)/i.test(txt) ? botPorId("nutricionista") : botPorId("asesor_imagen"); if (!destino) { await enviar("No tengo un bot para fotos ahora."); continue; } est.pendientes.push({ bot: destino.id, orden: txt.slice(0, 300) || "Mirá esta foto y decime qué mejorar.", foto, t: NOW.toISOString(), origen: "orden" }); await enviar(`📸 Le paso la foto a ${destino.nombre}. Te contesta en la próxima vuelta.`); }
      log("Mesa de entrada", "llegó una foto (no se guarda)"); continue;
    }
    if (resp && botPorId(resp) && botPorId(resp).receta?.registro) { try { if (await registrar(txt, botPorId(resp))) continue; } catch (e) { await enviar("⚠️ No pude anotarlo: " + e.message); continue; } }
    if (/(gast|compr[eé]|pagu[eé]|pago\b)/i.test(txt) && (txt.match(/\d[\d.,]*/g) || []).length > 1 && botPorId("gastos_personales")) { try { const n = await registrarLote(txt, botPorId("gastos_personales")); if (n) { log("Contaduría", `anotó ${n} gastos (privado)`); continue; } } catch {} }
    try { if (await registrar(txt, null)) { log("Asistente personal", "anotó algo (privado)"); continue; } } catch (e) { await enviar("⚠️ No pude anotarlo: " + e.message); continue; }
    if (resp && botPorId(resp)) {
      const b = botPorId(resp); const sb = est.bots[b.id];
      const pos = /👍|bien|genial|excelente|perfecto|buenísimo|sirve|me gusta/i.test(txt), neg = /👎|mal|no sirve|inventad|viejo|equivocad|no me gusta/i.test(txt);
      if (pos) sb.likes++; if (neg) sb.dislikes++;
      const feed = leerFeed(b); feed.push({ t: NOW.toISOString(), tipo: "jefe", texto: txt.slice(0, 500), valor: pos ? 1 : neg ? -1 : 0 }); guardarFeed(b, feed.slice(-40));
      log("Jonathan", `opinó sobre ${b.nombre}: ${txt.slice(0, 80)}`); await enviar(`📝 Anotado para ${b.nombre}. Lo aplica desde el entrenamiento de esta noche.`); continue;
    }
    const low = txt.toLowerCase().replace(/^\//, "").trim(); let mm;
    if ((mm = txt.match(RX_CELU)) || RX_CELU_AUTO.test(txt)) { try { await ordenCelu(mm ? mm[1] : txt); } catch (e) { await enviar("📱 No pude hablar con el celu: " + e.message); } continue; }
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
    log("Jonathan", "mandó una orden por Telegram");
  }
  // le confirmo a Telegram que ya los leí (si no, el despertador cree que siguen sin atender)
  if (reales) await tg("getUpdates", { offset: est.tgOffset, limit: 1, timeout: 0 });
}
async function repartir(p) {
  const g = est.bots.gerente; g.estado = "trabajando";
  const lista = bots().filter(b => b.tipo !== "externo" || (b.id === "celular_bot" && BUZON && PIN)).map(b => `- ${b.id}: ${b.nombre} (${areaDe(b).nombre}, ${tipoTxt(b)}) — ${b.mision}`).join("\n");
  const r = await ia(`Sos el Gerente general de una oficina de bots. Tu jefe ordenó: "${p.orden}"
Empleados:\n${lista}
Elegí el empleado que mejor la cumple. Si ninguno encaja, elegí "gerente" (la hacés vos).
Respondé SOLO un JSON: {"bot":"id o gerente","instruccion":"la orden clara para ese empleado","aviso":"frase corta para el jefe diciendo a quién se la pasaste","buscar":true si hace falta buscar en internet}`, { json: true });
  const j = parsearJSON(r.texto) || {}; const b = botPorId(j.bot);
  if (b && b.id === "celular_bot") { await ordenCelu(j.instruccion || p.orden); g.estado = "listo"; return; }
  if (b && b.tipo === "codigo" && b.receta && b.receta.registro) { const n = await registrarLote(p.orden, b); if (n) { log("Gerente general", `le pasó ${n} anotaciones a ${b.nombre}`); g.estado = "listo"; return; } }
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
    g.resumen = "Respondió una orden tuya";
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
    const rec = leerFeed(b).filter(x => new Date(x.t).getTime() > Date.now() - 8 * 86400e3); if (!rec.length) continue;
    const actuales = leerLecc(b) || "(todavía ninguna)";
    try {
      const r = await ia(`Sos el entrenador de "${b.nombre}", un bot cuya tarea es: ${b.mision}\nEntregable: ${b.entregable}\nSUS LECCIONES ACTUALES:\n${actuales}\nNOTAS RECIENTES (las del jefe valen el doble):\n${rec.map(x => x.tipo === "jefe" ? `JEFE (${x.valor > 0 ? "positivo" : x.valor < 0 ? "negativo" : "comentario"}): ${x.texto}` : `CALIDAD ${x.puntaje}/10: ${(x.problemas || []).join("; ")} → ${x.mejorar}`).join("\n").slice(0, 6000)}\nReescribí sus lecciones: máximo 8 viñetas cortas y accionables (qué hacer y qué evitar), conservando las que sirven. Respondé SOLO las viñetas empezando con "- ".`);
      const nuevas = r.texto.split("\n").map(s => s.trim()).filter(s => /^[-•*]/.test(s)).map(s => "- " + s.replace(/^[-•*]\s*/, "")).slice(0, 8).join("\n");
      if (nuevas) { guardarLecc(b, nuevas + "\n"); est.bots[b.id].nivel++; aprendieron.push(b.nombre); log("Entrenador", `${b.nombre} subió a nivel ${est.bots[b.id].nivel}`); }
    } catch (e) { log("Entrenador", `${b.nombre}: no pude entrenarlo (${e.message})`); if (e.cupo) break; }
  }
  if (aprendieron.length) await enviar(`🎓 Entrenamiento: ${aprendieron.join(", ")} aprendieron de sus notas y mañana trabajan mejor.`);
}
async function revisarExternos() {
  for (const b of bots().filter(x => x.tipo === "externo")) {
    const sb = est.bots[b.id]; let hb = leer(path.join(DATA, "externos", b.id + ".json"), null);
    if (b.id === "celular_bot" && BUZON && PIN) { try { const e = await buzon("/oficina/celu"); if (e.estado) { hb = { t: new Date(e.estado.t).toISOString(), estado: e.estado.estado && e.estado.estado.bot_vivo === false && !e.estado.estado.pausa ? "error" : "ok", detalle: textoCelu(e).split("\n").slice(0, 3).join(" · ").slice(0, 200) }; sb.memoria.celu = { t: e.estado.t, redes_hoy: (e.estado.estado || {}).redes_hoy || {} }; } } catch (e) { log("Redes sociales", "no pude leer el buzón del celu: " + e.message); } }
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
  if (h.horas) { const ent = s.memoria.horas && s.memoria.horas.fecha === fechaAR() ? s.memoria.horas : (s.memoria.horas = { fecha: fechaAR(), hechas: s.memoria.horas ? [] : h.horas.filter(x => x < hh) }); /* la primera vez no repite las que ya pasaron */ const pend = h.horas.filter(x => hh >= x && !ent.hechas.includes(x)); if (!pend.length) return null; ent.hechas.push(...pend); return { resumen: false, hora: pend[pend.length - 1] }; }
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
  if (!est.pendientes.length) est.pendientes = leerPrivSeguro("pendientes", []);
  { const viejas = est.pendientes.filter(p => p.t && NOW - new Date(p.t) > 6 * 3600e3); if (viejas.length) { est.pendientes = est.pendientes.filter(p => !viejas.includes(p)); log("Gerente general", `descartó ${viejas.length} órdenes viejas que esperaban IA`); await enviar(`🗑️ Descarté ${viejas.length} orden(es) de hace más de 6 horas que no se pudieron hacer por falta de IA: ${viejas.map(p => "«" + String(p.orden || p.bot || p.tipo).slice(0, 40) + "»").join(", ")}. Si todavía las necesitás, pedímelas de nuevo.`); } }
  await procesarMensajes();
  await avisarBuzonListo();
  await revisarExternos();
  if (MODO.startsWith("correr:")) est.pendientes.push({ bot: MODO.slice(7), orden: "", origen: "manual" });
  const quedan = [];
  for (const p of est.pendientes) {
    try {
      if (p.tipo === "comprobante") await leerComprobante(p);
      else if (p.tipo === "contratar") { const nb = await contratar(p.orden); if (p.pausa && nb) { est.bots[nb.id].pausado = true; await enviar(`⏸ «${nb.nombre}» queda en pausa hasta que escribas «activar ${nb.id}».`); } }
      else if (p.bot) { const b = botPorId(p.bot); if (b) { const ok = await trabajar(b, { orden: p.orden, origen: p.origen || "orden", foto: p.foto }); if (!ok && est.bots[b.id].estado === "postergado") quedan.push(p); } }
      else await repartir(p);
    } catch (e) { if (e.cupo) { quedan.push(p); log("Gerente general", "orden en espera por cupo: " + e.message); } else { log("Gerente general", "no pude con la orden: " + e.message); await enviar(`⚠️ No pude cumplir «${String(p.orden || p.bot).slice(0, 80)}»: ${e.message}`); } }
  }
  est.pendientes = quedan.slice(0, 30);
  if (MODO === "auto" || MODO === "todos" || MODO === "sinIA") {
    for (const b of bots()) {
      const t = MODO === "todos" ? (b.tipo !== "externo" && !est.bots[b.id].pausado ? { resumen: true } : null) : MODO === "sinIA" ? (b.tipo === "codigo" ? { resumen: true } : null) : toca(b);
      if (!t) continue;
      await trabajar(b, { origen: "agenda", resumen: t.resumen, hora: t.hora });
    }
  }
  if ((MODO === "auto" && horaAR() >= CFG.gerente.parteDiario && est.hechos.parte !== fechaAR()) || MODO === "parte") { est.hechos.parte = fechaAR(); try { await parteDiario(); } catch (e) { log("Gerente general", "parte: " + e.message); } }
  if ((MODO === "auto" && horaAR() >= CFG.gerente.entrenamiento && est.hechos.entrenamiento !== fechaAR()) || MODO === "entrenar") { est.hechos.entrenamiento = fechaAR(); await entrenar(); }
  est.bots.gerente.estado = est.pendientes.length ? "trabajando" : "esperando";
  est.actualizado = NOW.toISOString();
  escribirPriv("pendientes", est.pendientes); const pendPublicos = est.pendientes.length; est.pendientes = []; est.pendientesCant = pendPublicos;
  est.config = { telegram: !!TG_TOKEN, gemini: PROV.some(p => p.tipo === "gemini"), dueno: !!est.dueno, ias: [...new Set(PROV.map(p => p.nombre))] };
  escribir(FEST, est);
  escribir(path.join(DATA, "organigrama.json"), { oficina: CFG.oficina, dueno: CFG.dueno, gerente: CFG.gerente, areas: CFG.areas, bots: CFG.bots.map(b => ({ ...b, tipoTxt: tipoTxt(b), horarioTxt: horarioTxt(b) })), limites: CFG.limites });
  console.log(`Listo. Consultas de IA en esta corrida: ${consultasCorrida}. Hoy: ${est.consumo.consultas}.`);
}
main().catch(e => { console.error(e); log("Oficina", "error general: " + e.message); est.actualizado = NOW.toISOString(); try { if (est.pendientes && est.pendientes.length) { escribirPriv("pendientes", est.pendientes); est.pendientes = []; } } catch {} escribir(FEST, est); });
