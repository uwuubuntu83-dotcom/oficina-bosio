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
