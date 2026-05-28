import pool from '../config/database.js';

// Enums espelhados das classes Spring (mantém ordem dos values() — o
// frontend usa essa lista p/ popular selects e a ordem importa para UX).
// MaterialType: Spring/production/cutting/enums/MaterialType.java
const MATERIALS = ['ARAMIDA', 'TENSYLON_30A', 'TENSYLON_40A'];

// KitType: typo DESENVOLIVMENTO preservado p/ paridade com dados existentes
// (R-2 do SPEC). Renomear futuramente requer migração de dados em produção.
const KIT_TYPES = ['KIT_COMUM', 'AVULSA', 'REBLINDAGEM', 'DESENVOLIVMENTO', 'CORPO_DE_PROVA'];

// GET /api/plate-events/plate/:plateId  — histórico (mais recente primeiro)
export const findByPlate = async (req, res) => {
  try {
    const plateId = Number(req.params.plateId);
    if (!Number.isFinite(plateId)) {
      return res.status(400).json({ success: false, message: 'plateId inválido.' });
    }

    const { rows } = await pool.query(
      `
        SELECT
          id,
          event_type               AS "eventType",
          event_date               AS "eventDate",
          consumption_reference_id AS "consumptionReferenceId",
          consumed_area            AS "consumedArea",
          consumed_length          AS "consumedLength",
          description
        FROM public.plate_event
        WHERE plate_id = $1
        ORDER BY event_date DESC
      `,
      [plateId],
    );
    return res.json(rows.map((row) => ({
      id: Number(row.id),
      eventType: row.eventType,
      eventDate: row.eventDate,
      consumptionReferenceId: row.consumptionReferenceId == null ? null : Number(row.consumptionReferenceId),
      consumedArea: row.consumedArea == null ? null : Number(row.consumedArea),
      consumedLength: row.consumedLength == null ? null : Number(row.consumedLength),
      description: row.description,
    })));
  } catch (error) {
    console.error('[PlateEvent] findByPlate error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/plate-events/metadata — alimenta selects de Material/Kit no corte
export const metadata = (_req, res) => {
  return res.json({ materials: MATERIALS, kitType: KIT_TYPES });
};
