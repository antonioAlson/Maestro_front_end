import pool from '../config/database.js';

// GET /api/production-packs
// Lista todos os packs em ordem (seq ASC, id ASC) com contagem de OSs.
export const listarPacks = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pp.id, pp.name, pp.color, pp.seq, pp.target_date, pp.notes,
        pp.created_at, pp.updated_at,
        pp.created_by_user_id,
        u.email AS created_by_email,
        u.name  AS created_by_name,
        COALESCE(c.os_count, 0) AS os_count
      FROM maestro.production_pack pp
      LEFT JOIN maestro.users u ON u.id = pp.created_by_user_id
      LEFT JOIN (
        SELECT pack_id, COUNT(*)::int AS os_count
        FROM maestro.os_planning
        WHERE pack_id IS NOT NULL
        GROUP BY pack_id
      ) c ON c.pack_id = pp.id
      ORDER BY pp.seq ASC, pp.id ASC
    `);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('❌ Erro ao listar packs:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/production-packs
export const criarPack = async (req, res) => {
  const client = await pool.connect();
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'name é obrigatório.' });
    }
    const color = String(req.body?.color || '#3b82f6').trim();
    const targetDate = req.body?.target_date || null;
    const notes = req.body?.notes ? String(req.body.notes) : null;
    const userId = Number(req.user?.id) || null;

    // Novo pack vai para o fim da lista — seq = max(seq) + 1.
    const seqRes = await client.query(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM maestro.production_pack
    `);
    const nextSeq = seqRes.rows[0].next_seq;

    const ins = await client.query(
      `INSERT INTO maestro.production_pack
         (name, color, seq, target_date, notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, color, nextSeq, targetDate, notes, userId]
    );

    return res.status(201).json({ success: true, data: ins.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao criar pack:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PATCH /api/production-packs/:id
export const atualizarPack = async (req, res) => {
  try {
    const id = Number(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const fields = [];
    const values = [];
    let n = 1;
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ success: false, message: 'name não pode ser vazio.' });
      fields.push(`name = $${n++}`); values.push(name);
    }
    if (req.body?.color !== undefined) {
      fields.push(`color = $${n++}`); values.push(String(req.body.color || '').trim() || '#3b82f6');
    }
    if (req.body?.target_date !== undefined) {
      fields.push(`target_date = $${n++}`); values.push(req.body.target_date || null);
    }
    if (req.body?.notes !== undefined) {
      fields.push(`notes = $${n++}`); values.push(req.body.notes ? String(req.body.notes) : null);
    }
    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    fields.push(`updated_at = now()`);
    values.push(id);

    const { rows } = await pool.query(
      `UPDATE maestro.production_pack SET ${fields.join(', ')} WHERE id = $${n} RETURNING *`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pack não encontrado.' });
    }
    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('❌ Erro ao atualizar pack:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/production-packs/:id
// OSs vinculadas voltam para a fila "sem pack" via ON DELETE SET NULL.
export const excluirPack = async (req, res) => {
  try {
    const id = Number(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM maestro.production_pack WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Pack não encontrado.' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao excluir pack:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/production-packs/reorder
// Body: { order: [packId1, packId2, ...] } — define a nova ordem.
export const reordenarPacks = async (req, res) => {
  const client = await pool.connect();
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order || order.length === 0) {
      return res.status(400).json({ success: false, message: 'order é obrigatório.' });
    }
    const ids = order.map(Number).filter(Number.isFinite);
    if (ids.length !== order.length) {
      return res.status(400).json({ success: false, message: 'order contém ids inválidos.' });
    }

    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE maestro.production_pack SET seq = $1, updated_at = now() WHERE id = $2`,
        [i + 1, ids[i]]
      );
    }
    await client.query('COMMIT');
    return res.status(200).json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Erro ao reordenar packs:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PATCH /api/production-packs/:id/items/reorder
// Body: { order: [card_key1, card_key2, ...] } — reordena OSs dentro do pack.
// Use id = 0 ou "unassigned" para reordenar a fila sem pack.
export const reordenarItens = async (req, res) => {
  const client = await pool.connect();
  try {
    const rawId = req.params?.id;
    const isUnassigned = String(rawId).toLowerCase() === 'unassigned' || Number(rawId) === 0;
    const packId = isUnassigned ? null : Number(rawId);
    if (!isUnassigned && (!Number.isFinite(packId) || packId <= 0)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) {
      return res.status(400).json({ success: false, message: 'order é obrigatório.' });
    }
    const keys = order.map((k) => String(k || '').trim()).filter(Boolean);

    await client.query('BEGIN');

    // Se não-unassigned, valida que o pack existe.
    if (packId !== null) {
      const exists = await client.query(`SELECT 1 FROM maestro.production_pack WHERE id = $1`, [packId]);
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Pack não encontrado.' });
      }
    }

    // Atualiza production_seq na ordem do array. UPSERT: card pode não ter
    // os_planning ainda — cria linha mínima nesse caso.
    for (let i = 0; i < keys.length; i++) {
      const seq = i + 1;
      await client.query(
        `INSERT INTO maestro.os_planning (card_key, pack_id, production_seq)
         VALUES ($1, $2, $3)
         ON CONFLICT (card_key) DO UPDATE SET
           pack_id        = EXCLUDED.pack_id,
           production_seq = EXCLUDED.production_seq,
           updated_at     = now()`,
        [keys[i], packId, seq]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ success: true, data: { count: keys.length } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Erro ao reordenar itens do pack:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};
