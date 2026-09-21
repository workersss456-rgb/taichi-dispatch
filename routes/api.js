const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// ============================================================
// 身分：手機號碼識別（主管／管理者）
// ============================================================
function normPhone(v) { return String(v || '').replace(/[^0-9]/g, ''); }

async function findUserByPhone(phone) {
  const p = normPhone(phone);
  if (p.length < 8) return null;
  return (await pool.query(
    `SELECT name, group_id, role FROM employees
     WHERE REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $1 AND active IS NOT FALSE
     ORDER BY id LIMIT 1`, [p]
  )).rows[0] || null;
}

// 每個寫入動作都要帶手機；讀取則開放（畫面本來就是給內部看的）
async function requireUser(req, res) {
  const user = await findUserByPhone(req.body.phone || req.query.phone);
  if (!user) { res.status(401).json({ error: '請先以手機號碼登入' }); return null; }
  return user;
}

// 主管只能改自己那一組，admin 不限
function canEditGroup(user, groupId) {
  return user.role === 'admin' || user.group_id === groupId;
}

router.post('/auth/lookup', async (req, res) => {
  try {
    const user = await findUserByPhone(req.body.phone);
    res.json({ found: !!user, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

async function log(action, detail, operator) {
  try {
    await pool.query('INSERT INTO audit_logs (action, detail, operator) VALUES ($1,$2,$3)', [action, detail || '', operator || '']);
  } catch (err) { console.error('寫入操作紀錄失敗：', err.message); }
}

// ============================================================
// 主檔 + 指定日期的完整狀態（開站只打這一支）
// ============================================================
// 指定日期的組織架構：到職日之前不出現、離職日當天起不再出現
async function loadRoster(date) {
  const groups = (await pool.query('SELECT * FROM groups WHERE active IS NOT FALSE ORDER BY sort_order, id')).rows;
  const sites = (await pool.query('SELECT name, group_id FROM sites WHERE active IS NOT FALSE ORDER BY sort_order, id')).rows;
  const employees = (await pool.query(
    `SELECT name, group_id, role FROM employees
     WHERE active IS NOT FALSE AND in_roster IS NOT FALSE
       AND (hire_date IS NULL OR hire_date <= $1::date)
       AND (leave_date IS NULL OR leave_date > $1::date)
     ORDER BY sort_order, id`, [date]
  )).rows;

  const warnings = [];
  const groupsData = groups.map((g) => ({
    id: g.id,
    name: g.name,
    managerName: g.manager_name,
    managerTitle: g.manager_title || '',
    sites: sites.filter((s) => s.group_id === g.id).map((s) => s.name),
    members: employees.filter((e) => e.group_id === g.id && e.name !== g.manager_name).map((e) => e.name),
  }));
  sites.filter((s) => !s.group_id).forEach((s) => warnings.push(`案場「${s.name}」沒有對應到任何組別`));
  employees.filter((e) => !e.group_id).forEach((e) => warnings.push(`員工「${e.name}」沒有對應到任何組別`));
  groupsData.filter((g) => !g.sites.length).forEach((g) => warnings.push(`「${g.name}」目前沒有任何案場`));
  return { groupsData, warnings };
}

router.get('/bootstrap', async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const month = (req.query.month || date).slice(0, 7);

    const leaveTypes = (await pool.query('SELECT name FROM leave_types ORDER BY sort_order, id')).rows.map((r) => r.name);
    const tempPool = (await pool.query('SELECT name FROM saved_temp_workers ORDER BY name')).rows.map((r) => r.name);
    const { groupsData, warnings } = await loadRoster(date);

    const day = await loadDay(date);
    const leaves = await loadLeaveMonth(month);

    res.json({
      date, month, groupsData, leaveTypes, savedTempWorkers: tempPool,
      configWarnings: warnings,
      dailyDispatchData: { [date]: day.dispatch },
      dailyTempWorkers: { [date]: day.tempWorkers },
      subcontractData: { [date]: day.subcontracts },
      siteTasks: { [date]: day.tasks },
      versions: day.versions,
      monthlyLeavesDb: { [month]: leaves },
      lastUpdate: day.lastUpdate,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取資料失敗' });
  }
});

// 單一日期的派工（切換日期時只打這一支，資料量固定，不會越用越慢）
router.get('/day', async (req, res) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: '日期格式不正確' });
    const day = await loadDay(date);
    const roster = await loadRoster(date);
    res.json({ date, ...day, groupsData: roster.groupsData, configWarnings: roster.warnings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取當日資料失敗' });
  }
});

async function loadDay(date) {
  const entries = (await pool.query('SELECT * FROM dispatch_entries WHERE work_date = $1', [date])).rows;
  const dayGroups = (await pool.query(
    `SELECT *, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM day_groups WHERE work_date = $1`, [date]
  )).rows;
  const temps = (await pool.query('SELECT * FROM temp_workers WHERE work_date = $1 ORDER BY sort_order, id', [date])).rows;
  const subs = (await pool.query('SELECT * FROM subcontracts WHERE work_date = $1 ORDER BY sort_order, id', [date])).rows;
  const taskRows = (await pool.query('SELECT group_id, site, content FROM site_tasks WHERE work_date = $1', [date])).rows;
  const tasks = {};
  taskRows.forEach((t) => {
    if (!tasks[t.group_id]) tasks[t.group_id] = {};
    tasks[t.group_id][t.site] = t.content;
  });

  const dispatch = {};
  const versions = {};
  const tempWorkers = {};
  const subcontracts = {};

  dayGroups.forEach((dg) => {
    dispatch[dg.group_id] = { managerStatus: null, memberStatus: {}, locked: dg.locked };
    versions[dg.group_id] = { version: Number(dg.version), updatedBy: dg.updated_by, updatedAt: Number(dg.updated_ms) };
  });
  entries.forEach((e) => {
    if (!dispatch[e.group_id]) dispatch[e.group_id] = { managerStatus: null, memberStatus: {}, locked: false };
    const item = {
      status: e.status,
      workRatio: Number(e.work_ratio),
      assignedSite: e.assigned_site || '',
      targetGroupId: e.target_group_id || '',
      leaveType: e.leave_type || '',
    };
    if (e.is_manager) dispatch[e.group_id].managerStatus = { name: e.person_name, title: e.manager_title || '', ...item };
    else dispatch[e.group_id].memberStatus[e.person_name] = item;
  });
  temps.forEach((t) => {
    if (!tempWorkers[t.group_id]) tempWorkers[t.group_id] = [];
    tempWorkers[t.group_id].push({ name: t.name, site: t.site, ratio: Number(t.ratio) });
  });
  subs.forEach((s) => {
    if (!subcontracts[s.group_id]) subcontracts[s.group_id] = [];
    subcontracts[s.group_id].push({ vendor: s.vendor, workItem: s.work_item, site: s.site, count: s.head_count });
  });

  const last = dayGroups.slice().sort((a, b) => Number(b.updated_ms) - Number(a.updated_ms))[0];
  return {
    dispatch, versions, tempWorkers, subcontracts, tasks,
    lastUpdate: last ? { updatedBy: last.updated_by, updatedAt: Number(last.updated_ms) } : null,
  };
}

async function loadLeaveMonth(month) {
  const rows = (await pool.query(
    `SELECT person_name, TO_CHAR(leave_date,'YYYY-MM-DD') AS d, leave_type
     FROM leaves WHERE TO_CHAR(leave_date,'YYYY-MM') = $1`, [month]
  )).rows;
  const out = {};
  rows.forEach((r) => {
    if (!out[r.person_name]) out[r.person_name] = {};
    out[r.person_name][r.d] = r.leave_type;
  });
  return out;
}

router.get('/leaves', async (req, res) => {
  try {
    const month = req.query.month;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: '月份格式不正確' });
    res.json({ month, leaves: await loadLeaveMonth(month) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取排休失敗' });
  }
});

// ============================================================
// 儲存一組一天的派工（衝突偵測只比對這一組這一天）
// body: { phone, date, groupId, version, force, managerStatus, memberStatus, tempWorkers, subcontracts, locked }
// ============================================================
router.put('/day-group', async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { date, groupId, version, force } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: '日期格式不正確' });
    if (!canEditGroup(user, groupId)) {
      return res.status(403).json({ error: 'forbidden', message: `${user.name} 只能編輯自己組別的派工` });
    }

    await client.query('BEGIN');
    const current = (await client.query(
      `SELECT *, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM day_groups
       WHERE work_date = $1 AND group_id = $2 FOR UPDATE`, [date, groupId]
    )).rows[0];

    // 只有「同一組、同一天」被別人改過才算衝突，其他組同時作業互不影響
    if (current && !force && version !== undefined && version !== null && Number(current.version) !== Number(version)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'conflict',
        message: `${current.updated_by || '其他使用者'} 已經更新過這組今天的派工`,
        serverVersion: Number(current.version),
        updatedBy: current.updated_by,
        updatedAt: Number(current.updated_ms),
      });
    }

    if (current && current.locked && req.body.locked !== false && !force) {
      await client.query('ROLLBACK');
      return res.status(423).json({ error: 'locked', message: '這組今天的排班已鎖定，請先解鎖' });
    }

    const nextVersion = current ? Number(current.version) + 1 : 1;
    await client.query(
      `INSERT INTO day_groups (work_date, group_id, locked, version, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,NOW(),$5)
       ON CONFLICT (work_date, group_id) DO UPDATE
         SET locked = EXCLUDED.locked, version = EXCLUDED.version, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [date, groupId, req.body.locked === undefined ? (current ? current.locked : false) : !!req.body.locked, nextVersion, user.name]
    );

    // 派工：整組覆蓋（一組頂多 10 來個人，成本很低，也不會動到別組）
    if (req.body.managerStatus || req.body.memberStatus) {
      await client.query('DELETE FROM dispatch_entries WHERE work_date = $1 AND group_id = $2', [date, groupId]);
      const m = req.body.managerStatus;
      if (m && m.name) {
        await client.query(
          `INSERT INTO dispatch_entries (work_date, group_id, person_name, is_manager, manager_title, status, work_ratio,
             assigned_site, target_group_id, leave_type, updated_by)
           VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (work_date, person_name) DO UPDATE SET group_id = EXCLUDED.group_id, status = EXCLUDED.status,
             work_ratio = EXCLUDED.work_ratio, assigned_site = EXCLUDED.assigned_site,
             target_group_id = EXCLUDED.target_group_id, leave_type = EXCLUDED.leave_type,
             updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [date, groupId, m.name, m.title || '', m.status || 'work', m.workRatio ?? 1,
            m.assignedSite || '', m.targetGroupId || null, m.leaveType || '', user.name]
        );
      }
      for (const [name, s] of Object.entries(req.body.memberStatus || {})) {
        await client.query(
          `INSERT INTO dispatch_entries (work_date, group_id, person_name, is_manager, status, work_ratio,
             assigned_site, target_group_id, leave_type, updated_by)
           VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (work_date, person_name) DO UPDATE SET group_id = EXCLUDED.group_id, status = EXCLUDED.status,
             work_ratio = EXCLUDED.work_ratio, assigned_site = EXCLUDED.assigned_site,
             target_group_id = EXCLUDED.target_group_id, leave_type = EXCLUDED.leave_type,
             updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [date, groupId, name, s.status || 'work', s.workRatio ?? 1,
            s.assignedSite || '', s.targetGroupId || null, s.leaveType || '', user.name]
        );
      }
    }

    if (Array.isArray(req.body.tempWorkers)) {
      await client.query('DELETE FROM temp_workers WHERE work_date = $1 AND group_id = $2', [date, groupId]);
      for (const [i, t] of req.body.tempWorkers.entries()) {
        if (!t || !t.name) continue;
        await client.query(
          'INSERT INTO temp_workers (work_date, group_id, name, site, ratio, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
          [date, groupId, t.name, t.site || '', t.ratio || 1, i]
        );
        await client.query('INSERT INTO saved_temp_workers (name) VALUES ($1) ON CONFLICT DO NOTHING', [t.name]);
      }
    }

    if (req.body.tasks && typeof req.body.tasks === 'object') {
      await client.query('DELETE FROM site_tasks WHERE work_date = $1 AND group_id = $2', [date, groupId]);
      for (const [site, content] of Object.entries(req.body.tasks)) {
        const text = String(content || '').trim();
        if (!text) continue;
        await client.query(
          'INSERT INTO site_tasks (work_date, group_id, site, content) VALUES ($1,$2,$3,$4)',
          [date, groupId, site, text.slice(0, 1000)]
        );
      }
    }

    if (Array.isArray(req.body.subcontracts)) {
      await client.query('DELETE FROM subcontracts WHERE work_date = $1 AND group_id = $2', [date, groupId]);
      for (const [i, s] of req.body.subcontracts.entries()) {
        if (!s || !s.vendor) continue;
        await client.query(
          'INSERT INTO subcontracts (work_date, group_id, vendor, work_item, site, head_count, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [date, groupId, s.vendor, s.workItem || '', s.site || '', parseInt(s.count, 10) || 1, i]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, version: nextVersion, updatedBy: user.name, updatedAt: Date.now() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '儲存失敗' });
  } finally {
    client.release();
  }
});

// 鎖定／解鎖
router.put('/day-group/lock', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { date, groupId, locked } = req.body;
    if (!canEditGroup(user, groupId)) return res.status(403).json({ error: 'forbidden', message: '只能鎖定自己組別的排班' });
    const row = (await pool.query(
      `INSERT INTO day_groups (work_date, group_id, locked, version, updated_at, updated_by)
       VALUES ($1,$2,$3,1,NOW(),$4)
       ON CONFLICT (work_date, group_id) DO UPDATE SET locked = EXCLUDED.locked,
         version = day_groups.version + 1, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING version`, [date, groupId, !!locked, user.name]
    )).rows[0];
    await log(locked ? '鎖定排班' : '解除鎖定', `${date} ${groupId}`, user.name);
    res.json({ ok: true, version: Number(row.version) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '切換鎖定失敗' });
  }
});

// ============================================================
// 排休：整個月、單一個人
// ============================================================
router.put('/leaves', async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { month, personName, leaves } = req.body;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: '月份格式不正確' });
    if (!personName) return res.status(400).json({ error: '請指定姓名' });

    await client.query('BEGIN');
    await client.query(
      `DELETE FROM leaves WHERE person_name = $1 AND TO_CHAR(leave_date,'YYYY-MM') = $2`, [personName, month]
    );
    for (const [date, type] of Object.entries(leaves || {})) {
      if (!type) continue;
      await client.query(
        `INSERT INTO leaves (person_name, leave_date, leave_type, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (person_name, leave_date) DO UPDATE SET leave_type = EXCLUDED.leave_type,
           updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [personName, date, type, user.name]
      );
    }

    // 排休改了之後，順手把「還沒被主管手動調整過」的派工狀態一起校正
    const synced = await resyncDispatchWithLeaves(client, personName, month);
    await client.query('COMMIT');
    await log('儲存排休', `${personName} ${month}（同步派工 ${synced} 筆）`, user.name);
    res.json({ ok: true, syncedDispatch: synced });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '儲存排休失敗' });
  } finally {
    client.release();
  }
});

// 排休異動後同步派工：只動「狀態還停在假別預設值」的資料，主管手動調過的不覆蓋
async function resyncDispatchWithLeaves(client, personName, month) {
  const result = await client.query(
    `UPDATE dispatch_entries e SET
       leave_type = COALESCE(l.leave_type, ''),
       status = CASE
         WHEN e.status = CASE WHEN e.leave_type <> '' THEN 'off' ELSE 'work' END
           THEN CASE WHEN COALESCE(l.leave_type,'') <> '' THEN 'off' ELSE 'work' END
         ELSE e.status END,
       work_ratio = CASE
         WHEN e.status = CASE WHEN e.leave_type <> '' THEN 'off' ELSE 'work' END
           THEN CASE WHEN COALESCE(l.leave_type,'') <> '' THEN 0 ELSE 1 END
         ELSE e.work_ratio END,
       updated_at = NOW()
     FROM (SELECT $1::text AS person_name) x
     LEFT JOIN leaves l ON l.person_name = x.person_name
     WHERE e.person_name = x.person_name
       AND TO_CHAR(e.work_date,'YYYY-MM') = $2
       AND (l.leave_date = e.work_date OR l.leave_date IS NULL)
       AND e.leave_type IS DISTINCT FROM COALESCE(l.leave_type,'')`,
    [personName, month]
  );
  return result.rowCount;
}

// 批量匯入排休（Excel）：一次多人
router.put('/leaves/bulk', async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { month, people } = req.body;   // people = { 姓名: { 'YYYY-MM-DD': '假別' } }
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: '月份格式不正確' });

    await client.query('BEGIN');
    let count = 0;
    for (const [name, days] of Object.entries(people || {})) {
      await client.query(`DELETE FROM leaves WHERE person_name = $1 AND TO_CHAR(leave_date,'YYYY-MM') = $2`, [name, month]);
      for (const [date, type] of Object.entries(days || {})) {
        if (!type) continue;
        await client.query(
          `INSERT INTO leaves (person_name, leave_date, leave_type, updated_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (person_name, leave_date) DO UPDATE SET leave_type = EXCLUDED.leave_type, updated_by = EXCLUDED.updated_by`,
          [name, date, type, user.name]
        );
      }
      await resyncDispatchWithLeaves(client, name, month);
      count++;
    }
    await client.query('COMMIT');
    await log('批量匯入排休', `${month}　${count} 人`, user.name);
    res.json({ ok: true, count });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '批量匯入失敗' });
  } finally {
    client.release();
  }
});

// ============================================================
// 匯出：給 Google 試算表用 IMPORTDATA 自動抓取的 CSV
// ============================================================
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_TEXT = {
  work: '出勤 (1工)', half: '半天 (0.5工)', borrow: '外借支援', ot1: '加班 (1工)', ot15: '加班 (1.5工)', off: '休假',
};

router.get('/export/dispatch.csv', async (req, res) => {
  try {
    if (!checkExportToken(req, res)) return;
    const days = Math.min(parseInt(req.query.days, 10) || 90, 400);
    const rows = (await pool.query(
      `SELECT TO_CHAR(e.work_date,'YYYY-MM-DD') AS d, g.name AS group_name, e.person_name, e.is_manager,
              e.status, e.work_ratio, e.assigned_site, e.leave_type, tg.name AS target_group,
              TO_CHAR(e.updated_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS updated, e.updated_by
       FROM dispatch_entries e JOIN groups g ON g.id = e.group_id
       LEFT JOIN groups tg ON tg.id = e.target_group_id
       WHERE e.work_date >= CURRENT_DATE - $1::int
       ORDER BY e.work_date DESC, g.sort_order, e.is_manager DESC, e.person_name`, [days]
    )).rows;
    const out = [['日期', '組別', '姓名', '身份', '狀態', '工數', '派往案場', '外借至', '原排假別', '更新時間', '更新人']];
    rows.forEach((r) => out.push([
      r.d, r.group_name, r.person_name, r.is_manager ? '主管' : '組員',
      STATUS_TEXT[r.status] || r.status, Number(r.work_ratio), r.assigned_site,
      r.target_group || '', r.leave_type || '', r.updated, r.updated_by,
    ]));
    sendCsv(res, out, 'dispatch.csv');
  } catch (err) {
    console.error(err);
    res.status(500).send('匯出失敗');
  }
});

router.get('/export/leaves.csv', async (req, res) => {
  try {
    if (!checkExportToken(req, res)) return;
    const rows = (await pool.query(
      `SELECT person_name, TO_CHAR(leave_date,'YYYY-MM') AS ym, TO_CHAR(leave_date,'YYYY-MM-DD') AS d,
              leave_type, TO_CHAR(updated_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS updated, updated_by
       FROM leaves ORDER BY leave_date DESC, person_name`
    )).rows;
    const out = [['姓名', '年月', '日期', '假別', '更新時間', '更新人']];
    rows.forEach((r) => out.push([r.person_name, r.ym, r.d, r.leave_type, r.updated, r.updated_by]));
    sendCsv(res, out, 'leaves.csv');
  } catch (err) {
    console.error(err);
    res.status(500).send('匯出失敗');
  }
});

// 每日工數彙總（案場 × 日期），方便試算表做成本分析
router.get('/export/summary.csv', async (req, res) => {
  try {
    if (!checkExportToken(req, res)) return;
    const days = Math.min(parseInt(req.query.days, 10) || 90, 400);
    const rows = (await pool.query(
      `SELECT TO_CHAR(work_date,'YYYY-MM-DD') AS d, assigned_site AS site, g.name AS group_name,
              SUM(work_ratio) AS own_ratio, COUNT(*) FILTER (WHERE status = 'off') AS off_count
       FROM dispatch_entries e JOIN groups g ON g.id = e.group_id
       WHERE work_date >= CURRENT_DATE - $1::int AND status <> 'off'
       GROUP BY 1,2,3 ORDER BY 1 DESC, 2`, [days]
    )).rows;
    const temps = (await pool.query(
      `SELECT TO_CHAR(work_date,'YYYY-MM-DD') AS d, site, SUM(ratio) AS ratio
       FROM temp_workers WHERE work_date >= CURRENT_DATE - $1::int GROUP BY 1,2`, [days]
    )).rows;
    const subs = (await pool.query(
      `SELECT TO_CHAR(work_date,'YYYY-MM-DD') AS d, site, SUM(head_count) AS cnt
       FROM subcontracts WHERE work_date >= CURRENT_DATE - $1::int GROUP BY 1,2`, [days]
    )).rows;
    const out = [['日期', '案場', '組別', '本工工數', '點工工數', '發包人數']];
    rows.forEach((r) => {
      const t = temps.find((x) => x.d === r.d && x.site === r.site);
      const s = subs.find((x) => x.d === r.d && x.site === r.site);
      out.push([r.d, r.site, r.group_name, Number(r.own_ratio), t ? Number(t.ratio) : 0, s ? Number(s.cnt) : 0]);
    });
    sendCsv(res, out, 'summary.csv');
  } catch (err) {
    console.error(err);
    res.status(500).send('匯出失敗');
  }
});

function checkExportToken(req, res) {
  const expected = process.env.EXPORT_TOKEN || '';
  if (!expected) { res.status(503).send('尚未設定 EXPORT_TOKEN'); return false; }
  if (req.query.token !== expected) { res.status(401).send('token 不正確'); return false; }
  return true;
}

function sendCsv(res, rows, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + rows.map((r) => r.map(csvEscape).join(',')).join('\n'));
}

// ============================================================
// 主檔維護（組別／案場／員工／假別／手機）
// ============================================================
router.get('/masters', async (req, res) => {
  try {
    res.json({
      groups: (await pool.query('SELECT * FROM groups ORDER BY sort_order, id')).rows,
      sites: (await pool.query('SELECT * FROM sites ORDER BY sort_order, id')).rows,
      employees: (await pool.query('SELECT * FROM employees ORDER BY sort_order, id')).rows,
      leaveTypes: (await pool.query('SELECT * FROM leave_types ORDER BY sort_order, id')).rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取主檔失敗' });
  }
});

// ============================================================
// 人員與組織管理（僅限 admin：總經理、人資）
// ============================================================
async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { res.status(403).json({ error: 'forbidden', message: '只有管理者可以維護人員與組織' }); return null; }
  return user;
}

router.get('/admin/people', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const employees = (await pool.query(
      `SELECT id, name, group_id, phone, role, title, in_roster, active, note,
              TO_CHAR(hire_date,'YYYY-MM-DD') AS hire_date, TO_CHAR(leave_date,'YYYY-MM-DD') AS leave_date,
              (SELECT COUNT(*)::int FROM dispatch_entries d WHERE d.person_name = e.name) AS dispatch_count
       FROM employees e ORDER BY active DESC, sort_order, id`
    )).rows.map((e) => ({
      ...e,
      state: !e.active ? 'deleted'
        : (e.leave_date && e.leave_date <= today) ? 'left'
        : (e.hire_date && e.hire_date > today) ? 'upcoming'
        : 'active',
    }));
    const groups = (await pool.query('SELECT * FROM groups ORDER BY sort_order, id')).rows;
    const sites = (await pool.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM dispatch_entries d WHERE d.assigned_site = s.name) AS used_count
       FROM sites s ORDER BY s.active DESC, s.sort_order, s.id`
    )).rows;
    const leaveTypes = (await pool.query('SELECT * FROM leave_types ORDER BY sort_order, id')).rows;
    res.json({ employees, groups, sites, leaveTypes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取失敗' });
  }
});

function cleanDate(v) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }

// 新增人員（入職）
async function phoneTaken(phone, exceptId) {
  const p = normPhone(phone);
  if (!p) return null;
  return (await pool.query(
    `SELECT name FROM employees WHERE REGEXP_REPLACE(COALESCE(phone,''),'[^0-9]','','g') = $1 AND id <> $2 LIMIT 1`,
    [p, exceptId || 0]
  )).rows[0] || null;
}

router.post('/admin/employees', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const dup = await phoneTaken(req.body.employee_phone);
    if (dup) return res.status(400).json({ error: `這組手機已經是 ${dup.name} 在使用` });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '請填寫姓名' });
    const inRoster = req.body.in_roster !== false;
    if (inRoster && !req.body.group_id) return res.status(400).json({ error: '要排班的同仁請選擇組別' });
    const maxSort = (await pool.query('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM employees')).rows[0].m;
    const row = (await pool.query(
      `INSERT INTO employees (name, group_id, phone, role, title, hire_date, in_roster, note, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, req.body.group_id || null, normPhone(req.body.employee_phone), req.body.role || 'member',
        (req.body.title || '').trim(), cleanDate(req.body.hire_date), inRoster, (req.body.note || '').trim(), maxSort + 1]
    )).rows[0];
    await log('新增人員', `${name}　${req.body.group_id || '不排班'}　到職 ${req.body.hire_date || '即日'}`, user.name);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '已經有同名的人員了（同名同姓請加註區別，例如「王小明B」）' });
    console.error(err);
    res.status(500).json({ error: '新增失敗' });
  }
});

// 修改人員（調組、改職稱、改手機、改權限）
router.put('/admin/employees/:id', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const cur = (await pool.query('SELECT * FROM employees WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: '找不到這位人員' });
    const b = req.body;
    if (b.employee_phone) {
      const dup = await phoneTaken(b.employee_phone, cur.id);
      if (dup) return res.status(400).json({ error: `這組手機已經是 ${dup.name} 在使用` });
    }
    // 防止管理者把自己降級後把自己鎖在門外
    if (cur.name === user.name && b.role && b.role !== 'admin') {
      return res.status(400).json({ error: '不能移除自己的管理者權限，請由另一位管理者操作' });
    }
    const row = (await pool.query(
      `UPDATE employees SET group_id=$1, phone=$2, role=$3, title=$4, hire_date=$5, in_roster=$6, note=$7
       WHERE id=$8 RETURNING *`,
      [b.group_id === undefined ? cur.group_id : (b.group_id || null),
        b.employee_phone === undefined ? cur.phone : normPhone(b.employee_phone),
        b.role || cur.role, b.title === undefined ? cur.title : b.title,
        b.hire_date === undefined ? cur.hire_date : cleanDate(b.hire_date),
        b.in_roster === undefined ? cur.in_roster : !!b.in_roster,
        b.note === undefined ? cur.note : b.note, req.params.id]
    )).rows[0];
    const changes = [];
    if (cur.group_id !== row.group_id) changes.push(`組別 ${cur.group_id || '無'} → ${row.group_id || '無'}`);
    if (cur.role !== row.role) changes.push(`權限 ${cur.role} → ${row.role}`);
    if ((cur.phone || '') !== (row.phone || '')) changes.push('手機已更新');
    await log('修改人員', `${row.name}　${changes.join('、') || '基本資料'}`, user.name);
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 離職：設定離職日，當天起不再出現在派工與排休名單；歷史紀錄完整保留
router.put('/admin/employees/:id/leave', async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const leaveDate = cleanDate(req.body.leave_date);
    if (!leaveDate) return res.status(400).json({ error: '請選擇離職日' });
    await client.query('BEGIN');
    const row = (await client.query(
      `UPDATE employees SET leave_date = $1, phone = CASE WHEN $2 THEN '' ELSE phone END WHERE id = $3 RETURNING *`,
      [leaveDate, req.body.clear_phone !== false, req.params.id]
    )).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到這位人員' }); }
    // 離職日之後已經排好的派工與排休一併清掉，免得名單外的人還佔著工數
    const d = await client.query('DELETE FROM dispatch_entries WHERE person_name = $1 AND work_date >= $2', [row.name, leaveDate]);
    const l = await client.query('DELETE FROM leaves WHERE person_name = $1 AND leave_date >= $2', [row.name, leaveDate]);
    await client.query('COMMIT');
    await log('設定離職', `${row.name}　離職日 ${leaveDate}（清除之後派工 ${d.rowCount} 筆、排休 ${l.rowCount} 筆）`, user.name);
    res.json({ ok: true, removedDispatch: d.rowCount, removedLeaves: l.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '設定離職失敗' });
  } finally {
    client.release();
  }
});

// 取消離職（回任或設錯）
router.put('/admin/employees/:id/rehire', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const row = (await pool.query('UPDATE employees SET leave_date = NULL, active = true WHERE id = $1 RETURNING name', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這位人員' });
    await log('取消離職', row.name, user.name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失敗' });
  }
});

// 刪除：只有「從來沒有派工紀錄」的人（建錯資料）才能刪；有紀錄的請用離職
router.delete('/admin/employees/:id', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const row = (await pool.query('SELECT name FROM employees WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這位人員' });
    const used = (await pool.query('SELECT COUNT(*)::int AS c FROM dispatch_entries WHERE person_name = $1', [row.name])).rows[0].c;
    if (used) return res.status(400).json({ error: `${row.name} 已經有 ${used} 筆派工紀錄，請改用「設定離職」保留歷史` });
    const isManager = (await pool.query('SELECT 1 FROM groups WHERE manager_name = $1', [row.name])).rows.length;
    if (isManager) return res.status(400).json({ error: `${row.name} 目前是組別主管，請先更換該組主管` });
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    await log('刪除人員', row.name, user.name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 組別：新增、改名、換主管
router.post('/admin/groups', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const name = (req.body.name || '').trim();
    const manager = (req.body.manager_name || '').trim();
    if (!name || !manager) return res.status(400).json({ error: '請填寫組別名稱與主管' });
    const id = 'g' + Date.now().toString(36);
    const maxSort = (await pool.query('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM groups')).rows[0].m;
    await pool.query(
      'INSERT INTO groups (id, name, manager_name, manager_title, sort_order) VALUES ($1,$2,$3,$4,$5)',
      [id, name, manager, (req.body.manager_title || '').trim(), maxSort + 1]
    );
    await pool.query(`UPDATE employees SET group_id = $1, role = CASE WHEN role = 'admin' THEN role ELSE 'manager' END WHERE name = $2`, [id, manager]);
    await log('新增組別', `${name}（主管 ${manager}）`, user.name);
    res.status(201).json({ ok: true, id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '已經有同名的組別了' });
    console.error(err);
    res.status(500).json({ error: '新增組別失敗' });
  }
});

router.put('/admin/groups/:id', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const cur = (await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: '找不到這個組別' });
    const name = (req.body.name || cur.name).trim();
    const manager = (req.body.manager_name || cur.manager_name).trim();
    const title = req.body.manager_title === undefined ? cur.manager_title : req.body.manager_title;
    const active = req.body.active === undefined ? cur.active : !!req.body.active;
    await pool.query('UPDATE groups SET name=$1, manager_name=$2, manager_title=$3, active=$4 WHERE id=$5',
      [name, manager, title, active, req.params.id]);
    if (manager !== cur.manager_name) {
      // 新主管併入本組並取得主管權限；舊主管降為組員（仍留在本組，要調走再到人員頁調整）
      await pool.query(`UPDATE employees SET group_id = $1, role = CASE WHEN role = 'admin' THEN role ELSE 'manager' END WHERE name = $2`, [req.params.id, manager]);
      await pool.query(`UPDATE employees SET role = 'member' WHERE name = $1 AND role = 'manager'`, [cur.manager_name]);
    }
    await log('修改組別', `${cur.name}${manager !== cur.manager_name ? `　主管 ${cur.manager_name} → ${manager}` : ''}`, user.name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '修改組別失敗' });
  }
});

// 案場：新增、改組、結案（停用後不再出現在下拉，但歷史紀錄保留）
router.post('/admin/sites', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const name = (req.body.name || '').trim();
    if (!name || !req.body.group_id) return res.status(400).json({ error: '請填寫案場名稱與負責組別' });
    await pool.query(
      `INSERT INTO sites (name, group_id, sort_order) VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM sites))
       ON CONFLICT (name, group_id) DO UPDATE SET active = true`, [name, req.body.group_id]
    );
    await log('新增案場', `${name}（${req.body.group_id}）`, user.name);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '新增案場失敗' });
  }
});

router.put('/admin/sites/:id', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const cur = (await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: '找不到這個案場' });
    await pool.query('UPDATE sites SET name=$1, group_id=$2, active=$3 WHERE id=$4', [
      (req.body.name || cur.name).trim(), req.body.group_id || cur.group_id,
      req.body.active === undefined ? cur.active : !!req.body.active, req.params.id,
    ]);
    await log(req.body.active === false ? '案場結案' : '修改案場', cur.name, user.name);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '這個組別已經有同名案場了' });
    console.error(err);
    res.status(500).json({ error: '修改案場失敗' });
  }
});

router.get('/admin/logs', async (req, res) => {
  try {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const rows = (await pool.query(
      `SELECT action, detail, operator, TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS t
       FROM audit_logs ORDER BY id DESC LIMIT 200`
    )).rows;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取失敗' });
  }
});

router.put('/employees/:name/phone', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin' && user.name !== req.params.name) {
      return res.status(403).json({ error: '只有管理者可以修改其他人的手機' });
    }
    const row = (await pool.query('UPDATE employees SET phone = $1 WHERE name = $2 RETURNING name, phone',
      [normPhone(req.body.newPhone), req.params.name])).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這位同仁' });
    await log('更新手機', `${row.name}`, user.name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失敗' });
  }
});

module.exports = router;
