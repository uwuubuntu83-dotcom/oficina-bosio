#!/usr/bin/env python3
import math, os, sys, glob, time, json, re, html, shutil, urllib.parse
from collections import Counter
import torch
import torch.nn as nn
import torch.nn.functional as F

TAMANOS = {
    "chica":   dict(capas=4,  cabezas=4,  dim=256,  contexto=256),
    "mediana": dict(capas=8,  cabezas=8,  dim=512,  contexto=512),
    "grande":  dict(capas=16, cabezas=16, dim=1024, contexto=1024),
}
CONFIG = dict(tamano="chica", lote=32, aprendizaje=3e-4, pasos=5000, cada=250, dropout=0.1)

DIR = os.path.dirname(os.path.abspath(__file__))
CARPETA_DATOS = os.path.join(DIR, "datos")
ARCHIVO_MODELO = os.path.join(DIR, "mi_ia.pt")
DISP = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")


# ---------- Tokenizador: convierte texto en números (por bytes UTF-8: entiende cualquier letra o emoji) ----------
def codificar(texto): return list(texto.encode("utf-8"))
def decodificar(nums): return bytes(int(n) for n in nums).decode("utf-8", errors="ignore")
VOCAB = 256


# ---------- El modelo: Transformer (atención + capas) ----------
class Atencion(nn.Module):
    def __init__(s, dim, cabezas, contexto, drop):
        super().__init__()
        s.qkv = nn.Linear(dim, 3 * dim); s.salida = nn.Linear(dim, dim)
        s.cabezas = cabezas; s.drop = drop
    def forward(s, x):
        B, T, C = x.shape
        q, k, v = s.qkv(x).split(C, dim=2)
        q, k, v = [t.view(B, T, s.cabezas, C // s.cabezas).transpose(1, 2) for t in (q, k, v)]
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=s.drop if s.training else 0)
        return s.salida(y.transpose(1, 2).contiguous().view(B, T, C))

class Bloque(nn.Module):
    def __init__(s, dim, cabezas, contexto, drop):
        super().__init__()
        s.n1 = nn.LayerNorm(dim); s.at = Atencion(dim, cabezas, contexto, drop)
        s.n2 = nn.LayerNorm(dim); s.mlp = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim), nn.Dropout(drop))
    def forward(s, x):
        x = x + s.at(s.n1(x))
        return x + s.mlp(s.n2(x))

class MiIA(nn.Module):
    def __init__(s, capas, cabezas, dim, contexto, drop=0.1):
        super().__init__()
        s.contexto = contexto
        s.tok = nn.Embedding(VOCAB, dim); s.pos = nn.Embedding(contexto, dim)
        s.bloques = nn.ModuleList([Bloque(dim, cabezas, contexto, drop) for _ in range(capas)])
        s.norm = nn.LayerNorm(dim); s.cabeza = nn.Linear(dim, VOCAB, bias=False)
        s.cabeza.weight = s.tok.weight  # comparte pesos (como GPT-2)
        s.apply(s._iniciar)
    def _iniciar(s, m):
        if isinstance(m, (nn.Linear, nn.Embedding)): nn.init.normal_(m.weight, mean=0.0, std=0.02)
        if isinstance(m, nn.Linear) and m.bias is not None: nn.init.zeros_(m.bias)
    def forward(s, idx, objetivo=None):
        B, T = idx.shape
        x = s.tok(idx) + s.pos(torch.arange(T, device=idx.device))
        for b in s.bloques: x = b(x)
        logits = s.cabeza(s.norm(x))
        perdida = None if objetivo is None else F.cross_entropy(logits.view(-1, VOCAB), objetivo.view(-1))
        return logits, perdida
    @torch.no_grad()
    def escribir(s, idx, cuantos=400, temperatura=0.8, top_k=50, parar=None):
        for _ in range(cuantos):
            logits, _ = s(idx[:, -s.contexto:])
            logits = logits[:, -1, :] / temperatura
            v, _ = torch.topk(logits, top_k); logits[logits < v[:, [-1]]] = -float("inf")
            sig = torch.multinomial(F.softmax(logits, dim=-1), 1)
            idx = torch.cat([idx, sig], dim=1)
            if parar is not None and sig.item() == parar: break
        return idx


# ---------- Datos ----------
def cargar_datos():
    archivos = sorted(glob.glob(os.path.join(CARPETA_DATOS, "**", "*.txt"), recursive=True))
    if not archivos:
        os.makedirs(CARPETA_DATOS, exist_ok=True)
        sys.exit(f"No hay textos. Poné archivos .txt en: {CARPETA_DATOS}")
    texto = "\n\n".join(open(a, encoding="utf-8", errors="ignore").read() for a in archivos)
    print(f"Leí {len(archivos)} archivo(s), {len(texto):,} caracteres.")
    datos = torch.tensor(codificar(texto), dtype=torch.long)
    corte = int(0.95 * len(datos))
    return datos[:corte], datos[corte:]

def lote(datos, ctx, n):
    ix = torch.randint(len(datos) - ctx - 1, (n,))
    x = torch.stack([datos[i:i + ctx] for i in ix]); y = torch.stack([datos[i + 1:i + ctx + 1] for i in ix])
    return x.to(DISP), y.to(DISP)


# ---------- Entrenar ----------
def entrenar():
    tr, va = cargar_datos()
    t = TAMANOS[CONFIG["tamano"]]; ctx = min(t["contexto"], len(va) - 2, len(tr) - 2)
    modelo = MiIA(t["capas"], t["cabezas"], t["dim"], t["contexto"], CONFIG["dropout"]).to(DISP)
    opt = torch.optim.AdamW(modelo.parameters(), lr=CONFIG["aprendizaje"], weight_decay=0.1)
    paso0 = 0
    if os.path.exists(ARCHIVO_MODELO):
        ck = torch.load(ARCHIVO_MODELO, map_location=DISP)
        if ck["tamano"] == CONFIG["tamano"]:
            modelo.load_state_dict(ck["modelo"]); opt.load_state_dict(ck["opt"]); paso0 = ck["paso"]
            print(f"Sigo aprendiendo desde el paso {paso0}.")
    print(f"Modelo «{CONFIG['tamano']}»: {sum(p.numel() for p in modelo.parameters())/1e6:.1f} millones de parámetros, en {DISP}.")
    def guardar(p): torch.save(dict(modelo=modelo.state_dict(), opt=opt.state_dict(), paso=p, tamano=CONFIG["tamano"]), ARCHIVO_MODELO)
    t0 = time.time(); paso = paso0
    try:
        for paso in range(paso0, paso0 + CONFIG["pasos"]):
            lr = CONFIG["aprendizaje"] * min(1, (paso + 1) / 200)
            for g in opt.param_groups: g["lr"] = lr
            modelo.train(); x, y = lote(tr, ctx, CONFIG["lote"])
            _, perdida = modelo(x, y)
            opt.zero_grad(set_to_none=True); perdida.backward()
            torch.nn.utils.clip_grad_norm_(modelo.parameters(), 1.0); opt.step()
            if paso % CONFIG["cada"] == 0:
                modelo.eval()
                with torch.no_grad(): _, pv = modelo(*lote(va, ctx, CONFIG["lote"]))
                print(f"paso {paso:6d} | error entrenando {perdida.item():.3f} | error en texto nuevo {pv.item():.3f} | {time.time()-t0:.0f}s")
                guardar(paso)
    except KeyboardInterrupt:
        print("\nCortado. Guardo lo aprendido.")
    guardar(paso + 1); print(f"Guardado en {ARCHIVO_MODELO}. Cuanto más baja el 'error en texto nuevo', mejor aprendió.")


# ---------- Charlar ----------
def charlar():
    if not os.path.exists(ARCHIVO_MODELO): sys.exit("Primero entrená:  python mi_ia.py entrenar")
    ck = torch.load(ARCHIVO_MODELO, map_location=DISP); t = TAMANOS[ck["tamano"]]
    modelo = MiIA(t["capas"], t["cabezas"], t["dim"], t["contexto"], 0).to(DISP)
    modelo.load_state_dict(ck["modelo"]); modelo.eval()
    print("Escribí algo y Enter (salir con Ctrl+C).")
    while True:
        try: texto = input("\nVos: ")
        except (KeyboardInterrupt, EOFError): break
        idx = torch.tensor([codificar(texto + "\n")], dtype=torch.long, device=DISP)
        sal = modelo.escribir(idx, cuantos=400)
        print("IA:", decodificar(sal[0, idx.shape[1]:].tolist()).split("\n\n")[0])


# ======================= INTERNET EN EL MOMENTO ========================


NAVEGADOR = {"User-Agent": "Mozilla/5.0 (MiIA lector; uso personal)"}
VACIAS = set("""de la que el en y a los se del las un por con no una su para es al lo como más o pero sus le ya
fue este ha sí porque esta son entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante
todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa
estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras
vosotros os mío mía cuál cuánto cuánta cuántos cómo dónde cuándo qué quién es son ser""".split())


def palabras(t):
    return [w for w in re.findall(r"[a-záéíóúñü0-9]+", t.lower()) if w not in VACIAS and len(w) > 1]


# ---------- 1) buscar ----------
def buscar_wikipedia(q, n=3):
    import requests
    r = requests.get("https://es.wikipedia.org/w/api.php", headers=NAVEGADOR, timeout=15,
                     params=dict(action="query", list="search", srsearch=q, format="json", srlimit=n))
    return [("https://es.wikipedia.org/wiki/" + urllib.parse.quote(x["title"].replace(" ", "_")), x["title"])
            for x in r.json().get("query", {}).get("search", [])]


def buscar_duckduckgo(q, n=5):
    import requests
    from bs4 import BeautifulSoup
    r = requests.post("https://html.duckduckgo.com/html/", data={"q": q, "kl": "ar-es"}, headers=NAVEGADOR, timeout=15)
    s = BeautifulSoup(r.text, "html.parser"); out = []
    for a in s.select("a.result__a")[:n]:
        u = a.get("href", "")
        m = re.search(r"uddg=([^&]+)", u)
        if m: u = urllib.parse.unquote(m.group(1))
        if u.startswith("http"): out.append((u, a.get_text(" ", strip=True)))
    return out


# ---------- 2) leer ----------
def leer(url):
    import requests
    from bs4 import BeautifulSoup
    try:
        r = requests.get(url, headers=NAVEGADOR, timeout=15)
        if "text/html" not in r.headers.get("content-type", ""): return ""
        s = BeautifulSoup(r.text, "html.parser")
        for t in s(["script", "style", "nav", "footer", "header", "aside", "form"]): t.decompose()
        return re.sub(r"\s+", " ", " ".join(p.get_text(" ", strip=True) for p in s.find_all(["p", "li", "td", "h2", "h3"])))
    except Exception:
        return ""


# ---------- 3) elegir lo importante (sin IA: puntaje por coincidencia tipo buscador, BM25) ----------
def mejores_oraciones(pregunta, docs, cuantas=6):
    q = palabras(pregunta)
    oraciones = []
    for url, texto in docs:
        for o in re.split(r"(?<=[.!?])\s+", texto):
            if 40 <= len(o) <= 400: oraciones.append((o.strip(), url))
    if not oraciones or not q: return []
    df = Counter(w for o, _ in oraciones for w in set(palabras(o)))
    N = len(oraciones); prom = sum(len(palabras(o)) for o, _ in oraciones) / N
    def puntaje(o):
        ws = palabras(o); tf = Counter(ws); s = 0.0
        for w in q:
            if w in tf:
                idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf[w] * 2.2 / (tf[w] + 1.2 * (0.25 + 0.75 * len(ws) / prom))
        if re.search(r"\d", o) and re.search(r"cu[aá]nt|precio|cost|pesa|mide|a[nñ]o", pregunta.lower()): s *= 1.3
        return s
    vistas, salida = set(), []
    for o, u in sorted(oraciones, key=lambda x: -puntaje(x[0])):
        clave = o[:60].lower()
        if clave in vistas or puntaje(o) <= 0: continue
        vistas.add(clave); salida.append((o, u))
        if len(salida) >= cuantas: break
    return salida


# ---------- 4) responder ----------
def responder(pregunta):
    resultados = []
    for f in (buscar_wikipedia, buscar_duckduckgo):
        try: resultados += f(pregunta)
        except Exception as e: print(f"  (no pude buscar con {f.__name__}: {e})")
    if not resultados: return "No encontré nada. ¿Hay internet?"
    docs = []
    for url, titulo in resultados[:6]:
        t = leer(url)
        if t: docs.append((url, t))
    mejores = mejores_oraciones(pregunta, docs)
    if not mejores: return "Encontré páginas pero nada que responda bien. Probá con otras palabras."
    texto = "\n".join(f"• {o}" for o, _ in mejores)
    fuentes = "\n".join(sorted({f"  - {u}" for _, u in mejores}))
    redactado = redactar_con_mi_ia(pregunta, [o for o, _ in mejores])
    return (f"{redactado}\n\n" if redactado else "") + f"Lo que encontré:\n{texto}\n\nFuentes:\n{fuentes}"


def redactar_con_mi_ia(pregunta, oraciones):
    """Si ya entrenaste tu IA, le da lo encontrado para que lo redacte con su estilo."""
    try:
        if not os.path.exists(ARCHIVO_MODELO): return ""
        ck = torch.load(ARCHIVO_MODELO, map_location=DISP); t = TAMANOS[ck["tamano"]]
        m = MiIA(t["capas"], t["cabezas"], t["dim"], t["contexto"], 0).to(DISP)
        m.load_state_dict(ck["modelo"]); m.eval()
        prompt = "Información: " + " ".join(oraciones)[: t["contexto"] * 2] + f"\nPregunta: {pregunta}\nRespuesta:"
        idx = torch.tensor([codificar(prompt)[-t["contexto"]:]], dtype=torch.long, device=DISP)
        sal = m.escribir(idx, cuantos=300)
        return "Mi IA: " + decodificar(sal[0, idx.shape[1]:].tolist()).split("\n\n")[0].strip()
    except Exception:
        return ""


# ======================= APRENDER SOLA CON INTERNET =====================
ESTADO = os.path.join(DIR, "aprender_estado.json")
RONDA = os.path.join(DIR, "_ronda")             # carpeta temporal de cada vuelta
MB_POR_VUELTA = 20                              # cuánto texto nuevo lee por vuelta
PASOS_POR_VUELTA = 1500                         # cuánto entrena por vuelta

# Fuentes públicas y legales de internet (nombre en Hugging Face, configuración, campo de texto, peso)
FUENTES = [
    ("wikimedia/wikipedia", "20231101.es", "text", 3),      # enciclopedia: información y datos
    ("HuggingFaceFW/fineweb-2", "spa_Latn", "text", 5),     # páginas web en español: de todo un poco
    ("HuggingFaceFW/fineweb-edu", "default", "text", 2),    # páginas educativas (inglés): ciencia, lógica
    ("codeparrot/github-code-clean", "Python-all", "code", 1),  # código: programación
]


def leer_estado():
    try: return json.load(open(ESTADO, encoding="utf-8"))
    except Exception: return {"vuelta": 0, "leidos": {}}


def abrir_fuente(nombre, config, saltear):
    from datasets import load_dataset
    ds = load_dataset(nombre, config, split="train", streaming=True)
    return iter(ds.skip(saltear)) if saltear else iter(ds)


def bajar_pedazo(est):
    """Baja MB_POR_VUELTA de texto nuevo, repartido entre las fuentes según su peso."""
    os.makedirs(RONDA, exist_ok=True)
    total_peso = sum(f[3] for f in FUENTES); bajado = 0
    for nombre, config, campo, peso in FUENTES:
        meta = MB_POR_VUELTA * 1_000_000 * peso // total_peso
        clave = f"{nombre}:{config}"; ya = est["leidos"].get(clave, 0); n = 0; bytes_ = 0
        try:
            it = abrir_fuente(nombre, config, ya)
            with open(os.path.join(RONDA, clave.replace("/", "_").replace(":", "_") + ".txt"), "w", encoding="utf-8") as f:
                for fila in it:
                    n += 1
                    t = str(fila.get(campo) or "").strip()
                    if len(t) < 200: continue
                    f.write(t + "\n\n"); bytes_ += len(t.encode("utf-8"))
                    if bytes_ >= meta: break
        except Exception as e:
            print(f"  (no pude leer {nombre}: {str(e)[:120]})")
        est["leidos"][clave] = ya + n; bajado += bytes_
        print(f"  {nombre}: +{bytes_/1e6:.1f} MB (lleva {est['leidos'][clave]:,} documentos leídos)")
    return bajado


def sumar_lo_tuyo():
    """Copia tus textos a la vuelta, varias veces, para que tu estilo y tus temas pesen más que internet."""
    tuyos = glob.glob(os.path.join(CARPETA_DATOS, "**", "*.txt"), recursive=True)
    for i, a in enumerate(tuyos):
        for k in range(3):
            shutil.copy(a, os.path.join(RONDA, f"tuyo_{i}_{k}.txt"))
    return len(tuyos)


def aprender_solo():
    est = leer_estado()
    print("Tu IA aprende sola. Para frenarla: creá un archivo llamado PARAR en esta carpeta.\n")
    while not os.path.exists(os.path.join(DIR, "PARAR")):
        est["vuelta"] += 1
        print(f"=== Vuelta {est['vuelta']} · {time.strftime('%d/%m %H:%M')} ===")
        shutil.rmtree(RONDA, ignore_errors=True)
        bajado = bajar_pedazo(est)
        tuyos = sumar_lo_tuyo()
        if bajado == 0 and tuyos == 0:
            print("No pude bajar nada (¿hay internet?). Reintento en 5 minutos."); time.sleep(300); continue
        global CARPETA_DATOS
        carpeta_original = CARPETA_DATOS; CARPETA_DATOS = RONDA
        pasos_original = CONFIG["pasos"]; CONFIG["pasos"] = PASOS_POR_VUELTA
        try: entrenar()
        finally: CARPETA_DATOS = carpeta_original; CONFIG["pasos"] = pasos_original
        json.dump(est, open(ESTADO, "w", encoding="utf-8"), indent=1)
        shutil.rmtree(RONDA, ignore_errors=True)
        print()
    os.remove(os.path.join(DIR, "PARAR")); print("Frené. Lo aprendido quedó guardado en mi_ia.pt.")

# ======================= CREAR: busca en internet, razona y te arma lo que pidas =======================
# Cerebro: un modelo libre que razona (Qwen2.5-Coder, licencia Apache 2.0) guardado EN TU CARPETA (cerebro/).
# Se baja una sola vez; después anda sin internet, sin cuentas y sin programas aparte. Es tuyo: lo podés modificar y entrenar.
CARPETA_CEREBRO = os.path.join(DIR, "cerebro")
CARPETA_PROYECTOS = os.path.join(DIR, "proyectos")
_CEREBRO = {}

INSTRUCCIONES = """Sos un programador experto que trabaja solo. Tenés estas herramientas y respondés SIEMPRE con UN solo JSON, sin texto extra:
{"pensar": "tu razonamiento corto", "accion": "buscar", "texto": "qué buscar en internet"}
{"pensar": "...", "accion": "leer", "url": "https://..."}
{"pensar": "...", "accion": "escribir", "archivo": "ruta/relativa.ext", "contenido": "el archivo COMPLETO"}
{"pensar": "...", "accion": "terminar", "resumen": "qué hiciste y cómo se usa"}
Método: 1) buscá cómo se hace; 2) leé lo útil; 3) planeá los archivos; 4) escribí cada archivo completo y funcionando;
5) si la revisión marca errores, corregilos; 6) terminá. Textos y comentarios en español.
Preferí apps web en un solo index.html (HTML, CSS y JavaScript) que funcionen abriendo el archivo."""


def elegir_cerebro():
    """Elige el tamaño de cerebro según tu compu (más grande = razona mejor)."""
    if torch.cuda.is_available():
        gb = torch.cuda.get_device_properties(0).total_memory / 1e9
        return "Qwen/Qwen2.5-Coder-7B-Instruct" if gb >= 15 else "Qwen/Qwen2.5-Coder-3B-Instruct" if gb >= 7 else "Qwen/Qwen2.5-Coder-1.5B-Instruct"
    return "Qwen/Qwen2.5-Coder-1.5B-Instruct"


def cargar_cerebro():
    if _CEREBRO: return _CEREBRO["m"], _CEREBRO["t"]
    from transformers import AutoModelForCausalLM, AutoTokenizer
    nombre = os.environ.get("MI_IA_CEREBRO") or elegir_cerebro()
    local = os.path.join(CARPETA_CEREBRO, nombre.split("/")[-1])
    if not os.path.exists(os.path.join(local, "config.json")):
        from huggingface_hub import snapshot_download
        print(f"Bajo el cerebro {nombre} a tu carpeta (una sola vez)...")
        snapshot_download(nombre, local_dir=local)
    t = AutoTokenizer.from_pretrained(local)
    m = AutoModelForCausalLM.from_pretrained(local, torch_dtype=torch.float16 if DISP == "cuda" else torch.float32).to(DISP).eval()
    _CEREBRO.update(m=m, t=t, nombre=nombre); print(f"Cerebro listo: {nombre} en {DISP}")
    return m, t


def cerebro_local(mensajes, largo=3000):
    m, t = cargar_cerebro()
    ids = t.apply_chat_template(mensajes, add_generation_prompt=True, return_tensors="pt")
    if not torch.is_tensor(ids): ids = ids["input_ids"]
    ids = ids.to(DISP)
    with torch.no_grad():
        sal = m.generate(ids, max_new_tokens=largo, do_sample=False, repetition_penalty=1.05, pad_token_id=t.eos_token_id)
    return t.decode(sal[0, ids.shape[1]:], skip_special_tokens=True)


def cerebro_propio(mensajes):
    m = None
    if os.path.exists(ARCHIVO_MODELO):
        ck = torch.load(ARCHIVO_MODELO, map_location=DISP); t = TAMANOS[ck["tamano"]]
        m = MiIA(t["capas"], t["cabezas"], t["dim"], t["contexto"], 0).to(DISP); m.load_state_dict(ck["modelo"]); m.eval()
    if m is None: raise RuntimeError("No hay cerebro: instalá transformers (pip install transformers huggingface_hub accelerate) o entrená tu IA (python mi_ia.py aprender).")
    texto = "\n".join(x["content"] for x in mensajes[-3:])
    idx = torch.tensor([codificar(texto + "\n{")[-m.contexto:]], dtype=torch.long, device=DISP)
    return "{" + decodificar(m.escribir(idx, cuantos=800)[0, idx.shape[1]:].tolist())


def pensar(mensajes):
    try: return cerebro_local(mensajes), _CEREBRO.get("nombre", "cerebro")
    except ImportError:
        print("Para razonar falta instalar una vez:  pip install transformers huggingface_hub accelerate")
        return cerebro_propio(mensajes), "mi_ia.pt"


def sacar_json(t):
    t = t.strip(); i = t.find("{")
    while i >= 0:
        prof = 0
        for j in range(i, len(t)):
            if t[j] == "{": prof += 1
            elif t[j] == "}":
                prof -= 1
                if prof == 0:
                    try: return json.loads(t[i:j + 1])
                    except Exception: break
        i = t.find("{", i + 1)
    return None


def revisar_archivo(ruta):
    """Revisa que lo escrito funcione (sin ejecutar nada peligroso)."""
    ext = os.path.splitext(ruta)[1].lower()
    try:
        if ext == ".py":
            compile(open(ruta, encoding="utf-8").read(), ruta, "exec")
        elif ext == ".json":
            json.load(open(ruta, encoding="utf-8"))
        elif ext in (".js", ".mjs") and shutil.which("node"):
            import subprocess
            r = subprocess.run(["node", "--check", ruta], capture_output=True, text=True, timeout=30)
            if r.returncode: return r.stderr.strip()[:600]
        elif ext in (".html", ".htm"):
            t = open(ruta, encoding="utf-8", errors="ignore").read().lower()
            if "<html" not in t or "</html>" not in t: return "El HTML está incompleto (falta <html> o </html>)."
        return ""
    except Exception as e:
        return str(e)[:600]


def crear(pedido, pasos_max=40):
    nombre = re.sub(r"[^a-z0-9]+", "_", pedido.lower())[:40].strip("_") or "proyecto"
    carpeta = os.path.join(CARPETA_PROYECTOS, nombre); os.makedirs(carpeta, exist_ok=True)
    mensajes = [{"role": "system", "content": INSTRUCCIONES}, {"role": "user", "content": "PEDIDO: " + pedido}]
    print(f"Proyecto en: {carpeta}\n")
    for paso in range(1, pasos_max + 1):
        crudo, quien = pensar(mensajes)
        a = sacar_json(crudo)
        if not a or "accion" not in a:
            mensajes += [{"role": "assistant", "content": crudo[:2000]}, {"role": "user", "content": "Respondé SOLO con un JSON válido de los indicados."}]
            print(f"[{paso}] ({quien}) respuesta no válida, le pido que corrija"); continue
        print(f"[{paso}] {a.get('pensar', '')[:160]}")
        acc = a["accion"]; resultado = ""
        if acc == "buscar":
            q = str(a.get("texto", pedido)); print(f"     🔎 busco: {q}")
            res = []
            for f in (buscar_duckduckgo, buscar_wikipedia):
                try: res += f(q)
                except Exception as e: res.append(("", f"(no pude buscar: {e})"))
            res += [(f"https://github.com/search?q={urllib.parse.quote(q)}&type=code", "Código en GitHub")]
            resultado = "Resultados:\n" + "\n".join(f"- {t}: {u}" for u, t in res[:8])
        elif acc == "leer":
            u = str(a.get("url", "")); print(f"     📖 leo: {u}")
            texto = leer(u)
            mejores = mejores_oraciones(pedido + " " + a.get("pensar", ""), [(u, texto)], 25)
            resultado = ("Lo importante de la página:\n" + "\n".join(o for o, _ in mejores)) if mejores else (texto[:4000] or "No pude leer esa página.")
        elif acc == "escribir":
            rel = os.path.normpath(str(a.get("archivo", "index.html"))).lstrip(os.sep).replace("..", "_")
            ruta = os.path.join(carpeta, rel); os.makedirs(os.path.dirname(ruta), exist_ok=True)
            open(ruta, "w", encoding="utf-8").write(str(a.get("contenido", "")))
            err = revisar_archivo(ruta); print(f"     ✍️  escribí {rel}" + (f"  ⚠️ {err[:120]}" if err else "  ✅"))
            resultado = f"Escribí {rel}. " + (f"LA REVISIÓN ENCONTRÓ UN ERROR, corregilo: {err}" if err else "Revisado sin errores.")
        elif acc == "terminar":
            archivos = [os.path.relpath(os.path.join(r, f), carpeta) for r, _, fs in os.walk(carpeta) for f in fs]
            print(f"\n✅ Listo: {a.get('resumen', '')}\nArchivos: {', '.join(archivos) or '(ninguno)'}\nCarpeta: {carpeta}")
            return carpeta
        else:
            resultado = f"La acción «{acc}» no existe. Usá buscar, leer, escribir o terminar."
        mensajes += [{"role": "assistant", "content": json.dumps(a, ensure_ascii=False)[:6000]}, {"role": "user", "content": resultado[:8000]}]
        if len(mensajes) > 30: mensajes = mensajes[:2] + mensajes[-26:]
    print(f"\nLlegué al límite de {pasos_max} pasos. Lo que hice quedó en: {carpeta}")
    return carpeta


# ======================= WEB Y APP PROPIAS (todo en tu compu) =======================
PAGINA = """<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111318">
<link rel="manifest" href="/manifest.json"><link rel="icon" href="/icono.svg">
<title>Mi IA</title><style>
:root{--f:#111318;--p:#1b1e26;--t:#e9ecf2;--s:#8b93a7;--a:#e0b84f}
*{box-sizing:border-box}body{margin:0;background:var(--f);color:var(--t);font:16px system-ui,sans-serif;height:100dvh;display:flex;flex-direction:column}
header{padding:14px 16px;border-bottom:1px solid #262a35;display:flex;align-items:center;gap:10px;font-weight:600}
header span{width:10px;height:10px;border-radius:50%;background:var(--a)}
#chat{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:85%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;line-height:1.4}
.vos{align-self:flex-end;background:var(--a);color:#111}.ia{align-self:flex-start;background:var(--p)}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #262a35}
input{flex:1;padding:12px 14px;border-radius:12px;border:1px solid #2c3140;background:var(--p);color:var(--t);font-size:16px}
button{padding:0 16px;border:0;border-radius:12px;background:var(--a);color:#111;font-weight:600;font-size:15px}
label{display:flex;align-items:center;gap:6px;color:var(--s);font-size:13px;padding:0 14px 10px}
</style></head><body>
<header><span></span>Mi IA</header><div id="chat"></div>
<form id="f"><input id="q" placeholder="Escribí..." autocomplete="off"><button>Enviar</button></form>
<label><input type="checkbox" id="net" style="flex:0"> Buscar en internet</label>
<script>
const chat=document.getElementById('chat');
function poner(t,c){const d=document.createElement('div');d.className='m '+c;d.textContent=t;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const q=document.getElementById('q');const t=q.value.trim();if(!t)return;q.value='';
poner(t,'vos');const r=poner('...','ia');
try{const res=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({texto:t,internet:document.getElementById('net').checked})});
r.textContent=(await res.json()).respuesta||'(sin respuesta)'}catch(err){r.textContent='No pude conectar con la IA.'}};
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');
</script></body></html>"""
MANIFEST = '{"name":"Mi IA","short_name":"Mi IA","start_url":"/","display":"standalone","background_color":"#111318","theme_color":"#111318","icons":[{"src":"/icono.svg","sizes":"any","type":"image/svg+xml"}]}'
ICONO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#111318"/><circle cx="50" cy="50" r="22" fill="#e0b84f"/></svg>'
SW = "self.addEventListener('fetch',()=>{});"


def web(puerto=8000):
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
    import socket
    modelo = [None]
    def cargar():
        if modelo[0] is None and os.path.exists(ARCHIVO_MODELO):
            ck = torch.load(ARCHIVO_MODELO, map_location=DISP); t = TAMANOS[ck["tamano"]]
            m = MiIA(t["capas"], t["cabezas"], t["dim"], t["contexto"], 0).to(DISP)
            m.load_state_dict(ck["modelo"]); m.eval(); modelo[0] = m
        return modelo[0]
    def contestar(texto, internet):
        if texto.lower().startswith(("crear:", "creá:", "crea:", "haceme")):
            return "Proyecto creado en: " + crear(texto.split(":", 1)[-1].strip())
        if internet: return responder(texto)
        m = cargar()
        if m is None: return "Todavía no aprendí nada. Corré: python mi_ia.py aprender"
        idx = torch.tensor([codificar(texto + "\n")[-m.contexto:]], dtype=torch.long, device=DISP)
        sal = m.escribir(idx, cuantos=400)
        return decodificar(sal[0, idx.shape[1]:].tolist()).split("\n\n")[0].strip() or "(no supe qué decir)"
    class H(BaseHTTPRequestHandler):
        def _env(s, cuerpo, tipo):
            b = cuerpo.encode("utf-8"); s.send_response(200); s.send_header("content-type", tipo + "; charset=utf-8")
            s.send_header("content-length", str(len(b))); s.end_headers(); s.wfile.write(b)
        def do_GET(s):
            rutas = {"/": (PAGINA, "text/html"), "/manifest.json": (MANIFEST, "application/manifest+json"),
                     "/icono.svg": (ICONO, "image/svg+xml"), "/sw.js": (SW, "text/javascript")}
            if s.path in rutas: s._env(*rutas[s.path])
            else: s.send_response(404); s.end_headers()
        def do_POST(s):
            if s.path != "/api": s.send_response(404); s.end_headers(); return
            d = json.loads(s.rfile.read(int(s.headers.get("content-length", 0))) or b"{}")
            try: r = contestar(str(d.get("texto", ""))[:2000], bool(d.get("internet")))
            except Exception as e: r = f"Error: {e}"
            s._env(json.dumps({"respuesta": r}), "application/json")
        def log_message(s, *a): pass
    try:
        so = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); so.connect(("10.255.255.255", 1)); ip = so.getsockname()[0]; so.close()
    except Exception: ip = "127.0.0.1"
    print(f"Tu web está andando:\n  en esta compu:          http://localhost:{puerto}\n  en tu celu (mismo wifi): http://{ip}:{puerto}\n"
          "En el celu: abrila en Chrome → ⋮ → «Agregar a pantalla principal» y queda como app.\nPara apagarla: Ctrl+C.")
    ThreadingHTTPServer(("0.0.0.0", puerto), H).serve_forever()


# ======================================================================================
if __name__ == "__main__":
    modo = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if modo == "entrenar": entrenar()
    elif modo == "charlar": charlar()
    elif modo == "aprender": aprender_solo()
    elif modo == "crear":
        pedido = " ".join(sys.argv[2:]) or input("¿Qué querés que cree? ")
        crear(pedido)
    elif modo == "web": web(int(sys.argv[2]) if len(sys.argv) > 2 else 8000)
    elif modo == "preguntar":
        if len(sys.argv) > 2: print(responder(" ".join(sys.argv[2:])))
        else:
            print("Preguntá lo que quieras (salir con Ctrl+C).")
            while True:
                try: q = input("\nVos: ").strip()
                except (KeyboardInterrupt, EOFError): break
                if q: print("\n" + responder(q))
    else: print("Uso: python mi_ia.py aprender | entrenar | charlar | preguntar | crear | web")
