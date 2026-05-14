/**
 * Seed RBAC — idempotente, seguro para rodar múltiplas vezes.
 *
 * O que faz:
 *   1. Upsert de todas as permissões de ALL_PERMISSIONS.
 *   2. Upsert das 7 roles padrão (is_system=true).
 *   3. Upsert das role_permissions de cada role.
 *   4. Bootstrap is_master: se nenhum usuário is_master=true existe,
 *      promove o usuário cujo email = MASTER_BOOTSTRAP_EMAIL (env var)
 *      e atribui a role ADMIN a ele.
 *
 * Uso:
 *   node scripts/seed-rbac.js
 *   MASTER_BOOTSTRAP_EMAIL=antonio.goncalves@opera.security node scripts/seed-rbac.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { ALL_PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../shared/permissions.js';

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

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------

// Helper: all actions for a given resource extracted from ALL_PERMISSIONS.
function perms(...specs) {
  const result = [];
  for (const spec of specs) {
    const [resource, actionStr] = spec.split(':');
    if (actionStr === '*') {
      ALL_PERMISSIONS
        .filter((p) => p.resource === resource)
        .forEach((p) => result.push(p));
    } else {
      for (const action of actionStr.split(',')) {
        result.push({ resource, action: action.trim() });
      }
    }
  }
  return result;
}

const ALL_READ = ALL_PERMISSIONS.filter((p) => p.action === 'read');

const ROLE_DEFINITIONS = [
  {
    name: 'ADMIN',
    description: 'Acesso total ao sistema (exceto operações master como alterar is_master)',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'PCP_OPERATOR',
    description: 'Operação completa de PCP — criar, editar e acompanhar ordens',
    permissions: perms(
      'pcp_orders:read,create,update',
      'pcp_acompanhamento:read',
      'pcp_reports:read,export',
      'metrics:read',
    ),
  },
  {
    name: 'PCP_VIEWER',
    description: 'Acompanhamento de ordens sem poder editar',
    permissions: perms(
      'pcp_orders:read',
      'pcp_acompanhamento:read',
      'pcp_reports:read',
      'metrics:read',
    ),
  },
  {
    name: 'CORTE_OPERATOR',
    description: 'Gestão de projetos e planos de corte — sem excluir projetos ou planos',
    permissions: perms(
      'cutting_projects:read,create,update,clone,export',
      'cutting_plans:read,create,update',
      'cutting_attachments:*',
      'metrics:read',
    ),
  },
  {
    name: 'QUALIDADE',
    description: 'Emissão e gestão de certificados de qualidade',
    permissions: perms(
      'certificates:*',
      'cutting_projects:read',
      'metrics:read',
    ),
  },
  {
    name: 'FATURAMENTO',
    description: 'Gestão de faturamento, NFs e aging',
    permissions: perms(
      'invoicing:*',
      'invoicing_aging:read',
      'invoicing_integrity:read',
      'metrics:read',
    ),
  },
  {
    name: 'AUDITOR',
    description: 'Leitura ampla de todos os módulos — sem criar, editar ou excluir',
    permissions: ALL_READ,
  },
];

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function seedPermissions() {
  console.log('🔐 Upserting permissions...');
  let count = 0;
  for (const { resource, action } of ALL_PERMISSIONS) {
    const description = PERMISSION_DESCRIPTIONS[`${resource}:${action}`] ?? null;
    await q(
      `INSERT INTO maestro.permissions (resource, action, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (resource, action) DO UPDATE
         SET description = EXCLUDED.description`,
      [resource, action, description],
    );
    count++;
  }
  console.log(`  ✓ ${count} permissions upserted`);
}

async function seedRoles() {
  console.log('👥 Upserting roles...');
  const results = {};
  for (const { name, description } of ROLE_DEFINITIONS) {
    const res = await q(
      `INSERT INTO maestro.roles (name, description, is_system)
       VALUES ($1, $2, true)
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             is_system   = true,
             updated_at  = now()
       RETURNING id`,
      [name, description],
    );
    results[name] = res.rows[0].id;
    console.log(`  ✓ role ${name} → id ${results[name]}`);
  }
  return results;
}

async function seedRolePermissions(roleIds) {
  console.log('🔗 Upserting role_permissions...');
  let total = 0;
  for (const { name, permissions } of ROLE_DEFINITIONS) {
    const roleId = roleIds[name];
    // Resolve permission ids in a single query
    if (!permissions.length) continue;
    const pairs = permissions.map((p) => `('${p.resource}', '${p.action}')`).join(', ');
    const permRes = await q(
      `SELECT id FROM maestro.permissions
       WHERE (resource, action) IN (${pairs})`,
    );
    const permIds = permRes.rows.map((r) => r.id);

    for (const permId of permIds) {
      await q(
        `INSERT INTO maestro.role_permissions (role_id, permission_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [roleId, permId],
      );
    }
    total += permIds.length;
    console.log(`  ✓ ${name}: ${permIds.length} permissions linked`);
  }
  console.log(`  ✓ ${total} role_permissions total`);
}

async function bootstrapMaster(roleIds) {
  const bootstrapEmail = process.env.MASTER_BOOTSTRAP_EMAIL;

  // Check if any master already exists
  const existingMaster = await q(
    `SELECT id FROM maestro.users WHERE is_master = true AND deleted_at IS NULL LIMIT 1`,
  );
  if (existingMaster.rows.length > 0) {
    console.log('ℹ️  is_master already assigned — skipping bootstrap');
    return;
  }

  if (!bootstrapEmail) {
    console.warn(
      '⚠️  No MASTER_BOOTSTRAP_EMAIL set and no is_master user found.\n' +
      '    Set MASTER_BOOTSTRAP_EMAIL=<email> and re-run to bootstrap.',
    );
    return;
  }

  const userRes = await q(
    `SELECT id, email FROM maestro.users WHERE email = $1 AND deleted_at IS NULL`,
    [bootstrapEmail],
  );
  if (!userRes.rows.length) {
    console.warn(`⚠️  User "${bootstrapEmail}" not found — cannot bootstrap is_master.`);
    return;
  }

  const user = userRes.rows[0];
  const adminRoleId = roleIds['ADMIN'];

  // Promote to is_master
  await q(
    `UPDATE maestro.users SET is_master = true WHERE id = $1`,
    [user.id],
  );

  // Assign ADMIN role (idempotent)
  await q(
    `INSERT INTO maestro.user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [user.id, adminRoleId],
  );

  // Audit log
  await q(
    `INSERT INTO maestro.access_audit
       (user_id, user_email, event_type, target_user_id, details)
     VALUES ($1, $2, 'master_action', $1, $3::jsonb)`,
    [
      user.id,
      user.email,
      JSON.stringify({
        action:  'bootstrap_is_master',
        role:    'ADMIN',
        trigger: 'seed-rbac.js',
      }),
    ],
  );

  console.log(`✅ Bootstrap: ${user.email} → is_master=true + role ADMIN`);
}

async function main() {
  try {
    console.log('\n🚀 Seeding RBAC...\n');
    await seedPermissions();
    const roleIds = await seedRoles();
    await seedRolePermissions(roleIds);
    await bootstrapMaster(roleIds);
    console.log('\n✅ seed-rbac complete\n');
  } catch (err) {
    console.error('\n❌ seed-rbac failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
