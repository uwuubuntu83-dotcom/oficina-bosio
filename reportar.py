"""
reportar.py — conecta los bots del celular (Termux / Python) con la Oficina Bosio.

Uso en tus scripts del celu:
    from reportar import reportar
    reportar("celular_bot", "ok", "Publiqué 3 historias en Instagram")
    reportar("celular_bot", "error", "Instagram pidió verificación")

Cómo se configura (una sola vez, en Termux):
    1. Creá un token de GitHub de acceso fino (Fine-grained) solo para el repositorio oficina-bosio,
       con permiso "Contents: Read and write":  https://github.com/settings/personal-access-tokens/new
    2. En Termux:  echo 'export OFICINA_TOKEN=el_token' >> ~/.bashrc  y reiniciá Termux.
    3. Copiá este archivo al lado de tus bots.

Con un reporte cada 30 a 60 minutos alcanza: si pasan 90 minutos sin señal, la oficina te avisa por Telegram.
Solo usa la librería estándar de Python (no hace falta instalar nada).
"""
import base64, json, os, urllib.request, urllib.error
from datetime import datetime, timezone

REPO = "uwuubuntu83-dotcom/oficina-bosio"


def reportar(bot_id: str, estado: str = "ok", detalle: str = "") -> bool:
    token = os.environ.get("OFICINA_TOKEN", "")
    if not token:
        print("reportar: falta la variable OFICINA_TOKEN")
        return False
    url = f"https://api.github.com/repos/{REPO}/contents/data/externos/{bot_id}.json"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "celular-bot"}
    sha = None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
            sha = json.load(r).get("sha")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print("reportar: no pude leer el estado anterior", e.code)
    datos = {"t": datetime.now(timezone.utc).isoformat(), "estado": estado, "detalle": detalle[:300]}
    cuerpo = {"message": f"{bot_id}: {estado}", "content": base64.b64encode(json.dumps(datos, ensure_ascii=False).encode()).decode()}
    if sha:
        cuerpo["sha"] = sha
    req = urllib.request.Request(url, data=json.dumps(cuerpo).encode(), headers={**headers, "Content-Type": "application/json"}, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=20):
            return True
    except urllib.error.HTTPError as e:
        print("reportar: GitHub respondió", e.code, e.read()[:200])
        return False
    except Exception as e:  # sin internet, etc.
        print("reportar: sin conexión", e)
        return False


if __name__ == "__main__":
    import sys
    print(reportar(sys.argv[1] if len(sys.argv) > 1 else "celular_bot", sys.argv[2] if len(sys.argv) > 2 else "ok", " ".join(sys.argv[3:])))
