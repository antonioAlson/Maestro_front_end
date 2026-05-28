import pool from '../config/database.js';

// Colunas + JOIN com workorder para devolver packageId/workorderId/workorderLote
// no mesmo shape do Spring (entity Plates expõe esses campos via @JsonProperty).
const PLATE_SELECT = `
  SELECT
    p.id,
    p.plate_sequence       AS "plateSequence",
    p.status,
    p.layers,
    p.actual_size          AS "actualSize",
    p.init_size            AS "initSize",
    p.workorderid          AS "workorderId",
    p.package_id           AS "packageId",
    w.lote                 AS "workorderLote"
  FROM public.plates p
  LEFT JOIN public.workorder_table w ON w.id = p.workorderid
`;

function mapPlate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    plateSequence: Number(row.plateSequence),
    status: row.status,
    layers: Number(row.layers),
    actualSize: row.actualSize == null ? null : Number(row.actualSize),
    initSize: row.initSize == null ? null : Number(row.initSize),
    workorderId: row.workorderId == null ? null : Number(row.workorderId),
    packageId: row.packageId == null ? null : Number(row.packageId),
    workorderLote: row.workorderLote ?? null,
  };
}

// POST /api/plate  — body: [id1, id2, ...]  (Spring: findAllById)
export const findAllById = async (req, res) => {
  try {
    const ids = Array.isArray(req.body) ? req.body.map(Number).filter(Number.isFinite) : [];
    if (ids.length === 0) return res.json([]);

    const { rows } = await pool.query(
      `${PLATE_SELECT} WHERE p.id = ANY($1::bigint[]) ORDER BY p.id ASC`,
      [ids],
    );
    return res.json(rows.map(mapPlate));
  } catch (error) {
    console.error('[Plate] findAllById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/plate/getEstoque — placas em estoque (EM_ESTOQUE ou CONSUMO_PARCIAL)
export const findByInStock = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `${PLATE_SELECT}
       WHERE p.status IN ('EM_ESTOQUE', 'CONSUMO_PARCIAL')
       ORDER BY p.id ASC`,
    );
    return res.json(rows.map(mapPlate));
  } catch (error) {
    console.error('[Plate] findByInStock error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/plate/available — mesma regra de getEstoque (Spring duplicou)
export const findAvailable = findByInStock;

// GET /api/plate/:id
export const findById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const { rows } = await pool.query(`${PLATE_SELECT} WHERE p.id = $1`, [id]);
    if (rows.length === 0) return res.json(null);
    return res.json(mapPlate(rows[0]));
  } catch (error) {
    console.error('[Plate] findById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/plate/update-status — body: { plateId, newStatus }
// Mudança manual: cria plate_event ATUALIZACAO registrando o autor (vindo do JWT).
export const updateStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    const plateId = Number(req.body?.plateId);
    const newStatus = String(req.body?.newStatus || '').trim();
    if (!Number.isFinite(plateId) || !newStatus) {
      return res.status(400).json({ success: false, message: 'plateId e newStatus são obrigatórios.' });
    }

    await client.query('BEGIN');

    const current = await client.query(
      'SELECT status FROM public.plates WHERE id = $1 FOR UPDATE',
      [plateId],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Placa com ID ${plateId} não encontrada.` });
    }

    const previousStatus = current.rows[0].status;

    await client.query(
      'UPDATE public.plates SET status = $1 WHERE id = $2',
      [newStatus, plateId],
    );

    const actor = req.user?.email || req.user?.username || 'sistema';
    await client.query(
      `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
       VALUES ($1, 'ATUALIZACAO', now(), $2)`,
      [plateId, `Status alterado de ${previousStatus} para ${newStatus} por ${actor}`],
    );

    const { rows } = await client.query(`${PLATE_SELECT} WHERE p.id = $1`, [plateId]);
    await client.query('COMMIT');
    return res.json(mapPlate(rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Plate] updateStatus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};
