import pool from '../config/database.js';

function parseDimNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Fornecedores ────────────────────────────────────────────────────────────

// GET /api/plate-suppliers
// Devolve fornecedores com seus sizes aninhados em um único json_agg.
export const listarFornecedores = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE s.active = true' : '';
    const result = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.active,
        s.created_at,
        s.updated_at,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id',         z.id,
                'label',      z.label,
                'width',      z.width,
                'height',     z.height,
                'active',     z.active,
                'created_at', z.created_at,
                'updated_at', z.updated_at
              ) ORDER BY z.width ASC, z.height ASC
            )
            FROM maestro.plate_size z
            WHERE z.supplier_id = s.id
          ),
          '[]'::json
        ) AS sizes
      FROM maestro.plate_supplier s
      ${where}
      ORDER BY s.name ASC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar fornecedores de placa:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/plate-suppliers
export const criarFornecedor = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });
    }

    const result = await pool.query(
      `INSERT INTO maestro.plate_supplier (name)
         VALUES ($1)
         RETURNING id, name, active, created_at, updated_at`,
      [name]
    );
    return res.status(201).json({ success: true, data: { ...result.rows[0], sizes: [] } });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um fornecedor com esse nome.' });
    }
    console.error('❌ Erro ao criar fornecedor:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/plate-suppliers/:id
export const atualizarFornecedor = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.name !== undefined) fields.name = String(req.body.name).trim();
    if (req.body?.active !== undefined) fields.active = !!req.body.active;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    if (fields.name === '') {
      return res.status(400).json({ success: false, message: 'Nome não pode ser vazio.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE maestro.plate_supplier
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id, name, active, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fornecedor não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um fornecedor com esse nome.' });
    }
    console.error('❌ Erro ao atualizar fornecedor:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/plate-suppliers/:id
// CASCADE remove sizes; se algum size estiver em uso por os_planning, o RESTRICT
// dispara via FK em plate_size_id (se existir) ou erro de cascata. Trato 23503.
export const excluirFornecedor = async (req, res) => {
  try {
    const { id } = req.params;

    // Verifica se algum tipo desse fornecedor está em uso.
    const inUse = await pool.query(
      `SELECT 1 FROM maestro.os_planning op
         JOIN maestro.plate_size z ON z.id = op.plate_size_id
        WHERE z.supplier_id = $1
        LIMIT 1`,
      [id]
    );
    if (inUse.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Fornecedor possui tipos de placa em uso por OSs planejadas — desative em vez de excluir.',
      });
    }

    const result = await pool.query(
      'DELETE FROM maestro.plate_supplier WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fornecedor não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Fornecedor excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Fornecedor está em uso — desative em vez de excluir.',
      });
    }
    console.error('❌ Erro ao excluir fornecedor:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// ─── Tipos de placa (filhos) ─────────────────────────────────────────────────

// POST /api/plate-suppliers/:supplierId/sizes
export const criarTipo = async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId);
    if (!Number.isFinite(supplierId)) {
      return res.status(400).json({ success: false, message: 'supplierId inválido.' });
    }

    const label = String(req.body?.label || '').trim();
    const width = parseDimNumber(req.body?.width);
    const height = parseDimNumber(req.body?.height);

    const missing = [];
    if (!label) missing.push('label');
    if (width === null) missing.push('width');
    if (height === null) missing.push('height');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    const result = await pool.query(
      `INSERT INTO maestro.plate_size (supplier_id, label, width, height)
         VALUES ($1, $2, $3, $4)
         RETURNING id, supplier_id, label, width, height, active, created_at, updated_at`,
      [supplierId, label, width, height]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Já existe um tipo com essas dimensões para este fornecedor.',
      });
    }
    if (error.code === '23503') {
      return res.status(400).json({ success: false, message: 'Fornecedor inexistente.' });
    }
    console.error('❌ Erro ao criar tipo de placa:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/plate-suppliers/:supplierId/sizes/:sizeId
export const atualizarTipo = async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId);
    const sizeId = Number(req.params.sizeId);

    const fields = {};
    if (req.body?.label !== undefined) fields.label = String(req.body.label).trim();
    if (req.body?.width !== undefined) {
      const w = parseDimNumber(req.body.width);
      if (w === null) return res.status(400).json({ success: false, message: 'width inválido.' });
      fields.width = w;
    }
    if (req.body?.height !== undefined) {
      const h = parseDimNumber(req.body.height);
      if (h === null) return res.status(400).json({ success: false, message: 'height inválido.' });
      fields.height = h;
    }
    if (req.body?.active !== undefined) fields.active = !!req.body.active;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    if (fields.label === '') {
      return res.status(400).json({ success: false, message: 'Label não pode ser vazio.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(sizeId, supplierId);

    const result = await pool.query(
      `UPDATE maestro.plate_size
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length - 1} AND supplier_id = $${values.length}
        RETURNING id, supplier_id, label, width, height, active, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tipo de placa não encontrado para este fornecedor.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Já existe um tipo com essas dimensões para este fornecedor.',
      });
    }
    console.error('❌ Erro ao atualizar tipo de placa:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/plate-suppliers/:supplierId/sizes/:sizeId
export const excluirTipo = async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId);
    const sizeId = Number(req.params.sizeId);

    const result = await pool.query(
      'DELETE FROM maestro.plate_size WHERE id = $1 AND supplier_id = $2 RETURNING id',
      [sizeId, supplierId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tipo de placa não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Tipo de placa excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Tipo de placa está em uso por OSs planejadas — desative em vez de excluir.',
      });
    }
    console.error('❌ Erro ao excluir tipo de placa:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
