// Lo que el bot sabe de esta instancia antes de consultar: quién es el negocio y la guía de su base.
// Rama cancun: una sola instancia, así que va fijo en el código y no se edita desde el panel. Para
// cambiarlo, se edita aquí y se despliega. Copiado de lo que estaba guardado en Ajustes (14 oct 2026).

export const CONTEXTO = {
  nombre: 'Cancun Country Club',
  giro: 'Desarrollo residencial de lujo',
  guia: `Base de métricas de “Cancun Country Club” (esquema metricas, solo lectura).

Usa siempre el esquema metricas; no hay capas adicionales (no hay mart/agregado vs bruto). Todas son vistas ya preprocesadas.

PATRONES GENERALES

1) Embudo “ligero” por eventos de marketing/CRM, con el mismo patrón de columnas:
   - Tablas: apartado, cita_agendada, contacto_establecido, precalificado, ventas_perdidas.
   - Llave de evento: id (text, a veces con sufijo “TEST-…”) e id_postgres (integer, casi siempre null en ejemplos).
   - Fecha del evento: fecha_evento (timestamp without time zone; los ejemplos traen solo fecha tipo “2026-10-08”, pero es timestamp).
   - Contexto de marketing:
     - proyecto (texto del desarrollo/proyecto inmobiliario)
     - campana, adset, ad (nombres de campaña, conjunto, anuncio)
     - atribucion (ej. “Meta Ads - Formulario TEST”)
     - formulario (nombre del formulario o fuente interna)
   - Contexto de atención:
     - atendido_por_ia, agendado_por_ia (texto, suelen ser “”, “No” o null: trampa, trátalas como flags poco confiables)
     - id_usuario (id o nombre del usuario/asesor que lo atendió; tipo text y sin catálogo aparte)

   Recomendación:
   - Para conteos de embudo (contactos, precalificados, citas, apartados, pérdidas), empieza por estas vistas; ya están alineadas por proyecto/campaña/anuncio y fecha_evento.
   - Ten cuidado con campos booleanos representados como texto (“No”, vacío, null).

2) Embudo “pesado” por pipeline/CRM, mismo patrón de columnas:
   - Tablas: asistencia, calificado, cierre, cubierto_30, firma_contrato.
   - Columnas comunes:
     - id (bigint, PK técnica del evento)
     - contact_id, opportunity_id (text, referencias al CRM, para unir etapas del mismo lead/oportunidad)
     - pipeline, etapa (text: nombre del pipeline y la etapa CRM)
     - asesor (nombre del asesor)
     - fuente, campana, conjunto, anuncio (atribución de origen más granular)
     - monto (numeric: importe asociado a la oportunidad/etapa, probablemente valor del negocio)
     - fechas:
       - fecha_evento (timestamp with time zone): cuándo ocurrió la etapa
       - created_at (timestamp with time zone): cuándo se registró en el sistema (útil para frescura / retraso)

   Recomendación:
   - Para análisis de funnel CRM por etapa (asistencia, calificación, cierre, firma de contrato, cobertura 30), usa estas tablas.
   - Únelas por contact_id y/o opportunity_id si necesitas el recorrido completo.
   - Usa fecha_evento para métricas de negocio cronológicas; created_at solo para auditoría o latencia.

TABLAS / VISTAS Y MÉTRICAS PRINCIPALES

metricas.apartado
- Qué representa: eventos donde un cliente aparta una unidad (reservas).
- Columnas clave:
  - fecha_evento: fecha de apartado.
  - monto (numeric): monto del apartado; en ejemplos viene bien tipado (no texto).
  - unidad: nombre/identificador de la unidad (“Villa 12”).
  - fracciones (integer): número de fracciones/unidades incluidas.
  - proyecto: proyecto inmobiliario.
  - campana, adset, ad, atribucion, formulario: contexto de marketing.
- Métricas típicas:
  - Número de apartados: COUNT(DISTINCT id) o COUNT(*).
  - Monto total apartado: SUM(monto).
  - Fracciones apartadas: SUM(fracciones).
- Trampas:
  - fecha_evento es timestamp sin zona pero los ejemplos son tipo fecha; no asumas siempre medianoche.

metricas.cita_agendada
- Qué representa: citas/videollamadas agendadas.
- Columnas clave:
  - fecha_evento: cuándo se genera la cita.
  - fecha_videollamada: fecha/hora concreta de la videollamada.
  - tipo_evento: tipo de cita (videollamada, presencial, etc.).
  - proyecto, campana, adset, ad, atribucion, formulario, id_usuario: contexto.
- Métricas típicas:
  - Citas agendadas por día/proyecto/campaña.
  - Tasa de avance de contacto_establecido → cita_agendada (uniendo por id o por proyecto+usuario+fecha, según el modelo de datos real).

metricas.contacto_establecido
- Qué representa: leads con contacto efectivo (ej. llamada contestada o interacción significativa).
- Columnas clave:
  - fecha_evento: fecha de primer contacto efectivo.
  - proyecto, campana, adset, ad, atribucion, formulario, id_usuario.
- Métricas:
  - Contactos efectivos por día/proyecto/campaña.
  - Primera etapa del embudo “ligero” tras leads.

metricas.precalificado
- Qué representa: leads que pasan filtro de precalificación (capacidad/presupuesto básico).
- Columnas clave:
  - fecha_evento, proyecto, campana, adset, ad, atribucion, formulario, id_usuario.
- Métricas:
  - Conteo de precalificados.
  - Tasa contacto_establecido → precalificado por proyecto/campaña.

metricas.ventas_perdidas
- Qué representa: oportunidades que se pierden en el embudo “ligero”.
- Columnas clave:
  - fecha_evento: fecha en que se marca la pérdida.
  - id_razon_perdida: motivo de pérdida (texto tipo “No califica”).
  - id_embudo, id_etapa_previa: referencia a flujo y etapa desde donde se perdió.
  - campana, adset, ad, atribucion, formulario, id_usuario.
- Métricas:
  - Volumen de ventas perdidas por motivo, proyecto, campaña.
  - Tasa de pérdida a partir de precalificado / cita / apartado, si se puede mapear por id_embudo.
- Trampas:
  - Campos id_embudo e id_etapa_previa son text sin diccionario aquí; tendrás que agrupar por valor literal.

metricas.asistencia
- Qué representa: asistencias (probablemente a visitas/citas/eventos) ligadas al CRM.
- Columnas clave:
  - contact_id, opportunity_id, pipeline, etapa, asesor.
  - fuente, campana, conjunto, anuncio.
  - monto (numeric): valor de la oportunidad en esta etapa.
  - fecha_evento, created_at (timestamptz).
- Métricas:
  - Asistencias por campaña/origen/asesor.
  - Valor (monto) asociado a asistencias.

metricas.calificado
- Qué representa: leads/oportunidades que llegan a etapa “calificado” en CRM.
- Columnas: mismo patrón que asistencia.
- Métricas:
  - Calificados por día/campaña/origen/asesor.
  - Tasa leads → calificado (uniendo con metricas.leads por campaña, asesor u origen).

metricas.cierre
- Qué representa: cierres de oportunidad (ventas ganadas) en CRM.
- Columnas: mismo patrón que asistencia/calificado.
- Métricas:
  - Número de cierres: COUNT(*).
  - Volumen vendido: SUM(monto).
  - Cierres por asesor, campaña, fuente, pipeline.
- Recomendación:
  - Usa cierre.monto como “valor de venta” siempre que te pidan facturación/ventas cerradas.

metricas.cubierto_30
- Qué representa: oportunidades “cubiertas” dentro de 30 días (seguimiento).
- Columnas: mismo patrón CRM.
- Métricas:
  - Cobertura 30 días por asesor/fuente.
  - Indicador de seguimiento adecuado.

metricas.firma_contrato
- Qué representa: etapa de firma de contrato en el CRM.
- Columnas: patrón CRM.
- Métricas:
  - Contratos firmados: conteo de eventos.
  - Monto en contratos firmados: SUM(monto).
- Uso:
  - Para “ventas firmadas” prefiere firma_contrato sobre cierre si el negocio distingue ambas.

metricas.leads
- Qué representa: generación de leads desde canales de marketing.
- Columnas clave:
  - fecha_creacion (date): fecha del lead (verdadero tipo date; no texto).
  - asesor_id: id del asesor asignado (text).
  - Atribución:
    - campana, adset, ad, atribucion, formulario.
    - origin_channel, device_platform.
    - fb_campaign_name, fb_adset_name, fb_ad_name (nombres crudos de Meta; pueden diferir de campana/adset/ad “limpios”).
  - Perfil del lead:
    - pais, estado, ciudad.
    - tipo_lead, enganche, presupuesto, tiempo, proyecto (todos TEXT, ojo: presupuesto y enganche no son numéricos).
- Métricas:
  - Leads generados por día, campaña, origen, dispositivo, formulario.
  - Embudo inicial: leads → contacto_establecido (mismas campañas/proyecto).
- Trampas:
  - enganche, presupuesto, tiempo están como text: no los trates como numéricos sin limpiarlos.
  - No hay monto numérico de oportunidad aquí; el monto llega en tablas CRM (calificado, cierre, etc.).

metricas.llamadas
- Qué representa: registro de llamadas telefónicas.
- Columnas:
  - cuenta (text): cuenta/origen del sistema de telefonía.
  - call_id (text): identificador único de llamada.
  - fecha (timestamptz): fecha/hora de la llamada.
  - asesor, ciudad.
  - duracion_seg (integer): duración en segundos.
  - estatus (text): estado de la llamada (ej. contestada, no contestada; no se dan ejemplos).
  - n_grabaciones (integer): número de grabaciones asociadas.
- Métricas:
  - Volumen de llamadas por asesor/fecha.
  - Tiempo total y promedio de conversación (SUM/AVG(duracion_seg)).
  - Tasa de intentos de contacto vs leads.

metricas.llamadas_calificacion
- Qué representa: calificación posterior de llamadas (calidad/contactabilidad).
- Columnas:
  - cuenta, call_id: para unir con metricas.llamadas.
  - estado: estado resultante de la gestión.
  - tipo_contacto: tipo de contacto logrado.
  - calif_global (integer): calificación global (escala no documentada aquí).
  - procesado_at (timestamptz): cuándo se procesó/evaluó la llamada.
- Métricas:
  - Calidad promedio de llamadas: AVG(calif_global).
  - Distribución por estado/tipo_contacto.

RESÚMENES Y PREFERENCIAS

- Leads: metricas.leads (fecha_creacion).
- Contacto efectivo: metricas.contacto_establecido.
- Precalificación: metricas.precalificado.
- Citas: metricas.cita_agendada (y asistencia para la parte CRM).
- Apartados: metricas.apartado (usa monto y fracciones).
- Ventas ganadas:
  - CRM: metricas.cierre (ventas ganadas) y metricas.firma_contrato (contratos firmados; preferible si preguntan explícitamente por “firmas”).
- Ventas perdidas: metricas.ventas_perdidas (motivo en id_razon_perdida).
- Seguimiento y cobertura: metricas.cubierto_30.
- Llamadas: metricas.llamadas + metricas.llamadas_calificacion para la calidad.
- Atributos por campaña/anuncio: campana, adset, ad + campos fb_* en leads.

No hay tablas de “mart” o agregadas; debes agrupar tú mismo. Todas las fechas están como date o timestamp (no como texto), pero hay muchos flags y montos potenciales guardados como text (enganche, presupuesto, tiempo), que requieren parsing si se usan como números.`,
};

export const contextoActual = () => CONTEXTO;
export const guiaActual = () => CONTEXTO.guia;

/** "Cancun Country Club, Desarrollo residencial de lujo", o "este negocio" si no hay nombre. */
export function quienEs(c = CONTEXTO) {
  const nombre = c?.nombre?.trim();
  if (!nombre) return 'este negocio';
  return c.giro?.trim() ? `${nombre}, ${c.giro.trim()}` : nombre;
}
