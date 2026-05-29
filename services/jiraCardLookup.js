import pool from '../config/database.js';

// Lookup de cards do Jira a partir de OS + material, contra a tabela
// `maestro.jira_cards` (espelho sincronizado pelo cron). Centraliza a
// heurística de "qual board cobre esse corte" para que cuttingController
// (congela jira_key no momento do apontamento) e cuttingRomaneioController
// (enriquece o romaneio) compartilhem o mesmo critério.

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function extractOsFromResumo(resumo) {
  const matches = String(resumo || '').match(/\b(\d{4,10})\b/g);
  return matches ? matches[matches.length - 1] : '';
}

export function normalizeOsNumber(value) {
  const text = sanitizeText(value);
  const matches = text.match(/\b(\d{4,10})\b/g);
  return matches ? matches[matches.length - 1] : text;
}

// Decide a qual board do Jira pertence o corte. A variação do Tensylon
// (TENSYLON_30A vs TENSYLON_40A) NÃO muda o board — ambos vão pra `TENSYLON-*`.
// A variação importa só na busca de certificado de conformidade (filtro por
// material_variant_id), feita em outro lugar.
export function pickBoardForCutting({ material, kitType } = {}) {
  const mat = sanitizeText(material).toUpperCase();
  const kit = sanitizeText(kitType).toUpperCase();
  if (mat.startsWith('TENSYLON') || kit.includes('TENSYLON')) return 'TENSYLON';
  if (mat === 'ARAMIDA' || kit === 'KIT_COMUM') return 'MANTA';
  return null;
}

async function findJiraCardByOs(osNumber, keyPrefix, client = pool) {
  const os = normalizeOsNumber(osNumber);
  if (!os) return null;

  const { rows } = await client.query(
    `
      SELECT key, resumo, veiculo, project, nota_fiscal
        FROM maestro.jira_cards
       WHERE key ILIKE $1
         AND resumo ILIKE $2
       ORDER BY last_updated_at DESC NULLS LAST
    `,
    [`${keyPrefix}-%`, `%${os}%`],
  );

  return rows.find((row) => extractOsFromResumo(row.resumo) === os) || null;
}

export async function findMantaCardByOs(osNumber, client = pool) {
  return findJiraCardByOs(osNumber, 'MANTA', client);
}

export async function findTensylonCardByOs(osNumber, client = pool) {
  return findJiraCardByOs(osNumber, 'TENSYLON', client);
}

// Resolve o card Jira para um corte específico. Retorna `{ key, board, card }`
// quando encontra ou `{ key: null, board, card: null }` caso contrário.
// `board === null` significa que material/kit não mapeiam pra Jira (não tenta).
export async function resolveJiraCardForCutting({ orderNumber, material, kitType } = {}, client = pool) {
  const board = pickBoardForCutting({ material, kitType });
  if (!board) return { key: null, board: null, card: null };

  const card = board === 'TENSYLON'
    ? await findTensylonCardByOs(orderNumber, client)
    : await findMantaCardByOs(orderNumber, client);

  return { key: card?.key || null, board, card };
}
