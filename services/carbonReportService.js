import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import axios from 'axios';
import ExcelJS from 'exceljs';
import { scrapeCarbonExcel } from './carbonScraperService.js';

// Orquestra o ciclo do Relatório Carbon:
//   1. scraping do Carbon (Playwright) -> xlsx bruto
//   2. lê a aba "data", coleta as OS
//   3. de-para com o Jira por cf[10256] (OS/PD)
//   4. NÃO altera as colunas originais do Carbon. Em vez disso, acrescenta
//      colunas "(Jira)" com a informação correta e uma coluna final de
//      "OBSERVAÇÕES (DIVERGÊNCIAS)". Quando o Jira diverge do Carbon, a
//      célula da OS é destacada (âmbar) e a divergência é descrita na obs.
//   5. escrita atômica do latest.xlsx (+ status.json)
//
// Credenciais do Jira vêm do ambiente (JIRA_URL/JIRA_EMAIL/JIRA_API_TOKEN),
// igual ao cron sync_cards_jira.cjs — o cron não tem usuário logado.

const TMP = process.env.CARBON_TMP_DIR || os.tmpdir();
export const LATEST_FILE = path.join(TMP, 'carbon-latest.xlsx');
export const STATUS_FILE = path.join(TMP, 'carbon-status.json');

// ===== Mapeamento Excel <-> Jira =====================================
// O export do Carbon tem UMA aba "data" (~1112 linhas x 31 colunas) com
// valores planos (sem fórmulas). Índices 0-based; exceljs é 1-based (col+1).
const EXCEL = {
  sheet: 'data',
  headerRow: 1,
  col: {
    OS: 0,
    ETAPA: 5,
    PREV_VIDRO: 17,
    PREV_ACO: 18,
    PREV_OPACO: 19, // OPACO ~ Manta
    PREV_TENSYLON: 20,
    PREV_SUP_VIDRO: 21,
  },
};

// Cor de destaque (âmbar) aplicada à célula da OS quando há divergência.
const OS_DIVERGENCE_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFC000' },
};

// Campos comparados Carbon (coluna original) x Jira. Para cada um é criada
// uma coluna "<label> (Jira)" ao final da planilha, sem tocar na original.
//   type 'text' -> comparação normalizada (case-insensitive, sem acento de cor)
//   type 'date' -> comparação por data (AAAA-MM-DD)
const COMPARE_FIELDS = [
  { label: 'ETAPA', origCol: EXCEL.col.ETAPA, jira: 'etapa', type: 'text' },
  { label: 'PREVISÃO RECEB. VIDRO', origCol: EXCEL.col.PREV_VIDRO, jira: 'prevVidro', type: 'date' },
  { label: 'PREVISÃO RECEB. AÇO', origCol: EXCEL.col.PREV_ACO, jira: 'prevAco', type: 'date' },
  { label: 'PREVISÃO RECEB. OPACO', origCol: EXCEL.col.PREV_OPACO, jira: 'prevOpaco', type: 'date' },
  { label: 'PREVISÃO RECEB TENSYLON', origCol: EXCEL.col.PREV_TENSYLON, jira: 'prevTensylon', type: 'date' },
  { label: 'PREVISÃO RECEB SUP. VIDRO', origCol: EXCEL.col.PREV_SUP_VIDRO, jira: 'prevSupVidro', type: 'date' },
];

// Custom fields do Jira (confirmados no dump jira_kanban_custom_fields.txt)
const JIRA_FIELDS = {
  OS_PD: 'customfield_10256', // chave do de-para (mesma faixa da coluna OS)
  SITUACAO: 'customfield_10039', // -> ETAPA
  PREV_VIDRO: 'customfield_11448',
  PREV_ACO: 'customfield_11450',
  PREV_MANTA: 'customfield_11449', // -> OPACO
  PREV_TENSYLON: 'customfield_13064',
  PREV_SUP_VIDRO: 'customfield_12635',
};

const JIRA_REQUEST_FIELDS = [
  'status',
  JIRA_FIELDS.OS_PD,
  JIRA_FIELDS.SITUACAO,
  JIRA_FIELDS.PREV_VIDRO,
  JIRA_FIELDS.PREV_ACO,
  JIRA_FIELDS.PREV_MANTA,
  JIRA_FIELDS.PREV_TENSYLON,
  JIRA_FIELDS.PREV_SUP_VIDRO,
];

const BATCH_SIZE = 50;
const col1 = (i) => i + 1;

// Lock em memória: o ciclo pode passar de 15 min (Atualizar Todos demora).
let running = false;
export function isRunning() {
  return running;
}

// ===== Jira ==========================================================
function jiraAuthHeader() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildJql(osBatch) {
  const list = osBatch.map((o) => `"${String(o).replace(/"/g, '\\"')}"`).join(', ');
  const proj = process.env.JIRA_PROJECT ? `project = ${process.env.JIRA_PROJECT} AND ` : '';
  const cfId = JIRA_FIELDS.OS_PD.replace('customfield_', '');
  return `${proj}cf[${cfId}] in (${list}) ORDER BY updated DESC`;
}

function normSituacao(v) {
  if (v == null) return null;
  const s = typeof v === 'object' ? v.value || v.name || '' : String(v);
  // Remove emojis/bolinhas de cor do início (ex.: "⚫Aguardando entrada")
  return s.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;
}

function dateOnly(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

// Normaliza qualquer valor de célula/Jira para data AAAA-MM-DD (ou '' se vazio).
// Trata Date (exceljs lê datas como Date), célula de fórmula e string ISO.
function toDateOnly(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result != null) return toDateOnly(v.result);
    if (v.text != null) return String(v.text).slice(0, 10);
    return '';
  }
  return String(v).slice(0, 10);
}

// Texto legível de uma célula (para exibir na coluna de observações).
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.value ?? v.name ?? '');
  return String(v);
}

// Normalização para comparação de texto: remove emojis/bolinhas de cor do
// início, espaços nas pontas e diferenças de caixa.
function normText(v) {
  return cellText(v)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .toLowerCase();
}

async function fetchJiraByOs(osList) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado no ambiente');
  if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
    throw new Error('JIRA_EMAIL/JIRA_API_TOKEN não configurados no ambiente');
  }

  const unique = [...new Set(osList.map((o) => String(o).trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();

  console.log(`[CarbonReport] de-para Jira para ${unique.length} OS`);
  const map = new Map();
  const url = `${jiraUrl}/rest/api/3/search/jql`;
  const auth = jiraAuthHeader();

  for (const batch of chunk(unique, BATCH_SIZE)) {
    const jql = buildJql(batch);
    let nextPageToken = null;
    do {
      const body = { jql, fields: JIRA_REQUEST_FIELDS, maxResults: 100 };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const resp = await axios.post(url, body, {
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 30000,
      });

      for (const issue of resp.data.issues || []) {
        const f = issue.fields || {};
        const os = String(f[JIRA_FIELDS.OS_PD] ?? '').trim();
        if (!os || map.has(os)) continue; // mantém o card mais recente (JQL ordena por updated DESC)
        map.set(os, {
          etapa: normSituacao(f[JIRA_FIELDS.SITUACAO]),
          prevVidro: dateOnly(f[JIRA_FIELDS.PREV_VIDRO]),
          prevAco: dateOnly(f[JIRA_FIELDS.PREV_ACO]),
          prevOpaco: dateOnly(f[JIRA_FIELDS.PREV_MANTA]),
          prevTensylon: dateOnly(f[JIRA_FIELDS.PREV_TENSYLON]),
          prevSupVidro: dateOnly(f[JIRA_FIELDS.PREV_SUP_VIDRO]),
        });
      }

      nextPageToken = resp.data.isLast ? null : resp.data.nextPageToken ?? null;
    } while (nextPageToken);
  }

  console.log(`[CarbonReport] Jira retornou ${map.size}/${unique.length} OS`);
  return map;
}

// ===== Excel =========================================================
function getSheet(wb) {
  const ws = wb.getWorksheet(EXCEL.sheet) || wb.worksheets[0];
  if (!ws) throw new Error('Planilha sem abas legíveis');
  return ws;
}

function getOsList(ws) {
  const list = [];
  const osCol = col1(EXCEL.col.OS);
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= EXCEL.headerRow) return;
    const v = row.getCell(osCol).value;
    if (v != null && String(v).trim() !== '') list.push(String(v).trim());
  });
  return list;
}

// Acrescenta o cabeçalho das novas colunas (sem mexer nas originais) e
// devolve os índices 1-based de cada coluna "(Jira)" + da coluna de obs.
function addJiraColumns(ws) {
  const headerRow = ws.getRow(EXCEL.headerRow);
  const baseStyle = headerRow.getCell(col1(EXCEL.col.OS)).style;
  let next = headerRow.cellCount + 1; // primeira coluna livre após as originais

  const jiraCol = {};
  for (const f of COMPARE_FIELDS) {
    const cell = headerRow.getCell(next);
    cell.value = `${f.label} (Jira)`;
    cell.style = { ...baseStyle };
    ws.getColumn(next).width = 24;
    jiraCol[f.jira] = next;
    next++;
  }

  const obsCol = next;
  const obsCell = headerRow.getCell(obsCol);
  obsCell.value = 'OBSERVAÇÕES (DIVERGÊNCIAS)';
  obsCell.style = { ...baseStyle };
  ws.getColumn(obsCol).width = 60;
  headerRow.commit?.();

  return { jiraCol, obsCol };
}

// Compara Carbon x Jira sem alterar as colunas originais:
//   - escreve o valor correto (Jira) nas colunas "(Jira)"
//   - em divergência, destaca a célula da OS e descreve na coluna de obs
export function applyJira(ws, jiraMap) {
  const osCol = col1(EXCEL.col.OS);
  const { jiraCol, obsCol } = addJiraColumns(ws);
  let matched = 0;
  let missing = 0;
  let diverged = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= EXCEL.headerRow) return;
    const os = String(row.getCell(osCol).value ?? '').trim();
    if (!os) return;

    const j = jiraMap.get(os);
    if (!j) {
      missing++;
      return;
    }
    matched++;

    const divergences = [];
    for (const f of COMPARE_FIELDS) {
      const jiraVal = j[f.jira];
      // Coluna "(Jira)" sempre recebe a informação correta (quando houver).
      row.getCell(jiraCol[f.jira]).value = jiraVal == null || jiraVal === '' ? null : jiraVal;

      const origRaw = row.getCell(col1(f.origCol)).value;
      if (f.type === 'date') {
        const jiraDate = toDateOnly(jiraVal);
        if (!jiraDate) continue; // Jira sem data: nada a afirmar
        const origDate = toDateOnly(origRaw);
        if (origDate !== jiraDate) {
          divergences.push(`${f.label}: Carbon=${origDate || '—'} / Jira=${jiraDate}`);
        }
      } else {
        const jiraNorm = normText(jiraVal);
        if (!jiraNorm) continue;
        if (normText(origRaw) !== jiraNorm) {
          divergences.push(
            `${f.label}: Carbon='${cellText(origRaw) || '—'}' / Jira='${cellText(jiraVal)}'`
          );
        }
      }
    }

    if (divergences.length) {
      diverged++;
      row.getCell(osCol).fill = OS_DIVERGENCE_FILL;
      row.getCell(obsCol).value = divergences.join(' | ');
    }
  });

  return { matched, missing, diverged };
}

// ===== Status ========================================================
function writeStatus(payload) {
  const status = { updatedAt: new Date().toISOString(), ...payload };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    console.warn('[CarbonReport] falha ao gravar status.json:', err.message);
  }
  return status;
}

export function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return { updatedAt: null, ok: false, message: 'sem execução registrada' };
  }
}

// ===== Ciclo completo ================================================
/**
 * Executa um ciclo: scrape -> de-para Jira -> publica latest.xlsx (atômico).
 * Pula se já houver um ciclo em andamento.
 * @param {{ scrape?: () => Promise<string> }} [opts] scraper injetável (testes)
 */
export async function run({ scrape = scrapeCarbonExcel } = {}) {
  if (running) {
    console.warn('[CarbonReport] ciclo anterior ainda em andamento; pulando');
    return { skipped: true };
  }
  running = true;
  const startedAt = Date.now();
  const tmpFile = `${LATEST_FILE}.tmp`;
  console.log('[CarbonReport] iniciando ciclo');

  try {
    const rawPath = await scrape();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(rawPath);
    const ws = getSheet(wb);
    const osList = getOsList(ws);

    const jiraMap = await fetchJiraByOs(osList);
    const merge = applyJira(ws, jiraMap);

    // Publicação atômica: grava o NOVO relatório em .tmp e só então renomeia
    // por cima do latest.xlsx. O relatório anterior continua sendo servido
    // para download até o novo estar 100% gravado — nunca há janela sem arquivo.
    await wb.xlsx.writeFile(tmpFile);
    fs.renameSync(tmpFile, LATEST_FILE);

    fs.rm(rawPath, { force: true }, () => {});

    const durationMs = Date.now() - startedAt;
    const stats = { ok: true, rows: osList.length, ...merge, durationMs };
    writeStatus(stats);
    console.log('[CarbonReport] ciclo concluído', stats);
    return stats;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error('[CarbonReport] ciclo falhou:', err.message);
    // Mantém o último latest.xlsx bom; remove só o .tmp parcial (se houver)
    // e registra a falha no status. O relatório anterior segue intacto.
    fs.rm(tmpFile, { force: true }, () => {});
    writeStatus({ ok: false, message: err.message, durationMs });
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}
