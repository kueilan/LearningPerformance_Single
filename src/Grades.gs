/**
 * ============================================================
 * 成績登錄 (Grades.gs) — M4
 * 規格書 4.2-1 / 4.2-2；PLAN.md §4 F4
 *
 * 決策：
 *   D4  先載入原成績 → 僅存變動 → 一次批次寫入
 *   D7  成績唯一鍵 Ysem + Subject + Exam_Date + Exam_Scope + Student_ID
 *   D8  場次鍵 Subject + Exam_Date + Exam_Scope
 *   D9  分數留空 = 刪除該筆成績（畫面即最終狀態）
 *   D12 分數僅整數 0–100（前端擋一次、後端再驗一次）
 *   權限：小老師僅能操作「本人科目 + 本人學期」，後端強制
 * ============================================================
 */

/**
 * 考試日期字串化（相容 Date 物件與 ISO 字串）。
 * @param {*} v
 * @return {string} YYYY-MM-DD
 */
function examDateStr_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return s.substring(0, 10);
  return s;
}

/**
 * 驗證並正規化考試日期。
 * @param {*} v
 * @return {string} YYYY-MM-DD
 */
function normalizeExamDate_(v) {
  const s = examDateStr_(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('考試日期格式錯誤，需為 YYYY-MM-DD（例：2026-09-27）');
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error('考試日期「' + s + '」不存在，請重新選擇');
  }
  return s;
}

/**
 * 正規化考試範圍。
 * 規格 4.1-3／4.2-2：考試範圍**可空白**（僅日期必填），故不驗必填。
 * @param {*} v
 * @return {string}
 */
function normalizeExamScope_(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > 60) throw new Error('考試範圍過長（上限 60 字）');
  return s;
}

/**
 * 驗證分數：留空回傳 null（＝刪除），否則回傳 0–100 整數。
 * @param {*} v
 * @return {number|null}
 */
function normalizeScore_(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (!/^\d{1,3}$/.test(s)) {
    throw new Error('分數「' + s + '」無效：只能是 0–100 的整數（或留空表示刪除）');
  }
  const n = Number(s);
  if (n > 100) {
    throw new Error('分數「' + s + '」超出範圍：只能是 0–100 的整數');
  }
  return n;
}

/**
 * 把呼叫端傳入的科目代碼解析為該學期「科目清單上的正式代碼」。
 * 若該學期已建立科目清單，卻查無此科目 → 拒絕（清單為唯一真相，D14）。
 *
 * @param {string} ysem
 * @param {string} subject 短碼 (Chi) 或複合碼 (1151_Chi)
 * @return {string} 正式短代碼
 */
function resolveSubject_(ysem, subject) {
  const code = subjectCodeOf_(subject);
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(code)) {
    throw new Error('請先選擇科目');
  }
  const rows = readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA);
  let canonical = null;
  let semesterHasSubjects = false;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].Ysem).trim() !== ysem) continue;
    semesterHasSubjects = true;
    const c = subjectCodeOf_(rows[i].Subject);
    if (c.toUpperCase() === code.toUpperCase()) canonical = c;
  }
  if (canonical) return canonical;
  if (semesterHasSubjects) {
    throw new Error('科目「' + code + '」不在 ' + ysem + ' 學期的科目清單，請先於「學期 / TA 密碼」維護');
  }
  return code; // 該學期尚未建立科目清單（允許先補登成績）
}

/**
 * 後端權限閘道：小老師僅能操作本人學期 + 本科。
 * @param {Object} ctx
 * @param {string} ysem
 * @param {string} code 已正規化的科目短代碼
 */
function assertExamAccess_(ctx, ysem, code) {
  if (!ctx || ctx.role === 'admin') return;
  if (ctx.role !== 'ta') throw new Error('權限不足，無法登錄成績');
  if (String(ctx.ysem) !== String(ysem)) {
    throw new Error('小老師僅能操作 ' + ctx.ysem + ' 學期的成績');
  }
  const mine = String(ctx.subjectCode || '').toUpperCase();
  if (!mine || mine !== String(code).toUpperCase()) {
    throw new Error('小老師僅能登錄本科（' + (ctx.subjectNA || ctx.subjectCode) + '）的成績');
  }
}

/**
 * 該科既有場次清單（供下拉載入），由舊到新。
 *
 * @param {Object} ctx
 * @param {string} ysem
 * @param {string} subject
 * @return {Object[]} [{examDate, examScope, count, avg}]
 */
function listExams_(ctx, ysem, subject) {
  ysem = String(ysem == null ? '' : ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');
  assertExamAccess_(ctx, ysem, subjectCodeOf_(subject)); // 先驗權限，再查科目清單
  const code = resolveSubject_(ysem, subject);
  assertExamAccess_(ctx, ysem, code);
  const up = code.toUpperCase();

  const groups = {};
  readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    if (subjectCodeOf_(String(r.Subject)).toUpperCase() !== up) return;
    const date = examDateStr_(r.Exam_Date);
    const scope = String(r.Exam_Scope == null ? '' : r.Exam_Scope).trim();
    if (!date) return; // 範圍可空白（規格 4.1-3），僅日期為場次必備
    const key = date + '\u0001' + scope;
    if (!groups[key]) groups[key] = { examDate: date, examScope: scope, scores: [] };
    const raw = r.Score;
    if (raw === '' || raw === null || raw === undefined) return;
    const n = Number(raw);
    if (isFinite(n)) groups[key].scores.push(n);
  });

  return Object.keys(groups).map(function (k) {
    const g = groups[k];
    const n = g.scores.length;
    const sum = g.scores.reduce(function (a, b) { return a + b; }, 0);
    return {
      examDate: g.examDate,
      examScope: g.examScope,
      count: n,
      avg: n ? Math.round((sum / n) * 10) / 10 : null
    };
  }).sort(function (a, b) {
    return a.examDate === b.examDate
      ? (a.examScope < b.examScope ? -1 : 1)
      : (a.examDate < b.examDate ? -1 : 1);
  });
}

/**
 * 讀取該場次的分數（studentId → score，null 表示空分數列）。
 * 同一生有多列時以「最後一列」為準（與 saveExam_ 的清理邏輯一致）。
 *
 * @param {string} ysem
 * @param {string} code 科目短代碼
 * @param {string} examDate YYYY-MM-DD
 * @param {string} examScope
 * @return {Object}
 */
function readExamScores_(ysem, code, examDate, examScope) {
  const up = code.toUpperCase();
  const scores = {};
  readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    if (subjectCodeOf_(String(r.Subject)).toUpperCase() !== up) return;
    if (examDateStr_(r.Exam_Date) !== examDate) return;
    if (String(r.Exam_Scope == null ? '' : r.Exam_Scope).trim() !== examScope) return;
    const id = String(r.Student_ID).trim();
    if (!id) return;
    const raw = r.Score;
    scores[id] = (raw === '' || raw === null || raw === undefined) ? null : Number(raw);
  });
  return scores;
}

/**
 * 以名單為底，合併該場次分數 → 表格列（座號升冪）。
 *
 * @param {string} ysem
 * @param {Object} scoresById studentId → score|null
 * @param {Object[]=} optRoster 已讀好的名單（省一次讀取）
 * @return {Object[]}
 */
function buildExamRows_(ysem, scoresById, optRoster) {
  const roster = optRoster || readRoster_(ysem);
  const seen = {};
  const rows = roster.map(function (s) {
    seen[s.studentId] = true;
    const has = Object.prototype.hasOwnProperty.call(scoresById, s.studentId);
    return {
      seatNo: s.seatNo,
      studentId: s.studentId,
      name: s.name,
      score: has ? scoresById[s.studentId] : null
    };
  });

  // 名單上已沒有、但成績仍存在的學生（名單調整過）→ 一併列出，避免成績被漏看
  Object.keys(scoresById).forEach(function (id) {
    if (seen[id]) return;
    rows.push({ seatNo: 0, studentId: id, name: '（不在名單）', score: scoresById[id] });
  });
  rows.sort(function (a, b) { return a.seatNo - b.seatNo; });
  return rows;
}

/**
 * 載入單一场次的全班成績（以名單為底，未登分者為 null）。
 * @param {Object} ctx
 * @param {string} ysem
 * @param {string} subject
 * @param {string} examDate
 * @param {string} examScope
 * @return {{examDate:string, examScope:string, subject:string, subjectNA:string, rows:Object[]}}
 */
function getExam_(ctx, ysem, subject, examDate, examScope) {
  ysem = String(ysem == null ? '' : ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');
  assertExamAccess_(ctx, ysem, subjectCodeOf_(subject)); // 先驗權限，再查科目清單
  const code = resolveSubject_(ysem, subject);
  assertExamAccess_(ctx, ysem, code);
  const date = normalizeExamDate_(examDate);
  const scope = normalizeExamScope_(examScope);

  return {
    examDate: date,
    examScope: scope,
    subject: code,
    subjectNA: subjectNA_(ysem, code),
    rows: buildExamRows_(ysem, readExamScores_(ysem, code, date, scope))
  };
}

/**
 * 由下往上刪除連續列（合併成一次 deleteRow 迴圈）。
 * @param {Sheet} sh
 * @param {number[]} rows 1-based 列號（可不連續、可重複內容列）
 */
function deleteRowsByNo_(sh, rows) {
  if (!rows.length) return;
  const sorted = rows.slice().sort(function (a, b) { return b - a; }); // 由大到小
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] - 1) j++;
    const start = sorted[j];      // 該連續段最小列號
    const n = j - i + 1;
    for (let k = 0; k < n; k++) sh.deleteRow(start);
    i = j + 1;
  }
}

/**
 * 儲存場次成績（規格書 4.2-2；D4 diff、D9 清空＝刪除）。
 *
 * 以「呼叫端送來的完整最終狀態」為準：
 *   - 分數不同 → 更新（整列重寫，含座號/姓名同步）
 *   - 原無此次有 → 新增
 *   - 原有此次留空 → 刪除
 *   - 該場次存在但本次未送出的學生 → 刪除（畫面即最終狀態）
 * 全程於寫入鎖內重讀現況再比對，避免覆蓋他人並發輸入。
 *
 * @param {Object} ctx
 * @param {Object} payload {ysem, subject, examDate, examScope, rows:[{studentId, score}]}
 * @return {Object} {added, changed, removed, count, avg, max, min, examDate, examScope, subject, subjectNA}
 */
function saveExam_(ctx, payload) {
  payload = payload || {};
  const ysem = String(payload.ysem == null ? '' : payload.ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');

  assertExamAccess_(ctx, ysem, subjectCodeOf_(payload.subject)); // 先驗權限，再查科目清單
  const code = resolveSubject_(ysem, payload.subject);
  assertExamAccess_(ctx, ysem, code);

  const examDate = normalizeExamDate_(payload.examDate);
  const examScope = normalizeExamScope_(payload.examScope);

  const list = payload.rows;
  if (!Array.isArray(list) || !list.length) throw new Error('沒有可儲存的成績資料');
  if (list.length > 500) throw new Error('單次最多儲存 500 筆');

  const roster = readRoster_(ysem);
  const rosterById = {};
  roster.forEach(function (r) { rosterById[r.studentId] = r; });

  const incoming = {};
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const id = String(r.studentId == null ? '' : r.studentId).trim();
    if (!id) throw new Error('第 ' + (i + 1) + ' 筆缺少學號');
    if (Object.prototype.hasOwnProperty.call(incoming, id)) {
      throw new Error('學號 ' + id + ' 重複出現，請重新整理後再試');
    }
    if (roster.length && !rosterById[id]) {
      throw new Error('學號 ' + id + ' 不在 ' + ysem + ' 學期名單中，請重新整理');
    }
    incoming[id] = { score: normalizeScore_(r.score) }; // 會在這裡擋掉非 0–100 整數
  }

  const sh = getSheet_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES);
  const cols = CFG.HEADERS.GRADES.length;
  const up = code.toUpperCase();
  let added = 0, updated = 0, removed = 0, deduped = 0;
  const finalScores = {};

  withWriteLock_(function () {
    const values = sh.getDataRange().getValues(); // 鎖內重讀（不依賴快取）
    const cur = {}; // studentId → [{row, score}]（同一生可能有多列，依表單順序）

    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (String(v[0]).trim() !== ysem) continue;
      if (subjectCodeOf_(String(v[4])).toUpperCase() !== up) continue;
      if (examDateStr_(v[5]) !== examDate) continue;
      if (String(v[7] == null ? '' : v[7]).trim() !== examScope) continue;
      const id = String(v[2]).trim();
      if (!id) continue;
      if (!cur[id]) cur[id] = [];
      cur[id].push({
        row: i + 1,
        score: (v[6] === '' || v[6] === null || v[6] === undefined) ? null : Number(v[6])
      });
    }

    const appends = [], updates = [], deletes = [];

    Object.keys(incoming).forEach(function (id) {
      const inc = incoming[id];
      const rowsOf = cur[id] || [];
      const meta = rosterById[id];

      if (inc.score === null) {           // D9：留空 → 刪除（含重複列）
        rowsOf.forEach(function (r) { deletes.push(r.row); removed++; });
        return;
      }
      finalScores[id] = inc.score;

      const rowVals = [
        ysem,
        meta ? meta.seatNo : 0,
        id,
        meta ? meta.name : '',
        code,
        examDate,
        inc.score,
        examScope
      ];

      if (!rowsOf.length) {
        appends.push(rowVals);
        added++;
        return;
      }

      // 同一生只保留最後一列（與讀取端 last-wins 一致），其餘重複資料一併清掉
      const primary = rowsOf[rowsOf.length - 1];
      for (let k = 0; k < rowsOf.length - 1; k++) { deletes.push(rowsOf[k].row); deduped++; }

      if (primary.score !== inc.score) {  // 整列重寫，座號/姓名一併同步
        updates.push({ row: primary.row, vals: rowVals });
        updated++;
      }
    });

    // 畫面即最終狀態：該場次有、但本次未送出的學生 → 刪除
    Object.keys(cur).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(incoming, id)) return;
      cur[id].forEach(function (r) { deletes.push(r.row); removed++; });
    });

    if (!appends.length && !updates.length && !deletes.length) return; // 無變動

    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, cols).setValues(appends);
    }
    // 注意：多欄範圍必須用 setValues（setValue 會把整列填成第一個值）
    updates.forEach(function (u) { sh.getRange(u.row, 1, 1, cols).setValues([u.vals]); });
    deleteRowsByNo_(sh, deletes);
  });

  // 寫入後重讀（withWriteLock_ 已清空讀取記憶體）→ 回傳「表裡實際狀態」給前端直接渲染
  const finalRows = buildExamRows_(ysem, readExamScores_(ysem, code, examDate, examScope), roster);

  // 交付前核對：送出的分數必須真的落在表裡（若欄位被手動移動/修改會在此現形）
  const scoreById = {};
  finalRows.forEach(function (r) { scoreById[r.studentId] = r.score; });
  const mismatch = Object.keys(incoming).filter(function (id) {
    const s = incoming[id].score;
    return s !== null && scoreById[id] !== s;
  });
  if (mismatch.length) {
    throw new Error('儲存後核對失敗：學號 ' + mismatch[0] + ' 送出的分數與 Grades 表不一致，' +
      '請檢查 Grades 工作表的欄位是否被手動移動或修改（資料已寫入，此為異常警告）');
  }

  const scores = Object.keys(finalScores).map(function (k) { return finalScores[k]; });
  const n = scores.length;
  const sum = scores.reduce(function (a, b) { return a + b; }, 0);

  return {
    added: added,
    changed: updated,   // 規格書 F4-e 的 changed（分數更新筆數）
    updated: updated,
    removed: removed,
    deduped: deduped,
    count: n,
    avg: n ? Math.round((sum / n) * 10) / 10 : null,
    max: n ? Math.max.apply(null, scores) : null,
    min: n ? Math.min.apply(null, scores) : null,
    examDate: examDate,
    examScope: examScope,
    subject: code,
    subjectNA: subjectNA_(ysem, code),
    rows: finalRows
  };
}
