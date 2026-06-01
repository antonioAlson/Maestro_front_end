/**
 * Seed dos relatórios Jasper legados no registry (maestro.report_templates).
 *
 * Lê os 4 .jrxml de printServiceCarbon/src/main/resources/Reports/, parseia as
 * variáveis e cria a versão 1.00 em OPE de cada relatório, com o código JS que
 * monta os parâmetros equivalentes aos endpoints legados do Spring.
 *
 * Idempotente: se o relatório já tiver QUALQUER versão, não cria outra (não
 * sobrescreve edições feitas pela UI). Só faz upsert de name/description.
 *
 * Uso:  node scripts/seed-report-templates.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pool, { ensureDatabaseCompatibility } from '../config/database.js';
import { parseJrxml } from '../services/jrxmlParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../printServiceCarbon/src/main/resources/Reports');
// Relatórios que vivem dentro do próprio Orquestra_API (não no printServiceCarbon).
const LOCAL_REPORTS_DIR = path.resolve(__dirname, '../reports');

// code da etiqueta de rastreabilidade: recebe input.id, reconstrói as linhas
// (line1..line5) a partir do banco — equivalente ao buildLabelData do
// rastreabilidadesController, para render genérico via /render/:key.
const RASTREABILIDADE_CODE = `
const id = input.id ?? input.rastreabilidade_id;
if (!id) throw new Error('input.id é obrigatório');
const CNPJ = process.env.RASTREABILIDADE_LABEL_CNPJ || '22.811.775/0002-60';
const NIVEL = process.env.RASTREABILIDADE_LABEL_NIVEL || 'IIIA';
const { rows } = await ctx.db.query(\`
  SELECT c.numero AS certificate_numero,
         r.codigo_iis, r.iis_dv, r.codigo_rastreabilidade,
         COALESCE((
           SELECT json_agg(json_build_object('nome', mt.nome, 'valor', c.medidas->>(mt.id::text)) ORDER BY mt.nome)
             FROM maestro.material_measure_type_map mm
             JOIN maestro.material_measure_types mt ON mt.id = mm.measure_type_id
            WHERE mm.material_id = c.material_id AND mt.ativo = true
         ), '[]'::json) AS medidas
    FROM maestro.rastreabilidades r
    JOIN maestro.conformity_certificates c ON c.id = r.certificate_id
   WHERE r.id = $1\`, [id]);
if (!rows.length) throw new Error('Rastreabilidade não encontrada: ' + id);
const it = rows[0];
const certNum = String(it.certificate_numero || '').trim();
const certLabel = certNum ? (certNum.toUpperCase().startsWith('CC') ? certNum.toUpperCase() : 'CC' + certNum) : '';
const codigo = String(it.codigo_iis || '').trim();
const dv = String(it.iis_dv || '').trim();
let iisLabel = '';
if (codigo) iisLabel = (dv && codigo.endsWith(dv)) ? (codigo.slice(0, -1) + ' ' + dv) : codigo;
const medidas = Array.isArray(it.medidas) ? it.medidas : [];
const camada = medidas.find((m) => String((m && m.nome) || '').toLowerCase().includes('camada'));
const valor = String(camada && camada.valor != null ? camada.valor : '').trim();
const layers = valor ? (valor.replace('.', ',') + ' Layers') : '';
return {
  params: {},
  data: [{
    line1: CNPJ,
    line2: certLabel,
    line3: NIVEL,
    line4: iisLabel,
    line5: (it.codigo_rastreabilidade || '') + '\\n' + layers,
  }],
};
`.trim();

// key → uso lógico; code → param-builder equivalente ao endpoint Spring legado.
const REPORTS = [
  {
    key: 'production-label',
    name: 'Etiqueta de Produção',
    file: 'BR_PROCUTION_LABEL.jrxml',
    description: 'Etiqueta de placa por OT. Legado: GET /etiqueta?otid=.',
    code: 'return { params: { otid: input.otid } };',
  },
  {
    key: 'test-body-label',
    name: 'Etiqueta de Corpo de Prova',
    file: 'BR_LABEL_TEST_BODY.jrxml',
    description: 'Etiqueta de validação de engenharia. Legado: GET /etiqueta2?...',
    code: 'return { params: input };',
  },
  {
    key: 'receipt-label',
    name: 'Etiqueta de Recebimento',
    file: 'BR_LABEL_RECEIPT.jrxml',
    description: 'Etiqueta de recebimento de matéria-prima. Legado: GET /etiquetaReceipt?id=.',
    code: 'return { params: { id: input.id } };',
  },
  {
    key: 'enfesto-report',
    name: 'Relatório de Enfesto',
    file: 'BR_REPORT_ENFESTO REPORT.jrxml',
    description: 'Relatório de enfesto (sem parâmetros). Legado: GET /reportEnfesto.',
    code: 'return { params: {} };',
  },
  {
    key: 'rastreabilidade-label',
    name: 'Etiqueta de Rastreabilidade',
    dir: LOCAL_REPORTS_DIR,
    file: 'rastreabilidade_etiquetas.jrxml',
    description: 'Folha de etiquetas de rastreabilidade opaca. Legado: GET /api/rastreabilidades/:id/pdf.',
    code: RASTREABILIDADE_CODE,
  },
];

async function seedOne(r) {
  let xml;
  try {
    xml = readFileSync(path.join(r.dir || REPORTS_DIR, r.file), 'utf8');
  } catch (e) {
    console.warn(`! ${r.key}: arquivo não encontrado (${r.file}) — pulando. ${e.code || e.message}`);
    return;
  }

  const variables = parseJrxml(xml);

  const tpl = await pool.query(
    `INSERT INTO maestro.report_templates (key, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
     RETURNING id`,
    [r.key, r.name, r.description]
  );
  const templateId = tpl.rows[0].id;

  const existing = await pool.query(
    `SELECT COUNT(*)::int AS n FROM maestro.report_template_versions WHERE template_id = $1`,
    [templateId]
  );
  if (existing.rows[0].n > 0) {
    console.log(`= ${r.key}: já possui versões — mantido (sem novo insert).`);
    return;
  }

  await pool.query(
    `INSERT INTO maestro.report_template_versions
       (template_id, version_number, status, jrxml, variables, code, notes)
     VALUES ($1, 1.00, 'OPE', $2, $3, $4, $5)`,
    [templateId, xml, variables, r.code, 'Seed automático dos relatórios legados do Spring']
  );

  const params = variables.parameters.filter((p) => !p.isImage).map((p) => p.name).join(', ') || '—';
  console.log(`+ ${r.key}: v1.00 OPE criada (params: ${params}).`);
}

(async () => {
  try {
    console.log('Garantindo schema (ensureDatabaseCompatibility)...');
    await ensureDatabaseCompatibility();
    for (const r of REPORTS) await seedOne(r);
    console.log('Seed de report templates concluído.');
  } catch (e) {
    console.error('Erro no seed de report templates:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
