-- Política de reintento ante un 403 del servicio de push.
--
-- Numerada en este repo por pedido explícito de Luis (22 sep 2026), no por el
-- agente del Hub: ver CLAUDE.md §5.2. Igual que 0007, 0008 y 0009, entra al Hub
-- como historia.
--
-- EL PROBLEMA QUE CIERRA
-- ----------------------
-- Hasta acá `sendOne` (lib/push/server.ts) trataba un 403 como 'failed': no
-- borraba la fila y la reintentaba para siempre. Si las claves VAPID se rotan,
-- la suscripción vieja de un dispositivo que nunca vuelve a tocar "On" se
-- reintenta en CADA check, un minuto tras otro, sin que nada la limpie nunca.
--
-- Convertir el 403 en borrado directo sería PEOR: una VAPID mal configurada en
-- el server da 403 para TODAS las suscripciones a la vez, y borraría de un
-- saque las de toda la familia. Ese es el caso que esta columna distingue.
--
-- POR QUÉ UNA COLUMNA Y NO UN CONTADOR EN MEMORIA
-- -----------------------------------------------
-- El check corre en Vercel, serverless: cada invocación es un proceso nuevo y
-- efímero. Un contador en RAM no sobrevive de un minuto al siguiente, así que
-- "3 chequeos seguidos" sólo se puede contar en la base.
--
-- LA REGLA (implementada en runNursingCheck, lib/push/server.ts)
-- --------------------------------------------------------------
--   · Un envío OK                          → el contador vuelve a 0.
--   · 403 en ESTA suscripción mientras OTRA del mismo lote recibió el push
--     → +1. Al llegar a 3, se borra la fila: está muerta.
--   · TODAS las suscripciones del lote en 403 → no se toca ningún contador y
--     no se borra nada. Eso no es una suscripción muerta, es casi seguro una
--     VAPID mal puesta en el server, y se loguea para revisión a mano.
--   · Volver a suscribirse desde el navegador resetea el contador (el upsert
--     de saveSubscription lo pone en 0): son claves nuevas.
alter table push_subscriptions
  add column if not exists consecutive_403 smallint not null default 0
    check (consecutive_403 >= 0);

comment on column push_subscriptions.consecutive_403 is
  'Chequeos SEGUIDOS en los que esta suscripción dio 403 mientras otras del mismo lote sí recibieron el push. A 3, la fila se borra. Un envío OK lo devuelve a 0.';
