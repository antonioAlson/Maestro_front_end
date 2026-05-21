import pool from '../config/database.js';
import { logProjectAudit } from '../services/auditService.js';

const ALLOWED_ORDER_COLS = ['id', 'project', 'material_type', 'brand', 'model', 'total_parts_qty', 'created_at'];

// Snapshot completo do projeto + planos, no formato gravado no audit (before/after).
async function getProjectSnapshot(projectId) {
  const result = await pool.query(
    `SELECT p.id, p.project, p.material_type, p.brand, p.model,
            p.roof_config, p.total_parts_qty, p.lid_parts_qty, p.product_alert,
            COALESCE(
              json_agg(
                json_build_object(
                  'id',                cp.id,
                  'plate_width',       cp.plate_width,
                  'plate_height',      cp.plate_height,
                  'linear_meters',     cp.linear_meters,
                  'square_meters',     cp.square_meters,
                  'notes',             cp.notes,
                  'plate_consumption', cp.plate_consumption,
                  'reviews',           cp.reviews
                ) ORDER BY cp.id
              ) FILTER (WHERE cp.id IS NOT NULL),
              '[]'::json
            ) AS cutting_plans
       FROM maestro.project p
       LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
      WHERE p.id = $1
      GROUP BY p.id`,
    [projectId]
  );
  return result.rows[0] || null;
}

// Wrapper que captura o snapshot e chama logProjectAudit sem nunca quebrar o fluxo principal.
async function safeAudit({ req, action, projectId, projectCode, before, after, metadata }) {
  try {
    await logProjectAudit({ req, action, projectId, projectCode, before, after, metadata });
  } catch (err) {
    console.error('[Audit] Falha ao auditar cutting-projects:', err.message);
  }
}

// POST /api/cutting-projects
export const criarProjectComPlanos = async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};

    const project = String(body.project || '').trim();
    const materialType = String(body.material_type || '').trim();
    const brand = String(body.brand || '').trim();
    const model = String(body.model || '').trim();
    const totalPartsQty = Number(body.total_parts_qty);

    const missing = [];
    if (!project) missing.push('project');
    if (!materialType) missing.push('material_type');
    if (!brand) missing.push('brand');
    if (!model) missing.push('model');
    if (!Number.isFinite(totalPartsQty) || totalPartsQty <= 0) missing.push('total_parts_qty');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando: ${missing.join(', ')}`
      });
    }

    const cuttingPlans = Array.isArray(body.cuttingPlans) ? body.cuttingPlans : [];
    if (cuttingPlans.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'É necessário pelo menos um plano de corte (cuttingPlans).'
      });
    }

    await client.query('BEGIN');

    const projectResult = await client.query(
      `INSERT INTO maestro.project
         (project, material_type, brand, model, roof_config, total_parts_qty, lid_parts_qty, product_alert)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        project,
        materialType,
        brand,
        model,
        String(body.roof_config || '').trim(),
        Math.trunc(totalPartsQty),
        Number.isFinite(Number(body.lid_parts_qty))
          ? Math.max(0, Math.trunc(Number(body.lid_parts_qty)))
          : 0,
        String(body.product_alert || '').trim()
      ]
    );

    const projectId = projectResult.rows[0].id;

    for (const plan of cuttingPlans) {
      await client.query(
        `INSERT INTO maestro.cutting_plan
           (project_id, plate_width, plate_height, linear_meters, square_meters,
            notes, plate_consumption, reviews)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          projectId,
          Number(plan.plate_width) || 0,
          Number(plan.plate_height) || 0,
          JSON.stringify(plan.linear_meters || {}),
          JSON.stringify(plan.square_meters || {}),
          String(plan.notes || ''),
          JSON.stringify(plan.plate_consumption || {}),
          JSON.stringify(plan.reviews || { cutting: false, labeling: false, ki_Layout: false, nesting_report: false, folder_template: false })
        ]
      );
    }

    await client.query('COMMIT');

    const after = await getProjectSnapshot(projectId);
    await safeAudit({
      req,
      action: 'CREATE',
      projectId,
      projectCode: after?.project ?? project,
      before: null,
      after,
    });

    return res.status(201).json({
      success: true,
      message: 'Projeto criado com planos de corte.',
      data: { id: projectId }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar projeto com planos:', error);
    return res.status(500).json({ success: false, message: `Erro ao criar projeto: ${error.message}` });
  } finally {
    client.release();
  }
};

// GET /api/cutting-projects
export const listarProjectsComPlanos = async (req, res) => {
  try {
    const { page = 1, limit = 20, filtro = '', ordenarPor = 'id', ordem = 'DESC' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const col = ALLOWED_ORDER_COLS.includes(ordenarPor) ? ordenarPor : 'id';
    const dir = ordem.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const filterTerm = filtro.trim() ? `%${filtro.trim()}%` : null;
    const countParams = filterTerm ? [filterTerm] : [];
    const whereClause = filterTerm
      ? `WHERE LOWER(p.project) LIKE LOWER($1)
            OR LOWER(p.brand)   LIKE LOWER($1)
            OR LOWER(p.model)   LIKE LOWER($1)
            OR LOWER(p.material_type) LIKE LOWER($1)`
      : '';

    const dataParams = filterTerm ? [filterTerm] : [];
    const limitIdx = dataParams.length + 1;
    const offsetIdx = dataParams.length + 2;
    dataParams.push(limitNum, offset);

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM maestro.project p ${whereClause}`,
        countParams
      ),
      pool.query(
        `SELECT
            p.id,
            p.project,
            p.material_type,
            p.brand,
            p.model,
            p.roof_config,
            p.total_parts_qty,
            p.lid_parts_qty,
            p.product_alert,
            p.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id',              cp.id,
                  'plate_width',     cp.plate_width,
                  'plate_height',    cp.plate_height,
                  'linear_meters',   cp.linear_meters,
                  'square_meters',   cp.square_meters,
                  'notes',           cp.notes,
                  'plate_consumption', cp.plate_consumption,
                  'attachments', (
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'type', cpa.type,
        'file', json_build_object(
          'id', fs.id,
          'original_name', fs.original_name,
          'mime_type', fs.mime_type
        )
      )
    ),
    '[]'::json
  )
  FROM maestro.cutting_plan_attachment cpa
  JOIN maestro.file_storage fs ON fs.id = cpa.file_id
  WHERE cpa.cutting_plan_id = cp.id
),
                  'reviews',         cp.reviews,
                  'created_at',      cp.created_at
                ) ORDER BY cp.id
              ) FILTER (WHERE cp.id IS NOT NULL),
              '[]'::json
            ) AS cutting_plans
          FROM maestro.project p
          LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
          ${whereClause}
          GROUP BY p.id
          ORDER BY p.${col} ${dir}
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        dataParams
      )
    ]);

    const total = parseInt(countResult.rows[0].count);
    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum
      }
    });
  } catch (error) {
    console.error('❌ Erro ao listar projetos:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/cutting-projects/:id
export const obterProjectComPlanos = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
          p.id,
          p.project,
          p.material_type,
          p.brand,
          p.model,
          p.roof_config,
          p.total_parts_qty,
          p.lid_parts_qty,
          p.product_alert,
          p.created_at,
          COALESCE(
            json_agg(
              json_build_object(
                'id',                cp.id,
                'plate_width',       cp.plate_width,
                'plate_height',      cp.plate_height,
                'linear_meters',     cp.linear_meters,
                'square_meters',     cp.square_meters,
                'notes',             cp.notes,
                'plate_consumption', cp.plate_consumption,
                'reviews',           cp.reviews,
                'created_at',        cp.created_at,
                'attachments', (
                  SELECT COALESCE(
                    json_agg(
                      json_build_object(
                        'type', cpa.type,
                        'file', json_build_object(
                          'id',            fs.id,
                          'original_name', fs.original_name,
                          'mime_type',     fs.mime_type
                        )
                      )
                    ),
                    '[]'::json
                  )
                  FROM maestro.cutting_plan_attachment cpa
                  JOIN maestro.file_storage fs ON fs.id = cpa.file_id
                  WHERE cpa.cutting_plan_id = cp.id
                )
              ) ORDER BY cp.id
            ) FILTER (WHERE cp.id IS NOT NULL),
            '[]'::json
          ) AS cutting_plans
        FROM maestro.project p
        LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter projeto:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PUT /api/cutting-projects/:projectId/plans/:planId
export const atualizarPlanoDeCorte = async (req, res) => {
  try {
    const { projectId, planId } = req.params;
    const body = req.body || {};

    const check = await pool.query(
      'SELECT id FROM maestro.cutting_plan WHERE id = $1 AND project_id = $2',
      [planId, projectId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Plano de corte não encontrado.' });
    }

    const fields = {};
    if (body.reviews !== undefined) fields.reviews = JSON.stringify(body.reviews);
    if (body.notes !== undefined) fields.notes = String(body.notes);
    if (body.plate_consumption !== undefined) fields.plate_consumption = JSON.stringify(body.plate_consumption);
    if (body.linear_meters !== undefined) fields.linear_meters = JSON.stringify(body.linear_meters);
    if (body.square_meters !== undefined) fields.square_meters = JSON.stringify(body.square_meters);
    if (body.plate_width !== undefined) fields.plate_width = Number(body.plate_width);
    if (body.plate_height !== undefined) fields.plate_height = Number(body.plate_height);

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }

    const before = await getProjectSnapshot(projectId);

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(planId);

    await pool.query(
      `UPDATE maestro.cutting_plan SET ${setClauses} WHERE id = $${values.length}`,
      values
    );

    const after = await getProjectSnapshot(projectId);
    await safeAudit({
      req,
      action: 'UPDATE',
      projectId: Number(projectId),
      projectCode: before?.project ?? after?.project,
      before,
      after,
      metadata: { plan_id: Number(planId), plan_action: 'updated' },
    });

    return res.status(200).json({ success: true, message: 'Plano de corte atualizado.' });
  } catch (error) {
    console.error('❌ Erro ao atualizar plano:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/cutting-projects/:id/plans
export const adicionarPlanoDeCorte = async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const plan = req.body || {};

    const before = await getProjectSnapshot(projectId);
    if (!before) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }

    const result = await pool.query(
      `INSERT INTO maestro.cutting_plan
         (project_id, plate_width, plate_height, linear_meters, square_meters,
          notes, plate_consumption, reviews)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        projectId,
        Number(plan.plate_width) || 0,
        Number(plan.plate_height) || 0,
        JSON.stringify(plan.linear_meters || {}),
        JSON.stringify(plan.square_meters || {}),
        String(plan.notes || ''),
        JSON.stringify(plan.plate_consumption || {}),
        JSON.stringify(plan.reviews || { cutting: false, labeling: false, ki_Layout: false, nesting_report: false, folder_template: false })
      ]
    );

    const newPlanId = result.rows[0].id;
    const after = await getProjectSnapshot(projectId);
    await safeAudit({
      req,
      action: 'UPDATE',
      projectId: Number(projectId),
      projectCode: before.project,
      before,
      after,
      metadata: { plan_id: newPlanId, plan_action: 'added' },
    });

    return res.status(201).json({
      success: true,
      message: 'Plano de corte adicionado.',
      data: { id: newPlanId }
    });
  } catch (error) {
    console.error('❌ Erro ao adicionar plano:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/cutting-projects/:id/clone
export const clonarProjectComPlanos = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const projResult = await client.query(
      'SELECT * FROM maestro.project WHERE id = $1',
      [id]
    );
    if (projResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }
    const orig = projResult.rows[0];

    const plansResult = await client.query(
      'SELECT * FROM maestro.cutting_plan WHERE project_id = $1 ORDER BY id',
      [id]
    );

    await client.query('BEGIN');

    const newProj = await client.query(
      `INSERT INTO maestro.project
         (project, material_type, brand, model, roof_config, total_parts_qty, lid_parts_qty, product_alert)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        `${orig.project} (cópia)`,
        orig.material_type,
        orig.brand,
        orig.model,
        orig.roof_config || '',
        orig.total_parts_qty,
        orig.lid_parts_qty || 0,
        orig.product_alert || '',
      ]
    );
    const newId = newProj.rows[0].id;

    for (const plan of plansResult.rows) {
      await client.query(
        `INSERT INTO maestro.cutting_plan
           (project_id, plate_width, plate_height, linear_meters, square_meters,
            notes, plate_consumption, reviews)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId,
          plan.plate_width,
          plan.plate_height,
          JSON.stringify(plan.linear_meters || {}),
          JSON.stringify(plan.square_meters || {}),
          plan.notes || '',
          JSON.stringify(plan.plate_consumption || {}),
          JSON.stringify({ cutting: false, labeling: false, ki_Layout: false, nesting_report: false, folder_template: false }),
        ]
      );
    }

    await client.query('COMMIT');

    const after = await getProjectSnapshot(newId);
    await safeAudit({
      req,
      action: 'CLONE',
      projectId: newId,
      projectCode: after?.project,
      before: null,
      after,
      metadata: { source_project_id: orig.id, source_project_code: orig.project },
    });

    return res.status(201).json({ success: true, message: 'Projeto clonado.', data: { id: newId } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao clonar projeto:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PUT /api/cutting-projects/:id  (atualiza campos fixos do projeto)
export const atualizarProjectFixo = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const fields = {};
    if (body.project !== undefined) fields.project = String(body.project).trim();
    if (body.material_type !== undefined) fields.material_type = String(body.material_type).trim();
    if (body.brand !== undefined) fields.brand = String(body.brand).trim();
    if (body.model !== undefined) fields.model = String(body.model).trim();
    if (body.roof_config !== undefined) fields.roof_config = String(body.roof_config).trim();
    if (body.product_alert !== undefined) fields.product_alert = String(body.product_alert).trim();
    if (body.total_parts_qty !== undefined) fields.total_parts_qty = Math.trunc(Number(body.total_parts_qty));
    if (body.lid_parts_qty !== undefined) fields.lid_parts_qty = Math.max(0, Math.trunc(Number(body.lid_parts_qty)));

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }

    const before = await getProjectSnapshot(id);
    if (!before) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE maestro.project SET ${setClauses} WHERE id = $${values.length} RETURNING id`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }

    const after = await getProjectSnapshot(id);
    await safeAudit({
      req,
      action: 'UPDATE',
      projectId: Number(id),
      projectCode: after?.project ?? before.project,
      before,
      after,
    });

    return res.status(200).json({ success: true, message: 'Projeto atualizado.' });
  } catch (error) {
    console.error('❌ Erro ao atualizar projeto:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/cutting-projects/:projectId/plans/:planId
export const excluirPlanoDeCorte = async (req, res) => {
  try {
    const { projectId, planId } = req.params;

    const before = await getProjectSnapshot(projectId);

    const result = await pool.query(
      'DELETE FROM maestro.cutting_plan WHERE id = $1 AND project_id = $2 RETURNING id',
      [planId, projectId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Plano de corte não encontrado.' });
    }

    const after = await getProjectSnapshot(projectId);
    await safeAudit({
      req,
      action: 'UPDATE',
      projectId: Number(projectId),
      projectCode: before?.project ?? after?.project,
      before,
      after,
      metadata: { plan_id: Number(planId), plan_action: 'removed' },
    });

    return res.status(200).json({ success: true, message: 'Plano de corte excluído.' });
  } catch (error) {
    console.error('❌ Erro ao excluir plano:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/cutting-projects/:id
export const excluirProjectComPlanos = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const before = await getProjectSnapshot(id);

    await client.query('BEGIN');
    await client.query('DELETE FROM maestro.cutting_plan WHERE project_id = $1', [id]);
    const result = await client.query(
      'DELETE FROM maestro.project WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }
    await client.query('COMMIT');

    await safeAudit({
      req,
      action: 'DELETE',
      projectId: Number(id),
      projectCode: before?.project,
      before,
      after: null,
    });

    return res.status(200).json({ success: true, message: 'Projeto excluído.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao excluir projeto:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};
