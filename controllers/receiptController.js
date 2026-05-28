import pool from '../config/database.js';

function mapReceipt(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    nf: row.nf,
    internBatch: row.intern_batch,
    situation: row.situation,
    quantity: row.quantity,
    responsible: row.responsible,
    observation: row.observation,
    receiveDate: row.receive_date,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export const listReceipts = async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public."Receipt" ORDER BY id DESC');
    return res.json(rows.map(mapReceipt));
  } catch (error) {
    console.error('[Receipt] list error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createReceipt = async (req, res) => {
  try {
    const body = req.body || {};
    const actor = req.user?.email || req.user?.username || null;
    const { rows } = await pool.query(
      `INSERT INTO public."Receipt"
        (nf, intern_batch, situation, quantity, responsible, observation, receive_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        body.nf || null,
        body.internBatch || null,
        body.situation || null,
        body.quantity || null,
        body.responsible || null,
        body.observation || null,
        body.receiveDate || null,
        actor,
      ],
    );
    return res.status(201).json(mapReceipt(rows[0]));
  } catch (error) {
    console.error('[Receipt] create error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateReceipt = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id invalido.' });
    const body = req.body || {};
    const { rows } = await pool.query(
      `UPDATE public."Receipt" SET
        nf = $2,
        intern_batch = $3,
        situation = $4,
        quantity = $5,
        responsible = $6,
        observation = $7,
        receive_date = $8
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.nf || null,
        body.internBatch || null,
        body.situation || null,
        body.quantity || null,
        body.responsible || null,
        body.observation || null,
        body.receiveDate || null,
      ],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Recebimento nao encontrado.' });
    return res.json(mapReceipt(rows[0]));
  } catch (error) {
    console.error('[Receipt] update error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteReceipt = async (req, res) => {
  try {
    const id = Number(req.query.id ?? req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id invalido.' });
    const deleted = await pool.query('DELETE FROM public."Receipt" WHERE id = $1', [id]);
    if (deleted.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Erro ao deletar recebimento, recebimento nao encontrado' });
    }
    return res.json(`Deletar recebimento ${id} realizado com sucesso`);
  } catch (error) {
    console.error('[Receipt] delete error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
