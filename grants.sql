-- Permisos del rol de lectura (el usuario de DATABASE_URL). Re-ejecutable: aplicarlo dos veces no
-- hace daño, y hay que volver a correrlo cada vez que se crean vistas nuevas.
--
-- El servidor lo aplica solo al arrancar, y desde Ajustes, si tiene METRICAS_ADMIN_URL. A mano:
--   psql "$METRICAS_ADMIN_URL" -c "set zebra.lector = 'claude_readonly'" -f grants.sql
--
-- Nada de nombres fijos: el rol sale de zebra.lector (por defecto claude_readonly), la base es la
-- actual y los privilegios por defecto se dan en nombre del dueño de cada esquema, que es quien
-- crea sus tablas. El rol tiene que existir ya (se crea una vez, con su contraseña).
DO $$
DECLARE
  lector text := coalesce(nullif(current_setting('zebra.lector', true), ''), 'claude_readonly');
  v record;
BEGIN
  EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 5', lector);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', lector);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', lector, '20s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', lector, '30s');
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), lector);

  -- Capa canónica (si existe en esta base): todas sus tablas y vistas, también las que se creen después.
  FOR v IN SELECT nspname, pg_get_userbyid(nspowner) AS duenio FROM pg_namespace
            WHERE nspname IN ('mart', 'crm', 'ops', 'ads')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v.nspname, lector);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', v.nspname, lector);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO %I', v.duenio, v.nspname, lector);
  END LOOP;

  -- Esquemas de cliente: solo vistas, nunca las tablas en bruto ni "chats".
  -- (Sin DEFAULT PRIVILEGES aquí: en Postgres cubrirían también las tablas.)
  FOR v IN SELECT schemaname, viewname FROM pg_views
            WHERE schemaname NOT IN ('mart', 'crm', 'ops', 'ads', 'public', 'pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v.schemaname, lector);
    EXECUTE format('GRANT SELECT ON %I.%I TO %I', v.schemaname, v.viewname, lector);
  END LOOP;
END $$;
