-- Base del dashboard: lo que se administra desde el panel. Las claves de API van en `ajustes`
-- (clave 'claves-ia') cifradas con AES-256-GCM: la llave sale de AUTH_SESSION_SECRET, que no vive
-- aquí. El servidor lo aplica solo al arrancar; es re-ejecutable, aplicarlo dos veces no hace daño.
--
-- ponytail: la app entra como "postgres" a su propia base, que guarda preferencias y la sesión de
-- WhatsApp. Si algún día guarda datos de clientes, toca un rol propio sin permisos de DDL.

-- Qué proveedor y modelo responden. Clave/valor para no migrar la tabla por cada preferencia nueva.
create table if not exists ajustes (
  clave       text primary key,
  valor       jsonb not null,
  actualizado timestamptz not null default now(),
  por         text                                  -- correo de quien lo cambió, para saber a quién preguntar
);

-- Los números de WhatsApp del bot. El nombre identifica la conexión y va dentro de una URL, así que el servidor lo valida contra /^[a-z0-9][a-z0-9_-]{2,30}$/ antes de crearlo.
create table if not exists wa_numeros (
  instancia text primary key,                       -- "zebra-bot"
  etiqueta  text,                                   -- "Bot Zebra", para leerlo en el panel
  creado    timestamptz not null default now(),
  por       text
);
-- Cuándo WhatsApp cerró la sesión por su cuenta (14 días sin usar el teléfono, o lo desvincularon
-- desde el teléfono). Null mientras está vinculado o si nunca lo estuvo.
alter table wa_numeros add column if not exists vencida timestamptz;
-- La clave con la que n8n envía mensajes por este número (nodo de Evolution). Solo su sha256 y
-- sus últimos 4: la clave entera se muestra una vez al generarla y no se guarda.
alter table wa_numeros add column if not exists api_hash text;
alter table wa_numeros add column if not exists api_fin text;
alter table wa_numeros add column if not exists api_creada timestamptz;
-- Kill switch: si WhatsApp empieza a rechazar los envíos de n8n por este número, se pausan aquí
-- hasta que alguien los reanude en el panel. Las respuestas del bot no se pausan.
alter table wa_numeros add column if not exists n8n_pausa timestamptz;
alter table wa_numeros add column if not exists n8n_pausa_motivo text;

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
-- El nombre del grupo al vincularlo, para mostrarlo en el panel (WhatsApp no lo da sin conexión).
alter table wa_grupos add column if not exists nombre text;

-- La sesión de cada número: las llaves del dispositivo vinculado. Sin esto, cada despliegue
-- obligaría a escanear el QR otra vez. Quien lea esta tabla puede hacerse pasar por el bot.
create table if not exists wa_sesion (
  instancia text not null references wa_numeros(instancia) on delete cascade,
  clave     text not null,                          -- 'creds' o '<tipo>-<id>': pre-key, session, sender-key…
  valor     jsonb not null,                         -- serializado con BufferJSON de Baileys
  primary key (instancia, clave)
);

-- Usuarios con contraseña: la gente del cliente, que no entra con Google. Los crea un
-- administrador en Ajustes → Usuarios. Nunca se guarda la contraseña, solo su hash scrypt.
create table if not exists usuarios (
  email  text primary key,                          -- siempre en minúsculas
  nombre text not null default '',
  hash   text not null,                             -- scrypt$N$r$p$salt$hash
  activo boolean not null default true,
  v      integer not null default 0,                -- subirla revoca todas sus sesiones vivas
  creado timestamptz not null default now(),
  por    text                                       -- correo del administrador que lo creó
);

-- Qué puede hacer: "admin" entra a Ajustes (IA y usuarios); "usuario" solo usa el panel.
-- El equipo de Zebra (Google) no vive aquí: es administrador siempre.
alter table usuarios add column if not exists rol text not null default 'usuario' check (rol in ('admin', 'usuario'));
