import pool from '../config/database.js';

// Shape do pacote retornado — espelha AutoclavePackage do Spring (sem
// recursão para o ciclo: usamos cycle_id direto para evitar ciclos JSON).
const PACKAGE_SELECT = `
  SELECT
    pk.id,
    pk.package_observations,
    pk.cycle_id,
    to_char(pk.creation_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS creation_date,
    to_char(pk.finish_date,   'YYYY-MM-DD"T"HH24:MI:SS') AS finish_date,
    pk.package_status,
    COALESCE((
      SELECT json_agg(
        json_build_object(
          'id',             pl.id,
          'plate_sequence', pl.plate_sequence,
          'status',         pl.status,
          'layers',         pl.layers,
          'actual_size',    pl.actual_size,
          'init_size',      pl.init_size,
          'workorderid',    pl.workorderid,
          'package_id',     pl.package_id
        ) ORDER BY pl.id ASC
      )
      FROM public.plates pl
      WHERE pl.package_id = pk.id
    ), '[]'::json) AS plates
  FROM public.package pk
`;

function mapPackage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    packageObservations: row.package_observations,
    autoclaveCycle: row.cycle_id == null ? null : { id: Number(row.cycle_id) },
    creationDate: row.creation_date,
    finishDate: row.finish_date,
    packageStatus: row.package_status,
    plates: (row.plates || []).map((pl) => ({
      id: Number(pl.id),
      plateSequence: pl.plate_sequence == null ? null : Number(pl.plate_sequence),
      status: pl.status,
      layers: pl.layers == null ? null : Number(pl.layers),
      actualSize: pl.actual_size == null ? null : Number(pl.actual_size),
      initSize: pl.init_size == null ? null : Number(pl.init_size),
      workorderId: pl.workorderid == null ? null : Number(pl.workorderid),
      packageId: pl.package_id == null ? null : Number(pl.package_id),
    })),
  };
}

// POST /api/autoclave/package/cycle  — body: PackageDTO
// Spring permite criar pacote vazio; o vínculo das placas (se houver
// plateIds) também muda o package_id delas. Status inicial: PREPARANDO.
export const createPackage = async (req, res) => {
  const client = await pool.connect();
  try {
    const cycleId = Number(req.body?.autoclaveCycleId);
    if (!Number.isFinite(cycleId)) {
      return res.status(400).json({ success: false, message: 'autoclaveCycleId é obrigatório.' });
    }
    const packageObservations = req.body?.packageObservations ?? null;
    const plateIds = Array.isArray(req.body?.plateIds)
      ? req.body.plateIds.map(Number).filter(Number.isFinite)
      : [];

    await client.query('BEGIN');

    const cycle = await client.query(
      'SELECT id FROM public.autoclave_cycle WHERE id = $1',
      [cycleId],
    );
    if (cycle.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    const insert = await client.query(
      `INSERT INTO public.package
         (package_observations, cycle_id, creation_date, package_status)
       VALUES ($1, $2, now(), 'PREPARANDO')
       RETURNING id`,
      [packageObservations, cycleId],
    );
    const packageId = Number(insert.rows[0].id);

    if (plateIds.length > 0) {
      // Mesma validação de addPlatesToPackage — pacote novo só aceita
      // EM_ENFESTO/REPASSE sem package_id prévio.
      const plates = await client.query(
        `SELECT id, status, package_id FROM public.plates
          WHERE id = ANY($1::bigint[]) FOR UPDATE`,
        [plateIds],
      );
      if (plates.rows.length !== plateIds.length) {
        const found = new Set(plates.rows.map((p) => Number(p.id)));
        const missing = plateIds.filter((id) => !found.has(id));
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: `Placas não encontradas: ${missing.join(', ')}`,
        });
      }
      const blocked = plates.rows.filter(
        (p) => !PACKAGE_ELIGIBLE_STATUSES.has(p.status) || p.package_id != null,
      );
      if (blocked.length > 0) {
        await client.query('ROLLBACK');
        const detail = blocked
          .map((p) => `${p.id}(${p.status}${p.package_id != null ? `, pacote ${p.package_id}` : ''})`)
          .join(', ');
        return res.status(409).json({
          success: false,
          message: `Placas inelegíveis para o pacote — só EM_ENFESTO/REPASSE sem pacote: ${detail}`,
        });
      }
      await client.query(
        `UPDATE public.plates
            SET package_id = $1, status = 'EM_PACOTE'
          WHERE id = ANY($2::bigint[])`,
        [packageId, plateIds],
      );
      for (const pid of plateIds) {
        await client.query(
          `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
           VALUES ($1, 'AUTOCLAVE', now(), $2)`,
          [pid, `Placa ${pid} adicionada ao pacote ${packageId}`],
        );
      }
    }

    const { rows: full } = await client.query(`${PACKAGE_SELECT} WHERE pk.id = $1`, [packageId]);
    await client.query('COMMIT');
    return res.json(mapPackage(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Autoclave/Package] createPackage:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// Statuses aceitos para adicionar placa a um pacote novo (§5.2 da spec):
// EM_ENFESTO (pacote novo) ou REPASSE (retorno após reprovação).
const PACKAGE_ELIGIBLE_STATUSES = new Set(['EM_ENFESTO', 'REPASSE']);

// POST /api/autoclave/package/:packid/addPlates  — body: [plateId, ...]
// Cada placa adicionada vai para EM_PACOTE e ganha plate_event AUTOCLAVE.
// Bloqueia placas fora de EM_ENFESTO/REPASSE e placas já vinculadas a outro
// pacote — evita meter placa consumida ou em ciclo no pacote novo.
export const addPlatesToPackage = async (req, res) => {
  const client = await pool.connect();
  try {
    const packageId = Number(req.params.packid);
    const plateIds = Array.isArray(req.body)
      ? req.body.map(Number).filter(Number.isFinite)
      : [];
    if (!Number.isFinite(packageId)) {
      return res.status(400).json({ success: false, message: 'packid inválido.' });
    }
    if (plateIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma placa enviada.' });
    }

    await client.query('BEGIN');

    const pkg = await client.query('SELECT id FROM public.package WHERE id = $1', [packageId]);
    if (pkg.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Package not found' });
    }

    // Valida status e vínculo prévio antes de mover.
    const plates = await client.query(
      `SELECT id, status, package_id FROM public.plates
        WHERE id = ANY($1::bigint[]) FOR UPDATE`,
      [plateIds],
    );
    if (plates.rows.length !== plateIds.length) {
      await client.query('ROLLBACK');
      const found = new Set(plates.rows.map((p) => Number(p.id)));
      const missing = plateIds.filter((id) => !found.has(id));
      return res.status(404).json({
        success: false,
        message: `Placas não encontradas: ${missing.join(', ')}`,
      });
    }
    const blocked = plates.rows.filter((p) => {
      if (!PACKAGE_ELIGIBLE_STATUSES.has(p.status)) return true;
      // Permite re-adicionar se a placa já está no MESMO pacote (idempotência).
      return p.package_id != null && Number(p.package_id) !== packageId;
    });
    if (blocked.length > 0) {
      await client.query('ROLLBACK');
      const detail = blocked
        .map((p) => `${p.id}(${p.status}${p.package_id != null ? `, pacote ${p.package_id}` : ''})`)
        .join(', ');
      return res.status(409).json({
        success: false,
        message: `Placas inelegíveis para o pacote — só EM_ENFESTO/REPASSE sem pacote: ${detail}`,
      });
    }

    await client.query(
      `UPDATE public.plates
          SET package_id = $1,
              status = 'EM_PACOTE'
        WHERE id = ANY($2::bigint[])`,
      [packageId, plateIds],
    );

    for (const pid of plateIds) {
      await client.query(
        `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
         VALUES ($1, 'AUTOCLAVE', now(), $2)`,
        [pid, `Placa ${pid} adicionada ao pacote ${packageId}`],
      );
    }

    const { rows: full } = await client.query(`${PACKAGE_SELECT} WHERE pk.id = $1`, [packageId]);
    await client.query('COMMIT');
    return res.json(mapPackage(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Autoclave/Package] addPlatesToPackage:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// POST /api/autoclave/package/removePlate  — body: { packid, plateId }
export const removePlateFromPackage = async (req, res) => {
  const client = await pool.connect();
  try {
    const packageId = Number(req.body?.packid);
    const plateId = Number(req.body?.plateId);
    if (!Number.isFinite(packageId) || !Number.isFinite(plateId)) {
      return res.status(400).json({ success: false, message: 'packid e plateId são obrigatórios.' });
    }

    await client.query('BEGIN');
    const plate = await client.query(
      'SELECT package_id FROM public.plates WHERE id = $1 FOR UPDATE',
      [plateId],
    );
    if (plate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Placa não encontrada' });
    }
    if (Number(plate.rows[0].package_id) !== packageId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'A placa não pertence a este pacote' });
    }

    await client.query(
      `UPDATE public.plates
          SET package_id = NULL,
              status = 'EM_ENFESTO'
        WHERE id = $1`,
      [plateId],
    );

    const { rows: full } = await client.query(`${PACKAGE_SELECT} WHERE pk.id = $1`, [packageId]);
    await client.query('COMMIT');
    return res.json(mapPackage(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Autoclave/Package] removePlateFromPackage:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// POST /api/autoclave/package/:packid/updateStatus  — body: { newStatus }
// APROVADO: placas normais → EM_ESTOQUE; placas REPASSE saem do pacote
//   (package_id=NULL) com plate_event AUTOCLAVE.
// FALHOU:   placas → REPASSE.
export const updatePackageStatus = async (req, res) => {
  const client = await pool.connect();
  try {
    const packageId = Number(req.params.packid);
    const newStatus = String(req.body?.newStatus || '').trim();
    if (!Number.isFinite(packageId) || !newStatus) {
      return res.status(400).json({ success: false, message: 'packid e newStatus são obrigatórios.' });
    }

    await client.query('BEGIN');
    const pkg = await client.query(
      'SELECT id FROM public.package WHERE id = $1 FOR UPDATE',
      [packageId],
    );
    if (pkg.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Pacote não encontrado' });
    }

    if (newStatus === 'APROVADO') {
      // Coletar IDs antes de mutar para registrar eventos coerentes
      const plates = await client.query(
        `SELECT id, status FROM public.plates WHERE package_id = $1`,
        [packageId],
      );
      const repasseIds = plates.rows.filter((p) => p.status === 'REPASSE').map((p) => Number(p.id));
      const otherIds = plates.rows.filter((p) => p.status !== 'REPASSE').map((p) => Number(p.id));

      // REPASSE: removidas do pacote, mantêm status REPASSE
      if (repasseIds.length > 0) {
        await client.query(
          `UPDATE public.plates SET package_id = NULL WHERE id = ANY($1::bigint[])`,
          [repasseIds],
        );
        for (const id of repasseIds) {
          await client.query(
            `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
             VALUES ($1, 'AUTOCLAVE', now(), $2)`,
            [id, `Placa removida do pacote ${packageId} por APROVADO`],
          );
        }
      }
      // Demais: vão para EM_ESTOQUE
      if (otherIds.length > 0) {
        await client.query(
          `UPDATE public.plates SET status = 'EM_ESTOQUE' WHERE id = ANY($1::bigint[])`,
          [otherIds],
        );
        for (const id of otherIds) {
          await client.query(
            `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
             VALUES ($1, 'ENTRADA_EM_ESTOQUE', now(), $2)`,
            [id, `Placa entrou em estoque pelo pacote ${packageId} aprovado`],
          );
        }
      }
      await client.query(
        `UPDATE public.package SET package_status = 'APROVADO', finish_date = now() WHERE id = $1`,
        [packageId],
      );
    } else if (newStatus === 'FALHOU') {
      const plates = await client.query(
        `SELECT id FROM public.plates WHERE package_id = $1`,
        [packageId],
      );
      const ids = plates.rows.map((p) => Number(p.id));
      if (ids.length > 0) {
        await client.query(
          `UPDATE public.plates SET status = 'REPASSE' WHERE id = ANY($1::bigint[])`,
          [ids],
        );
        for (const id of ids) {
          await client.query(
            `INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
             VALUES ($1, 'AUTOCLAVE', now(), $2)`,
            [id, `Placa marcada como REPASSE pelo pacote ${packageId} reprovado`],
          );
        }
      }
      await client.query(
        `UPDATE public.package SET package_status = 'FALHOU' WHERE id = $1`,
        [packageId],
      );
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Status não reconhecido: ${newStatus}` });
    }

    const { rows: full } = await client.query(`${PACKAGE_SELECT} WHERE pk.id = $1`, [packageId]);
    await client.query('COMMIT');
    return res.json(mapPackage(full[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Autoclave/Package] updatePackageStatus:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};
