-- Base del dashboard: servicio "zebra-mcp_db" del proyecto zebra-mcp, base "zebra-mcp".
-- Aquí vive lo que se administra desde el panel. Las claves de API NO: esas siguen en el entorno.
-- Re-ejecutable: aplicarlo dos veces no hace daño.
--
--   docker exec -i $(docker ps -q -f name=zebra-mcp_db) psql -U postgres -d zebra-mcp -f -   < app-schema.sql
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

-- Los números de WhatsApp del bot. El nombre es el de la instancia en Evolution y va dentro de
-- una URL, así que el servidor lo valida contra /^[a-z0-9][a-z0-9_-]{2,30}$/ antes de crearlo.
create table if not exists wa_numeros (
  instancia text primary key,                       -- "zebra-bot"
  etiqueta  text,                                   -- "Bot Zebra", para leerlo en el panel
  creado    timestamptz not null default now(),
  por       text
);

-- Los grupos donde contesta, uno por cliente. Antes vivían en WHATSAPP_GROUPS.
create table if not exists wa_grupos (
  jid     text primary key,                         -- 1203…@g.us
  cliente text,                                     -- null = grupo sin ámbito de cliente
  creado  timestamptz not null default now()
);

-- Qué número atiende cada grupo. La clave sigue siendo el jid: un grupo lo atiende UNO, nunca dos.
alter table wa_grupos add column if not exists instancia text references wa_numeros(instancia);
alter table wa_grupos add column if not exists por text;
alter table wa_grupos alter column instancia set not null;
create index if not exists wa_grupos_instancia on wa_grupos (instancia);
