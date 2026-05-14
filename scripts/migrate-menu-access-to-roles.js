/**
 * migrate-menu-access-to-roles.js
 *
 * Lê o campo menu_access (paths legados) de cada usuário e infere as roles
 * RBAC apropriadas. Por padrão executa em modo dry-run (somente relatório CSV).
 *
 * Uso:
 *   node scripts/migrate-menu-access-to-roles.js
 *   node scripts/migrate-menu-access-to-roles.js --apply
 *   node scripts/migrate-menu-access-to-roles.js --apply --csv migration-report.csv
 *
 * Pré-requisito: rode scripts/seed-rbac.js antes para garantir que as roles
 * existam no banco.
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  options:  '-c search_path=maestro,public',
});

const q = (text, params) => pool.query(text, params);

// ─── Mapeamento menu_access → roles ─────────────────────────────────────────
//
// Aceita caminhos com ou sem barra inicial: '/pcp/ordens' e 'pcp/ordens'
// são tratados da mesma forma. A tabela de mapeamento cobre tanto o formato
// antigo (DEFAULT_MENU_ACCESS com barras) quanto as chaves do MODULE_OPTIONS
// do frontend (sem barras).

function normalize(path) {
  return (path || '').replace(/^\/+/, '').toLowerCase().trim();
}

function inferRoles(rawMenuAccess) {
  const access = new Set((rawMenuAccess || []).map(normalize));
  const roles  = new Set();
  const notes  = [];

  const has = (...paths) => paths.some((p) => access.has(p));

  // Gestão de usuários → ADMIN (único role com users:* e user_access:manage)
  if (has('users', 'users/acesso', 'usuarios')) {
    roles.add('ADMIN');
    notes.push('gestão de usuários → ADMIN');
  }

  // Faturamento → FATURAMENTO
  if (
    has('faturamento', 'faturamento/invoicing', 'faturamento/aging', 'faturamento/integrity') ||
    has('invoicing', 'invoicing/aging', 'invoicing/integrity')
  ) {
    roles.add('FATURAMENTO');
  }

  // Projetos / planos de corte → CORTE_OPERATOR
  if (has('projetos', 'projetos/corte', 'projetos/planos')) {
    roles.add('CORTE_OPERATOR');
  }

  // Espelhos sem CORTE_OPERATOR nem ADMIN → AUDITOR (único com espelhos:read além deles)
  if (has('projetos/espelhos') && !roles.has('CORTE_OPERATOR') && !roles.has('ADMIN')) {
    roles.add('AUDITOR');
    notes.push('projetos/espelhos → AUDITOR (sem role exclusiva de espelhos)');
  }

  // PCP com edição → PCP_OPERATOR
  if (has('pcp', 'pcp/ordens')) {
    roles.add('PCP_OPERATOR');
  }

  // PCP somente leitura → PCP_VIEWER
  if (!roles.has('PCP_OPERATOR') && has('pcp/acompanhamento', 'pcp/relatorios', 'pcp/gestao')) {
    roles.add('PCP_VIEWER');
  }

  // Relatórios gerais → AUDITOR
  if (has('reports') && !roles.has('ADMIN')) {
    roles.add('AUDITOR');
  }

  // Home / métricas sem nenhum outro role → PCP_VIEWER (tem metrics:read)
  const coversMetrics = new Set([
    'ADMIN', 'PCP_OPERATOR', 'PCP_VIEWER',
    'CORTE_OPERATOR', 'QUALIDADE', 'FATURAMENTO', 'AUDITOR',
  ]);
  const hasMetricsCovered = [...roles].some((r) => coversMetrics.has(r));
  if (!hasMetricsCovered && has('home', 'metricas')) {
    roles.add('PCP_VIEWER');
    notes.push('metricas/home → PCP_VIEWER (metrics:read)');
  }

  // Configurações — não requer permissão específica, sem role necessária
  // '/settings' → ignorado intencionalmente

  return { roles: [...roles], notes };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

const CSV_HEADERS = ['email', 'previous_access', 'assigned_roles', 'notes', 'action'];

function toCSV(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      CSV_HEADERS
        .map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const apply   = args.includes('--apply');
  const csvIdx  = args.indexOf('--csv');
  const csvPath = csvIdx !== -1 ? args[csvIdx + 1] : null;

  console.log(`\n🔄  migrate-menu-access-to-roles — ${apply ? 'APLICANDO' : 'DRY RUN'}\n`);

  // Catálogo de roles existentes
  const rolesRes = await q('SELECT id, name FROM maestro.roles ORDER BY name');
  if (!rolesRes.rows.length) {
    console.error('❌  Nenhuma role encontrada. Execute scripts/seed-rbac.js primeiro.');
    process.exit(1);
  }
  const roleByName = Object.fromEntries(rolesRes.rows.map((r) => [r.name, r.id]));
  console.log(`   Roles disponíveis: ${Object.keys(roleByName).join(', ')}\n`);

  // Usuário grantor (master)
  const masterRes = await q(
    'SELECT id, email FROM maestro.users WHERE is_master = true AND deleted_at IS NULL LIMIT 1',
  );
  const grantor = masterRes.rows[0] || null;
  if (!grantor) {
    console.warn('⚠️   Nenhum is_master encontrado — granted_by ficará como id do próprio usuário.');
  }

  // Todos os usuários ativos
  const usersRes = await q(`
    SELECT u.id, u.email, u.menu_access, u.is_master,
      (SELECT COUNT(*) FROM maestro.user_roles ur WHERE ur.user_id = u.id) AS role_count
    FROM maestro.users u
    WHERE u.deleted_at IS NULL
    ORDER BY u.email
  `);

  const report       = [];
  let assignedCount  = 0;
  let skippedCount   = 0;
  let noRolesCount   = 0;

  for (const user of usersRes.rows) {
    const menuAccess    = Array.isArray(user.menu_access) ? user.menu_access : [];
    const existingCount = parseInt(user.role_count, 10);

    // is_master — pular
    if (user.is_master) {
      report.push({
        email: user.email,
        previous_access: menuAccess.join('|'),
        assigned_roles: '(is_master — bypass RBAC)',
        notes: 'Pulado: is_master não precisa de roles',
        action: 'skipped',
      });
      skippedCount++;
      continue;
    }

    // Já tem roles — pular
    if (existingCount > 0) {
      const curRes = await q(
        `SELECT r.name FROM maestro.roles r
         JOIN maestro.user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1
         ORDER BY r.name`,
        [user.id],
      );
      report.push({
        email: user.email,
        previous_access: menuAccess.join('|'),
        assigned_roles: curRes.rows.map((r) => r.name).join('|'),
        notes: 'Já possui roles — pulado',
        action: 'skipped',
      });
      skippedCount++;
      continue;
    }

    // Sem menu_access armazenado
    if (!menuAccess.length) {
      report.push({
        email: user.email,
        previous_access: '(vazio)',
        assigned_roles: '',
        notes: 'menu_access vazio — nenhuma role inferida',
        action: 'no_roles',
      });
      noRolesCount++;
      continue;
    }

    const { roles, notes } = inferRoles(menuAccess);

    if (!roles.length) {
      report.push({
        email: user.email,
        previous_access: menuAccess.join('|'),
        assigned_roles: '',
        notes: notes.join('; ') || 'Não foi possível mapear o acesso a nenhuma role',
        action: 'no_roles',
      });
      noRolesCount++;
      continue;
    }

    const validRoleIds = roles.map((name) => roleByName[name]).filter(Boolean);
    const missingRoles = roles.filter((name) => !roleByName[name]);
    const allNotes = [
      ...notes,
      ...(missingRoles.length ? [`AVISO: roles não encontradas no DB: ${missingRoles.join(', ')}`] : []),
    ];

    if (apply && validRoleIds.length) {
      const grantorId    = grantor?.id    || user.id;
      const grantorEmail = grantor?.email || user.email;

      for (const roleId of validRoleIds) {
        await q(
          `INSERT INTO maestro.user_roles (user_id, role_id, granted_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [user.id, roleId, grantorId],
        );
      }

      await q(
        `INSERT INTO maestro.access_audit
           (user_id, user_email, event_type, target_user_id, details)
         VALUES ($1, $2, 'role_granted', $3, $4::jsonb)`,
        [
          grantorId,
          grantorEmail,
          user.id,
          JSON.stringify({ trigger: 'migrate-menu-access-to-roles', roles }),
        ],
      );
    }

    report.push({
      email: user.email,
      previous_access: menuAccess.join('|'),
      assigned_roles: roles.join('|'),
      notes: allNotes.join('; '),
      action: apply ? 'assigned' : 'would_assign',
    });
    assignedCount++;
  }

  // Gerar CSV
  const csv = toCSV(report);

  if (csvPath) {
    writeFileSync(resolve(csvPath), csv, 'utf8');
    console.log(`📄  Relatório salvo em: ${resolve(csvPath)}`);
  } else {
    console.log('=== CSV REPORT ===');
    console.log(csv);
    console.log('==================\n');
  }

  console.log(`✅  Concluído — ${apply ? 'APLICADO' : 'dry run'}`);
  console.log(`   ${assignedCount} usuário(s) ${apply ? 'receberam' : 'receberiam'} roles`);
  console.log(`   ${skippedCount} usuário(s) pulados (is_master ou já tinham roles)`);
  console.log(`   ${noRolesCount} usuário(s) sem mapeamento possível`);

  if (!apply) {
    console.log('\n💡  Para aplicar:');
    console.log('   node scripts/migrate-menu-access-to-roles.js --apply --csv migration-report.csv');
  } else {
    console.log('\n💡  Próximo passo: verifique o CSV, ajuste roles manualmente se necessário,');
    console.log('   depois ative RBAC_MODE=strict no .env e reinicie a API.');
  }
}

main()
  .catch((err) => {
    console.error('\n❌  Erro na migração:', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
