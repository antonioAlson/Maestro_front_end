// Executor do "código JS" de uma versão de relatório.
//
// Espelha o sandbox do cron (cron_jobs/jobWorker.cjs): o código do usuário é
// embrulhado numa async function que recebe (input, ctx, require). O retorno
// esperado é o que alimenta o render Jasper:
//
//   return { params: { id: input.id } };           // mapa de parâmetros (primário)
//   return { params: {...}, data: [ {...}, ... ] }; // + linhas (JSON datasource)
//   return { id: input.id };                        // açúcar: tratado como params
//
// Diferente do cron, aqui RETORNAMOS um valor e o JS é curto, então roda
// in-process com timeout (sem worker_threads). Pode evoluir depois se preciso.

import pool from '../config/database.js';

const DEFAULT_TIMEOUT_MS = 10_000;

function buildCtx(logs) {
  return {
    db: { query: (text, params) => pool.query(text, params) },
    log:  (...a) => logs.push({ level: 'info',  args: a.map(safe) }),
    warn: (...a) => logs.push({ level: 'warn',  args: a.map(safe) }),
    error:(...a) => logs.push({ level: 'error', args: a.map(safe) }),
  };
}

function safe(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function normalizeResult(raw) {
  if (raw == null) return { params: {}, data: null };
  if (Array.isArray(raw)) return { params: {}, data: raw };
  if (typeof raw === 'object') {
    const hasParams = Object.prototype.hasOwnProperty.call(raw, 'params');
    const hasData   = Object.prototype.hasOwnProperty.call(raw, 'data');
    if (hasParams || hasData) {
      return {
        params: raw.params && typeof raw.params === 'object' ? raw.params : {},
        data: Array.isArray(raw.data) ? raw.data : null,
      };
    }
    // Objeto solto → tratado como o próprio mapa de parâmetros.
    return { params: raw, data: null };
  }
  throw new Error('O código JS deve retornar um objeto (params) ou um array (data).');
}

// Executa o código e devolve { params, data, logs }.
export async function runReportCode(code, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const logs = [];

  // Sem código → render direto com o input como parâmetros (caso trivial).
  if (typeof code !== 'string' || !code.trim()) {
    return { ...normalizeResult(input ?? {}), logs };
  }

  const ctx = buildCtx(logs);
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'input', 'ctx', 'require',
    `return (async function reportBuilder() {\n${code}\n})();`
  );

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout de ${timeoutMs}ms no código do relatório`)), timeoutMs);
  });

  try {
    const raw = await Promise.race([Promise.resolve(fn(input ?? {}, ctx, undefined)), timeout]);
    return { ...normalizeResult(raw), logs };
  } finally {
    clearTimeout(timer);
  }
}

export default { runReportCode };
