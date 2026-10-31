# Oficina Bosio

Una oficina de bots que funciona sola y gratis. Está organizada como una empresa: un **Gerente general** recibe las órdenes de Jonathan por Telegram y se las pasa al bot que corresponde. Cada bot tiene **una sola tarea**, un **control de calidad** revisa cada trabajo y todas las noches cada bot **se entrena** con las notas del día.

- **Ver la oficina:** https://uwuubuntu83-dotcom.github.io/oficina-bosio/
- **Darle órdenes:** por Telegram, al bot de la oficina.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| `bots.json` | El organigrama: áreas, bots, la tarea de cada uno, su horario y cómo se lo evalúa. Para agregar o cambiar un bot, se edita este archivo. |
| `oficina.mjs` | El motor. GitHub lo ejecuta cada 30 minutos: lee las órdenes de Telegram, hace trabajar a los bots que tienen turno, controla la calidad, manda los informes, arma el parte diario (20:00) y entrena a los bots (23:00). |
| `index.html` | La oficina visual: muestra cada bot en su escritorio con su estado real. |
| `data/` | Lo que produce la oficina: estado, informes, lecciones de cada bot y opiniones de Jonathan. |

La IA es Gemini, con una clave gratis. GitHub Actions corre el motor gratis y Telegram es el canal para dar órdenes. Hay un límite diario de consultas (`limites` en `bots.json`) para no pasarse del cupo gratis.

Las ideas vienen de dos proyectos de código abierto:
- **Paperclip:** organigrama, un gerente que delega y bots que se despiertan solos con un presupuesto.
- **Star-Office-UI:** oficina en pixel art que muestra el estado real de cada bot.

## Secretos necesarios

Se cargan en Settings → Secrets and variables → Actions:
- `GEMINI_API_KEY`: la clave de Google AI Studio.
- `TELEGRAM_TOKEN`: el token del bot que da @BotFather.

Después hay que mandarle `/start` al bot desde Telegram. El primero que lo hace queda como dueño, y el bot ignora a cualquier otra persona.

**Importante:** el repositorio es público para que GitHub lo corra gratis. Los informes se pueden ver, así que no le pidas a la oficina cosas privadas. Las claves no se ven: quedan guardadas en los secretos.

## Buzón en Cloudflare (celu bot + órdenes desde la página + despertador)

`buzon/worker.js` es un Worker gratis de Cloudflare (con un Durable Object para guardar) que:

- **Habla con el celu bot** con su protocolo de siempre: `POST /celu/estado`, `GET /celu/ordenes`, `POST /celu/respuesta` (encabezado `x-clave` = secreto `CELU_KEY`).
- **Atiende la página** con PIN (`x-pin` = secreto `OFICINA_PIN`): `GET /oficina/celu`, `POST /oficina/orden`, `POST /oficina/gerente`.
- **Despierta a la oficina** cada minuto si hay un mensaje de Telegram o una orden de la página, y la arranca si GitHub se atrasó con su vuelta de cada 30 minutos.

Se instala solo con el workflow **Instalar buzón** cuando están cargados los secretos `CLOUDFLARE_API_TOKEN`, `DESPERTADOR_TOKEN`, `CELU_KEY` y `OFICINA_PIN`.
En el celu, `~/celu_solo/nube.json` queda así (sin la clave de Cloudflare):
```json
{ "url": "https://oficina-buzon.uwuubuntu83.workers.dev", "celu_key": "LA_MISMA_QUE_CELU_KEY", "mudado": "si" }
```
Por Telegram: `celu programa de hoy`, `celu subí una historia`, `celu pausa`, `celu seguí`, `celu reiniciar`, `celu informe`, `celu`.

## Programador (OpenHands)

Arregla o mejora el código de la oficina con [OpenHands](https://github.com/OpenHands/software-agent-sdk) y las IA gratis de los secretos (Gemini, Cerebras, Groq, SambaNova, NVIDIA, OpenRouter, Z.ai, rotando si una se queda sin cupo). Nunca aplica nada solo: deja una propuesta (pull request).

- Telegram / oficina: `programador: lo que hay que arreglar` · `propuestas` · `aprobar N` · `descartar N`
- GitHub: etiqueta `arreglar` en un issue, o comentario que empiece con `@programador` (solo el dueño).
- Archivos: `.github/workflows/programador.yml` y `.github/openhands/programador.py`.
