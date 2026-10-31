#!/usr/bin/env python3
"""Programador de la Oficina Bosio (OpenHands).

Lee el pedido (variable PEDIDO), arregla o mejora el código del repo y deja los cambios
en la carpeta de trabajo. El workflow después arma la propuesta (pull request) para que
Jonathan la apruebe. Nunca publica nada solo.

IA: usa las gratis que haya cargadas en los secretos, en orden; si una se queda sin cupo
pasa a la siguiente (FallbackStrategy de OpenHands).
"""
import os
import sys
import tempfile

from pydantic import SecretStr

from openhands.sdk import LLM, Conversation, LLMProfileStore, get_logger
from openhands.sdk.llm import FallbackStrategy
from openhands.tools.preset.default import get_default_agent

log = get_logger(__name__)

# (variable del secreto, modelo para LiteLLM, base_url o None)
CANDIDATAS = [
    ("GEMINI_API_KEY", "gemini/gemini-2.5-flash", None),
    ("GEMINI_API_KEY_2", "gemini/gemini-2.5-flash", None),
    ("CEREBRAS_API_KEY", "openai/gpt-oss-120b", "https://api.cerebras.ai/v1"),
    ("GROQ_API_KEY", "openai/openai/gpt-oss-120b", "https://api.groq.com/openai/v1"),
    ("SAMBANOVA_API_KEY", "openai/DeepSeek-V3.1", "https://api.sambanova.ai/v1"),
    ("NVIDIA_API_KEY", "openai/qwen/qwen3-coder-480b-a35b-instruct", "https://integrate.api.nvidia.com/v1"),
    ("OPENROUTER_API_KEY", "openrouter/qwen/qwen3-coder:free", None),
    ("ZAI_API_KEY", "openai/glm-4.5-flash", "https://api.z.ai/api/paas/v4"),
    ("GEMINI_API_KEY", "gemini/gemini-2.5-flash-lite", None),
]

REGLAS = """Sos el programador de la "Oficina Bosio", una oficina de bots que corre gratis en GitHub Actions.
Estás parado en la raíz del repositorio. Archivos principales:
- oficina.mjs: el motor (Node 20, SIN dependencias externas: solo módulos de node:).
- bots.json: la lista de bots y áreas.
- index.html: la página de la oficina (un solo archivo).
- buzon/worker.js: el Worker de Cloudflare (buzón del celu y chat).
- celu/: scripts de Python para el celular.

REGLAS (obligatorias):
1. Hacé SOLO lo que pide el pedido, con el cambio más chico y prolijo posible. No reescribas archivos enteros.
2. NO toques la carpeta data/ (son datos de la oficina) ni .github/ (no tenés permiso).
3. NUNCA escribas claves, tokens ni datos privados en el código. El repo es público.
4. No agregues dependencias ni package.json. Todo sigue sin instalar nada.
5. Textos para el usuario en español rioplatense.
6. Antes de terminar verificá: `node --check oficina.mjs` y `node --check buzon/worker.js` deben pasar.
   Si tocaste bots.json, que siga siendo JSON válido: `node -e "JSON.parse(require('fs').readFileSync('bots.json','utf8'))"`.
7. No hagas git commit ni push: el workflow arma la propuesta.
8. Al final escribí en el archivo /tmp/resumen.md, en 3 a 8 renglones simples (para alguien que no programa),
   qué cambiaste y cómo probarlo.

PEDIDO DE JONATHAN:
"""


def armar_llm():
    vistas, cfgs = set(), []
    for var, modelo, base in CANDIDATAS:
        k = (os.getenv(var) or "").strip()
        if not k or (var, modelo) in vistas:
            continue
        vistas.add((var, modelo))
        cfgs.append(dict(usage_id=f"ia-{len(cfgs)}", model=modelo, api_key=SecretStr(k), base_url=base,
                         num_retries=3, retry_min_wait=10, drop_params=True))
    if not cfgs:
        log.error("No hay ninguna clave de IA cargada (GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY...).")
        sys.exit(1)
    print("IA del programador (en orden):", ", ".join(c["model"] for c in cfgs))
    extra = {}
    if len(cfgs) > 1:
        carpeta = tempfile.mkdtemp()
        store = LLMProfileStore(base_dir=carpeta)
        nombres = []
        for i, c in enumerate(cfgs[1:]):
            n = f"respaldo-{i}"
            store.save(n, LLM(**c), include_secrets=True)
            nombres.append(n)
        extra["fallback_strategy"] = FallbackStrategy(fallback_llms=nombres, profile_store_dir=carpeta)
    return LLM(**cfgs[0], **extra)


def main():
    pedido = (os.getenv("PEDIDO") or "").strip()
    if not pedido:
        log.error("Falta el pedido (PEDIDO).")
        sys.exit(1)
    agente = get_default_agent(llm=armar_llm(), cli_mode=True)
    conv = Conversation(agent=agente, workspace=os.getcwd(), max_iteration_per_run=int(os.getenv("MAX_PASOS", "60")))
    conv.send_message(REGLAS + pedido)
    conv.run()
    print("Programador terminó.")


if __name__ == "__main__":
    main()
