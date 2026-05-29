import pool from '../config/database.js';

// Catálogo de preferências. type controla validação e como o valor é
// interpretado pelo frontend.
//   - boolean: '0' | '1'
//   - digits:  string com `length` dígitos
//   - text:    string livre (limit opcional)
const PREFERENCE_SCHEMA = {
  corte_romaneio_opera_enabled: {
    type: 'boolean',
    label: 'Habilitar romaneio para corte OPERA',
    description: 'Permite gerar romaneio para registros de corte cujo único fornecedor é OPERA.',
  },
  quality_certificate_signature_user_id: {
    type: 'user_id',
    label: 'Assinante do Certificado de Qualidade',
    description: 'Usuário cujo nome e cargo serão exibidos na assinatura do PDF do certificado de qualidade.',
  },
};

const ALLOWED_KEYS = new Set(Object.keys(PREFERENCE_SCHEMA));

function validateValue(key, raw) {
  const schema = PREFERENCE_SCHEMA[key];
  const value = String(raw ?? '').trim();
  if (schema.type === 'boolean') {
    if (value !== '0' && value !== '1') {
      return { ok: false, message: `${key} deve ser '0' ou '1'.` };
    }
    return { ok: true, value };
  }
  if (schema.type === 'digits') {
    if (!/^[0-9]+$/.test(value) || value.length !== schema.length) {
      return { ok: false, message: `${key} deve ter exatamente ${schema.length} dígitos.` };
    }
    return { ok: true, value };
  }
  if (schema.type === 'text') {
    if (schema.maxLength && value.length > schema.maxLength) {
      return { ok: false, message: `${key} excede ${schema.maxLength} caracteres.` };
    }
    return { ok: true, value };
  }
  if (schema.type === 'user_id') {
    if (value === '') return { ok: true, value };
    if (!/^[0-9]+$/.test(value)) {
      return { ok: false, message: `${key} deve ser um usuário válido.` };
    }
    return { ok: true, value };
  }
  return { ok: false, message: `Tipo desconhecido para ${key}.` };
}

async function validateReferences(updates) {
  const signer = updates.find((u) => u.key === 'quality_certificate_signature_user_id');
  if (!signer || signer.value === '') return { ok: true };
  const result = await pool.query(
    'SELECT id FROM maestro.users WHERE id = $1 AND deleted_at IS NULL',
    [Number(signer.value)],
  );
  if (result.rows.length === 0) {
    return { ok: false, message: 'Assinante do certificado não encontrado ou inativo.' };
  }
  return { ok: true };
}

// GET /api/app-preferences
// Retorna { [key]: { value, description, updated_at, type, label } }.
// Acessível a qualquer usuário autenticado — preferências afetam o comportamento
// das telas e precisam ser lidas pelo frontend mesmo sem permissão de edição.
export const obterPreferencias = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value, description, updated_at
         FROM maestro.app_preferences
        WHERE key = ANY($1)`,
      [Array.from(ALLOWED_KEYS)]
    );
    const data = {};
    for (const row of result.rows) {
      const schema = PREFERENCE_SCHEMA[row.key];
      data[row.key] = {
        value:       row.value,
        description: row.description,
        updated_at:  row.updated_at,
        type:        schema.type,
        label:       schema.label,
      };
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('❌ Erro ao obter app_preferences:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/app-preferences
// Body: { corte_romaneio_opera_enabled: '1', ... } — atualiza só o que veio.
export const atualizarPreferencias = async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) {
        return res.status(400).json({ success: false, message: `Chave não permitida: ${key}` });
      }
      const v = validateValue(key, body[key]);
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }
      updates.push({ key, value: v.value });
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    const refs = await validateReferences(updates);
    if (!refs.ok) {
      return res.status(400).json({ success: false, message: refs.message });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { key, value } of updates) {
        // UPSERT — garante consistência caso a chave nova ainda não tenha
        // sido semeada (ex.: deploy onde a migração roda depois).
        await client.query(
          `INSERT INTO maestro.app_preferences (key, value)
                VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = now()`,
          [key, value]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return obterPreferencias(req, res);
  } catch (error) {
    console.error('❌ Erro ao atualizar app_preferences:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const listarAssinantesCertificado = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
          u.id,
          u.name,
          u.username,
          u.email,
          u.cargo_id AS "cargoId",
          c.nome AS "cargoNome"
         FROM maestro.users u
         LEFT JOIN maestro.cargos c ON c.id = u.cargo_id
        WHERE u.deleted_at IS NULL
        ORDER BY c.nome NULLS LAST, u.name ASC`,
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erro ao listar assinantes:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
