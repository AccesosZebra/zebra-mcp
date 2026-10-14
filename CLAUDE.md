# zebra-mcp

## Al empezar cada sesión: preguntar en qué rama trabajar

Antes de leer, editar o commitear nada en este repo, pregunta a Carlos en qué rama vamos a trabajar
y espera la respuesta:

- **`main`**: la instancia de Zebra (VPS `vps-zebra`, se despliega a mano).
- **`cancun`**: la instancia de Cancún Country Club (VPS `vps-ccc`; EasyPanel despliega esa rama).

Luego haz `git checkout <rama>`, confirma con `git branch --show-current` y dile en cuál quedó.

Reglas mientras trabajamos:
- Antes de cada commit, vuelve a confirmar la rama. Un cambio de Cancún nunca va a `main`.
- Lo general (que sirve a las dos instancias) se hace en `main` y se lleva a `cancun` con
  `git merge main` estando en `cancun`.
- No cambies de rama con cambios sin commitear.
