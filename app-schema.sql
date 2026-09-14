-- Base del dashboard: servicio "zebra-mcp_db" del proyecto zebra-mcp, base "zebra-mcp".
-- Aquí vive lo que se administra desde el panel. Las claves de API NO: esas siguen en el entorno.
-- Re-ejecutable: aplicarlo dos veces no hace daño.
--
--   docker exec $(docker ps -q -f name=zebra-mcp_db) psql -U postgres -d zebra-mcp -f -   < app-schema.sql
--
-- ponytail: la app entra como "postgres" a su propia base, que solo guarda preferencias.
-- Si algún día guarda datos de clientes, toca un rol propio sin permisos de DDL.

-- Qué proveedor y modelo responden. Clave/valor para no migrar la tabla por cada preferencia nueva.
create table if not exists ajustes (
  clave       text primary key,
  valor       jsonb not null,
  actualizado timestamptz not null default now(),
  por         text                                  -- correo de quien lo cambió, para saber a quién preguntar
);

-- Los grupos de WhatsApp donde el bot contesta, uno por cliente. Antes vivían en WHATSAPP_GROUPS.
create table if not exists wa_grupos (
  jid     text primary key,                         -- 1203…@g.us
  cliente text,                                     -- null = grupo sin ámbito de cliente
  creado  timestamptz not null default now()
);
