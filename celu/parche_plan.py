# Parche de la Oficina Bosio para el celu bot: agrega el PLAN DE HOY de Instagram al estado que el celu manda al buzón.
# No cambia nada de cómo publica. Se puede correr varias veces sin problema.
import pathlib
f = pathlib.Path.home() / "celu_solo" / "oficina.py"
txt = f.read_text(encoding="utf-8")
MARCA = "# --- parche oficina-bosio: plan de hoy"
if MARCA in txt:
    print("El parche ya estaba puesto. Todo OK.")
else:
    txt += '''

''' + MARCA + '''
_estado_sin_plan = estado


def _plan_hoy():
    import re as _re
    try:
        with open(BOT / "bot_celu.log", "rb") as _f:
            _f.seek(0, 2)
            _f.seek(max(0, _f.tell() - 3_000_000))
            t = _f.read().decode("utf-8", "ignore")
        i = t.rfind("] PLAN DE HOY:")
        if i < 0:
            return {}
        tareas = []
        for l in t[i:].splitlines()[1:]:
            m = _re.match(r"\\s+(\\d\\d:\\d\\d)\\s+(\\S+)(?: x(\\d+))?\\s*$", l)
            if not m:
                break
            tareas.append([m.group(1), m.group(2), int(m.group(3) or 0)])
        return {"fecha": t[i - 19:i - 9], "tareas": tareas}
    except Exception:
        return {}


def estado(fab, bot_corriendo):
    e = _estado_sin_plan(fab, bot_corriendo)
    try:
        e["plan_hoy"] = _plan_hoy()
    except Exception:
        pass
    return e
'''
    f.write_text(txt, encoding="utf-8")
    print("Parche puesto. Ahora el celu manda el plan de hoy a la oficina.")
