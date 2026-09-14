# zebra-mcp · Reporte de Métricas

Dos cosas en un solo servicio Node, sin framework:

- **Servidor MCP** (`/mcp`): expone la base de métricas de Zebra a Claude en modo solo lectura.
- **Data Chat** (`/`): pantalla interna donde el equipo pregunta en lenguaje natural. El backend
  (`/api/chat`) manda la pregunta a la API de Anthropic con el MCP conectado y devuelve la
  respuesta en streaming.

Desplegado en EasyPanel (VPS 177.7.43.4), proyecto y app `zebra-mcp`:
<https://zebra-mcp-zebra-mcp.anof8l.easypanel.host/>

## Archivos

| Archivo | Qué hace |
|---|---|
| `server.mjs` | Arranque, ruta `/mcp` con token, `/health`, y monta chat y login si hay configuración |
| `chat.mjs` | `/api/chat` (Claude + conector MCP, NDJSON) y `/api/me` |
| `auth.mjs` | Login con Google y cookie de sesión firmada (HMAC), restringido a un dominio |
| `public/chat.html` | La interfaz: barra lateral, conversación, tablas y consultas |
| `public/login.html` | Pantalla de acceso |
| `grants.sql` | Permisos del rol `claude_readonly`. Re-ejecutable |
| `check.mjs` | Comprobaciones del MCP contra un servidor en marcha |
| `auth.check.mjs` | Comprobaciones de la firma de sesión |

## Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres con el rol `claude_readonly` |
| `MCP_AUTH_TOKEN` | Token que exige `/mcp` en la cabecera `Authorization` |
| `PORT` | Puerto, 3000 por defecto |
| `ANTHROPIC_API_KEY` | Clave de la API de Anthropic |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Cliente OAuth de Google |
| `AUTH_SESSION_SECRET` | Firma de la cookie de sesión (`openssl rand -hex 32`) |
| `AUTH_BASE_URL` | URL pública. De aquí sale la URI de retorno y la URL del MCP |
| `AUTH_ALLOWED_DOMAIN` | Dominio permitido. `zebradigital.marketing` por defecto |
| `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` | Pasarela de WhatsApp (Evolution API) |
| `WHATSAPP_WEBHOOK_SECRET` | Secreto que Evolution manda en la cabecera `x-zebra-secret` |
| `WHATSAPP_ALLOWED` | Números permitidos, separados por coma. Vacío = cualquiera que escriba |

Si falta alguna de las cinco primeras del bloque de login, el chat no se monta y el MCP sigue
funcionando solo. Igual con WhatsApp: sin sus cuatro variables, el resto no se entera.

## WhatsApp

`whatsapp.mjs` responde el webhook de Evolution API:

1. Evolution avisa a `POST /api/whatsapp` en cada `messages.upsert`, con el secreto en la cabecera.
2. Se descartan los mensajes propios, los de grupo, los que no son texto y los números fuera de
   `WHATSAPP_ALLOWED`.
3. Se responde 200 de inmediato (Evolution corta a los 30 s) y el turno se procesa aparte.
4. La respuesta vuelve por `POST /message/sendText/<instancia>` con la cabecera `apikey`.

El historial vive en memoria, por número, con media hora de vida y un máximo de 12 mensajes.
El prompt cambia para este canal: sin tablas ni encabezados, que en WhatsApp no se ven.

Para configurar el webhook de la instancia:

```bash
curl -X POST "$EVOLUTION_URL/webhook/set/$EVOLUTION_INSTANCE" \
  -H "apikey: $EVOLUTION_API_KEY" -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://<host>/api/whatsapp",
       "events":["MESSAGES_UPSERT"],"headers":{"x-zebra-secret":"<secreto>"}}}'
```
La URI `<AUTH_BASE_URL>/auth/callback` tiene que estar registrada en el cliente OAuth de Google.

## Desarrollo

```bash
npm install
node --env-file=.env server.mjs        # necesita un .env local (no se versiona)
npm run check                          # comprueba el MCP contra localhost:3000
node auth.check.mjs                    # comprueba la firma de sesión
MCP_URL=https://<host>/mcp npm run check   # lo mismo contra el servidor desplegado
```

## Seguridad

- El rol `claude_readonly` solo tiene SELECT: sobre `mart`, `crm`, `ops` y `ads` completos, y
  únicamente sobre las **vistas** de cada esquema de cliente. Nunca sobre sus tablas en bruto ni
  sobre `chats`.
- Cada consulta corre en una transacción de solo lectura, envuelta en un `SELECT`, con el
  protocolo extendido (una sola sentencia), 20 s de límite y un tope de 500 filas.
- `/mcp` exige el token; el resto exige sesión de Google del dominio permitido.
