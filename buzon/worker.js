// Buzón de la Oficina Bosio (Cloudflare Worker + Durable Object, plan gratis, sin tarjeta).
// 1) Buzón del celu: habla EXACTAMENTE el protocolo del vigía (/celu/estado, /celu/ordenes, /celu/respuesta).
// 2) Buzón de la página: la oficina en github.io lee el celu y deja órdenes (con PIN).
// 3) Despertador: cada minuto, si le escribiste al bot de Telegram (o dejaste una orden en la página), despierta a la oficina en GitHub.
//    Además es el reloj fijo: si GitHub se atrasa con su vuelta de cada 30 minutos, la arranca él.
// Las claves (CELU_KEY, OFICINA_PIN, TELEGRAM_TOKEN, GH_TOKEN) son secretos de Cloudflare: nunca están en el código.
import { DurableObject } from "cloudflare:workers";

const MAX_CHAT = 400;
const json = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

export class Buzon extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url); const s = this.ctx.storage;
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const anotar = async (...es) => { const c = (await s.get("chat")) || []; let t = Date.now(); for (const e of es) c.push({ t: t++, ...e }); await s.put("chat", c.slice(-MAX_CHAT)); };
    switch (u.pathname) {
      case "/celu/estado":
        await s.put("estado", { t: Date.now(), estado: body.estado || {}, diagnostico: body.diagnostico || {}, cripto: body.cripto || {} });
        return json({ ok: true });
      case "/celu/ordenes": {
        const o = (await s.get("ordenes")) || [];
        if (o.length) await s.put("ordenes", []);     // se borran al entregarlas (el celu no confirma aparte)
        return json({ ordenes: o });
      }
      case "/celu/respuesta": {
        const r = { de: "celu", texto: String(body.texto || "").slice(0, 4000), urgente: !!body.urgente, informe: !!body.informe, alerta: !!body.alerta };
        await anotar(r);
        const tgHasta = (await s.get("tgHasta")) || 0;
        const periodico = /últimos \d+ min/i.test(r.texto);           // el resumen de cada 15 min queda solo en el chat de la oficina
        return json({ ok: true, aTelegram: r.urgente || r.alerta || !periodico, texto: r.texto });
      }
      case "/oficina/celu":
        return json({ estado: (await s.get("estado")) || null, chat: ((await s.get("chat")) || []).slice(-120), pendientes: ((await s.get("ordenes")) || []).length, ahora: Date.now() });
      case "/oficina/orden": {
        const o = { id: crypto.randomUUID().slice(0, 8) };
        let que;
        if (body.tipo === "chat" && String(body.texto || "").trim()) { o.tipo = "chat"; o.texto = String(body.texto).trim().slice(0, 1000); que = o.texto; }
        else if (body.tipo === "accion" && ["pausa_ig", "seguir_ig", "reiniciar_ig"].includes(body.accion)) { o.tipo = "accion"; o.accion = body.accion; que = { pausa_ig: "⏸ Pausar Instagram", seguir_ig: "▶️ Seguir con Instagram", reiniciar_ig: "🔄 Reiniciar el bot" }[body.accion]; }
        else if (body.tipo === "ajuste" && typeof body.telegram === "boolean") { o.tipo = "ajuste"; o.telegram = body.telegram; que = "Avisos por Telegram: " + (body.telegram ? "prendidos" : "apagados"); }
        else return json({ ok: false, error: "orden no válida" }, 400);
        const l = (await s.get("ordenes")) || []; l.push(o); await s.put("ordenes", l.slice(-50));
        if (body.origen !== "telegram") await anotar({ de: "vos (panel del celu)", texto: "📱 " + que });   // lo de Telegram ya lo anota la oficina
        return json({ ok: true, id: o.id, que });
      }
      case "/oficina/chat": {                          // lo que la oficina le dice a Jonathan (y lo que él escribe por Telegram): un solo chat
        if (req.method === "POST") { const ms = (body.mensajes || []).filter(m => m && m.texto).slice(0, 80).map(m => ({ de: String(m.de || "oficina").slice(0, 60), texto: String(m.texto).slice(0, 4000) })); if (ms.length) await anotar(...ms); return json({ ok: true, n: ms.length }); }
        return json({ chat: ((await s.get("chat")) || []).slice(-120) });
      }
      case "/oficina/gerente": {                       // órdenes para el Gerente escritas en la página
        if (req.method === "POST") {
          const t = String(body.texto || "").trim().slice(0, 600); if (!t) return json({ ok: false, error: "orden vacía" }, 400);
          await anotar({ de: "vos (oficina)", texto: t });
          const c = ordenCeluDe(t);
          if (c) {                                                            // «celu ...»: lo resuelvo acá mismo, sin esperar a la oficina
            const e = await s.get("estado");
            let resp = null;
            if (c.ver === "estado") resp = textoCelu(e); else if (c.ver === "plan") resp = textoPlan(e); else if (c.ver === "informe") resp = "🧾 Informe del celu de hoy\n\n" + textoCelu(e) + "\n\n" + textoPlan(e);
            else { const l = (await s.get("ordenes")) || []; l.push({ id: crypto.randomUUID().slice(0, 8), ...c.orden }); await s.put("ordenes", l.slice(-50)); resp = "📱 Se lo pasé al celu bot. Lo agarra en 15 segundos y te contesta acá."; }
            await anotar({ de: "oficina", texto: resp });
            return json({ ok: true, celu: true, respuesta: resp });
          }
          const g = (await s.get("gerente")) || []; g.push({ t: Date.now(), texto: t }); await s.put("gerente", g.slice(-20));
          return json({ ok: true });
        }
        const g = (await s.get("gerente")) || []; if (g.length && u.searchParams.get("sacar") === "1") await s.put("gerente", []);
        return json({ ordenes: g });
      }
    }
    return json({ ok: false, error: "no existe" }, 404);
  }
}

const buzon = env => env.BUZON.get(env.BUZON.idFromName("oficina"));
const pedirBuzon = (env, ruta, opt) => buzon(env).fetch("https://buzon" + ruta, opt).then(r => r.json());

function cors(env, req) {
  const o = req.headers.get("origin") || "";
  return o === (env.ORIGEN || "https://uwuubuntu83-dotcom.github.io") ? { "access-control-allow-origin": o, "access-control-allow-headers": "content-type, x-pin", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" } : {};
}

async function telegram(env, texto, prefijo = "📱 Celu bot:\n") {
  if (!env.TELEGRAM_TOKEN || !env.DUENO || !texto) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.DUENO, text: (prefijo + texto).slice(0, 4000), disable_web_page_preview: true }) }).catch(() => {});
}

// ---- órdenes «celu ...» escritas en la página (mismas palabras que por Telegram)
function ordenCeluDe(t) {
  const m = String(t).match(/^\/?celu(?:\s*bot)?\b[\s:,.-]*(.*)$/is); if (!m) return null;
  const q = m[1].trim(), low = q.toLowerCase();
  if (!q || /^(estado|c[oó]mo (est[aá]|and[aá])|anda\??)$/.test(low)) return { ver: "estado" };
  if (/^(programa|plan|agenda|tareas|qu[eé] (tiene|hace|le toca))/.test(low)) return { ver: "plan" };
  if (/^(informe|reporte|resumen)/.test(low)) return { ver: "informe" };
  const QUE = "(\\s+(con\\s+)?(el\\s+|los\\s+)?(instagram|celu|bot|bots|todo|redes))?\\s*[.!]*$";
  if (new RegExp("^(paus[a-záéíóú]*|fren[a-záéíóú]*|par[aá])" + QUE).test(low)) return { orden: { tipo: "accion", accion: "pausa_ig" } };
  if (new RegExp("^(segu[ií]|seguir|sigue|activ[a-záéíóú]*|arranc[a-záéíóú]*|continu[a-záéíóú]*)" + QUE).test(low)) return { orden: { tipo: "accion", accion: "seguir_ig" } };
  if (/^reinici/.test(low)) return { orden: { tipo: "accion", accion: "reiniciar_ig" } };
  if (/^(avisos|telegram) (on|si|sí|prend)/.test(low)) return { orden: { tipo: "ajuste", telegram: true } };
  if (/^(avisos|telegram) (off|no|apag)/.test(low)) return { orden: { tipo: "ajuste", telegram: false } };
  return { orden: { tipo: "chat", texto: q } };
}
const horaAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 16), fechaAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function textoCelu(E) {
  if (!E || !E.t) return "📱 El celu todavía no mandó señales al buzón.";
  const x = E.estado || {}, rh = x.redes_hoy || {}, min = Math.round((Date.now() - E.t) / 60000);
  const bat = x.bateria != null ? " · batería " + (typeof x.bateria === "object" ? (x.bateria.porcentaje ?? x.bateria.percentage ?? "?") : x.bateria) + "%" : "";
  return `📱 Celu bot · ${min <= 10 ? "🟢 andando" : "🔴 no responde hace " + min + " min (revisá Termux, el Wi-Fi y la depuración inalámbrica)"}\nBot de Instagram: ${x.pausa ? "⏸ en pausa" : x.bot_vivo ? "trabajando" : "parado"}${bat}\n\nHoy: ${rh.publicaciones || 0} publicaciones · ${rh.historias || 0} historias · ${rh.reels || 0} reels/reposts · ${rh.seguidos || 0} seguidos · ${rh.gringo || 0} gringo · ${rh.errores || 0} errores${(rh.ultimas || []).length ? "\n\nÚltimo que hizo:\n" + rh.ultimas.slice(-6).map(l => "• " + l).join("\n") : ""}`;
}
const TAREAS = { historia: "📸 Historia de Instagram", repost: "🔁 Repost", publicar: "🖼️ Publicación", reel: "🎬 Reel", reel_ia: "🤖 Reel con IA", seguir: "➕ Seguir cuentas", fb_compartir: "📘 Compartir en Facebook", fb_historia: "📘 Historia de Facebook", fb_seguir: "📘 Seguir en Facebook", ofertas: "🏷️ Oferta", grin_unfollow: "➖ Gringo: dejar de seguir" };
const nombreT = t => TAREAS[t] || (/^memes_/.test(t) ? "😂 Memes: " + t.slice(6) : /^obra_/.test(t) ? "🧱 Obra: " + t.slice(5) : "• " + t.replace(/_/g, " "));
function textoPlan(E) {
  const pl = E && E.estado && E.estado.plan_hoy;
  if (!pl || !pl.tareas) return "📅 El celu todavía no mandó su plan.";
  if (pl.fecha !== fechaAR()) return `📅 El plan que tiene el celu es del ${pl.fecha}: todavía no armó el de hoy.`;
  const hh = horaAR(), q = pl.tareas.filter(t => t[0] >= hh), por = {}; for (const t of q) por[t[1]] = (por[t[1]] || 0) + 1;
  return `📅 Programa de hoy del celu bot\nTotal: ${pl.tareas.length} tareas · quedan ${q.length}\n\n${Object.entries(por).sort((a, z) => z[1] - a[1]).map(([k, v]) => `${nombreT(k)}: ${v}`).join("\n") || "No le quedan tareas por hoy."}${q.length ? "\n\n⏭️ Próximas:\n" + q.slice(0, 15).map(t => `${t[0]}  ${nombreT(t[1])}${t[2] ? " ×" + t[2] : ""}`).join("\n") : ""}`;
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url); const p = u.pathname;
    if (p.startsWith("/celu/")) {
      if (!env.CELU_KEY || req.headers.get("x-clave") !== env.CELU_KEY) return json({ ok: false, error: "clave incorrecta" }, 401);
      if (p === "/celu/manejar") return json({});            // la oficina nueva no interpreta esto: el celu lo resuelve solo
      if (p === "/celu/taller") return json({});
      if (p === "/celu/taller_resultado" || p === "/celu/mudar") return json({ ok: true });
      const r = await buzon(env).fetch(req);
      if (p === "/celu/respuesta") { const j = await r.clone().json().catch(() => ({})); if (j.aTelegram) ctx.waitUntil(telegram(env, j.texto)); return json({ ok: true }); }
      return r;
    }
    if (p.startsWith("/oficina/")) {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      const pin = req.headers.get("x-pin") || u.searchParams.get("pin") || "";
      if (!env.OFICINA_PIN || pin !== env.OFICINA_PIN) return json({ ok: false, error: "PIN incorrecto" }, 401, h);
      if (p === "/oficina/ia") return json(await iaCloudflare(env, await req.json().catch(() => ({}))), 200, h);
      if (p === "/oficina/llm") return json(await rotarIA(env, await req.json().catch(() => ({}))), 200, h);   // Forja y cualquier app tuya: todas las IA gratis en rueda
      const cuerpo = req.method === "POST" ? await req.text() : null;
      const r = await buzon(env).fetch(new Request(req.url, { method: req.method, headers: req.headers, body: cuerpo }));
      const j = r.ok && cuerpo ? await r.clone().json().catch(() => ({})) : {};
      const b = cuerpo ? (() => { try { return JSON.parse(cuerpo); } catch { return {}; } })() : {};
      const out = new Response(r.body, r); for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
      if (r.ok && p === "/oficina/gerente" && req.method === "POST") {          // un solo chat: lo que escribís en la página también queda en tu Telegram
        ctx.waitUntil((async () => { await telegram(env, b.texto, "🖥️ Vos (desde la oficina):\n"); if (j.respuesta) await telegram(env, j.respuesta, ""); else if (!j.celu) await revisar(env, true); })());
      }
      if (r.ok && p === "/oficina/orden" && req.method === "POST" && b.origen !== "telegram" && j.que) ctx.waitUntil(telegram(env, j.que, "🖥️ Vos (panel del celu):\n📱 "));
      return out;
    }
    if (p === "/despertar") return json(await revisar(env));
    return json({ ok: true, servicio: "Buzón de la Oficina Bosio", ayuda: "El celu usa /celu/*, la página usa /oficina/* con PIN." });
  },
  async scheduled(evento, env, ctx) { ctx.waitUntil(revisar(env)); }
};

// IA gratis de Cloudflare (Workers AI, plan free: ~10.000 "neuronas" por día) para la oficina
async function iaCloudflare(env, b) {
  if (!env.AI) return { error: true, status: 503, msg: "Workers AI no está conectado" };
  try {
    const r = await env.AI.run(b.modelo || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "user", content: String(b.prompt || "").slice(0, 60000) }], max_tokens: 3000, temperature: b.json ? 0.2 : 0.5 });
    let t = r && (typeof r.response === "string" ? r.response : r.response != null ? JSON.stringify(r.response) : (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || "");
    t = String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return t ? { texto: t } : { error: true, status: 200, msg: "respuesta vacía" };
  } catch (e) {
    const m = String(e && e.message || e);
    return { error: true, status: /4006|neuron|limit|quota|capacity|429/i.test(m) ? 429 : /not found|5007|No such model/i.test(m) ? 404 : 500, msg: m.slice(0, 200) };
  }
}

// ---- Rueda de IA gratis (como FreeLLMAPI, pero en internet 24 h): si una no tiene cupo, pasa a la siguiente
const PROVEEDORES = [
  ["GROQ_API_KEY", "Groq", "https://api.groq.com/openai/v1", ["openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile"]],
  ["CEREBRAS_API_KEY", "Cerebras", "https://api.cerebras.ai/v1", ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507", "llama-3.3-70b"]],
  ["GEMINI_API_KEY", "Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", ["gemini-2.5-flash", "gemini-2.5-flash-lite"], true],
  ["SAMBANOVA_API_KEY", "SambaNova", "https://api.sambanova.ai/v1", ["DeepSeek-V3.1", "Meta-Llama-3.3-70B-Instruct"]],
  ["OPENROUTER_API_KEY", "OpenRouter", "https://openrouter.ai/api/v1", ["openai/gpt-oss-120b:free", "qwen/qwen3-coder:free", "deepseek/deepseek-chat-v3-0324:free"]],
  ["NVIDIA_API_KEY", "NVIDIA", "https://integrate.api.nvidia.com/v1", ["openai/gpt-oss-120b", "meta/llama-3.3-70b-instruct"]],
  ["ZAI_API_KEY", "Z.ai", "https://api.z.ai/api/paas/v4", ["glm-4.5-flash"]],
  ["LLM7_API_KEY", "LLM7", "https://api.llm7.io/v1", ["default", "fast"]],
  ["UPSTAGE_API_KEY", "Upstage", "https://api.upstage.ai/v1", ["solar-pro2"]],
  ["HF_TOKEN", "Hugging Face", "https://router.huggingface.co/v1", ["openai/gpt-oss-120b"]],
  ["COHERE_API_KEY", "Cohere", "https://api.cohere.ai/compatibility/v1", ["command-a-03-2025"]]
];
const sinCupo = {}; // proveedor:modelo -> hasta cuándo saltearlo (vive mientras el worker está despierto)
async function rotarIA(env, b) {
  const msgs = (b.messages || []).filter(m => m && m.content).map(m => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: String(m.content).slice(0, 200000) }));
  if (!msgs.length) return { error: true, msg: "no hay mensaje" };
  const imgs = (b.images || []).slice(0, 4);
  if (imgs.length) { const u = msgs[msgs.length - 1]; u.content = [{ type: "text", text: u.content }, ...imgs.map(x => ({ type: "image_url", image_url: { url: `data:${x.mime};base64,${x.data}` } }))]; }
  const errores = [], ahora = Date.now();
  let lista = PROVEEDORES.filter(([k]) => env[k]);
  if (imgs.length) lista = lista.filter(p => p[4]);                       // con foto: solo las que ven imágenes
  for (const [k, nombre, base, modelos] of lista) for (const modelo of modelos) {
    const id = nombre + ":" + modelo; if ((sinCupo[id] || 0) > ahora) continue;
    try {
      const r = await fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env[k] }, body: JSON.stringify({ model: modelo, messages: msgs, temperature: 0.5 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { errores.push(`${nombre}: ${r.status}`); sinCupo[id] = ahora + (r.status === 429 ? 5 * 60e3 : r.status === 401 || r.status === 403 ? 6 * 3600e3 : 60e3); if (r.status === 401 || r.status === 403) break; continue; }
      const c = (j.choices || [])[0] || {}; const t = String((c.message && c.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (t) return { texto: t, modelo: `${nombre} · ${modelo}`, cortado: c.finish_reason === "length" };
      errores.push(`${nombre}: vacío`);
    } catch (e) { errores.push(`${nombre}: sin conexión`); }
  }
  if (!imgs.length) {
    if (env.AI) { try { const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: msgs.map(m => ({ role: m.role, content: String(m.content) })), max_tokens: 4000 }); const t = typeof r.response === "string" ? r.response.trim() : ""; if (t) return { texto: t, modelo: "Cloudflare · llama-3.3-70b" }; } catch (e) { errores.push("Cloudflare: " + String(e.message || e).slice(0, 40)); } }
    try { const r = await fetch("https://text.pollinations.ai/openai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai", messages: msgs }) }); const j = await r.json().catch(() => ({})); const t = String((((j.choices || [])[0] || {}).message || {}).content || "").trim(); if (t) return { texto: t, modelo: "Pollinations" }; errores.push("Pollinations: " + r.status); } catch { errores.push("Pollinations: sin conexión"); }
  }
  return { error: true, msg: "Todas las IA están sin cupo en este momento: " + errores.slice(-5).join(" · ") };
}

// Despertador + reloj fijo
async function revisar(env, forzar = false) {
  if (!env.GH_TOKEN) return { estado: "falta la clave GH_TOKEN" };
  let hayMensaje = forzar;
  if (!hayMensaje && env.TELEGRAM_TOKEN) {
    // Sin "offset": Telegram muestra el mensaje pendiente más viejo SIN darlo por leído; la oficina lo recibe igual.
    try { const tg = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getUpdates?timeout=0&limit=1`)).json(); hayMensaje = !!(tg.ok && tg.result.length); } catch {}
  }
  if (!hayMensaje) { try { hayMensaje = ((await pedirBuzon(env, "/oficina/gerente")).ordenes || []).length > 0; } catch {} }
  const gh = (ruta, opt = {}) => fetch(`https://api.github.com/repos/${env.REPO}/${ruta}`, { ...opt, headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "oficina-buzon", "x-github-api-version": "2022-11-28", ...(opt.headers || {}) } });
  const runs = await gh(`actions/workflows/${env.WORKFLOW}/runs?per_page=5`);
  if (runs.status === 401 || runs.status === 403) return { estado: "la clave de GitHub (GH_TOKEN) no sirve o no tiene permiso de Actions" };
  const lista = ((await runs.json().catch(() => ({}))).workflow_runs || []);
  if (lista.some(r => r.status !== "completed")) return { estado: "la oficina ya está trabajando" };
  const ultima = lista[0] ? Date.parse(lista[0].created_at) : 0;
  const atrasada = Date.now() - ultima > 29 * 60e3;   // GitHub a veces se saltea su vuelta de cada 30 min: la arranco yo
  if (!hayMensaje && !atrasada) return { estado: "todo tranquilo", ultimaVuelta: lista[0] && lista[0].created_at };
  const r = await gh(`actions/workflows/${env.WORKFLOW}/dispatches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: env.RAMA || "main", inputs: { modo: "auto" } }) });
  return { estado: r.status === 204 ? (hayMensaje ? "hay un mensaje nuevo: desperté a la oficina" : "GitHub estaba atrasado: arranqué la vuelta") : `GitHub no me dejó despertarla (${r.status})` };
}
