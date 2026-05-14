import { randomUUID } from 'crypto';
import pool from '../config/database.js';
import { parseDimension, filterPlansByDimension } from '../utils/dimensionMatcher.js';
import { validatePlans } from '../utils/reviewValidator.js';

// Issues que impedem o projeto de ficar "Liberado" — mesma regra de Espelhos.
const BLOCKING_ISSUES = new Set([
  'NO_ATTACHMENT',
  'NO_CUTTING',
  'NO_LABEL_8C',
  'NO_LABEL_9C',
  'NO_LABEL_11C',
  'NO_LABEL_TENSYLON',
]);

const PRODUCED_STATUS = 'PRODUZIDO';

// Lê todas as OSs visíveis (não-produzidas + janela de 48h após produção),
// já com planning, projeto e cutting_plans agregados.
async function fetchPlanningRows() {
  const { rows } = await pool.query(`
    SELECT
      jc.key                   AS card_key,
      jc.tipo                  AS jira_tipo,
      jc.resumo                AS jira_resumo,
      jc.status                AS jira_status,
      jc.situacao              AS jira_situacao,
      jc.veiculo               AS jira_veiculo,
      jc.previsao              AS jira_previsao,
      jc.project               AS jira_project_code,
      jc.fabrica_manta         AS jira_fabrica_manta,
      jc.produced_at           AS jira_produced_at,
      jc.last_updated_at       AS jira_last_updated_at,

      op.id                    AS planning_id,
      op.os_numero             AS os_numero,
      op.plate_supplier_id     AS plate_supplier_id,
      op.plate_size_id         AS plate_size_id,
      op.material_assigned_at  AS material_assigned_at,
      op.material_assigned_by_user_id AS material_assigned_by_user_id,
      op.production_seq        AS production_seq,
      op.first_printed_at      AS first_printed_at,
      op.first_printed_by_user_id AS first_printed_by_user_id,
      op.last_printed_at       AS last_printed_at,
      op.last_printed_by_user_id  AS last_printed_by_user_id,
      op.print_count           AS print_count,
      op.pack_id               AS pack_id,

      pp.name                  AS pack_name,
      pp.color                 AS pack_color,
      pp.seq                   AS pack_seq,
      pp.target_date           AS pack_target_date,

      ps.name                  AS supplier_name,
      psz.label                AS size_label,
      psz.width                AS size_width,
      psz.height               AS size_height,

      p.id                     AS project_id,
      p.project                AS project_code,
      p.material_type          AS project_material_type,
      p.brand                  AS project_brand,
      p.model                  AS project_model,
      p.total_parts_qty        AS project_total_parts_qty,

      ua.email                 AS material_assigned_by_email,
      ua.name                  AS material_assigned_by_name,
      up_first.email           AS first_printed_by_email,
      up_first.name            AS first_printed_by_name,
      up_last.email            AS last_printed_by_email,
      up_last.name             AS last_printed_by_name,

      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id',                cp.id,
              'plate_width',       cp.plate_width,
              'plate_height',      cp.plate_height,
              'linear_meters',     cp.linear_meters,
              'square_meters',     cp.square_meters,
              'plate_consumption', cp.plate_consumption,
              'reviews',           cp.reviews,
              'attachments', (
                SELECT COALESCE(
                  json_agg(
                    json_build_object(
                      'type', cpa.type,
                      'file', json_build_object('id', fs.id, 'original_name', fs.original_name)
                    )
                  ),
                  '[]'::json
                )
                FROM maestro.cutting_plan_attachment cpa
                JOIN maestro.file_storage fs ON fs.id = cpa.file_id
                WHERE cpa.cutting_plan_id = cp.id
              )
            ) ORDER BY cp.id
          )
          FROM maestro.cutting_plan cp
          WHERE cp.project_id = p.id
        ),
        '[]'::json
      ) AS cutting_plans

    FROM maestro.jira_cards jc
    LEFT JOIN maestro.os_planning op   ON op.card_key = jc.key
    LEFT JOIN maestro.production_pack pp ON pp.id = op.pack_id
    LEFT JOIN maestro.plate_supplier ps ON ps.id = op.plate_supplier_id
    LEFT JOIN maestro.plate_size psz    ON psz.id = op.plate_size_id
    LEFT JOIN maestro.project p
      ON jc.project IS NOT NULL
     AND TRIM(jc.project) <> ''
     AND UPPER(TRIM(p.project)) = UPPER(TRIM(jc.project))
    LEFT JOIN maestro.users ua       ON ua.id = op.material_assigned_by_user_id
    LEFT JOIN maestro.users up_first ON up_first.id = op.first_printed_by_user_id
    LEFT JOIN maestro.users up_last  ON up_last.id  = op.last_printed_by_user_id

    WHERE jc.produced_at IS NULL
       OR jc.produced_at > now() - interval '2 days'
    ORDER BY
      pp.seq IS NULL,           -- packs no topo (na ordem deles), depois OSs sem pack
      pp.seq ASC,
      op.production_seq IS NULL,
      op.production_seq ASC,
      jc.last_updated_at DESC
  `);

  return rows;
}

// Classifica uma linha em uma das 5 categorias e devolve tags acessórias.
function classifyRow(row) {
  const status = String(row.jira_status || '').trim();
  const isProduced = status.toUpperCase() === PRODUCED_STATUS;

  // ENTREGUE: somente cards com status atual "Produzido" (visíveis por 48h via filtro SQL).
  if (isProduced) {
    return { category: 'entregue', tags: [], issues: [] };
  }

  const hasMaterial = !!(row.plate_supplier_id && row.plate_size_id);

  // Regra atual: sem fornecedor/tamanho de placa vinculado fica em aguardando material.
  // AGUARDANDO PLANEJAMENTO DE MATERIAL
  if (!hasMaterial) {
    return { category: 'aguardando_material', tags: [], issues: [] };
  }

  // A partir daqui a OS tem material atribuído e cai sempre em "liberado".
  // O status do projeto (sem projeto, não cadastrado, plano inválido, etc.)
  // deixa de ser categoria — vira apenas sinalização na coluna "Status Projeto".

  // SEM PROJETO VINCULADO: o card Jira não tem o customfield de projeto preenchido.
  const projectCode = String(row.jira_project_code || '').trim();
  if (!projectCode) {
    return { category: 'liberado', tags: ['SEM_PROJETO_VINCULADO'], issues: [] };
  }

  // PROJECT_NOT_FOUND: o card aponta para um projeto que não existe no maestro.project.
  if (!row.project_id) {
    return { category: 'liberado', tags: ['PROJETO_NAO_CADASTRADO'], issues: [] };
  }

  // Aplica filtro de dimensão da placa atribuída (em metros).
  const allPlans = Array.isArray(row.cutting_plans) ? row.cutting_plans : [];
  const isTensylon = String(row.project_material_type || '').toUpperCase() === 'TENSYLON';

  let plansToValidate = allPlans;
  if (!isTensylon) {
    const widthM = Number(row.size_width);
    const heightM = Number(row.size_height);
    const dimStr = `${widthM.toFixed(2)}x${heightM.toFixed(2)}`;
    const target = parseDimension(dimStr);
    plansToValidate = target ? filterPlansByDimension(allPlans, target) : [];

    if (plansToValidate.length === 0) {
      return { category: 'liberado', tags: ['SEM_PLANO_PARA_DIMENSAO'], issues: [] };
    }
  } else if (allPlans.length === 0) {
    return { category: 'liberado', tags: ['SEM_PLANO_PARA_DIMENSAO'], issues: [] };
  }

  const issues = validatePlans(plansToValidate);
  const blocked = issues.some(i => BLOCKING_ISSUES.has(i));

  if (blocked) {
    // Projeto existe e está vinculado, mas o plano de corte tem pendências
    // bloqueantes (PDF, nesting, label .txt obrigatório, etc.).
    return { category: 'liberado', tags: ['PLANO_DE_CORTE_INVALIDO'], issues };
  }

  // Issues não-bloqueantes (pendências de checklist) geram tag de aviso amarelo.
  const tags = issues.length > 0 ? ['PROJETO_COM_PENDENCIAS'] : [];
  return { category: 'liberado', tags, issues };
}

// Serializa uma row do banco no formato consumido pela UI.
function serializeRow(row) {
  const { category, tags, issues } = classifyRow(row);
  // Regra de exibição: OS já impressa aparece como "Em Produção" na UI,
  // independentemente do status original do Jira. O valor no banco NÃO é
  // alterado — a sobrescrita acontece apenas na resposta da API.
  const rawStatus = String(row.jira_status || '').trim();
  const displayStatus = row.last_printed_at && rawStatus.toUpperCase() !== PRODUCED_STATUS
    ? 'Em Produção'
    : (row.jira_status || '');
  return {
    card_key: row.card_key,
    os_numero: row.os_numero || extractOsFromResumo(row.jira_resumo),
    veiculo: row.jira_veiculo || '',
    resumo: row.jira_resumo || '',
    jira: {
      tipo: row.jira_tipo || '',
      status: displayStatus,
      situacao: row.jira_situacao || '',
      previsao: row.jira_previsao || '',
      project_code: row.jira_project_code || '',
      fabrica_manta: row.jira_fabrica_manta || '',
      produced_at: row.jira_produced_at,
      last_updated_at: row.jira_last_updated_at,
    },
    project: row.project_id
      ? {
          id: row.project_id,
          code: row.project_code,
          material_type: row.project_material_type,
          brand: row.project_brand,
          model: row.project_model,
          total_parts_qty: row.project_total_parts_qty,
        }
      : null,
    plate: row.plate_supplier_id
      ? {
          supplier_id: row.plate_supplier_id,
          supplier_name: row.supplier_name,
          size_id: row.plate_size_id,
          size_label: row.size_label,
          width: row.size_width != null ? Number(row.size_width) : null,
          height: row.size_height != null ? Number(row.size_height) : null,
        }
      : null,
    pack: row.pack_id
      ? {
          id: row.pack_id,
          name: row.pack_name,
          color: row.pack_color,
          seq: row.pack_seq,
          target_date: row.pack_target_date,
        }
      : null,
    planning: {
      id: row.planning_id,
      production_seq: row.production_seq,
      material_assigned_at: row.material_assigned_at,
      material_assigned_by: row.material_assigned_by_user_id
        ? { id: row.material_assigned_by_user_id, email: row.material_assigned_by_email, name: row.material_assigned_by_name }
        : null,
      first_printed_at: row.first_printed_at,
      first_printed_by: row.first_printed_by_user_id
        ? { id: row.first_printed_by_user_id, email: row.first_printed_by_email, name: row.first_printed_by_name }
        : null,
      last_printed_at: row.last_printed_at,
      last_printed_by: row.last_printed_by_user_id
        ? { id: row.last_printed_by_user_id, email: row.last_printed_by_email, name: row.last_printed_by_name }
        : null,
      print_count: row.print_count || 0,
    },
    classification: { category, tags, issues },
  };
}

// Fallback: extrai número de OS do resumo (mesma heurística do jiraService).
function extractOsFromResumo(resumo) {
  const matches = String(resumo || '').match(/\b(\d{4,10})\b/g);
  return matches ? matches[matches.length - 1] : '';
}

function applySearch(items, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return items;
  return items.filter(item => {
    const haystacks = [
      item.card_key,
      item.os_numero,
      item.veiculo,
      item.resumo,
      item.project?.code,
      item.project?.brand,
      item.project?.model,
      item.plate?.supplier_name,
      item.plate?.size_label,
    ];
    return haystacks.some(v => String(v || '').toLowerCase().includes(t));
  });
}

// GET /api/os-planning
export const listarPlanejamento = async (req, res) => {
  try {
    const rows = await fetchPlanningRows();
    const all = rows.map(serializeRow);
    const filtered = applySearch(all, req.query?.search);

    const buckets = {
      aguardando_material: [],
      liberado: [],
      entregue: [],
    };
    for (const item of filtered) {
      buckets[item.classification.category]?.push(item);
    }

    return res.status(200).json({
      success: true,
      data: buckets,
      meta: {
        total: filtered.length,
        counts: {
          aguardando_material: buckets.aguardando_material.length,
          liberado: buckets.liberado.length,
          entregue: buckets.entregue.length,
        },
      },
    });
  } catch (error) {
    console.error('❌ Erro ao listar planejamento de OS:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/os-planning/:cardKey/material
export const atribuirMaterial = async (req, res) => {
  const client = await pool.connect();
  try {
    const cardKey = String(req.params?.cardKey || '').trim();
    if (!cardKey) {
      return res.status(400).json({ success: false, message: 'cardKey é obrigatório.' });
    }

    const supplierId = Number(req.body?.plate_supplier_id);
    const sizeId = Number(req.body?.plate_size_id);
    if (!Number.isFinite(supplierId) || supplierId <= 0) {
      return res.status(400).json({ success: false, message: 'plate_supplier_id é obrigatório.' });
    }
    if (!Number.isFinite(sizeId) || sizeId <= 0) {
      return res.status(400).json({ success: false, message: 'plate_size_id é obrigatório.' });
    }

    // Confere existência do card no banco — evita criar planning para OS que
    // ainda não foi sincronizada pelo cron (caminho manual será Fase 3).
    const cardExists = await client.query(
      'SELECT key, resumo, veiculo FROM maestro.jira_cards WHERE key = $1',
      [cardKey]
    );
    if (cardExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Card ${cardKey} não encontrado em jira_cards.`,
      });
    }
    const card = cardExists.rows[0];
    const osNumero = extractOsFromResumo(card.resumo);

    // Garante que o tipo escolhido pertence ao fornecedor escolhido.
    const sizeCheck = await client.query(
      'SELECT supplier_id FROM maestro.plate_size WHERE id = $1',
      [sizeId]
    );
    if (sizeCheck.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Tipo de placa não encontrado.' });
    }
    if (Number(sizeCheck.rows[0].supplier_id) !== supplierId) {
      return res.status(400).json({
        success: false,
        message: 'Tipo de placa não pertence ao fornecedor selecionado.',
      });
    }

    const userId = Number(req.user?.id) || null;

    // UPSERT — cria a linha de planning se ainda não existir.
    const result = await client.query(
      `INSERT INTO maestro.os_planning
         (card_key, os_numero, veiculo, plate_supplier_id, plate_size_id,
          material_assigned_at, material_assigned_by_user_id)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (card_key) DO UPDATE SET
         plate_supplier_id            = EXCLUDED.plate_supplier_id,
         plate_size_id                = EXCLUDED.plate_size_id,
         material_assigned_at         = now(),
         material_assigned_by_user_id = EXCLUDED.material_assigned_by_user_id,
         updated_at                   = now()
       RETURNING id, os_numero, plate_supplier_id, plate_size_id,
                 material_assigned_at, material_assigned_by_user_id`,
      [cardKey, osNumero || null, card.veiculo || null, supplierId, sizeId, userId]
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: 'Fornecedor ou tipo de placa inexistente.',
      });
    }
    console.error('❌ Erro ao atribuir material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// DELETE /api/os-planning/:cardKey/material
// Zera plate_supplier_id/plate_size_id, limpa auditoria de atribuição e
// remove a OS de qualquer pack (volta para "aguardando material").
// Mantém o histórico de impressão para auditoria.
export const desvincularMaterial = async (req, res) => {
  const client = await pool.connect();
  try {
    const cardKey = String(req.params?.cardKey || '').trim();
    if (!cardKey) {
      return res.status(400).json({ success: false, message: 'cardKey é obrigatório.' });
    }

    const result = await client.query(
      `UPDATE maestro.os_planning
          SET plate_supplier_id            = NULL,
              plate_size_id                = NULL,
              material_assigned_at         = NULL,
              material_assigned_by_user_id = NULL,
              pack_id                      = NULL,
              production_seq               = NULL,
              updated_at                   = now()
        WHERE card_key = $1
        RETURNING id, card_key`,
      [cardKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Planning não encontrado para o card ${cardKey}.`,
      });
    }

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao desvincular material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PATCH /api/os-planning/:cardKey/pack
// Body: { pack_id: number | null } — move OS para um pack ou tira dela.
// production_seq passa para o fim do destino.
export const moverParaPack = async (req, res) => {
  const client = await pool.connect();
  try {
    const cardKey = String(req.params?.cardKey || '').trim();
    if (!cardKey) {
      return res.status(400).json({ success: false, message: 'cardKey é obrigatório.' });
    }

    const rawPackId = req.body?.pack_id;
    const packId = rawPackId === null || rawPackId === undefined || rawPackId === '' ? null : Number(rawPackId);
    if (packId !== null && (!Number.isFinite(packId) || packId <= 0)) {
      return res.status(400).json({ success: false, message: 'pack_id inválido.' });
    }

    // Card precisa existir.
    const cardExists = await client.query(
      `SELECT key, resumo, veiculo FROM maestro.jira_cards WHERE key = $1`,
      [cardKey]
    );
    if (cardExists.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Card ${cardKey} não encontrado.` });
    }
    const card = cardExists.rows[0];

    // Pack (se informado) precisa existir.
    if (packId !== null) {
      const packExists = await client.query(
        `SELECT 1 FROM maestro.production_pack WHERE id = $1`,
        [packId]
      );
      if (packExists.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Pack não encontrado.' });
      }
    }

    // Próximo seq do destino (pack_id IS NULL ou pack específico).
    const seqRes = await client.query(
      packId === null
        ? `SELECT COALESCE(MAX(production_seq), 0) + 1 AS next_seq
             FROM maestro.os_planning WHERE pack_id IS NULL`
        : `SELECT COALESCE(MAX(production_seq), 0) + 1 AS next_seq
             FROM maestro.os_planning WHERE pack_id = $1`,
      packId === null ? [] : [packId]
    );
    const nextSeq = seqRes.rows[0].next_seq;

    const osNumero = extractOsFromResumo(card.resumo);

    const result = await client.query(
      `INSERT INTO maestro.os_planning (card_key, os_numero, veiculo, pack_id, production_seq)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (card_key) DO UPDATE SET
         pack_id        = EXCLUDED.pack_id,
         production_seq = EXCLUDED.production_seq,
         updated_at     = now()
       RETURNING id, card_key, pack_id, production_seq`,
      [cardKey, osNumero || null, card.veiculo || null, packId, nextSeq]
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao mover para pack:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// POST /api/os-planning/print
// Apenas registra impressão + audit. O frontend baixa o PDF via /api/jira/imprimir-ops
// (já existente) ANTES de chamar este endpoint.
export const registrarImpressao = async (req, res) => {
  const client = await pool.connect();
  try {
    const cardKeys = Array.isArray(req.body?.card_keys) ? req.body.card_keys : [];
    const success = Array.isArray(req.body?.success) ? req.body.success : cardKeys;
    const failed = Array.isArray(req.body?.failed) ? req.body.failed : [];

    const cleanKeys = success
      .map(k => String(k || '').trim())
      .filter(Boolean);

    if (cleanKeys.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum card_key informado.' });
    }

    const userId = Number(req.user?.id) || null;
    const requestId = randomUUID();
    const now = new Date();

    await client.query('BEGIN');

    // UPSERT por card_key — para cards sem planning ainda, cria linha.
    for (const cardKey of cleanKeys) {
      await client.query(
        `INSERT INTO maestro.os_planning
           (card_key, first_printed_at, first_printed_by_user_id,
            last_printed_at, last_printed_by_user_id, print_count)
         VALUES ($1, $2, $3, $2, $3, 1)
         ON CONFLICT (card_key) DO UPDATE SET
           first_printed_at         = COALESCE(maestro.os_planning.first_printed_at, EXCLUDED.first_printed_at),
           first_printed_by_user_id = COALESCE(maestro.os_planning.first_printed_by_user_id, EXCLUDED.first_printed_by_user_id),
           last_printed_at          = EXCLUDED.last_printed_at,
           last_printed_by_user_id  = EXCLUDED.last_printed_by_user_id,
           print_count              = maestro.os_planning.print_count + 1,
           updated_at               = now()`,
        [cardKey, now, userId]
      );
    }

    await client.query(
      `INSERT INTO maestro.os_print_audit
         (actor_user_id, actor_email, request_id, card_keys, total, success, failed, entries, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        req.user?.email || null,
        requestId,
        JSON.stringify(cardKeys),
        cardKeys.length,
        cleanKeys.length,
        failed.length,
        JSON.stringify({ success: cleanKeys, failed }),
        req.ip || null,
        req.headers?.['user-agent'] || null,
      ]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      data: { request_id: requestId, success: cleanKeys.length, failed: failed.length },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Erro ao registrar impressão:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};
