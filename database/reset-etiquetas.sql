-- Reset de etiquetagem em TODA a base.
--   (A) Remove todos os anexos .txt de etiqueta (label_8c, label_9c, label_11c, label_tensylon)
--   (B) Desmarca o checkbox de etiquetagem (reviews.labeling = false) em todos os planos
--
-- Apagar a linha em file_storage remove o vínculo em cutting_plan_attachment
-- automaticamente (FK ON DELETE CASCADE em config/database.js).
--
-- OBS: os arquivos físicos .txt no disco (file_storage.path) NÃO são apagados por
-- SQL. Para limpá-los do disco, exporte os caminhos com o \copy abaixo ANTES do
-- DELETE, ou use o comando find no diretório de uploads (ver README/instruções).
--
-- Uso:  psql "$DATABASE_URL" -f database/reset-etiquetas.sql

-- (Opcional) Exportar caminhos físicos ANTES de apagar, p/ limpar o disco depois:
-- \copy (SELECT fs.path FROM maestro.file_storage fs \
--        JOIN maestro.cutting_plan_attachment cpa ON cpa.file_id = fs.id \
--        WHERE cpa.type IN ('label_8c','label_9c','label_11c','label_tensylon')) \
--   TO 'txt-orfaos.txt'

BEGIN;

-- Diagnóstico (antes)
SELECT count(*) AS anexos_txt_antes
  FROM maestro.cutting_plan_attachment
 WHERE type IN ('label_8c','label_9c','label_11c','label_tensylon');

SELECT count(*) AS planos_com_labeling_marcado
  FROM maestro.cutting_plan
 WHERE reviews->>'labeling' = 'true';

-- (A) Remover anexos .txt de etiqueta de toda a base (cascade limpa cutting_plan_attachment).
DELETE FROM maestro.file_storage fs
 USING maestro.cutting_plan_attachment cpa
 WHERE cpa.file_id = fs.id
   AND cpa.type IN ('label_8c','label_9c','label_11c','label_tensylon');

-- (B) Desmarcar o checkbox de etiquetagem em todos os planos.
UPDATE maestro.cutting_plan
   SET reviews = jsonb_set(reviews, '{labeling}', 'false'::jsonb, true)
 WHERE reviews->>'labeling' IS DISTINCT FROM 'false';

-- Diagnóstico (depois)
SELECT count(*) AS anexos_txt_depois
  FROM maestro.cutting_plan_attachment
 WHERE type IN ('label_8c','label_9c','label_11c','label_tensylon');

COMMIT;
