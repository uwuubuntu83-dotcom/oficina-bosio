// Despertador de la Oficina Bosio (Cloudflare Worker, gratis).
// Cada minuto mira si mandaste un mensaje nuevo al bot de Telegram. Si hay, despierta a la oficina en GitHub
// para que te conteste en 1 o 2 minutos en vez de esperar la vuelta de cada 30 minutos.
// No lee ni guarda tus mensajes: solo se fija si hay alguno sin atender (no los marca como leídos).
export default {
  async scheduled(evento, env, ctx) { ctx.waitUntil(revisar(env)); },
  async fetch(req, env) {
    const r = await revisar(env);
    return new Response(JSON.stringify(r, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
};

async function revisar(env) {
  if (!env.TELEGRAM_TOKEN || !env.GH_TOKEN) return { estado: "faltan las claves TELEGRAM_TOKEN o GH_TOKEN" };
  // Sin "offset": Telegram devuelve el mensaje pendiente más viejo SIN darlo por leído; la oficina lo sigue recibiendo igual.
  let tg;
  try { tg = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getUpdates?timeout=0&limit=1`)).json(); }
  catch { return { estado: "Telegram no respondió" }; }
  if (!tg.ok) return { estado: "Telegram rechazó la consulta", detalle: tg.description };
  if (!tg.result.length) return { estado: "sin mensajes nuevos, la oficina sigue con su vuelta de cada 30 minutos" };

  const gh = (ruta, opt = {}) => fetch(`https://api.github.com/repos/${env.REPO}/${ruta}`, {
    ...opt,
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "oficina-despertador", "x-github-api-version": "2022-11-28", ...(opt.headers || {}) }
  });
  // Si la oficina ya está trabajando o en la fila, no la despierto de nuevo.
  const runs = await gh(`actions/workflows/${env.WORKFLOW}/runs?per_page=5`);
  if (runs.status === 401 || runs.status === 403) return { estado: "la clave de GitHub (GH_TOKEN) no sirve o no tiene permiso de Actions" };
  const j = await runs.json().catch(() => ({}));
  if ((j.workflow_runs || []).some(r => r.status !== "completed")) return { estado: "hay un mensaje nuevo y la oficina ya está trabajando" };
  const r = await gh(`actions/workflows/${env.WORKFLOW}/dispatches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: env.RAMA || "main", inputs: { modo: "auto" } }) });
  return { estado: r.status === 204 ? "hay un mensaje nuevo: desperté a la oficina" : `GitHub no me dejó despertarla (${r.status})` };
}
