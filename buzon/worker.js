// Buzón de la Oficina Bosio (Cloudflare Worker + Durable Object, plan gratis, sin tarjeta).
// 1) Buzón del celu: habla EXACTAMENTE el protocolo del vigía (/celu/estado, /celu/ordenes, /celu/respuesta).
// 2) Buzón de la página: la oficina en github.io lee el celu y deja órdenes (con PIN).
// 3) Despertador: cada minuto, si le escribiste al bot de Telegram (o dejaste una orden en la página), despierta a la oficina en GitHub.
//    Además es el reloj fijo: si GitHub se atrasa con su vuelta de cada 30 minutos, la arranca él.
// Las claves (CELU_KEY, OFICINA_PIN, TELEGRAM_TOKEN, GH_TOKEN) son secretos de Cloudflare: nunca están en el código.
import { DurableObject } from "cloudflare:workers";

const MAX_CHAT = 120;
const json = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

export class Buzon extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url); const s = this.ctx.storage;
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const anotar = async e => { const c = (await s.get("chat")) || []; c.push({ t: Date.now(), ...e }); await s.put("chat", c.slice(-MAX_CHAT)); };
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
        return json({ ok: true, aTelegram: r.urgente || r.alerta || r.informe || Date.now() < tgHasta, texto: r.texto });
      }
      case "/oficina/celu":
        return json({ estado: (await s.get("estado")) || null, chat: ((await s.get("chat")) || []).slice(-50), pendientes: ((await s.get("ordenes")) || []).length, ahora: Date.now() });
      case "/oficina/orden": {
        const o = { id: crypto.randomUUID().slice(0, 8) };
        let que;
        if (body.tipo === "chat" && String(body.texto || "").trim()) { o.tipo = "chat"; o.texto = String(body.texto).trim().slice(0, 1000); que = o.texto; }
        else if (body.tipo === "accion" && ["pausa_ig", "seguir_ig", "reiniciar_ig"].includes(body.accion)) { o.tipo = "accion"; o.accion = body.accion; que = { pausa_ig: "⏸ Pausar Instagram", seguir_ig: "▶️ Seguir con Instagram", reiniciar_ig: "🔄 Reiniciar el bot" }[body.accion]; }
        else if (body.tipo === "ajuste" && typeof body.telegram === "boolean") { o.tipo = "ajuste"; o.telegram = body.telegram; que = "Avisos por Telegram: " + (body.telegram ? "prendidos" : "apagados"); }
        else return json({ ok: false, error: "orden no válida" }, 400);
        const l = (await s.get("ordenes")) || []; l.push(o); await s.put("ordenes", l.slice(-50));
        await anotar({ de: body.origen === "telegram" ? "vos (Telegram)" : "vos", texto: que });
        if (body.origen === "telegram") await s.put("tgHasta", Date.now() + 15 * 60e3);   // lo que conteste el celu en los próximos 15 min va a tu Telegram
        return json({ ok: true, id: o.id });
      }
      case "/oficina/gerente": {                       // órdenes para el Gerente escritas en la página
        if (req.method === "POST") {
          const t = String(body.texto || "").trim().slice(0, 600); if (!t) return json({ ok: false, error: "orden vacía" }, 400);
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

async function telegram(env, texto) {
  if (!env.TELEGRAM_TOKEN || !env.DUENO || !texto) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.DUENO, text: ("📱 Celu bot:\n" + texto).slice(0, 4000), disable_web_page_preview: true }) }).catch(() => {});
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
      const r = await buzon(env).fetch(req);
      const out = new Response(r.body, r); for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
      if (p === "/oficina/gerente" && req.method === "POST" && r.ok) ctx.waitUntil(revisar(env, true));   // orden desde la página: despierto ya
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
