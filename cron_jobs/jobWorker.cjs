// Worker thread runner para execução de versões de cron jobs.
//
// Isolamento:
//   - Roda em event loop separado (loop infinito não trava a API).
//   - Tem seu próprio Pool de DB.
//   - Comunica-se com main thread só via parentPort.postMessage.
//   - Se travar, main thread chama worker.terminate() (timeout).
//
// Contrato com o código do usuário:
//   O código recebido em workerData.code é wrapeado numa async function que
//   recebe (ctx, require, console). O usuário pode usar top-level await
//   porque o corpo já está dentro de async.
require("dotenv").config();

const { parentPort, workerData } = require("worker_threads");
const { Pool } = require("pg");

const pool = new Pool({
  user:     process.env.DB_USER     || "postgres",
  host:     process.env.DB_HOST     || "localhost",
  database: process.env.DB_NAME     || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port:     Number(process.env.DB_PORT) || 5432,
  max: 5,
  options: "-c search_path=maestro,public -c timezone=America/Sao_Paulo",
});

const send = (msg) => {
  try { parentPort.postMessage(msg); } catch { /* main thread já fechou */ }
};

const ctx = {
  jobName:   workerData.jobName,
  versionId: workerData.versionId,
  runId:     workerData.runId,
  db: {
    query: (text, params) => pool.query(text, params),
  },
  log: (...args) => send({ type: "log", level: "info",  args: args.map((a) => safeStringify(a)) }),
  warn:(...args) => send({ type: "log", level: "warn",  args: args.map((a) => safeStringify(a)) }),
  error:(...args)=> send({ type: "log", level: "error", args: args.map((a) => safeStringify(a)) }),
  setRecordsProcessed: (n) => send({ type: "records", value: Number.isFinite(Number(n)) ? Number(n) : null }),
  setDetails: (obj) => send({ type: "details", value: obj ?? null }),
};

function safeStringify(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Console capturado: o que o usuário escrever com console.log/.error
// também sobe pra main thread (útil pra debug via UI no futuro).
const userConsole = {
  log:   ctx.log,
  info:  ctx.log,
  warn:  ctx.warn,
  error: ctx.error,
  debug: ctx.log,
};

(async () => {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "ctx", "require", "console",
      `return (async function userJob() {\n${workerData.code}\n})();`
    );
    await fn(ctx, require, userConsole);
    send({ type: "done" });
  } catch (err) {
    send({
      type: "error",
      message: err?.message || String(err),
      stack:   err?.stack || null,
    });
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  }

  try { await pool.end(); } catch { /* ignore */ }
  process.exit(0);
})();
