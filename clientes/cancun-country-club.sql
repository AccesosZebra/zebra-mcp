-- Cancún Country Club (VPS vps-ccc, base cancun_country_club): lo que el bot puede leer.
--
-- Vistas en el esquema "metricas" con el embudo y las llamadas SIN datos personales: nada de
-- nombres, teléfonos, correos, hashes, links, payload, user agent, URLs, transcripciones, textos
-- del análisis, chats ni PDFs. Solo crea vistas: no toca ni borra ninguna tabla.
-- Re-ejecutable. Si cambian las tablas de origen, se corre otra vez y luego grants.sql.
--
--   docker exec -i <contenedor> psql -U postgres -d cancun_country_club < clientes/cancun-country-club.sql

create schema if not exists metricas;
comment on schema metricas is 'Vistas sin datos personales para el bot de métricas (zebra-mcp).';

-- ── Entrada de leads ────────────────────────────────────────────────────────
create or replace view metricas.leads as
select id, fecha_creacion, asesor_id, campana, adset, ad, atribucion,
       pais, estado, ciudad, formulario, tipo_lead, enganche, presupuesto, tiempo, proyecto,
       origin_channel, device_platform, fb_campaign_name, fb_adset_name, fb_ad_name
  from cancun_country_club.e00_entrada_leads;

-- ── Etapas registradas por el CRM de mensajería (id de texto) ───────────────
create or replace view metricas.contacto_establecido as
select id, id_postgres, fecha_evento, proyecto, campana, adset, ad, atribucion,
       atendido_por_ia, agendado_por_ia, id_usuario, formulario
  from cancun_country_club.e01_contacto_establecido;

create or replace view metricas.precalificado as
select id, id_postgres, fecha_evento, proyecto, campana, adset, ad, atribucion,
       atendido_por_ia, agendado_por_ia, id_usuario, formulario
  from cancun_country_club.e02_precalificado;

create or replace view metricas.cita_agendada as
select id, id_postgres, fecha_evento, fecha_videollamada, tipo_evento, proyecto, campana, adset, ad,
       atribucion, atendido_por_ia, agendado_por_ia, id_usuario, formulario
  from cancun_country_club.e04_cita_agendada;

create or replace view metricas.ventas_perdidas as
select id, id_postgres, fecha_evento, id_razon_perdida, id_embudo, id_etapa_previa, campana, adset, ad,
       atribucion, atendido_por_ia, agendado_por_ia, id_usuario, formulario
  from cancun_country_club.e10_ventas_perdidas;

-- ── Etapas de oportunidad (pipeline, asesor y monto) ────────────────────────
create or replace view metricas.calificado as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e03_calificado;

create or replace view metricas.asistencia as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e05_asistencia;

create or replace view metricas.apartado as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e06_apartado;

create or replace view metricas.cubierto_30 as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e07_cubierto_30;

create or replace view metricas.firma_contrato as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e08_firma_contrato;

create or replace view metricas.cierre as
select id, contact_id, opportunity_id, pipeline, etapa, asesor, fuente, campana, conjunto, anuncio,
       monto, fecha_evento, created_at
  from cancun_country_club.e09_cierre;

-- ── Llamadas (sin número de la contraparte ni grabaciones) ──────────────────
create or replace view metricas.llamadas as
select cuenta, call_id, fecha, asesor, ciudad, duracion_seg, estatus, n_grabaciones
  from zebra.llamadas;

-- Solo la calificación numérica: los textos del análisis salen de la transcripción.
create or replace view metricas.llamadas_calificacion as
select cuenta, call_id, estado, tipo_contacto, calif_global, procesado_at
  from zebra.analisis;
