import pool from '../config/database.js';

const ALLOWED_KEYS = new Set(['tr_numero', 'iis_tipo_embalagem', 'iis_pais', 'iis_cep']);

// Regras de tamanho/formato por chave — só dígitos.
const KEY_FORMAT = {
  tr_numero:          { length: 4 },
  iis_tipo_embalagem: { length: 1 },
  iis_pais:           { length: 3 },
  iis_cep:            { length: 5 },
};

// GET /api/production-config
// Retorna objeto { tr_numero: '0430', iis_tipo_embalagem: '6', ... }
export const obterConfig = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value, description, updated_at
         FROM maestro.production_config
        WHERE key = ANY($1)`,
      [Array.from(ALLOWED_KEYS)]
    );
    const data = {};
    for (const row of result.rows) {
      data[row.key] = { value: row.value, description: row.description, updated_at: row.updated_at };
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('❌ Erro ao obter production_config:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/production-config
// Body: { tr_numero: '0430', iis_cep: '06460', ... } — atualiza só o que veio.
export const atualizarConfig = async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) {
        return res.status(400).json({ success: false, message: `Chave não permitida: ${key}` });
      }
      const value = String(body[key] ?? '').trim();
      const expected = KEY_FORMAT[key].length;
      if (!/^[0-9]+$/.test(value) || value.length !== expected) {
        return res.status(400).json({
          success: false,
          message: `${key} deve ter exatamente ${expected} dígitos.`,
        });
      }
      updates.push({ key, value });
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { key, value } of updates) {
        await client.query(
          `UPDATE maestro.production_config
              SET value = $1, updated_at = now()
            WHERE key = $2`,
          [value, key]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Retorna o estado atualizado
    return obterConfig(req, res);
  } catch (error) {
    console.error('❌ Erro ao atualizar production_config:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
