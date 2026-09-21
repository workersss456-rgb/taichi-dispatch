const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const connectionString = config.databaseUrl;
if (!connectionString) console.error('🚨 尚未設定 DATABASE_URL，請填入 Neon 連線字串。');

const pool = new Pool({
  connectionString,
  ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString || '') ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    -- ---------- 主檔 ----------
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,                    -- 組別代碼，例如 tingzhi
      name TEXT NOT NULL UNIQUE,
      manager_name TEXT NOT NULL,
      manager_title TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      UNIQUE (name, group_id)
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      phone TEXT,
      role TEXT DEFAULT 'member',             -- member 組員 / manager 主管 / admin 全權
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS leave_types (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS saved_temp_workers (
      name TEXT PRIMARY KEY
    );

    -- ---------- 每日派工：一人一天一列 ----------
    CREATE TABLE IF NOT EXISTS dispatch_entries (
      id SERIAL PRIMARY KEY,
      work_date DATE NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL,
      is_manager BOOLEAN DEFAULT false,
      manager_title TEXT DEFAULT '',
      status TEXT DEFAULT 'work',             -- work half borrow ot1 ot15 off
      work_ratio NUMERIC(4,2) DEFAULT 1,
      assigned_site TEXT DEFAULT '',
      target_group_id TEXT,                   -- 外借時借給哪一組
      leave_type TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT '',
      UNIQUE (work_date, person_name)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_date ON dispatch_entries (work_date);
    CREATE INDEX IF NOT EXISTS idx_dispatch_date_group ON dispatch_entries (work_date, group_id);

    -- 每組每天一列：鎖定狀態與版本（衝突偵測做到「日期＋組別」這一層）
    CREATE TABLE IF NOT EXISTS day_groups (
      work_date DATE NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      locked BOOLEAN DEFAULT false,
      version BIGINT DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT '',
      PRIMARY KEY (work_date, group_id)
    );

    CREATE TABLE IF NOT EXISTS temp_workers (
      id SERIAL PRIMARY KEY,
      work_date DATE NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      site TEXT DEFAULT '',
      ratio NUMERIC(4,2) DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_temp_date ON temp_workers (work_date, group_id);

    CREATE TABLE IF NOT EXISTS subcontracts (
      id SERIAL PRIMARY KEY,
      work_date DATE NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      vendor TEXT NOT NULL,
      work_item TEXT DEFAULT '',
      site TEXT DEFAULT '',
      head_count INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sub_date ON subcontracts (work_date, group_id);

    -- ---------- 排休：一人一天一列 ----------
    CREATE TABLE IF NOT EXISTS leaves (
      id SERIAL PRIMARY KEY,
      person_name TEXT NOT NULL,
      leave_date DATE NOT NULL,
      leave_type TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT '',
      UNIQUE (person_name, leave_date)
    );
    CREATE INDEX IF NOT EXISTS idx_leave_date ON leaves (leave_date);

    -- 每日工作安排：每組每天每個案場一段文字（今天要做什麼、注意事項）
    CREATE TABLE IF NOT EXISTS site_tasks (
      work_date DATE NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      site TEXT NOT NULL,
      content TEXT DEFAULT '',
      PRIMARY KEY (work_date, group_id, site)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      detail TEXT,
      operator TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ---------- 人員生命週期欄位 ----------
  // hire_date 到職日、leave_date 離職日（當天起不再排班）、in_roster 是否出現在派工名冊
  // 人資、行政這類管理者 in_roster = false，只負責管理不會被排班
  await pool.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS hire_date DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS leave_date DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS in_roster BOOLEAN DEFAULT true;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
  `);

  await seed();
  await migrateOnce('2026-09-hr-not-in-roster', async (client) => {
    // 沒有組別的管理者（例如人資）不列入派工名冊，也不再跳「沒有對應組別」的警告
    await client.query(`UPDATE employees SET in_roster = false WHERE group_id IS NULL AND role = 'admin'`);
  });
}

async function migrateOnce(name, fn) {
  const done = (await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])).rows.length;
  if (done) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM groups');
  if (rows[0].c > 0) return;

  const mastersFile = path.join(__dirname, 'seeds', 'masters.json');
  if (!fs.existsSync(mastersFile)) return;
  const m = JSON.parse(fs.readFileSync(mastersFile, 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, g] of m.groups.entries()) {
      await client.query(
        'INSERT INTO groups (id, name, manager_name, manager_title, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [g.code, g.name, g.manager, g.title, i]
      );
      // 主管本人也放進員工表，方便之後用手機登入
      await client.query(
        `INSERT INTO employees (name, group_id, role, sort_order) VALUES ($1,$2,'manager',$3)
         ON CONFLICT (name) DO UPDATE SET group_id = EXCLUDED.group_id, role = 'manager'`,
        [g.manager, g.code, i]
      );
    }
    const groupIdByName = {};
    (await client.query('SELECT id, name FROM groups')).rows.forEach((g) => { groupIdByName[g.name] = g.id; });

    for (const [i, s] of m.sites.entries()) {
      const gid = groupIdByName[s.group];
      if (!gid) continue;
      await client.query('INSERT INTO sites (name, group_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [s.name, gid, i]);
    }
    for (const [i, e] of m.employees.entries()) {
      await client.query(
        `INSERT INTO employees (name, group_id, role, sort_order) VALUES ($1,$2,'member',$3)
         ON CONFLICT (name) DO NOTHING`, [e.name, groupIdByName[e.group] || null, i]
      );
    }
    for (const [i, t] of m.leaveTypes.entries()) {
      await client.query('INSERT INTO leave_types (name, sort_order) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t, i]);
    }
    for (const n of ['粗工-阿強', '水電-老李', '油漆-陳師傅', '泥作-阿明', '粗工-大寶']) {
      await client.query('INSERT INTO saved_temp_workers (name) VALUES ($1) ON CONFLICT DO NOTHING', [n]);
    }
    await client.query('COMMIT');
    console.log(`✅ 已匯入主檔：組別 ${m.groups.length}、案場 ${m.sites.length}、員工 ${m.employees.length}、假別 ${m.leaveTypes.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await seedHistory();
}

// 舊系統的排休紀錄與派工紀錄（一次性匯入，之後不再執行）
async function seedHistory() {
  const file = path.join(__dirname, 'seeds', 'history.json');
  if (!fs.existsSync(file)) return;
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of h.leaves || []) {
      if (!l.name || !l.date || !l.type) continue;
      await client.query(
        `INSERT INTO leaves (person_name, leave_date, leave_type, updated_by) VALUES ($1,$2,$3,'舊系統匯入')
         ON CONFLICT (person_name, leave_date) DO NOTHING`, [l.name, l.date, l.type]
      );
    }
    const groupIdByName = {};
    (await client.query('SELECT id, name FROM groups')).rows.forEach((g) => { groupIdByName[g.name] = g.id; });

    let imported = 0;
    for (const r of h.history || []) {
      const gid = groupIdByName[r.group];
      if (!gid || !r.date || !r.name) continue;
      if (r.role === '點工') {
        await client.query(
          'INSERT INTO temp_workers (work_date, group_id, name, site, ratio) VALUES ($1,$2,$3,$4,$5)',
          [r.date, gid, r.name, r.site || '', r.ratio || 1]
        );
      } else if (r.role === '發包') {
        await client.query(
          'INSERT INTO subcontracts (work_date, group_id, vendor, site, head_count) VALUES ($1,$2,$3,$4,$5)',
          [r.date, gid, r.name, r.site || '', Math.round(r.ratio || 1)]
        );
      } else {
        const name = r.name.replace(/\(.*\)$/, '');
        await client.query(
          `INSERT INTO dispatch_entries (work_date, group_id, person_name, is_manager, status, work_ratio, assigned_site, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'舊系統匯入')
           ON CONFLICT (work_date, person_name) DO NOTHING`,
          [r.date, gid, name, r.role === '主管', ratioToStatus(r.ratio), r.ratio || 1, r.site || '']
        );
      }
      imported++;
    }
    await client.query('COMMIT');
    console.log(`✅ 已匯入歷史：排休 ${(h.leaves || []).length} 筆、派工 ${imported} 筆`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('歷史資料匯入失敗（不影響系統運作）：', err.message);
  } finally {
    client.release();
  }
}

function ratioToStatus(ratio) {
  const r = Number(ratio) || 0;
  if (r === 0) return 'off';
  if (r === 0.5) return 'half';
  if (r === 1.5) return 'ot15';
  return 'work';
}

module.exports = { pool, init };
