const fs = require('fs');
const crypto = require('crypto');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 8192 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function run(ctx) {
  const { rows } = await ctx.db.query(`
    SELECT d.*, fs.path AS file_path, COALESCE(fs.sha256_hash, d.sha256_hash) AS stored_file_hash
      FROM public.invoice_documents d
      LEFT JOIN maestro.file_storage fs ON fs.id = d.file_id
     WHERE d.active = true
     ORDER BY d.id
  `);

  let failures = 0;

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

    if (status !== 'OK') failures += 1;

    await ctx.db.query(
      `INSERT INTO public.document_integrity_checks
        (document_id, status, stored_hash, computed_hash, checked_at, notes)
       VALUES ($1, $2, $3, $4, now(), $5)`,
      [doc.id, status, storedHash, computedHash, notes],
    );
  }

  ctx.setRecordsProcessed(rows.length);
  ctx.setDetails({ total: rows.length, failures });
}

module.exports = { run };
