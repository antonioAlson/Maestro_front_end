import pool from '../config/database.js';
import { UPLOAD_DIR } from '../middleware/upload.js';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';

// Lê o arquivo em streaming (chunks de 64KB) para evitar carregar PDFs/imagens
// grandes em memória só para calcular o hash.
function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Pasta dedicada para relatórios de ciclo. Mantém isolamento por cycleId
// (espelha o padrão de cutting_plan_attachment) e evita colisão de UUIDs
// quando o admin precisa inspecionar arquivos manualmente.
const AUTOCLAVE_REPORTS_ROOT = path.join(UPLOAD_DIR, 'autoclave-reports');

// ── helpers ──────────────────────────────────────────────────────────────────

// Coluna no banco preserva o typo Spring (`cycle_obervation`), mas a resposta
// JSON é normalizada para `cycleObservation` — é o nome que o frontend usa.
function mapCycle(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    creationDate: row.creation_date,
    startTime: row.start_time,
    cicleDate: row.cicle_date,
    status: row.status,
    reportFilePath: row.report_file_path,
    reportFileId: row.report_file_id,
    cycleObservation: row.cycle_obervation,
    packages: row.packages || [],
  };
}

function mapDetailedCycle(row) {
  const packages = (row.packages || []).map((pkg) => ({
    id: Number(pkg.id),
    totalPlates: (pkg.plates || []).length,
    packageObservations: pkg.package_observations,
    plates: (pkg.plates || []).map((pl) => ({
      id: Number(pl.id),
      plateSequence: pl.plate_sequence == null ? null : Number(pl.plate_sequence),
      status: pl.status,
      layers: pl.layers == null ? null : Number(pl.layers),
    })),
    autoclaveCycleId: Number(row.id),
    creationTime: pkg.creation_date,
    packageStatus: pkg.package_status,
  }));

  // platesPerLayer: agrupamento por número de camadas (formato { layers: count })
  const platesPerLayer = {};
  for (const pkg of packages) {
    for (const pl of pkg.plates) {
      if (pl.layers == null) continue;
      platesPerLayer[pl.layers] = (platesPerLayer[pl.layers] || 0) + 1;
    }
  }

  return {
    id: Number(row.id),
    startTime: row.start_time,
    creationDate: row.creation_date,
    status: row.status,
    cycleObservation: row.cycle_obervation,
    reportFilePath: row.report_file_path,
    reportFileId: row.report_file_id,
    totalPackages: packages.length,
    totalPlates: packages.reduce((acc, p) => acc + p.plates.length, 0),
    packages,
    platesPerLayer,
  };
}

// Sub-query que devolve os pacotes do ciclo como JSON aninhado, com placas.
// Usado em todos os endpoints de listagem detalhada.
const PACKAGES_JSON_SUBQUERY = `
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'id', pk.id,
        'package_observations', pk.package_observations,
        'package_status',       pk.package_status,
        'creation_date',        to_char(pk.creation_date, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'finish_date',          to_char(pk.finish_date,   'YYYY-MM-DD"T"HH24:MI:SS'),
        'plates', COALESCE((
          SELECT json_agg(
            json_build_object(
              'id',             pl.id,
              'plate_sequence', pl.plate_sequence,
              'status',         pl.status,
              'layers',         pl.layers
            ) ORDER BY pl.id ASC
          )
          FROM public.plates pl
          WHERE pl.package_id = pk.id
        ), '[]'::json)
      ) ORDER BY pk.id ASC
    )
    FROM public.package pk
    WHERE pk.cycle_id = c.id
  ), '[]'::json)
`;

const CYCLE_SELECT = `
  SELECT
    c.id,
    to_char(c.creation_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS creation_date,
    to_char(c.start_time,    'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
    to_char(c.cicle_date,    'YYYY-MM-DD"T"HH24:MI:SS') AS cicle_date,
    c.status,
    c.report_file_path,
    c.report_file_id,
    c.cycle_obervation,
    ${PACKAGES_JSON_SUBQUERY} AS packages
  FROM public.autoclave_cycle c
`;

// ── createCycle ──────────────────────────────────────────────────────────────

export const createCycle = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO public.autoclave_cycle (creation_date, status)
       VALUES (now(), 'CRIADO')
       RETURNING id`,
    );
    const { rows: full } = await pool.query(`${CYCLE_SELECT} WHERE c.id = $1`, [rows[0].id]);
    return res.json(mapCycle(full[0]));
  } catch (error) {
    console.error('[Autoclave] createCycle:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── getAll / summary / incomplete / by-cycle ─────────────────────────────────

export const getAll = async (_req, res) => {
  try {
    const { rows } = await pool.query(`${CYCLE_SELECT} ORDER BY c.id ASC`);
    return res.json(rows.map(mapCycle));
  } catch (error) {
    console.error('[Autoclave] getAll:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listDetailedCycles = async (_req, res) => {
  try {
    const { rows } = await pool.query(`${CYCLE_SELECT} ORDER BY c.creation_date DESC NULLS LAST`);
    return res.json(rows.map(mapDetailedCycle));
  } catch (error) {
    console.error('[Autoclave] listDetailedCycles:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Mesma regra do Spring: ciclos não FINALIZADO E onde algum pacote ainda não
// está APROVADO com todas as placas em EM_ESTOQUE/CONSUMO_PARCIAL/CONSUMO_TOTAL.
// Tradução literal da @Query JPQL para SQL — mantém a semântica de "incomplete".
export const findIncompleteCycles = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `${CYCLE_SELECT}
       WHERE c.status <> 'FINALIZADO'
         AND (
           NOT EXISTS (SELECT 1 FROM public.package pk WHERE pk.cycle_id = c.id)
           OR EXISTS (
             SELECT 1 FROM public.package pk
              WHERE pk.cycle_id = c.id
                AND pk.package_status <> 'APROVADO'
                AND NOT EXISTS (
                  SELECT 1 FROM public.plates pl
                   WHERE pl.package_id = pk.id
                     AND pl.status IN ('EM_ESTOQUE', 'CONSUMO_PARCIAL', 'CONSUMO_TOTAL')
                )
           )
         )
       ORDER BY c.creation_date DESC NULLS LAST`,
    );
    return res.json(rows.map(mapDetailedCycle));
  } catch (error) {
    console.error('[Autoclave] findIncompleteCycles:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const findByDateRange = async (req, res) => {
  try {
    const start = req.query.start ? String(req.query.start) : null;
    const end = req.query.end ? String(req.query.end) : null;
    if (!start || !end) {
      return res.status(400).json({ success: false, message: 'start e end são obrigatórios.' });
    }
    const { rows } = await pool.query(
      `${CYCLE_SELECT}
       WHERE c.creation_date BETWEEN $1::date AND ($2::date + INTERVAL '1 day' - INTERVAL '1 second')
       ORDER BY c.creation_date DESC NULLS LAST`,
      [start, end],
    );
    return res.json(rows.map(mapDetailedCycle));
  } catch (error) {
    console.error('[Autoclave] findByDateRange:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── duplicateCycle ───────────────────────────────────────────────────────────

export const duplicateCycle = async (req, res) => {
  try {
    const cycleId = Number(req.params.id);
    if (!Number.isFinite(cycleId)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const original = await pool.query(
      'SELECT report_file_path, report_file_id FROM public.autoclave_cycle WHERE id = $1',
      [cycleId],
    );
    if (original.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.autoclave_cycle (start_time, status, report_file_path, report_file_id)
       VALUES (now(), 'DUPLICADO', $1, $2)
       RETURNING id`,
      [original.rows[0].report_file_path, original.rows[0].report_file_id],
    );
    const { rows: full } = await pool.query(`${CYCLE_SELECT} WHERE c.id = $1`, [rows[0].id]);
    return res.json(mapCycle(full[0]));
  } catch (error) {
    console.error('[Autoclave] duplicateCycle:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── updateStatus (com cascata) ───────────────────────────────────────────────
// Replica o switch do Spring AutoclaveCycleService.updateStatus:
// - EM_ANDAMENTO: pacotes → EM_CICLO, placas → EM_AUTOCLAVE. Bloqueia se algum
//   pacote estiver sem placas vinculadas.
// - FINALIZADO:   pacotes → AGUARDANDO_APROVACAO, placas → AGUARDANDO_APROVACAO.
// - outros:       só altera o status do ciclo.

async function cascadeOnEmAndamento(client, cycleId, actor) {
  const pkgs = await client.query(
    `SELECT pk.id,
            COALESCE((SELECT COUNT(*) FROM public.plates pl WHERE pl.package_id = pk.id), 0)::int AS plate_count
       FROM public.package pk WHERE pk.cycle_id = $1`,
    [cycleId],
  );
  if (pkgs.rows.length === 0) {
    throw new Error('O ciclo não pode ser iniciado. Não há pacotes vinculados.');
  }
  const semPlacas = pkgs.rows.filter((p) => p.plate_count === 0);
  if (semPlacas.length > 0) {
    throw new Error('O ciclo não pode ser iniciado. Existem pacotes sem placas vinculadas');
  }

  await client.query(
    `UPDATE public.package SET package_status = 'EM_CICLO' WHERE cycle_id = $1`,
    [cycleId],
  );
  const platesUpdated = await client.query(
    `UPDATE public.plates SET status = 'EM_AUTOCLAVE'
      WHERE package_id IN (SELECT id FROM public.package WHERE cycle_id = $1)
      RETURNING id`,
    [cycleId],
  );
  for (const { id } of platesUpdated.rows) {
    await client.query(
      `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
       VALUES ($1, 'AUTOCLAVE', now(), $2)`,
      [id, `Ciclo ${cycleId} iniciado — placa marcada como EM_AUTOCLAVE por ${actor}`],
    );
  }
}

async function cascadeOnFinalizado(client, cycleId, actor) {
  await client.query(
    `UPDATE public.package SET package_status = 'AGUARDANDO_APROVACAO' WHERE cycle_id = $1`,
    [cycleId],
  );
  const platesUpdated = await client.query(
    `UPDATE public.plates SET status = 'AGUARDANDO_APROVACAO'
      WHERE package_id IN (SELECT id FROM public.package WHERE cycle_id = $1)
      RETURNING id`,
    [cycleId],
  );
  for (const { id } of platesUpdated.rows) {
    await client.query(
      `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
       VALUES ($1, 'AUTOCLAVE', now(), $2)`,
      [id, `Ciclo ${cycleId} finalizado — placa aguardando aprovação por ${actor}`],
    );
  }
}

export const updateStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    const cycleId = Number(req.params.id);
    const newStatus = String(req.body?.newStatus || '').trim();
    if (!Number.isFinite(cycleId) || !newStatus) {
      return res.status(400).json({ success: false, message: 'id e newStatus são obrigatórios.' });
    }

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM public.autoclave_cycle WHERE id = $1 FOR UPDATE',
      [cycleId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    const actor = req.user?.email || req.user?.username || 'sistema';

    if (newStatus === 'EM_ANDAMENTO') {
      await cascadeOnEmAndamento(client, cycleId, actor);
    } else if (newStatus === 'FINALIZADO') {
      await cascadeOnFinalizado(client, cycleId, actor);
    }

    await client.query(
      'UPDATE public.autoclave_cycle SET status = $1 WHERE id = $2',
      [newStatus, cycleId],
    );

    const { rows: full } = await client.query(`${CYCLE_SELECT} WHERE c.id = $1`, [cycleId]);
    await client.query('COMMIT');
    return res.json(mapCycle(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Autoclave] updateStatus:', error);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// ── uploadReport + completeCycleWithImage ────────────────────────────────────
// Diferença do Spring: aqui o arquivo passa por maestro.file_storage (UUID).
// report_file_id é a fonte de verdade; report_file_path é mantido para compat
// com Spring legado (e contém o caminho relativo dentro de UPLOAD_DIR).

async function persistFileForCycle(client, cycleId, file) {
  // multer escreveu o arquivo em UPLOAD_DIR/<uuid>.ext (storage padrão);
  // movemos para autoclave-reports/<cycleId>/<uuid>.ext para isolar o domínio.
  const targetDir = path.join(AUTOCLAVE_REPORTS_ROOT, String(cycleId));
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, file.filename);
  fs.renameSync(file.path, targetPath);

  // SHA-256 calculado APÓS o move final para garantir que o hash corresponda
  // ao path persistido (e que o arquivo já está no destino quando consultado).
  const sha256 = await computeSha256(targetPath);

  const fileId = path.basename(file.filename, path.extname(file.filename));
  await client.query(
    `INSERT INTO maestro.file_storage
       (id, original_name, stored_name, path, mime_type, size, sha256_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [fileId, file.originalname, file.filename, targetPath, file.mimetype, file.size, sha256],
  );

  // Caminho relativo a UPLOAD_DIR — Spring espera apenas o filename, mas no
  // novo formato gravamos o subdir para reconstruir o caminho em /report/:id.
  const relativePath = path.join('autoclave-reports', String(cycleId), file.filename);
  return { fileId, relativePath };
}

export const uploadReport = async (req, res) => {
  const client = await pool.connect();
  try {
    const cycleId = Number(req.params.id);
    const file = req.file;
    if (!Number.isFinite(cycleId) || !file) {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, message: 'id e file são obrigatórios.' });
    }

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM public.autoclave_cycle WHERE id = $1 FOR UPDATE',
      [cycleId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    const { fileId, relativePath } = await persistFileForCycle(client, cycleId, file);
    await client.query(
      `UPDATE public.autoclave_cycle
         SET report_file_path = $1, report_file_id = $2
       WHERE id = $3`,
      [relativePath, fileId, cycleId],
    );

    const { rows: full } = await client.query(`${CYCLE_SELECT} WHERE c.id = $1`, [cycleId]);
    await client.query('COMMIT');
    return res.json(mapCycle(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[Autoclave] uploadReport:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// POST /autoclave/cycle/complete/:id/upload — multipart (file + data JSON)
// Replica o Spring: salva relatório, depois se data.newStatus === FINALIZADO
// também aplica a cascata em pacotes + placas.
export const completeCycleWithImage = async (req, res) => {
  const client = await pool.connect();
  try {
    const cycleId = Number(req.params.id);
    const file = req.file;
    if (!Number.isFinite(cycleId) || !file) {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, message: 'id e file são obrigatórios.' });
    }

    let dto = req.body?.data;
    if (typeof dto === 'string') {
      try { dto = JSON.parse(dto); } catch { dto = null; }
    }
    const newStatus = String(dto?.newStatus || '').trim() || 'FINALIZADO';

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM public.autoclave_cycle WHERE id = $1 FOR UPDATE',
      [cycleId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    const { fileId, relativePath } = await persistFileForCycle(client, cycleId, file);
    const actor = req.user?.email || req.user?.username || 'sistema';

    if (newStatus === 'FINALIZADO') {
      await cascadeOnFinalizado(client, cycleId, actor);
    }

    await client.query(
      `UPDATE public.autoclave_cycle
         SET status = $1, report_file_path = $2, report_file_id = $3
       WHERE id = $4`,
      [newStatus, relativePath, fileId, cycleId],
    );

    const { rows: full } = await client.query(`${CYCLE_SELECT} WHERE c.id = $1`, [cycleId]);
    await client.query('COMMIT');
    return res.json(mapCycle(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[Autoclave] completeCycleWithImage:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// GET /api/autoclave/cycle/:id/report — serve o arquivo do ciclo.
// Substitui o /autoclave/cycle/report/<filename> do Spring (que recebia o
// filename do report_file_path). Aqui o frontend só precisa do cycleId.
export const getReport = async (req, res) => {
  try {
    const cycleId = Number(req.params.id);
    if (!Number.isFinite(cycleId)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const { rows } = await pool.query(
      `SELECT fs.path, fs.mime_type, fs.original_name
         FROM public.autoclave_cycle ac
         JOIN maestro.file_storage fs ON fs.id = ac.report_file_id
        WHERE ac.id = $1`,
      [cycleId],
    );
    if (rows.length === 0 || !fs.existsSync(rows[0].path)) {
      return res.status(404).json({ success: false, message: 'Relatório não encontrado.' });
    }
    const f = rows[0];
    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(f.original_name)}"`);
    res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
    fs.createReadStream(f.path).pipe(res);
  } catch (error) {
    console.error('[Autoclave] getReport:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
