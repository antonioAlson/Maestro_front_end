import pool from '../config/database.js';
import ExcelJS from 'exceljs';

const MONTHS_PT_BR = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const WORKORDER_COLUMNS = `
  id,
  creation_date AS "creationDate",
  change_date AS "changeDate",
  lote,
  plates_quantity AS "platesQuantity",
  plates_layres AS "platesLayres",
  cloth_type AS "clothType",
  cloth_batch AS "clothBatch",
  fabric_supplier AS "fabricSupplier",
  plastic_type AS "plasticType",
  plastic_batch AS "plasticBatch",
  resined_batch AS "resinedBatch",
  to_char(enfesto_date, 'YYYY-MM-DD') AS "enfestoDate"
`;

// Sub-query reutilizada por list/listGrouped/fetchById. Mantém o agrupamento
// de plates idêntico em todas as rotas para evitar divergência de schema.
const PLATES_SUBQUERY = `
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'id', p.id,
        'plateSequence', p.plate_sequence,
        'status', p.status,
        'layers', p.layers,
        'actualSize', p.actual_size,
        'initSize', p.init_size,
        'workorderId', p.workorderid,
        'packageId', p.package_id,
        'workorderLote', w.lote
      )
      ORDER BY p.plate_sequence ASC
    )
    FROM public.plates p
    WHERE p.workorderid = w.id
  ), '[]'::json)
`;

function parseDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function parseLong(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${field} inválido.`);
  }
  return n;
}

function normalizeWorkorderPayload(body) {
  return {
    lote: body?.lote ?? null,
    platesQuantity: parseLong(body?.platesQuantity, 'platesQuantity'),
    platesLayres: parseLong(body?.platesLayres, 'platesLayres'),
    clothType: body?.clothType ?? null,
    clothBatch: body?.clothBatch ?? null,
    fabricSupplier: body?.fabricSupplier ?? null,
    plasticType: body?.plasticType ?? null,
    plasticBatch: body?.plasticBatch ?? null,
    resinedBatch: body?.resinedBatch ?? null,
    enfestoDate: parseDate(body?.enfestoDate),
  };
}

function mapPlate(row) {
  return {
    id: Number(row.id),
    plateSequence: Number(row.plateSequence),
    status: row.status,
    layers: Number(row.layers),
    actualSize: row.actualSize,
    initSize: row.initSize,
    workorderId: row.workorderId ? Number(row.workorderId) : null,
    packageId: row.packageId ? Number(row.packageId) : null,
    workorderLote: row.workorderLote ?? null,
  };
}

function mapWorkorder(row) {
  return {
    ...row,
    id: Number(row.id),
    platesQuantity: row.platesQuantity === null ? null : Number(row.platesQuantity),
    platesLayres: row.platesLayres === null ? null : Number(row.platesLayres),
    plates: Array.isArray(row.plates) ? row.plates.map(mapPlate) : [],
  };
}

async function fetchWorkorderById(client, id) {
  const { rows } = await client.query(
    `
      SELECT
        ${WORKORDER_COLUMNS},
        ${PLATES_SUBQUERY} AS plates
      FROM public.workorder_table w
      WHERE w.id = $1
    `,
    [id],
  );
  return rows[0] ? mapWorkorder(rows[0]) : null;
}

async function listGroupedWhere(whereSql = '', params = []) {
  const { rows } = await pool.query(
    `
      SELECT
        to_char(w.enfesto_date, 'YYYY-MM-DD') AS "enfestoDate",
        COALESCE(SUM(w.plates_quantity), 0) AS "totalPlacas",
        json_agg(
          json_build_object(
            'id', w.id,
            'creationDate', w.creation_date,
            'changeDate', w.change_date,
            'lote', w.lote,
            'platesQuantity', w.plates_quantity,
            'platesLayres', w.plates_layres,
            'clothType', w.cloth_type,
            'clothBatch', w.cloth_batch,
            'fabricSupplier', w.fabric_supplier,
            'plasticType', w.plastic_type,
            'plasticBatch', w.plastic_batch,
            'resinedBatch', w.resined_batch,
            'enfestoDate', to_char(w.enfesto_date, 'YYYY-MM-DD'),
            'plates', ${PLATES_SUBQUERY}
          )
          ORDER BY w.id ASC
        ) AS "workOrders"
      FROM public.workorder_table w
      ${whereSql}
      GROUP BY w.enfesto_date
      ORDER BY w.enfesto_date ASC
    `,
    params,
  );

  return rows.map((row) => ({
    enfestoDate: row.enfestoDate,
    totalPlacas: Number(row.totalPlacas),
    workOrders: (row.workOrders || []).map(mapWorkorder),
  }));
}

export const listWorkorders = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ${WORKORDER_COLUMNS},
        ${PLATES_SUBQUERY} AS plates
      FROM public.workorder_table w
      ORDER BY w.id ASC
    `);
    return res.json(rows.map(mapWorkorder));
  } catch (error) {
    console.error('[WorkOrder] listWorkorders error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const platesByEnfesto = async (req, res) => {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end);
  if (!start || !end) {
    return res.status(400).json({ success: false, message: 'start e end são obrigatórios.' });
  }

  try {
    const data = await listGroupedWhere(
      'WHERE w.enfesto_date::date BETWEEN $1::date AND $2::date',
      [start, end],
    );
    return res.json(data);
  } catch (error) {
    console.error('[WorkOrder] platesByEnfesto error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listGrouped = async (req, res) => {
  try {
    const data = await listGroupedWhere();
    return res.json(data);
  } catch (error) {
    console.error('[WorkOrder] listGrouped error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createWorkorder = async (req, res) => {
  const client = await pool.connect();
  try {
    const payload = normalizeWorkorderPayload(req.body);
    if (payload.platesQuantity < 1) {
      return res.status(400).json({ success: false, message: 'platesQuantity deve ser maior que zero.' });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `
        INSERT INTO public.workorder_table
          (creation_date, change_date, lote, plates_quantity, plates_layres,
           cloth_type, cloth_batch, fabric_supplier, plastic_type, plastic_batch,
           resined_batch, enfesto_date)
        VALUES
          (now(), now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `,
      [
        payload.lote,
        payload.platesQuantity,
        payload.platesLayres,
        payload.clothType,
        payload.clothBatch,
        payload.fabricSupplier,
        payload.plasticType,
        payload.plasticBatch,
        payload.resinedBatch,
        payload.enfestoDate,
      ],
    );

    const workorderId = rows[0].id;
    for (let i = 1; i <= payload.platesQuantity; i += 1) {
      const plate = await client.query(
        `
          INSERT INTO public.plates
            (workorderid, plate_sequence, status, layers, init_size, actual_size)
          VALUES ($1, $2, 'EM_ENFESTO', $3, 3000.00, 3000.00)
          RETURNING id, layers
        `,
        [workorderId, i, payload.platesLayres],
      );

      await client.query(
        `
          INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
          VALUES ($1, 'CRIACAO', now(), $2)
        `,
        [
          plate.rows[0].id,
          `Placa criada no enfesto OT ${workorderId} Camadas: ${plate.rows[0].layers}`,
        ],
      );
    }

    const created = await fetchWorkorderById(client, workorderId);
    await client.query('COMMIT');
    return res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[WorkOrder] createWorkorder error:', error);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

export const updateWorkorder = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const payload = normalizeWorkorderPayload(req.body);

    await client.query('BEGIN');
    const current = await client.query(
      'SELECT plates_layres FROM public.workorder_table WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Ordem de trabalho não encontrada.' });
    }

    const previousLayers = Number(current.rows[0].plates_layres);
    if (previousLayers !== payload.platesLayres) {
      const plates = await client.query(
        'SELECT id FROM public.plates WHERE workorderid = $1 ORDER BY plate_sequence ASC',
        [id],
      );
      await client.query(
        'UPDATE public.plates SET layers = $1 WHERE workorderid = $2',
        [payload.platesLayres, id],
      );
      for (const plate of plates.rows) {
        await client.query(
          `
            INSERT INTO public.plate_event (plate_id, event_type, event_date, description)
            VALUES ($1, 'ATUALIZACAO', now(), $2)
          `,
          [plate.id, `Camadas alteradas de ${previousLayers} para ${payload.platesLayres}`],
        );
      }
    }

    await client.query(
      `
        UPDATE public.workorder_table
           SET change_date = now(),
               lote = $1,
               plates_quantity = $2,
               plates_layres = $3,
               cloth_type = $4,
               cloth_batch = $5,
               fabric_supplier = $6,
               plastic_type = $7,
               plastic_batch = $8,
               resined_batch = $9,
               enfesto_date = $10
         WHERE id = $11
      `,
      [
        payload.lote,
        payload.platesQuantity,
        payload.platesLayres,
        payload.clothType,
        payload.clothBatch,
        payload.fabricSupplier,
        payload.plasticType,
        payload.plasticBatch,
        payload.resinedBatch,
        payload.enfestoDate,
        id,
      ],
    );

    const updated = await fetchWorkorderById(client, id);
    await client.query('COMMIT');
    return res.json(updated);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[WorkOrder] updateWorkorder error:', error);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// Porte direto de WorkOrderService.generateExcelReport (Spring). Mantém os
// mesmos cabeçalhos e o agrupamento Resumo (Mês × Lote × Camadas) com TOTAL
// via fórmula SUM — assim o Excel gerado é byte-comparável ao do Spring no
// período de coexistência (§4.6).
export const exportWorkordersExcel = async (req, res) => {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end);
  if (!start || !end) {
    return res.status(400).json({ success: false, message: 'start e end são obrigatórios.' });
  }

  try {
    const detailsResult = await pool.query(
      `
        SELECT
          p.id AS plate_id,
          p.plate_sequence,
          p.status AS plate_status,
          w.id AS workorder_id,
          w.lote,
          w.plates_quantity,
          w.plates_layres,
          w.cloth_type,
          w.cloth_batch,
          w.plastic_type,
          w.plastic_batch,
          w.resined_batch,
          w.enfesto_date
        FROM public.workorder_table w
        LEFT JOIN public.plates p ON p.workorderid = w.id
        WHERE w.enfesto_date::date BETWEEN $1::date AND $2::date
        ORDER BY w.id ASC, p.plate_sequence ASC
      `,
      [start, end],
    );

    const summaryResult = await pool.query(
      `
        SELECT
          date_trunc('month', w.enfesto_date)::date AS month,
          w.lote,
          w.plates_layres AS layers,
          COALESCE(SUM(w.plates_quantity), 0)::int AS total_plates
        FROM public.workorder_table w
        WHERE w.enfesto_date::date BETWEEN $1::date AND $2::date
        GROUP BY date_trunc('month', w.enfesto_date), w.lote, w.plates_layres
        ORDER BY date_trunc('month', w.enfesto_date) ASC, w.lote ASC, w.plates_layres ASC
      `,
      [start, end],
    );

    const workbook = new ExcelJS.Workbook();
    buildDetailsSheet(workbook, detailsResult.rows);
    buildSummarySheet(workbook, summaryResult.rows);

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="enfesto_${start}_${end}.xlsx"`,
    );
    return res.end(Buffer.from(buffer));
  } catch (error) {
    console.error('[WorkOrder] exportWorkordersExcel error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

function buildDetailsSheet(workbook, rows) {
  const sheet = workbook.addWorksheet('Detalhes');
  const headers = [
    'NUMERO DA PLACA', 'OT', 'LOTE', 'Qtd PLACAS', 'CAMADAS',
    'TECIDO', 'LOTE TECIDO', 'PLASTICO', 'LOTE PLASTICO', 'RWO',
    'DATA ENFESTO', 'SEQUENCIA DA PLACA', 'STATUS DA PLACA',
  ];
  sheet.addRow(headers);

  for (const row of rows) {
    if (row.plate_id == null) continue; // OT sem placas (improvável, mas defensivo)
    const enfestoDate = row.enfesto_date ? new Date(row.enfesto_date) : null;
    const sheetRow = sheet.addRow([
      `${row.plate_id}-${row.workorder_id}`,
      Number(row.workorder_id),
      row.lote,
      Number(row.plates_quantity),
      Number(row.plates_layres),
      row.cloth_type,
      row.cloth_batch,
      row.plastic_type,
      row.plastic_batch,
      row.resined_batch,
      enfestoDate,
      Number(row.plate_sequence),
      row.plate_status,
    ]);
    if (enfestoDate) {
      sheetRow.getCell(11).numFmt = 'dd/mm/yyyy';
    }
  }

  // Auto-size aproximado — exceljs não tem autoSizeColumn como POI; calcula
  // pelo comprimento máximo do conteúdo (+2 de margem).
  sheet.columns.forEach((col, idx) => {
    let max = headers[idx].length;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      const text = value instanceof Date
        ? value.toLocaleDateString('pt-BR')
        : String(value ?? '');
      if (text.length > max) max = text.length;
    });
    col.width = max + 2;
  });
}

function buildSummarySheet(workbook, rows) {
  const sheet = workbook.addWorksheet('Resumo');

  // Agrupa por mês: { 'YYYY-MM': [{ lote, layers, totalPlates }, ...] }
  const byMonth = new Map();
  for (const row of rows) {
    const monthDate = new Date(row.month);
    const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth()).padStart(2, '0')}`;
    if (!byMonth.has(key)) {
      byMonth.set(key, { year: monthDate.getFullYear(), month: monthDate.getMonth(), entries: [] });
    }
    byMonth.get(key).entries.push({
      lote: row.lote,
      layers: Number(row.layers),
      totalPlates: Number(row.total_plates),
    });
  }

  const titleStyle = {
    font: { bold: true },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } },
  };
  const headerStyle = { ...titleStyle };
  const cellStyle = {
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const totalStyle = {
    font: { bold: true },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };

  let rowIdx = 1;
  for (const { year, month, entries } of byMonth.values()) {
    // Linha de título mesclada em 3 colunas
    sheet.mergeCells(rowIdx, 1, rowIdx, 3);
    const titleCell = sheet.getCell(rowIdx, 1);
    titleCell.value = `Resumo ${MONTHS_PT_BR[month]} ${year}`;
    applyStyle(titleCell, titleStyle);
    // Borda nas outras células do merge (exceljs não aplica em todas)
    for (let c = 2; c <= 3; c += 1) applyStyle(sheet.getCell(rowIdx, c), titleStyle);
    rowIdx += 1;

    // Cabeçalho
    const headerRow = sheet.getRow(rowIdx);
    ['Camadas', 'Lote', 'Total Placas'].forEach((h, i) => {
      const c = headerRow.getCell(i + 1);
      c.value = h;
      applyStyle(c, headerStyle);
    });
    rowIdx += 1;

    const firstDataRow = rowIdx;
    for (const entry of entries) {
      const r = sheet.getRow(rowIdx);
      const c1 = r.getCell(1); c1.value = `${entry.layers} Camadas`; applyStyle(c1, cellStyle);
      const c2 = r.getCell(2); c2.value = entry.lote;                 applyStyle(c2, cellStyle);
      const c3 = r.getCell(3); c3.value = entry.totalPlates;          applyStyle(c3, cellStyle);
      rowIdx += 1;
    }
    const lastDataRow = rowIdx - 1;

    // Linha TOTAL
    sheet.mergeCells(rowIdx, 1, rowIdx, 2);
    const totalLabel = sheet.getCell(rowIdx, 1);
    totalLabel.value = 'TOTAL';
    applyStyle(totalLabel, totalStyle);
    applyStyle(sheet.getCell(rowIdx, 2), totalStyle);

    const totalValue = sheet.getCell(rowIdx, 3);
    totalValue.value = { formula: `SUM(C${firstDataRow}:C${lastDataRow})` };
    applyStyle(totalValue, totalStyle);
    rowIdx += 2; // pula linha em branco entre meses
  }

  sheet.columns.forEach((col, idx) => {
    let max = 12;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const text = String(cell.value?.formula ?? cell.value ?? '');
      if (text.length > max) max = text.length;
    });
    col.width = Math.min(max + 2, 30);
  });
}

function thinBorder() {
  const side = { style: 'thin' };
  return { top: side, left: side, right: side, bottom: side };
}

function applyStyle(cell, style) {
  if (style.font) cell.font = style.font;
  if (style.alignment) cell.alignment = style.alignment;
  if (style.border) cell.border = style.border;
  if (style.fill) cell.fill = style.fill;
}

export const deleteWorkorder = async (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, message: 'id inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // OT só pode ser deletada se TODAS as placas ainda estão no enfesto
    // (status EM_ENFESTO e sem package_id). Qualquer evolução (autoclave,
    // corte, NF) congela o enfesto historicamente.
    const inUseCheck = await client.query(
      `
        SELECT COUNT(*)::int AS total,
               SUM(CASE WHEN status <> 'EM_ENFESTO' OR package_id IS NOT NULL THEN 1 ELSE 0 END)::int AS in_use
        FROM public.plates
        WHERE workorderid = $1
      `,
      [id],
    );

    const { total, in_use: inUse } = inUseCheck.rows[0];
    if (total === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Ordem de trabalho com ID ${id} não encontrada.` });
    }
    if (inUse > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'OT possui placas que já saíram do enfesto (em pacote, autoclave ou consumo) — não pode ser excluída.',
      });
    }

    const plates = await client.query('SELECT id FROM public.plates WHERE workorderid = $1', [id]);
    const plateIds = plates.rows.map((row) => row.id);

    if (plateIds.length > 0) {
      await client.query('DELETE FROM public.plate_event WHERE plate_id = ANY($1::bigint[])', [plateIds]);
      await client.query('DELETE FROM public.plates WHERE id = ANY($1::bigint[])', [plateIds]);
    }

    await client.query('DELETE FROM public.workorder_table WHERE id = $1', [id]);
    await client.query('COMMIT');
    return res.send('Ordem de trabalho deletada com sucesso.');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'OT possui placas vinculadas a outros processos e não pode ser excluída.',
      });
    }
    console.error('[WorkOrder] deleteWorkorder error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};
