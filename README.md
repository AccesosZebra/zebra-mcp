# zebra-mcp · Reporte de Métricas

Dos cosas en un solo servicio Node, sin framework:

- **Servidor MCP** (`/mcp`): expone la base de métricas de Zebra a Claude en modo solo lectura.
- **Data Chat** (`/`): pantalla interna donde el equipo pregunta en lenguaje natural. El backend
  (`/api/chat`) manda la pregunta a la API de Anthropic con el MCP conectado y devuelve la
  respuesta en streaming.

Desplegado en EasyPanel (VPS 177.7.43.4), proyecto y app `zebra-mcp`:
<https://zebra-mcp-zebra-mcp.anof8l.easypanel.host/>

Cada cliente puede tener su propia instancia: todo, incluido WhatsApp, vive en este repo y en su
base del dashboard. No depende de ningún servicio externo de Zebra.

## Levantar una instancia

```bash
cp .env.example .env          # rellenarlo
docker compose up -d --build  # el servidor y su Postgres; el esquema se aplica solo al arrancar
```

Luego, en el panel: **Integración WA → Añadir número → escanear el QR → elegir los grupos**.

## Archivos

| Archivo | Qué hace |
|---|---|
| `server.mjs` | Arranque, ruta `/mcp` con token, `/health`, y monta chat, login y WhatsApp si hay configuración |
| `chat.mjs` | `/api/chat` (Claude + conector MCP, NDJSON) y `/api/me` |
| `proveedores.mjs` | Quién contesta: registro de proveedores, el prompt común y la elección activa |
| `ajustes.mjs` | `/api/settings`: proveedor y modelo, claves de IA, la base del negocio y los permisos, desde la pantalla Ajustes |
| `db.mjs` | La base del dashboard: lo que se administra desde el panel |
| `app-schema.sql` | Tablas de esa base. Re-ejecutable; el servidor lo aplica al arrancar |
| `guia.mjs` | Lo que describe la base de métricas de esta instancia: nombre del negocio, guía, borrador y permisos |
| `whatsapp.mjs` | El bot de WhatsApp: una conexión por número dentro del proceso, y cuándo contestar |
| `wa-admin.mjs` | Las rutas de la pantalla "Integración WA" |
| `docker-compose.yml` | Una instancia completa: el servidor y su base del dashboard |
| `auth.mjs` | Login con Google (equipo, admin) y con contraseña (cliente), cookie firmada con rol |
| `usuarios.mjs` | Usuarios con contraseña: scrypt, freno de intentos y revocación de sesiones |
| `admin.mjs` | La pestaña Admin: crear, resetear, activar y borrar usuarios |
| `public/chat.html` | La interfaz: barra lateral, conversación, tablas y consultas |
| `public/login.html` | Pantalla de acceso |
| `grants.sql` | Permisos del rol de lectura. Sin nombres fijos; re-ejecutable |
| `check.mjs` | Comprobaciones del MCP contra un servidor en marcha |
| `auth.check.mjs` | Comprobaciones de la firma de sesión |

## Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres con el rol `claude_readonly` |
| `MCP_AUTH_TOKEN` | Token que exige `/mcp` en la cabecera `Authorization` |
| `PORT` | Puerto, 3000 por defecto |
| `ANTHROPIC_API_KEY` | Opcional. Respaldo de la clave de Anthropic, que normalmente se pega en Ajustes |
| `OPENAI_API_KEY` | Opcional. Igual, para OpenAI |
| `METRICAS_ADMIN_URL` | Opcional. Conexión de administrador a la base de métricas, solo para aplicar `grants.sql` (al arrancar y desde Ajustes) |
| `AI_PROVIDER` | `anthropic` (por defecto) u `openai`. Solo vale hasta el primer guardado en Ajustes |
| `AI_MODEL` | Modelo del proveedor elegido. Vacío = el de por defecto del proveedor |
| `APP_DATABASE_URL` | Base del dashboard. Sin ella, Ajustes no puede guardar y WhatsApp no se monta. Con compose la arma él desde `APP_DB_PASSWORD` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Cliente OAuth de Google |
| `AUTH_SESSION_SECRET` | Firma de la cookie de sesión (`openssl rand -hex 32`) |
| `AUTH_BASE_URL` | URL pública. De aquí sale la URI de retorno y la URL del MCP |
| `AUTH_ALLOWED_DOMAIN` | Dominios que entran con Google como administradores, separados por comas. `zebradigital.marketing` por defecto |

Si falta alguna de las cuatro de Google y sesión (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`AUTH_SESSION_SECRET`, `AUTH_BASE_URL`), el chat no se monta y el MCP sigue funcionando solo. Las
claves de IA no hacen falta para arrancar: sin ninguna, el chat dice que falta y dónde pegarla. WhatsApp no tiene variables propias: solo necesita `APP_DATABASE_URL`.

## Las dos bases

| Base | Variable | Para qué |
|---|---|---|
| Métricas | `DATABASE_URL` | La de los clientes. Solo lectura, rol `claude_readonly`, es la que consulta el MCP |
| Dashboard | `APP_DATABASE_URL` | Lo que se administra desde el panel, y la sesión de WhatsApp |

La del dashboard es Postgres 17 sin puerto público (en Zebra, el servicio `zebra-mcp_db` de
EasyPanel; en compose, el servicio `db`). Sus tablas están en `app-schema.sql`. Ahí van las
claves de IA, cifradas, y la sesión de WhatsApp (`wa_sesion`), que no: quien lea esa tabla puede
hacerse pasar por el bot, así que la base no se expone.

## La pantalla "Ajustes"

Elige qué proveedor y qué modelo responden, en el chat web y en WhatsApp. El cambio surte efecto
en el turno siguiente, sin desplegar: se guarda en la tabla `ajustes` (clave `ia`) junto con el
correo de quien lo cambió. Lo guardado se lee una vez al arrancar y se recuerda en memoria.

Mientras no se haya guardado nada, mandan `AI_PROVIDER` y `AI_MODEL`. Después manda la base. Sin
`APP_DATABASE_URL` la pantalla sigue mostrando quién contesta, pero avisa de que no puede guardar
en vez de fingir que guardó.

### La base de este negocio

Cada instancia apunta a una base de métricas parecida a la de Zebra, pero no igual. Lo que el
modelo necesita saber de ella se edita aquí, no en el código (`guia.mjs`):

- **Nombre del negocio y a qué se dedica**: entran en el prompt ("Eres el analista de datos de…")
  y en el título del chat.
- **Guía de la base**: va en la descripción de `list_tables` y `query_readonly`, así que el modelo
  la lee antes de cada consulta. Vale desde la pregunta siguiente, sin reiniciar. Sin guía se usa
  una genérica que manda a explorar con `list_tables` y `get_schema`: funciona, pero más lento.
- **Generar borrador con IA**: recorre lo que ve el rol de lectura (esquemas, tablas, columnas y
  2 filas de ejemplo por objeto, hasta 150 objetos) y el modelo en uso redacta la guía. No se
  guarda sola: se revisa y se guarda.
- **Semilla de Zebra**: la primera vez que arranca, si no hay contexto guardado y la base tiene
  `mart.v_kpi_diario`, se guarda la guía de siempre de Zebra. En un clon no se siembra nada.
- **Permisos de lectura**: el panel dice cuántas vistas ve el bot. Con `METRICAS_ADMIN_URL`, el
  servidor aplica `grants.sql` al arrancar y hay un botón para repetirlo cuando se crean vistas.
  Sin ella, a mano: `psql "<conexión de administrador>" -c "set zebra.lector = 'claude_readonly'" -f grants.sql`.

### Claves de API

Cada tarjeta tiene su **Clave de API**: se pega ahí, sin entrar a EasyPanel.

- Antes de guardarla se prueba contra el proveedor (pidiendo su lista de modelos). Si no la
  acepta, no se guarda y se muestra por qué.
- Se guarda en `ajustes` (clave `claves-ia`) cifrada con AES-256-GCM. La llave se deriva de
  `AUTH_SESSION_SECRET` con HKDF: una copia de la base sola no basta para leerlas. **Rotar
  `AUTH_SESSION_SECRET` las deja ilegibles**: la tarjeta lo dice y hay que volver a pegarlas.
- Nunca vuelve al navegador: la pantalla solo sabe si hay clave, de dónde viene y sus últimos
  4 caracteres. En los logs queda quién la cambió, no cuál.
- Manda la del panel; si no hay, la variable de entorno. Así una instancia vieja sigue funcionando
  hasta que alguien pegue la suya, y después la variable se puede borrar.

## Quién entra

Dos puertas, como en Zebra Reports:

| Puerta | Quién | Rol | Ve |
|---|---|---|---|
| Google | Correos verificados de `AUTH_ALLOWED_DOMAIN` (lista) | `admin` | Todo |
| Correo y contraseña | Usuarios creados en **Admin** | `cliente` | Data Chat e Integración WA |

- Ajustes y Admin están cerrados en el servidor (`requireAdmin`), no solo escondidos.
- Las contraseñas se guardan con scrypt (`usuarios.mjs`); al crear o resetear se genera una
  temporal que se muestra una sola vez. El usuario la cambia desde **Clave**, en la barra lateral.
- La cookie de un cliente lleva su versión de sesión: resetear, cambiar la contraseña o
  desactivarlo lo saca (al instante en este proceso; en ≤ 60 s si hubiera caché vieja).
- 5 intentos fallidos por correo en 15 minutos y se frena. Un solo mensaje para "no existe" y
  "contraseña incorrecta".
- Sin `APP_DATABASE_URL` no hay acceso con contraseña: la página de login solo muestra Google.
- El botón de Google es el de Identity Services ("Acceder como…"): el navegador recibe un ID token y
  `POST /auth/google` lo verifica con `tokeninfo` (audiencia, emisor, vigencia, correo verificado).
  **Cada dominio tiene que estar en "Orígenes de JavaScript autorizados"** del cliente OAuth, además
  de `<dominio>/auth/callback` en las URI de redirección. Si el botón no se pinta, la página ofrece
  el flujo con redirección (`/auth/google`) como respaldo.

## WhatsApp

`whatsapp.mjs` es el bot, sin pasarela externa: cada número es un dispositivo vinculado (como
WhatsApp Web) que vive dentro de este proceso, con [Baileys](https://github.com/WhiskeySockets/Baileys).
Es la misma librería que usa Evolution API por dentro, y como ella **no es oficial**: WhatsApp
puede bloquear un número que se use para spam. Para un bot que solo contesta cuando lo mencionan
en grupos propios, el riesgo es bajo.

1. Al arrancar se reconectan los números que ya estaban vinculados; sus llaves viven en la tabla
   `wa_sesion`, así que un despliegue no obliga a escanear otra vez.
2. Solo se contesta en los grupos de la tabla `wa_grupos` de ese número, y solo si mencionan al bot
   o responden a un mensaje suyo. Se descartan los mensajes propios, los privados y los que no son
   texto. **La mención llega como `@lid`**, no como el teléfono: el bot reconoce sus dos nombres,
   que salen de `sock.user`.
3. Cada grupo es de un cliente: dentro de ese grupo las preguntas se entienden de ese cliente sin
   repetirlo, y el prompt le prohíbe traer datos de otro.
4. Si se corta la red, reconecta solo, con espera creciente hasta 1 min. Si lo desvinculan desde el
   teléfono, olvida las llaves y queda "Sin vincular" hasta escanear otra vez.

El historial vive en memoria, por grupo, con media hora de vida y un máximo de 12 mensajes.
El prompt cambia para este canal: sin tablas ni encabezados, que en WhatsApp no se ven.

**Una sola réplica.** WhatsApp acepta una conexión por dispositivo: dos procesos con la misma base
se tumbarían el uno al otro. No escalar el servicio a más de una instancia.

### La pantalla "Integración WA"

`wa-admin.mjs` monta lo que usa esa sección del panel, todo detrás del login de Google:

| Ruta | Qué hace |
|---|---|
| `GET /api/wa/numeros` | Los números guardados, con su estado real y los grupos de cada uno |
| `POST /api/wa/numeros` | Guarda un número nuevo |
| `GET /api/wa/numeros/:i/qr` | Abre la conexión si hace falta y devuelve el QR (data URL PNG) o el estado |
| `GET /api/wa/numeros/:i/groups` | Los grupos donde está ese teléfono, para elegirlos |
| `DELETE /api/wa/numeros/:i/session` | Desvincula el teléfono y olvida sus llaves, sin borrar el número |
| `DELETE /api/wa/numeros/:i` | Borra el número: lo desvincula y se lleva sus grupos y su sesión |
| `POST /api/wa/grupos` | Pone un grupo a cargo de un número, con su cliente |
| `DELETE /api/wa/grupos/:jid` | Deja de contestar en ese grupo |

El nombre de la conexión se valida contra `/^[a-z0-9][a-z0-9_-]{2,30}$/` antes de tocar nada,
porque lo escribe una persona y acaba dentro de una URL. El QR caduca si nadie lo escanea: la
conexión se cierra y se vuelve a abrir cuando el panel lo pide otra vez.

La URI `<AUTH_BASE_URL>/auth/callback` tiene que estar registrada en el cliente OAuth de Google.

## Desarrollo

```bash
npm install
node --env-file=.env server.mjs        # necesita un .env local (no se versiona)
npm run check                          # comprueba el MCP contra localhost:3000
node auth.check.mjs                    # comprueba la firma de sesión
for f in whatsapp wa-admin db chat proveedores; do node $f.check.mjs; done   # el resto, sin red ni base
MCP_URL=https://<host>/mcp npm run check   # lo mismo contra el servidor desplegado
```

## Seguridad

- El rol `claude_readonly` solo tiene SELECT: sobre `mart`, `crm`, `ops` y `ads` completos, y
  únicamente sobre las **vistas** de cada esquema de cliente. Nunca sobre sus tablas en bruto ni
  sobre `chats`.
- Cada consulta corre en una transacción de solo lectura, envuelta en un `SELECT`, con el
  protocolo extendido (una sola sentencia), 20 s de límite y un tope de 500 filas.
- `/mcp` exige el token; el resto exige sesión de Google del dominio permitido.

## Una instancia para un cliente

1. Base de métricas del cliente con un rol de solo lectura (`create role claude_readonly login password '…'`).
2. `cp .env.example .env`: `DATABASE_URL` con ese rol, Google, `AUTH_*`, `APP_DB_PASSWORD` y,
   si se quiere el botón de permisos, `METRICAS_ADMIN_URL`.
3. `docker compose up -d --build`.
4. En el panel, **Ajustes**: pegar la clave de IA, elegir modelo, poner el nombre del negocio,
   **Generar borrador**, revisarlo y guardar. Comprobar en "Permisos de lectura" que el bot ve las vistas.
5. **Integración WA**: añadir el número, escanear el QR y activar los grupos (ver "Manual de uso").
