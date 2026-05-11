import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Validar variáveis de ambiente obrigatórias
const requiredEnvVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Variáveis de ambiente faltando:', missingVars.join(', '));
  console.error('💡 Certifique-se de criar o arquivo .env na pasta backend/');
  process.exit(1);
}

// Configuração do pool de conexões
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  max: 20, // Número máximo de conexões no pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Schema padrão + fuso de Brasília na sessão (afeta now(), exibição de
  // TIMESTAMPTZ e parse de strings sem fuso). TIMESTAMPTZ continua armazenado
  // em UTC internamente — a TZ só muda apresentação e cálculos relativos.
  options: '-c search_path=maestro,public -c timezone=America/Sao_Paulo'
});

// Teste de conexão
pool.on('connect', () => {
  console.log('✅ Conectado ao banco de dados PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool de conexões:', err);
  process.exit(-1);
});

// Função para executar queries
export const query = (text, params) => pool.query(text, params);

async function runCompatibilityQuery(sql, label) {
  try {
    await pool.query(sql);
  } catch (error) {
    if (error?.code === '42501') {
      console.warn(`⚠️ Sem permissão para ajuste automático: ${label}`);
      return;
    }
    // 42P07 = duplicate_table/index/constraint — objeto já existe, ok ignorar em migrations
    if (error?.code === '42P07') {
      return;
    }

    throw error;
  }
}

async function ensureFileStorageTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.file_storage (
      id            uuid PRIMARY KEY,
      original_name text,
      stored_name   text,
      path          text,
      mime_type     text,
      size          bigint,
      created_at    timestamp DEFAULT now()
    )
  `, 'maestro.file_storage');
}

async function ensureCuttingPlanAttachmentTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cutting_plan_attachment (
      id               serial PRIMARY KEY,
      cutting_plan_id  int  NOT NULL,
      file_id          uuid NOT NULL,
      type             text NOT NULL,
      created_at       timestamp DEFAULT now(),
      CONSTRAINT fk_cp   FOREIGN KEY (cutting_plan_id) REFERENCES maestro.cutting_plan(id) ON DELETE CASCADE,
      CONSTRAINT fk_file FOREIGN KEY (file_id)         REFERENCES maestro.file_storage(id) ON DELETE CASCADE,
      CONSTRAINT unique_attachment UNIQUE (cutting_plan_id, type)
    )
  `, 'maestro.cutting_plan_attachment');
}

async function ensureCuttingPlansTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cutting_plan (
      id               SERIAL PRIMARY KEY,
      project_id       INTEGER NOT NULL REFERENCES maestro.project(id) ON DELETE CASCADE,
      plate_width      NUMERIC(8,3) NOT NULL DEFAULT 0,
      plate_height     NUMERIC(8,3) NOT NULL DEFAULT 0,
      linear_meters    JSONB NOT NULL DEFAULT '{}'::jsonb,
      square_meters    JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes            TEXT NOT NULL DEFAULT '',
      plate_consumption JSONB NOT NULL DEFAULT '{}'::jsonb,
      attachments      JSONB NOT NULL DEFAULT '[]'::jsonb,
      reviews          JSONB NOT NULL DEFAULT '{"cutting": false, "labeling": false, "ki_Layout": false, "nesting_report": false, "folder_template": false}'::jsonb,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, 'maestro.cutting_plan');
}

// Garante colunas esperadas para versões antigas do banco.
export async function ensureDatabaseCompatibility() {
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS menu_access JSONB NOT NULL DEFAULT '[]'::jsonb;
  `, 'maestro.users.menu_access');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  `, 'maestro.users.updated_at');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS api_token TEXT;
  `, 'maestro.users.api_token');

  // VARCHAR(255) é curta demais para tokens Jira longos (~200 chars) +
  // overhead da criptografia AES-GCM (~2× em hex). Converter para TEXT.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ALTER COLUMN api_token TYPE TEXT;
  `, 'maestro.users.api_token TYPE TEXT');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS linear_meters JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.linear_meters');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS square_meters JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.square_meters');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS plate_consumption JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.plate_consumption');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS reviews JSONB NOT NULL DEFAULT '{"cutting": false, "labeling": false, "ki_Layout": false, "nesting_report": false, "folder_template": false}'::jsonb;
  `, 'maestro.project.reviews');

  await ensureFileStorageTable();
  await ensureCuttingPlansTable();
  await ensureCuttingPlanAttachmentTable();
  await ensureAuditTables();
  await ensureQualityCertificatesTable();
  await ensureJiraCardsProducedAt();
  await ensurePlateSupplierTable();
  await ensurePlateSizeTable();
  await ensureOsPlanningTable();
  await ensureOsPrintAuditTable();
  await ensureProductionPackTable();
  await ensureOsPlanningPackId();
}

async function ensureJiraCardsProducedAt() {
  // Marco temporal da primeira transição p/ "Produzido" — alimentado pelo cron
  // de sync. Permite janela de visibilidade pós-entrega na tela do PCP.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.jira_cards
    ADD COLUMN IF NOT EXISTS produced_at TIMESTAMPTZ;
  `, 'maestro.jira_cards.produced_at');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS jira_cards_produced_at_idx
      ON maestro.jira_cards (produced_at)
  `, 'jira_cards_produced_at_idx');

  // Fábrica de Manta (customfield_11329 no Jira) — dropdown que indica em qual
  // unidade fabril a OS é produzida (ex.: COMTEC, MATRIZ).
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.jira_cards
    ADD COLUMN IF NOT EXISTS fabrica_manta TEXT;
  `, 'maestro.jira_cards.fabrica_manta');
}

async function ensurePlateSupplierTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.plate_supplier (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.plate_supplier');
}

async function ensurePlateSizeTable() {
  // plate_size pertence a um fornecedor (1:N). UNIQUE inclui supplier_id
  // porque dois fornecedores podem ter o mesmo tamanho geométrico.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.plate_size (
      id          SERIAL PRIMARY KEY,
      supplier_id INTEGER REFERENCES maestro.plate_supplier(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      width       NUMERIC(8,3) NOT NULL,
      height      NUMERIC(8,3) NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ,
      CONSTRAINT plate_size_supplier_dim_unique UNIQUE (supplier_id, width, height)
    )
  `, 'maestro.plate_size');

  // Migration p/ DBs criados antes da junção: adiciona supplier_id e troca o UNIQUE.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES maestro.plate_supplier(id) ON DELETE CASCADE;
  `, 'maestro.plate_size.supplier_id');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    DROP CONSTRAINT IF EXISTS plate_size_dim_unique;
  `, 'drop plate_size_dim_unique');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    ADD CONSTRAINT plate_size_supplier_dim_unique UNIQUE (supplier_id, width, height);
  `, 'add plate_size_supplier_dim_unique');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS plate_size_supplier_idx
      ON maestro.plate_size (supplier_id)
  `, 'plate_size_supplier_idx');
}

async function ensureOsPlanningTable() {
  // Vínculo lógico (sem FK) com jira_cards.key — o cron faz UPSERT em jira_cards
  // e podemos ter os_planning manuais antes do card existir (Fase 3).
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_planning (
      id                            SERIAL PRIMARY KEY,
      os_numero                     TEXT UNIQUE,
      card_key                      TEXT UNIQUE,
      veiculo                       TEXT,
      plate_supplier_id             INTEGER REFERENCES maestro.plate_supplier(id),
      plate_size_id                 INTEGER REFERENCES maestro.plate_size(id),
      material_assigned_at          TIMESTAMPTZ,
      material_assigned_by_user_id  INTEGER REFERENCES maestro.users(id),
      production_seq                INTEGER,
      first_printed_at              TIMESTAMPTZ,
      first_printed_by_user_id      INTEGER REFERENCES maestro.users(id),
      last_printed_at               TIMESTAMPTZ,
      last_printed_by_user_id       INTEGER REFERENCES maestro.users(id),
      print_count                   INTEGER NOT NULL DEFAULT 0,
      created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                    TIMESTAMPTZ
    )
  `, 'maestro.os_planning');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_card_key_idx
      ON maestro.os_planning (card_key)
  `, 'os_planning_card_key_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_supplier_idx
      ON maestro.os_planning (plate_supplier_id)
  `, 'os_planning_supplier_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_size_idx
      ON maestro.os_planning (plate_size_id)
  `, 'os_planning_size_idx');
}

async function ensureOsPrintAuditTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_print_audit (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id   INTEGER,
      actor_email     TEXT,
      request_id      UUID NOT NULL,
      card_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
      total           INTEGER NOT NULL DEFAULT 0,
      success         INTEGER NOT NULL DEFAULT 0,
      failed          INTEGER NOT NULL DEFAULT 0,
      entries         JSONB NOT NULL DEFAULT '[]'::jsonb,
      ip              TEXT,
      user_agent      TEXT
    )
  `, 'maestro.os_print_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_print_audit_actor_idx
      ON maestro.os_print_audit (actor_user_id, created_at DESC)
  `, 'os_print_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_print_audit_request_id_idx
      ON maestro.os_print_audit (request_id)
  `, 'os_print_audit_request_id_idx');
}

async function ensureProductionPackTable() {
  // Bloco de produção (visualização tipo "Excel colorido"). OSs são alocadas
  // a um pack via os_planning.pack_id. Pack agrupa OSs sem restringir tipo de
  // placa — pode misturar fornecedor/tamanho.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.production_pack (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      color             TEXT NOT NULL DEFAULT '#3b82f6',
      seq               INTEGER NOT NULL DEFAULT 0,
      target_date       DATE,
      notes             TEXT,
      created_by_user_id INTEGER REFERENCES maestro.users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ
    )
  `, 'maestro.production_pack');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS production_pack_seq_idx
      ON maestro.production_pack (seq)
  `, 'production_pack_seq_idx');
}

async function ensureOsPlanningPackId() {
  // Vínculo opcional: OSs podem estar em um pack ou ficar na fila "sem pack".
  // ON DELETE SET NULL — apagar pack devolve OSs para a fila.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.os_planning
    ADD COLUMN IF NOT EXISTS pack_id INTEGER REFERENCES maestro.production_pack(id) ON DELETE SET NULL;
  `, 'maestro.os_planning.pack_id');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_pack_id_idx
      ON maestro.os_planning (pack_id)
  `, 'os_planning_pack_id_idx');
}

async function ensureQualityCertificatesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.quality_certificates (
      id                       SERIAL PRIMARY KEY,
      numero                   TEXT NOT NULL,
      certificado              TEXT,
      paineis_balisticos       TEXT,
      produtos                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      nota_fiscal              TEXT,
      veiculo                  TEXT,
      data_emissao             DATE,
      material                 TEXT DEFAULT 'Dupont Kevlar® S745GR',
      norma                    TEXT DEFAULT 'ABNT NBR 15000:2020-2',
      nivel                    TEXT DEFAULT 'III-A',
      certificados_conformidade JSONB NOT NULL DEFAULT '[]'::jsonb,
      garantia_anos            INTEGER DEFAULT 5,
      created_by               INTEGER REFERENCES maestro.users(id),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ
    )
  `, 'maestro.quality_certificates');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS quality_certificates_numero_idx
      ON maestro.quality_certificates (numero)
  `, 'quality_certificates_numero_idx');
}

async function ensureAuditTables() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.project_audit (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id INTEGER,
      actor_email   TEXT,
      action        TEXT NOT NULL,
      project_id    INTEGER NOT NULL,
      project_code  TEXT,
      "before"      JSONB,
      "after"       JSONB,
      metadata      JSONB,
      request_id    UUID,
      ip            TEXT
    )
  `, 'maestro.project_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS project_audit_project_id_idx
      ON maestro.project_audit (project_id, created_at DESC)
  `, 'project_audit_project_id_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS project_audit_actor_idx
      ON maestro.project_audit (actor_user_id, created_at DESC)
  `, 'project_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_generation_audit (
      id                   SERIAL PRIMARY KEY,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id        INTEGER,
      actor_email          TEXT,
      request_id           UUID NOT NULL,
      total_requested      INTEGER NOT NULL DEFAULT 0,
      total_success        INTEGER NOT NULL DEFAULT 0,
      total_failed         INTEGER NOT NULL DEFAULT 0,
      total_field_warnings INTEGER NOT NULL DEFAULT 0,
      entries              JSONB NOT NULL DEFAULT '[]'::jsonb,
      ip                   TEXT,
      user_agent           TEXT
    )
  `, 'maestro.os_generation_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_generation_audit_actor_idx
      ON maestro.os_generation_audit (actor_user_id, created_at DESC)
  `, 'os_generation_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_generation_audit_request_id_idx
      ON maestro.os_generation_audit (request_id)
  `, 'os_generation_audit_request_id_idx');
}

export default pool;
