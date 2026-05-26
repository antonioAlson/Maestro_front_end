import pool from '../config/database.js';

const SELECT_FIELDS = `
  c.id,
  c.numero,
  c.nome_comercial,
  c.material_id,
  m.nome AS material_nome,
  c.quantidade_camadas,
  c.ativo,
  c.created_by,
  c.created_at,
  c.updated_at
`;

// GET /api/conformity-certificates?onlyActive=true
export const listarCertificados = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE c.ativo = true' : '';
    const result = await pool.query(`
      SELECT ${SELECT_FIELDS}
        FROM maestro.conformity_certificates c
        JOIN maestro.materials m ON m.id = c.material_id
        ${where}
       ORDER BY c.numero DESC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar certificados de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/conformity-certificates/:id
export const obterCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT ${SELECT_FIELDS}
         FROM maestro.conformity_certificates c
         JOIN maestro.materials m ON m.id = c.material_id
        WHERE c.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter certificado:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/conformity-certificates
export const criarCertificado = async (req, res) => {
  try {
    const numero = String(req.body?.numero || '').trim();
    const nome_comercial = String(req.body?.nome_comercial || '').trim();
    const material_id = Number(req.body?.material_id);
    const quantidade_camadas = Number(req.body?.quantidade_camadas);

    const missing = [];
    if (!numero) missing.push('numero');
    if (!nome_comercial) missing.push('nome_comercial');
    if (!Number.isFinite(material_id)) missing.push('material_id');
    if (!Number.isFinite(quantidade_camadas) || quantidade_camadas <= 0) {
      missing.push('quantidade_camadas');
    }
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    const inserted = await pool.query(
      `INSERT INTO maestro.conformity_certificates
         (numero, nome_comercial, material_id, quantidade_camadas, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
      [numero, nome_comercial, material_id, quantidade_camadas, req.user?.id || null]
    );

    // Devolve a forma "fat" com nome do material já resolvido
    const full = await pool.query(
      `SELECT ${SELECT_FIELDS}
         FROM maestro.conformity_certificates c
         JOIN maestro.materials m ON m.id = c.material_id
        WHERE c.id = $1`,
      [inserted.rows[0].id]
    );
    return res.status(201).json({ success: true, data: full.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um certificado com esse número.' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ success: false, message: 'Material inexistente.' });
    }
    console.error('❌ Erro ao criar certificado de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/conformity-certificates/:id
export const atualizarCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.numero !== undefined) fields.numero = String(req.body.numero).trim();
    if (req.body?.nome_comercial !== undefined) fields.nome_comercial = String(req.body.nome_comercial).trim();
    if (req.body?.material_id !== undefined) fields.material_id = Number(req.body.material_id);
    if (req.body?.quantidade_camadas !== undefined) fields.quantidade_camadas = Number(req.body.quantidade_camadas);
    if (req.body?.ativo !== undefined) fields.ativo = !!req.body.ativo;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    if (fields.numero === '' || fields.nome_comercial === '') {
      return res.status(400).json({ success: false, message: 'Numero e nome comercial não podem ser vazios.' });
    }
    if (fields.quantidade_camadas !== undefined &&
        (!Number.isFinite(fields.quantidade_camadas) || fields.quantidade_camadas <= 0)) {
      return res.status(400).json({ success: false, message: 'quantidade_camadas inválida.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const updated = await pool.query(
      `UPDATE maestro.conformity_certificates
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id`,
      values
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    }

    const full = await pool.query(
      `SELECT ${SELECT_FIELDS}
         FROM maestro.conformity_certificates c
         JOIN maestro.materials m ON m.id = c.material_id
        WHERE c.id = $1`,
      [id]
    );
    return res.status(200).json({ success: true, data: full.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um certificado com esse número.' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ success: false, message: 'Material inexistente.' });
    }
    console.error('❌ Erro ao atualizar certificado de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/conformity-certificates/:id
export const excluirCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM maestro.conformity_certificates WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Certificado excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Certificado está em uso por rastreabilidades — desative em vez de excluir.',
      });
    }
    console.error('❌ Erro ao excluir certificado:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
