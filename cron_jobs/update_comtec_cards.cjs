require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const { Pool } = require("pg");
const { recordRun, recordSkipped } = require("./recordRun.cjs");

const JOB_NAME = "update_comtec_cards";
let rodando = false;

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

const CAMPO_PREVISAO = "customfield_10245";

const JQL = `((project = MANTA AND "fábrica de manta[dropdown]" = COMTEC 
AND status IN ("A Produzir", "Liberado Engenharia","Em Produção", "Produzido"))  OR (project = TENSYLON AND "fábrica de tensylon[dropdown]" = COMTEC  AND status IN ("A Produzir", "Liberado Engenharia", "Aguardando Acabamento", "Aguardando Autoclave", "Aguardando Corte", "Aguardando montagem","🔴RECEBIDO NÃO LIBERADO")))`;
//let jql = '(project = MANTA AND "fábrica de manta[dropdown]" = COMTEC AND status IN ("A Produzir", "Liberado Engenharia")) OR (project = TENSYLON AND status IN ("A Produzir", "Liberado Engenharia", "Aguardando Acabamento", "Aguardando Autoclave", "Aguardando Corte", "Aguardando montagem", "🔴RECEBIDO NÃO LIBERADO"))';
 

const SITUACOES_VALIDAS = [
  "⚪️RECEBIDO ENCAMINHADO",
  "🟢RECEBIDO LIBERADO",
];

const client = axios.create({
  baseURL: `${JIRA_URL}/rest/api/3`,
  auth: {
    username: EMAIL,
    password: API_TOKEN,
  },
  headers: {
    Accept: "application/json",
  },
});

// ================= FUNÇÕES =================

// Próximo dia útil (igual Python)
function proximoDiaUtil() {
  let data = new Date();
  data.setDate(data.getDate() + 1);

  while (data.getDay() === 0 || data.getDay() === 6) {
    data.setDate(data.getDate() + 1);
  }

  return data.toISOString().split("T")[0]; // YYYY-MM-DD
}

// Salvar no banco
async function salvarOuAtualizar(issue) {
  const query = `
    INSERT INTO maestro.jira_cards (
      key,
      tipo,
      resumo,
      status,
      situacao,
      veiculo,
      previsao,
      last_updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (key)
    DO UPDATE SET
      tipo = EXCLUDED.tipo,
      resumo = EXCLUDED.resumo,
      status = EXCLUDED.status,
      situacao = EXCLUDED.situacao,
      veiculo = EXCLUDED.veiculo,
      previsao = EXCLUDED.previsao,
      last_updated_at = NOW();
  `;

  const values = [
    issue.key,
    issue.tipo,
    issue.resumo,
    issue.status,
    issue.situacao,
    issue.veiculo,
    issue.previsao || null,
  ];

  try {
    await pool.query(query, values);
  } catch (err) {
    console.error(`❌ Erro ao salvar ${issue.key}:`, err.message);
  }
}

// Atualizar previsão no Jira
async function atualizarPrevisao(issueKey, novaData) {
  try {
    await client.put(`/issue/${issueKey}`, {
      fields: {
        [CAMPO_PREVISAO]: novaData,
      },
    });

    console.log(`✅ ${issueKey} atualizado para ${novaData}`);
  } catch (err) {
    console.error(
      `❌ Erro ao atualizar ${issueKey}:`,
      err.response?.data || err.message
    );
  }
}

// Buscar issues
async function buscarIssues(jql, nextPageToken = null) {
  const params = {
    jql,
    maxResults: 100,
    fields:
      "issuetype,summary,status,customfield_10039,customfield_11298,customfield_10245",
  };

  if (nextPageToken) {
    params.nextPageToken = nextPageToken;
  }

  const response = await client.get("/search/jql", { params });
  console.log(response.data)
  return response.data;
}

// ================= PROCESSAMENTO =================

async function processar() {
  let nextPage = null;
  let total = 0;

  console.log("🚀 Sync iniciada...");

  do {
      const data = await buscarIssues(JQL, nextPage);
      const issues = data.issues || [];

      for (const issue of issues) {
        const fields = issue.fields || {};

        const key = issue.key;
        const tipo = fields.issuetype?.name || "";
        const resumo = fields.summary || "";
        const status = fields.status?.name || "";

        // SITUAÇÃO
        const situacaoRaw = fields.customfield_10039;
        const situacao =
          typeof situacaoRaw === "object"
            ? situacaoRaw?.value
            : situacaoRaw || "";

        // 🔴 FILTRO (igual Python)
        if (!SITUACOES_VALIDAS.includes(situacao)) {
          continue;
        }

        // VEÍCULO
        const veiculoRaw = fields.customfield_11298;
        const veiculo =
          typeof veiculoRaw === "object"
            ? veiculoRaw?.value
            : veiculoRaw || "";

        // PREVISÃO
        const previsaoRaw = fields.customfield_10245;

        console.log(`🔎 Processando ${key}`);

        // Salvar no banco
        await salvarOuAtualizar({
          key,
          tipo,
          resumo,
          status,
          situacao,
          veiculo,
          previsao: previsaoRaw,
        });

        const novaData = proximoDiaUtil();

        //await atualizarPrevisao(key, novaData);
        console.log(key," ", tipo, " previsão atualizada para", novaData);
        total++;
      }

      nextPage = data.nextPageToken;
      if (data.isLast) break;

  } while (true);

  console.log(`🏁 Total processado: ${total}`);
  return total;
}

// ================= CRON =================

cron.schedule("0 8 * * *", async () => {
  if (rodando) {
    console.log("⏳ Ainda em execução, pulando...");
    await recordSkipped(JOB_NAME, "Execução anterior ainda em andamento");
    return;
  }

  rodando = true;
  console.log("\n⏰ Rodando sincronização...");

  try {
    await recordRun(JOB_NAME, async (ctx) => {
      const total = await processar();
      ctx.setRecordsProcessed(total);
    });
  } catch (err) {
    console.error("❌ Erro geral:", err.message);
  } finally {
    rodando = false;
  }
}, {
  timezone: "America/Sao_Paulo"
});

// execução inicial
const isDev = process.env.NODE_ENV == "production";

if (isDev) {
  console.log("Executando em:", new Date().toISOString());
  recordRun(JOB_NAME, async (ctx) => {
    const total = await processar();
    ctx.setRecordsProcessed(total);
  }).catch((err) => console.error("❌ Erro geral:", err.message));
} else {
  const msg = `Script Comtec Datas Ambiente: ${process.env.NODE_ENV} | rodar? ${isDev}`;
  console.log(msg);
}

module.exports = { processar };
