-- Permisos de claude_readonly. El rol se crea una sola vez (contraseña en .env); este archivo es re-ejecutable.
-- Vuelve a correrlo cuando se agreguen vistas nuevas en los esquemas de cliente.
ALTER ROLE claude_readonly CONNECTION LIMIT 5;
ALTER ROLE claude_readonly SET default_transaction_read_only = on;
ALTER ROLE claude_readonly SET statement_timeout = '20s';
ALTER ROLE claude_readonly SET idle_in_transaction_session_timeout = '30s';
GRANT CONNECT ON DATABASE postgres TO claude_readonly;

-- Capa canónica: todas sus tablas y vistas, también las que se creen después.
GRANT USAGE ON SCHEMA mart, crm, ops, ads TO claude_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA mart, crm, ops, ads TO claude_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA mart, crm, ops, ads GRANT SELECT ON TABLES TO claude_readonly;

-- Esquemas de cliente: solo vistas, nunca las tablas en bruto ni "chats".
-- (Sin DEFAULT PRIVILEGES aquí: en Postgres cubrirían también las tablas.)
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT schemaname, viewname FROM pg_views
            WHERE schemaname NOT IN ('mart', 'crm', 'ops', 'ads', 'public', 'pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO claude_readonly', v.schemaname);
    EXECUTE format('GRANT SELECT ON %I.%I TO claude_readonly', v.schemaname, v.viewname);
  END LOOP;
END $$;
