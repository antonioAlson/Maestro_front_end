// Migra os crons legados (.cjs) para o banco como versão OPE 1.00.
// Roda uma única vez por job — se já existe registro, não faz nada.
//
// O código abaixo é a forma "limpa" do job: sem cron.schedule, sem mutex
// `rodando`, sem recordRun (o scheduler central faz tudo isso agora).
// O código aqui é o corpo que será executado dentro do worker_threads
// — ele recebe `ctx` (com setRecordsProcessed, log, etc.) e tem `require` livre.

import { query } from '../config/database.js';

const SYNC_CARDS_JIRA_CODE = `
const axios = require("axios");
const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

const JIRA_URL = process.env.JIRA_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

const JQL = \`project = MANTA AND status IN ("A Produzir", "Liberado Engenharia","Em Produção", "Produzido")\`;

const client = axios.create({
  baseURL: \`\${JIRA_URL}/rest/api/3\`,
  auth: { username: EMAIL, password: API_TOKEN },
});

async function salvarOuAtualizar(issue) {
  const sql = \`
    INSERT INTO maestro.jira_cards (
      key, tipo, resumo, status, situacao, veiculo, previsao,
      project, fabrica_manta, produced_at, last_updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      CASE WHEN $4 = 'Produzido' THEN NOW() ELSE NULL END,
      NOW()
    )
    ON CONFLICT (key)
    DO UPDATE SET
      tipo = EXCLUDED.tipo,
      resumo = EXCLUDED.resumo,
      status = EXCLUDED.status,
      situacao = EXCLUDED.situacao,
      veiculo = EXCLUDED.veiculo,
      previsao = EXCLUDED.previsao,
      project = EXCLUDED.project,
      fabrica_manta = EXCLUDED.fabrica_manta,
      produced_at = COALESCE(
        maestro.jira_cards.produced_at,
        CASE WHEN EXCLUDED.status = 'Produzido' THEN NOW() ELSE NULL END
      ),
      last_updated_at = NOW();
  \`;
  const values = [
    issue.key, issue.tipo, issue.resumo, issue.status, issue.situacao,
    issue.veiculo, issue.previsao || null, issue.project || null, issue.fabricaManta || null,
  ];
  await pool.query(sql, values);
}

async function buscarIssues(jql, nextPageToken) {
  const params = {
    jql,
    maxResults: 100,
    fields: "issuetype,summary,status,customfield_10039,customfield_11298,customfield_10245,customfield_11353,customfield_11329",
  };
  if (nextPageToken) params.nextPageToken = nextPageToken;
  const response = await client.get("/search/jql", { params });
  return response.data;
}

async function processar() {
  let nextPage = null;
  let total = 0;
  console.log("Sync Jira iniciada...");

  do {
    const data = await buscarIssues(JQL, nextPage);
    const issues = data.issues || [];

    for (const issue of issues) {
      const fields = issue.fields || {};
      const key = issue.key;
      const tipo = fields.issuetype?.name || "";
      const resumo = fields.summary || "";
      const status = fields.status?.name || "";

      const situacaoRaw = fields.customfield_10039;
      const situacao = typeof situacaoRaw === "object" ? situacaoRaw?.value : situacaoRaw || "";

      const veiculoRaw = fields.customfield_11298;
      const veiculo = typeof veiculoRaw === "object" ? veiculoRaw?.value : veiculoRaw || "";

      const previsaoRaw = fields.customfield_10245;

      const projectRaw = fields.customfield_11353;
      const project = typeof projectRaw === "object" ? projectRaw?.value : projectRaw || "";

      const fabricaMantaRaw = fields.customfield_11329;
      const fabricaManta = typeof fabricaMantaRaw === "object" ? fabricaMantaRaw?.value : fabricaMantaRaw || "";

      await salvarOuAtualizar({
        key, tipo, resumo, status, situacao, veiculo,
        previsao: previsaoRaw, project, fabricaManta,
      });
      total++;
    }

    nextPage = data.nextPageToken;
    if (data.isLast) break;
  } while (true);

  console.log(\`Total sincronizado: \${total}\`);
  return total;
}

try {
  const total = await processar();
  ctx.setRecordsProcessed(total);
} finally {
  await pool.end();
}
`.trim();

const LEGACY_JOBS = [
  {
    name: 'sync_cards_jira',
    description: 'Sincroniza cards do Jira (project MANTA) com a tabela jira_cards.',
    cron_expression: '*/5 * * * *',
    code: SYNC_CARDS_JIRA_CODE,
  },
];

export async function migrateLegacyCronJobs() {
  for (const job of LEGACY_JOBS) {
    const existing = await query('SELECT id FROM maestro.cron_jobs WHERE name = $1', [job.name]);
    if (existing.rowCount > 0) {
      // job já cadastrado — não sobrescreve (preserva edições do usuário).
      continue;
    }

    const jobIns = await query(
      `INSERT INTO maestro.cron_jobs (name, description) VALUES ($1, $2) RETURNING id`,
      [job.name, job.description]
    );
    const jobId = jobIns.rows[0].id;

    await query(
      `INSERT INTO maestro.cron_job_versions
         (job_id, version_number, status, cron_expression, code, notes)
       VALUES ($1, 1.00, 'OPE', $2, $3, 'Migração inicial do .cjs legado.')`,
      [jobId, job.cron_expression, job.code]
    );

    console.log(`✅ Cron job legado migrado: ${job.name} (v1.00 OPE)`);
  }
}
