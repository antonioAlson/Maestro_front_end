import crypto, { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import pool from '../config/database.js';
import { UPLOAD_DIR } from '../middleware/upload.js';

const DOCUMENT_TYPES = new Set(['NF', 'CARTA_CORRECAO']);
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/xml',
  'text/xml',
  'image/jpeg',
  'image/png',
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizePathPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

const invoiceStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const invoiceNumber = req.params?.invoiceNumber;
    const dir = path.join(
      UPLOAD_DIR,
      'invoice-documents',
      sanitizePathPart(invoiceNumber),
    );
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

export const uploadInvoiceDocumentMiddleware = multer({
  storage: invoiceStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
}).single('file');

function toCents(value) {
  const n = Number(value || 0);
  return Math.round(n * 100);
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 8192 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function mapDocument(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    invoiceNumber: row.invoice_number,
    type: row.type,
    originalFilename: row.original_filename,
    fileSizeBytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
    sha256Hash: row.sha256_hash,
    version: row.version == null ? null : Number(row.version),
    active: row.active,
    replacedById: row.replaced_by_id == null ? null : Number(row.replaced_by_id),
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    fileId: row.file_id,
  };
}

function mapIntegrity(row) {
  return {
    id: Number(row.id),
    status: row.status,
    storedHash: row.stored_hash,
    computedHash: row.computed_hash,
    checkedAt: row.checked_at,
    notes: row.notes,
    document: {
      id: row.document_id == null ? null : Number(row.document_id),
      type: row.type,
      originalFilename: row.original_filename,
      version: row.version == null ? null : Number(row.version),
      invoice: {
        id: row.invoice_id == null ? null : Number(row.invoice_id),
        invoiceNumber: row.invoice_number,
      },
    },
  };
}

async function getOrCreateInvoice(client, number) {
  const invoiceNumber = String(number || '').trim();
  if (!invoiceNumber) {
    const err = new Error('Numero da nota fiscal nao pode ser vazio');
    err.status = 400;
    throw err;
  }
  const existing = await client.query(
    'SELECT id FROM public.invoices WHERE invoice_number = $1',
    [invoiceNumber],
  );
  if (existing.rows.length > 0) return Number(existing.rows[0].id);

  const created = await client.query(
    `INSERT INTO public.invoices (invoice_number, nf_file_path, correction_file_path)
     VALUES ($1, NULL, NULL)
     ON CONFLICT (invoice_number) DO UPDATE SET invoice_number = EXCLUDED.invoice_number
     RETURNING id`,
    [invoiceNumber],
  );
  return Number(created.rows[0].id);
}

export const updateCuttingRecordInvoices = async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const recordId = Number(body.cuttingRecordId ?? body.cutting_record_id);
    const consumptions = Array.isArray(body.consumptions) ? body.consumptions : [];
    if (!Number.isFinite(recordId)) {
      return res.status(400).json({ success: false, message: 'cuttingRecordId invalido.' });
    }

    await client.query('BEGIN');

    const record = await client.query('SELECT id FROM public.cutting_records WHERE id = $1 FOR UPDATE', [recordId]);
    if (record.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `CuttingRecord nao encontrado: ${recordId}` });
    }

    const singleInvoice = Boolean(body.singleInvoice);

    for (const dto of consumptions) {
      const consumptionId = Number(dto.id);
      const invoices = Array.isArray(dto.invoices) ? dto.invoices : [];
      const splits = Array.isArray(dto.splits) ? dto.splits : [];

      const cRes = await client.query(
        `SELECT id, used_metrage
           FROM public.plate_consumptions
          WHERE id = $1 AND cutting_record_id = $2
          FOR UPDATE`,
        [consumptionId, recordId],
      );
      if (cRes.rows.length === 0) {
        const err = new Error(`Consumo nao encontrado: ${consumptionId}`);
        err.status = 404;
        throw err;
      }
      const consumption = cRes.rows[0];

      if (singleInvoice && splits.length > 0) {
        const err = new Error(`Modo Nota Unica ativo: divisoes nao sao permitidas (consumo ID=${consumptionId})`);
        err.status = 400;
        throw err;
      }
      if (singleInvoice && invoices.length > 1) {
        const err = new Error(`Modo Nota Unica ativo: cada consumo deve ter no maximo 1 nota fiscal (consumo ID=${consumptionId})`);
        err.status = 400;
        throw err;
      }
      if (!singleInvoice && invoices.length > 0 && splits.length > 0) {
        const err = new Error(`Consumo ID=${consumptionId}: nao e possivel combinar notas fiscais e divisoes no mesmo consumo`);
        err.status = 400;
        throw err;
      }

      const total = (splits.length > 0 ? splits : invoices)
        .reduce((sum, item) => sum + toCents(item.usedMetrage), 0);
      if (total > toCents(consumption.used_metrage)) {
        const err = new Error(`Consumo ID=${consumptionId}: soma apontada excede o consumo (${consumption.used_metrage})`);
        err.status = 400;
        throw err;
      }

      await client.query('DELETE FROM public.plate_consumption_invoices WHERE plate_consumption_id = $1', [consumptionId]);
      await client.query('DELETE FROM public.consumption_splits WHERE plate_consumption_id = $1', [consumptionId]);

      if (splits.length > 0) {
        for (const split of splits) {
          const number = split.invoice?.number ?? split.invoiceNumber ?? split.number;
          const invoiceId = await getOrCreateInvoice(client, number);
          await client.query(
            `INSERT INTO public.consumption_splits (used_metrage, invoice_id, plate_consumption_id)
             VALUES ($1, $2, $3)`,
            [asNumber(split.usedMetrage), invoiceId, consumptionId],
          );
        }
      } else {
        for (const invoice of invoices) {
          const invoiceId = await getOrCreateInvoice(client, invoice.number ?? invoice.invoiceNumber);
          await client.query(
            `INSERT INTO public.plate_consumption_invoices (used_metrage, plate_consumption_id, invoice_id)
             VALUES ($1, $2, $3)`,
            [asNumber(invoice.usedMetrage), consumptionId, invoiceId],
          );
        }
      }
    }

    await client.query('COMMIT');
    return res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Invoices] update error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const getAging = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cr.id,
        cr.order_number,
        cr.created_at,
        EXTRACT(DAY FROM now() - cr.created_at)::int AS days_since_creation,
        json_agg(json_build_object(
          'id', pc.id,
          'supplier', COALESCE(pc.supplier, 'N/A'),
          'usedMetrage', pc.used_metrage::float8,
          'invoiceCount', COALESCE(pci.cnt, 0),
          'splitCount', COALESCE(cs.cnt, 0)
        ) ORDER BY pc.id) AS consumptions
      FROM public.cutting_records cr
      JOIN public.plate_consumptions pc ON pc.cutting_record_id = cr.id
      LEFT JOIN (
        SELECT plate_consumption_id, COUNT(*)::int cnt
        FROM public.plate_consumption_invoices
        GROUP BY plate_consumption_id
      ) pci ON pci.plate_consumption_id = pc.id
      LEFT JOIN (
        SELECT plate_consumption_id, COUNT(*)::int cnt
        FROM public.consumption_splits
        GROUP BY plate_consumption_id
      ) cs ON cs.plate_consumption_id = pc.id
      GROUP BY cr.id
    `);

    const summary = { CURRENT: 0, ATTENTION: 0, WARNING: 0, CRITICAL: 0 };
    const bucketRank = { CRITICAL: 4, WARNING: 3, ATTENTION: 2, CURRENT: 1 };
    const items = [];

    for (const row of rows) {
      const consumptions = row.consumptions || [];
      const unbilled = consumptions
        .filter((c) => Number(c.invoiceCount || 0) === 0 && Number(c.splitCount || 0) === 0)
        .map((c) => ({
          consumptionId: Number(c.id),
          supplier: c.supplier || 'N/A',
          usedMetrage: c.usedMetrage,
        }));
      if (unbilled.length === 0) continue;

      const days = Number(row.days_since_creation || 0);
      const bucket = days <= 7 ? 'CURRENT' : days <= 15 ? 'ATTENTION' : days <= 30 ? 'WARNING' : 'CRITICAL';
      summary[bucket] += 1;
      items.push({
        cuttingRecordId: Number(row.id),
        orderNumber: row.order_number,
        createdAt: row.created_at,
        daysSinceCreation: days,
        bucket,
        totalConsumptions: consumptions.length,
        unbilledConsumptions: unbilled.length,
        unbilled,
      });
    }

    items.sort((a, b) => bucketRank[b.bucket] - bucketRank[a.bucket] || b.daysSinceCreation - a.daysSinceCreation);

    return res.json({ generatedAt: new Date().toISOString(), summary, items });
  } catch (error) {
    console.error('[Invoices] aging error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getComplianceChecklist = async (req, res) => {
  try {
    const recordId = Number(req.params.id);
    const recordRes = await pool.query(
      `SELECT id, order_number FROM public.cutting_records WHERE id = $1`,
      [recordId],
    );
    if (recordRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Corte nao encontrado: ${recordId}` });
    }

    const { rows } = await pool.query(`
      SELECT
        pc.id,
        pc.supplier,
        pc.used_metrage,
        COALESCE((
          SELECT json_agg(json_build_object(
            'number', i.invoice_number,
            'usedMetrage', pci.used_metrage::float8
          ))
          FROM public.plate_consumption_invoices pci
          JOIN public.invoices i ON i.id = pci.invoice_id
          WHERE pci.plate_consumption_id = pc.id
        ), '[]'::json) AS invoices,
        COALESCE((
          SELECT json_agg(json_build_object(
            'number', i.invoice_number,
            'usedMetrage', cs.used_metrage::float8
          ))
          FROM public.consumption_splits cs
          JOIN public.invoices i ON i.id = cs.invoice_id
          WHERE cs.plate_consumption_id = pc.id
        ), '[]'::json) AS splits
      FROM public.plate_consumptions pc
      WHERE pc.cutting_record_id = $1
      ORDER BY pc.id
    `, [recordId]);

    const items = [];
    for (const c of rows) {
      const invoices = c.invoices || [];
      const splits = c.splits || [];
      const hasBilling = invoices.length > 0 || splits.length > 0;

      items.push({
        consumptionId: Number(c.id),
        supplier: c.supplier || 'N/A',
        rule: 'INVOICE_REQUIRED',
        message: hasBilling
          ? (splits.length > 0 ? `Consumo dividido em ${splits.length} parte(s)` : 'Nota fiscal apontada')
          : 'Consumo sem nota fiscal apontada',
        passed: hasBilling,
      });

      if (c.supplier === 'OPERA' && hasBilling) {
        const numbers = [...new Set([...invoices, ...splits].map((i) => i.number).filter(Boolean))];
        const docs = numbers.length === 0 ? { rows: [] } : await pool.query(
          `SELECT id
             FROM public.invoice_documents d
             JOIN public.invoices i ON i.id = d.invoice_id
            WHERE d.active = true AND d.type = 'NF' AND i.invoice_number = ANY($1)`,
          [numbers],
        );
        const passed = docs.rows.length > 0;
        items.push({
          consumptionId: Number(c.id),
          supplier: c.supplier,
          rule: 'NF_DOCUMENT_REQUIRED_OPERA',
          message: passed ? 'Documento NF anexado (Opera)' : 'Fornecedor Opera: documento NF obrigatorio nao anexado',
          passed,
        });
      }

      if (hasBilling) {
        const total = [...invoices, ...splits].reduce((sum, item) => sum + toCents(item.usedMetrage), 0);
        const expected = toCents(c.used_metrage);
        const passed = total === expected;
        const totalText = (total / 100).toFixed(2);
        const expectedText = (expected / 100).toFixed(2);
        items.push({
          consumptionId: Number(c.id),
          supplier: c.supplier || 'N/A',
          rule: 'QUANTITY_BALANCE',
          message: passed
            ? `Saldo conferido: ${totalText} == ${expectedText}`
            : `Saldo divergente: faturado ${totalText} != consumo ${expectedText}`,
          passed,
        });
      }
    }

    const failedCount = items.filter((i) => !i.passed).length;
    return res.json({
      cutting_record_id: Number(recordRes.rows[0].id),
      cuttingRecordId: Number(recordRes.rows[0].id),
      order_number: recordRes.rows[0].order_number,
      orderNumber: recordRes.rows[0].order_number,
      is_compliant: failedCount === 0,
      compliant: failedCount === 0,
      total_consumptions: rows.length,
      totalConsumptions: rows.length,
      failed_count: failedCount,
      failedItems: failedCount,
      items,
    });
  } catch (error) {
    console.error('[Invoices] compliance error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const uploadInvoiceDocument = async (req, res) => {
  const client = await pool.connect();
  let createdPath = req.file?.path;
  try {
    const invoiceNumber = req.params.invoiceNumber;
    const type = req.body?.type;
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: 'Arquivo nao enviado.' });
    if (!DOCUMENT_TYPES.has(type)) {
      if (createdPath && fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
      return res.status(400).json({ success: false, message: 'Tipo de documento invalido.' });
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      if (createdPath && fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
      return res.status(400).json({ success: false, message: 'Mime type nao permitido.' });
    }

    const typedDir = path.join(
      UPLOAD_DIR,
      'invoice-documents',
      sanitizePathPart(invoiceNumber),
      sanitizePathPart(type),
    );
    ensureDir(typedDir);
    const typedPath = path.join(typedDir, file.filename);
    if (file.path !== typedPath) {
      fs.renameSync(file.path, typedPath);
      file.path = typedPath;
      createdPath = typedPath;
    }

    await client.query('BEGIN');

    const invoice = await client.query('SELECT id FROM public.invoices WHERE invoice_number = $1 FOR UPDATE', [invoiceNumber]);
    if (invoice.rows.length === 0) {
      await client.query('ROLLBACK');
      if (createdPath && fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
      return res.status(404).json({ success: false, message: `Nota fiscal nao encontrada: ${invoiceNumber}` });
    }
    const invoiceId = Number(invoice.rows[0].id);

    const previous = await client.query(
      `SELECT id, version
         FROM public.invoice_documents
        WHERE invoice_id = $1 AND type = $2 AND active = true
        ORDER BY version DESC
        LIMIT 1`,
      [invoiceId, type],
    );
    const nextVersion = previous.rows.length > 0 ? Number(previous.rows[0].version) + 1 : 1;
    const hash = await sha256File(file.path);
    const fileId = randomUUID();

    await client.query(
      `INSERT INTO maestro.file_storage
        (id, original_name, stored_name, path, mime_type, size, sha256_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [fileId, file.originalname, file.filename, file.path, file.mimetype, file.size, hash],
    );

    const inserted = await client.query(
      `INSERT INTO public.invoice_documents
        (invoice_id, type, original_filename, storage_path, file_id, file_size_bytes,
         sha256_hash, version, active, uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, now())
       RETURNING *`,
      [
        invoiceId,
        type,
        file.originalname,
        file.path,
        fileId,
        file.size,
        hash,
        nextVersion,
        req.user?.email || req.user?.username || 'sistema',
      ],
    );

    if (previous.rows.length > 0) {
      await client.query(
        'UPDATE public.invoice_documents SET active = false, replaced_by_id = $1 WHERE id = $2',
        [inserted.rows[0].id, previous.rows[0].id],
      );
    }

    await client.query('COMMIT');
    createdPath = null;
    return res.status(201).json(mapDocument({ ...inserted.rows[0], invoice_number: invoiceNumber }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (createdPath && fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
    console.error('[Invoices] upload error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const listInvoiceDocuments = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, i.invoice_number
         FROM public.invoice_documents d
         JOIN public.invoices i ON i.id = d.invoice_id
        WHERE i.invoice_number = $1 AND d.active = true
        ORDER BY d.type, d.version DESC`,
      [req.params.invoiceNumber],
    );
    return res.json(rows.map(mapDocument));
  } catch (error) {
    console.error('[Invoices] list docs error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listInvoiceDocumentHistory = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, i.invoice_number
         FROM public.invoice_documents d
         JOIN public.invoices i ON i.id = d.invoice_id
        WHERE i.invoice_number = $1
        ORDER BY d.version DESC, d.created_at DESC`,
      [req.params.invoiceNumber],
    );
    return res.json(rows.map(mapDocument));
  } catch (error) {
    console.error('[Invoices] history error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const downloadInvoiceDocument = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, i.invoice_number, fs.path AS file_path, fs.original_name, fs.mime_type
         FROM public.invoice_documents d
         JOIN public.invoices i ON i.id = d.invoice_id
         LEFT JOIN maestro.file_storage fs ON fs.id = d.file_id
        WHERE i.invoice_number = $1 AND d.id = $2`,
      [req.params.invoiceNumber, req.params.documentId],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Documento nao encontrado.' });
    const doc = rows[0];
    const filePath = doc.file_path || doc.storage_path;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Arquivo nao encontrado no disco.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_name || doc.original_filename)}"`);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('[Invoices] download error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

async function runIntegrityCheck() {
  const { rows } = await pool.query(`
    SELECT d.*, fs.path AS file_path, COALESCE(fs.sha256_hash, d.sha256_hash) AS stored_file_hash
      FROM public.invoice_documents d
      LEFT JOIN maestro.file_storage fs ON fs.id = d.file_id
     WHERE d.active = true
     ORDER BY d.id
  `);

  const results = [];
  for (const doc of rows) {
    const filePath = doc.file_path || doc.storage_path;
    let status = 'OK';
    let computedHash = null;
    let notes = null;
    const storedHash = doc.sha256_hash || doc.stored_file_hash;

    if (!filePath || !fs.existsSync(filePath)) {
      status = 'MISSING';
      notes = `Arquivo nao encontrado em: ${filePath || '(sem caminho)'}`;
    } else {
      try {
        computedHash = await sha256File(filePath);
        if (computedHash !== storedHash) {
          status = 'CORRUPTED';
          notes = `Hash divergente. Esperado: ${storedHash} | Calculado: ${computedHash}`;
        }
      } catch (err) {
        status = 'CORRUPTED';
        notes = `Erro ao calcular hash: ${err.message}`;
      }
    }

    const inserted = await pool.query(
      `INSERT INTO public.document_integrity_checks
        (document_id, status, stored_hash, computed_hash, checked_at, notes)
       VALUES ($1, $2, $3, $4, now(), $5)
       RETURNING *`,
      [doc.id, status, storedHash, computedHash, notes],
    );
    results.push(inserted.rows[0]);
  }
  return results;
}

export const runIntegrity = async (_req, res) => {
  try {
    const results = await runIntegrityCheck();
    const total = results.length;
    const ok = results.filter((r) => r.status === 'OK').length;
    const corrupted = results.filter((r) => r.status === 'CORRUPTED').length;
    const missing = results.filter((r) => r.status === 'MISSING').length;
    return res.json({ total, ok, corrupted, missing });
  } catch (error) {
    console.error('[Invoices] integrity run error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const INTEGRITY_SELECT = `
  SELECT c.*, d.id AS document_id, d.type, d.original_filename, d.version,
         i.id AS invoice_id, i.invoice_number
    FROM public.document_integrity_checks c
    JOIN public.invoice_documents d ON d.id = c.document_id
    JOIN public.invoices i ON i.id = d.invoice_id
`;

export const listIntegrityFailures = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      ${INTEGRITY_SELECT}
      WHERE c.checked_at = (
        SELECT MAX(c2.checked_at)
          FROM public.document_integrity_checks c2
         WHERE c2.document_id = c.document_id
      )
      AND c.status <> 'OK'
      ORDER BY c.checked_at DESC
      LIMIT 200
    `);
    return res.json(rows.map(mapIntegrity));
  } catch (error) {
    console.error('[Invoices] failures error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listDocumentIntegrityHistory = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      ${INTEGRITY_SELECT}
      WHERE c.document_id = $1
      ORDER BY c.checked_at DESC
    `, [req.params.documentId]);
    return res.json(rows.map(mapIntegrity));
  } catch (error) {
    console.error('[Invoices] doc integrity error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
