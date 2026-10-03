/**
 * ============================================================
 * 學期 / 名單 (Setup.gs)
 * - 導師建立學年學期與 8 科 TA 密碼
 * - 學期清單、班級名單讀取
 * - 一次性初始化工具函式（於指令碼編輯器執行）
 * ============================================================
 */

/** 隨機字元池：剔除易混淆的 0 o l 1 i (決策 D11) */
const TA_ALPHABET_ = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * 產生 4 碼隨機小寫英數。
 * @return {string}
 */
function randomTail_() {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += TA_ALPHABET_.charAt(Math.floor(Math.random() * TA_ALPHABET_.length));
  }
  return s;
}

/**
 * 解析科目清單文字（規格書 §2 可自訂）。
 * 格式：每行「代碼, 中文名稱」，例：Chi, 國文
 * 會自動處理全形逗號、空白行、CRLF。
 *
 * @param {string} text 使用者貼上的內容
 * @return {Object[]} [{code, na}]
 */
function parseSubjects_(text) {
  text = String(text == null ? '' : text);
  const out = [];
  const seen = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].replace(/，/g, ',').trim();
    if (!line) continue; // 空行略過

    const p = line.indexOf(',');
    if (p < 0) throw new Error('第 ' + lineNo + ' 列格式錯誤：需為「代碼, 中文名稱」（例：Chi, 國文）');

    const code = line.substring(0, p).trim();
    const na = line.substring(p + 1).trim();

    if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(code)) {
      throw new Error('第 ' + lineNo + ' 列代碼「' + code + '」無效：需為英文字母開頭的英數字（1–16 碼，不可含底線或逗號）');
    }
    if (!na) throw new Error('第 ' + lineNo + ' 列缺少科目名稱');
    if (na.length > 20) throw new Error('第 ' + lineNo + ' 列科目名稱過長（上限 20 字）');

    const key = code.toUpperCase();
    if (seen[key]) throw new Error('第 ' + lineNo + ' 列代碼「' + code + '」與第 ' + seen[key] + ' 列重複');
    seen[key] = lineNo;

    out.push({ code: code, na: na });
    if (out.length > 50) throw new Error('科目數量過多（上限 50 科）');
  }

  if (!out.length) throw new Error('科目清單不可為空');
  return out;
}

/**
 * 以「貼上的清單」為準，規劃該學期的科目變更（純計算、不寫入）。
 * 新名單為唯一真相：清單中沒有的既有科目 → 列入刪除。
 *
 * @param {Object[]} values Semester_TA_List 整表值
 * @param {string} ysem 學年學期
 * @param {Object[]} list 解析後的科目 [{code, na}]
 * @return {{creates:Object[], renames:Object[], deletes:Object[]}}
 */
function planSubjectChanges_(values, ysem, list) {
  const byCode = {}; // 鍵＝代碼大寫
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() !== ysem) continue;
    const subject = String(values[i][1]).trim();
    byCode[subjectCodeOf_(subject).toUpperCase()] = {
      row: i + 1,              // Sheet 實際列號
      subject: subject,
      na: String(values[i][2]).trim()
    };
  }

  const creates = [], renames = [], deletes = [];
  const listed = {};
  list.forEach(function (s) {
    const key = s.code.toUpperCase();
    const composite = ysem + '_' + s.code;
    listed[key] = true;
    const hit = byCode[key];
    if (!hit) {
      creates.push({ code: s.code, na: s.na });
    } else if (hit.na !== s.na || hit.subject !== composite) {
      renames.push({ row: hit.row, oldSubject: hit.subject, subjectNew: composite, code: s.code, oldNA: hit.na, na: s.na });
    }
  });

  Object.keys(byCode).forEach(function (key) {
    if (listed[key]) return;
    deletes.push({
      row: byCode[key].row,
      subject: byCode[key].subject,
      subjectNA: byCode[key].na || key,
      code: subjectCodeOf_(byCode[key].subject)
    });
  });

  return { creates: creates, renames: renames, deletes: deletes };
}

/**
 * 統計該學期各科目的成績筆數（供刪除前警告）。
 * @param {string} ysem
 * @return {Object} { 代碼大寫: 筆數 }
 */
function gradeCounts_(ysem) {
  const rows = readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES);
  const counts = {};
  rows.forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    const c = subjectCodeOf_(String(r.Subject)).toUpperCase();
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

/**
 * 刪除指定科目於該學期的成績列（由下往上、合併連續列一次刪）。
 * @param {string} ysem
 * @param {Object} delCodes { 代碼大寫: true }
 * @return {number} 刪除筆數
 */
function deleteGradesOfSubjects_(ysem, delCodes) {
  const gsh = getSheet_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES);
  const values = gsh.getDataRange().getValues();
  const runs = [];
  let start = -1, count = 0;

  for (let i = values.length - 1; i >= 1; i--) { // 由下往上
    const ysemOk = String(values[i][0]).trim() === ysem;
    const codeOk = !!delCodes[subjectCodeOf_(String(values[i][4])).toUpperCase()];
    if (ysemOk && codeOk) {
      count++;
      if (start < 0) start = i;
    } else if (count) {
      runs.push({ row: start + 1, count: count }); // row 為 1-based（含標頭）
      start = -1; count = 0;
    }
  }
  if (count) runs.push({ row: start + 1, count: count });

  runs.forEach(function (r) { gsh.deleteRow(r.row); }); // runs 已由下往上排序
  return runs.reduce(function (s, r) { return s + r.count; }, 0);
}

/**
 * 建立學年學期的科目與 TA 密碼（規格書 4.1-1，科目清單為唯一真相）。
 *
 * 流程：
 *  1. 解析清單 → 計算變更計畫（新增 / 改名 / 刪除）
 *  2. 若有刪除且未確認 → 回 needConfirm=true 與明細，**不寫入任何資料**
 *  3. 確認後 → 新增科目（產生 1151+4 碼密碼）、更新名稱、
 *              刪除未列出科目並**一併刪除該科學績**（決策 D14）
 *
 * 既有科目密碼一律保留不變。
 *
 * @param {string} ysem 如 1151
 * @param {string} subjectsText 科目清單文字，每行「代碼, 中文名稱」
 * @param {boolean} confirmDelete 使用者是否已於對話框確認刪除
 * @return {Object}
 */
function createSemester_(ysem, subjectsText, confirmDelete) {
  ysem = String(ysem == null ? '' : ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');

  const list = parseSubjects_(subjectsText);
  const sh = getSheet_(CFG.SHEETS.TA, CFG.HEADERS.TA);
  const cols = CFG.HEADERS.TA.length;
  const plan = planSubjectChanges_(sh.getDataRange().getValues(), ysem, list);

  /* --- 需要刪除但尚未確認：僅回預覽，不寫入 --- */
  if (plan.deletes.length && !confirmDelete) {
    const counts = gradeCounts_(ysem);
    const deletions = plan.deletes
      .map(function (d) {
        return {
          subjectNA: d.subjectNA,
          code: d.code,
          gradeCount: counts[String(d.code).toUpperCase()] || 0
        };
      })
      .sort(function (a, b) { return b.gradeCount - a.gradeCount; });
    return {
      needConfirm: true,
      ysem: ysem,
      subjectCount: list.length,
      creates: plan.creates.length,
      renames: plan.renames.length,
      deletions: deletions,
      totalGrades: deletions.reduce(function (s, d) { return s + d.gradeCount; }, 0)
    };
  }

  /* --- 確認後執行 --- */
  let created = 0, renamed = 0, deleted = 0, deletedGrades = 0;

  withWriteLock_(function () {
    // 鎖內重讀，避免預覽與確認之間資料被他人改動
    const fresh = planSubjectChanges_(sh.getDataRange().getValues(), ysem, list);

    if (fresh.creates.length) {
      const rows = fresh.creates.map(function (s) {
        return [ysem, ysem + '_' + s.code, s.na, ysem + randomTail_()];
      });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols).setValues(rows);
      created = rows.length;
    }

    fresh.renames.forEach(function (r) {
      sh.getRange(r.row, 2, 1, 2).setValues([[r.subjectNew, r.na]]); // Subject + Subject_NA
      renamed++;
    });

    if (fresh.deletes.length) {
      const delCodes = {};
      fresh.deletes.forEach(function (d) { delCodes[d.code.toUpperCase()] = true; });
      deletedGrades = deleteGradesOfSubjects_(ysem, delCodes);
      fresh.deletes
        .map(function (d) { return d.row; })
        .sort(function (a, b) { return b - a; })      // 由下往上，避免列號位移
        .forEach(function (row) { sh.deleteRow(row); });
      deleted = fresh.deletes.length;
    }
  });

  const rows = readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA)
    .filter(function (r) { return String(r.Ysem).trim() === ysem; })
    .map(function (r) {
      return {
        ysem: String(r.Ysem).trim(),
        subject: String(r.Subject).trim(),
        subjectNA: String(r.Subject_NA).trim(),
        password: String(r.TA_Password).trim()
      };
    });

  // 寫入後核對：清單上的科目必須全部如實落表（偵測 Subject/Subject_NA 被整列覆寫）
  const wantNA = {};
  list.forEach(function (s) { wantNA[s.code.toUpperCase()] = s.na; });
  const gotNA = {};
  rows.forEach(function (r) { gotNA[subjectCodeOf_(r.subject).toUpperCase()] = r.subjectNA; });
  const badSubjects = Object.keys(wantNA).filter(function (c) {
    return !Object.prototype.hasOwnProperty.call(gotNA, c) || gotNA[c] !== wantNA[c];
  });
  if (badSubjects.length) {
    throw new Error('科目寫入後核對失敗：「' + badSubjects.join('、') +
      '」與清單不一致（資料已寫入，屬異常警告），請在編輯器執行 scanCorruptedRows() 檢查');
  }

  return {
    needConfirm: false,
    ysem: ysem,
    rows: rows,
    created: created,
    reused: list.length - created,
    renamed: renamed,
    deleted: deleted,
    deletedGrades: deletedGrades,
    subjectCount: list.length,
    csv: toCsv_(rows)
  };
}

/**
 * 全部學期（含 TA 與學生資料）由新到舊。
 * @param {Object} ctx 使用者情境（可為 null）
 * @return {string[]}
 */
function listYsems_(ctx) {
  const set = {};
  readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA).forEach(function (r) { set[String(r.Ysem).trim()] = 1; });
  readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS).forEach(function (r) { set[String(r.Ysem).trim()] = 1; });
  const all = Object.keys(set).filter(function (k) { return k && k !== 'null' && k !== 'undefined'; }).sort().reverse();

  // 學生僅能看到自己有登錄的學期（D5 跨學期 + 權限收斂）。
  // 判準與 query_ 共用 studentMayReadYsem_，避免「下拉選得到、後端卻拒絕」。
  if (ctx && ctx.role === 'student') {
    return all.filter(function (y) { return studentMayReadYsem_(ctx, y); });
  }
  return all;
}

/**
 * 導師用：學期與科目密碼總表。
 * @return {Object[]}
 */
function listSemesters_() {
  return readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA).map(function (r) {
    return {
      ysem: String(r.Ysem).trim(),
      subject: String(r.Subject).trim(),
      subjectNA: String(r.Subject_NA).trim(),
      password: String(r.TA_Password).trim()
    };
  });
}

/**
 * 取得班級名單，依座號升冪（規格書 4.2-3）。
 * TA 僅能取自己科目的學期名單（在此以學期驗證，科目鎖定於寫入端）。
 *
 * @param {Object} ctx
 * @param {string} ysem
 * @return {Object[]}
 */
function getRoster_(ctx, ysem) {
  ysem = String(ysem == null ? '' : ysem).trim() || (ctx && ctx.ysem);
  if (!ysem) throw new Error('缺少學年學期');
  if (ctx.role === 'ta' && ysem !== ctx.ysem) throw new Error('無法存取其他學期的名單');

  return readRoster_(ysem);
}

/**
 * 物件陣列轉 CSV（含 BOM，Excel 可直接開啟中文）。
 * @param {Object[]} rows
 * @return {string}
 */
function toCsv_(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = function (v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.join(',')];
  rows.forEach(function (r) { lines.push(keys.map(function (k) { return esc(r[k]); }).join(',')); });
  return '\ufeff' + lines.join('\r\n');
}

/* ============================================================
 * 指令碼編輯器工具函式（部署時執行一次）
 * ============================================================ */

/**
 * 系統初始化：建立 3 張工作表。
 * 若尚未設定導師密碼，會產生一組隨機密碼回傳（亦寫入 Logger）。
 * @return {string} 給管理者看的摘要
 */
function initSystem() {
  getSheet_(CFG.SHEETS.TA, CFG.HEADERS.TA);
  getSheet_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS);
  getSheet_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES);

  const props = PropertiesService.getScriptProperties();
  let pwd = props.getProperty(CFG.PROP_ADMIN);
  let created = false;
  if (!pwd) {
    pwd = 'admin' + randomTail_() + String(Math.floor(100 + Math.random() * 900));
    props.setProperty(CFG.PROP_ADMIN, pwd);
    created = true;
  }

  /**
   * 詳細內容（試算表 ID、網址、導師密碼）**只寫入執行記錄**。
   * M7-1：本函式是公開函式，任何人都能在開發人員工具用
   * `google.script.run.initSystem()` 直呼，回傳值會直接送到對方瀏覽器；
   * 而 `console.log` 只有指令碼編輯器的「執行記錄」看得到，故機密一律走這裡。
   */
  console.log([
    '✅ 初始化完成',
    '試算表 ID：' + props.getProperty(CFG.PROP_SSID),
    '試算表網址：https://docs.google.com/spreadsheets/d/' + props.getProperty(CFG.PROP_SSID),
    '工作表：' + CFG.SHEETS.TA + ' / ' + CFG.SHEETS.STUDENTS + ' / ' + CFG.SHEETS.GRADES,
    created ? ('🔑 導師密碼（請立即抄下，僅此一次）：' + pwd) : '🔑 導師密碼：已存在（未顯示）'
  ].join('\n'));

  return created
    ? '✅ 初始化完成。導師密碼已產生，請到「執行記錄」立即抄下（僅顯示這一次）。'
    : '✅ 初始化完成。試算表與工作表已就緒，試算表網址請看「執行記錄」。';
}

/**
 * 設定/更換導師密碼。
 *
 * **M7 起改為私有（尾碼 _）**：公開函式可被任何訪客以 `google.script.run`
 * 直呼，等同「任何人都能改掉導師密碼」＝全面繞過登入（PLAN §9.8【M7-1】）。
 * 本函式需要參數，本來就無法在編輯器下拉選單直接執行，改為私有沒有損失；
 * 更換密碼請改用：**指令碼編輯器 → 專案設定 → 腳本屬性 → 編輯 `ADMIN_PASSWORD`**。
 *
 * @param {string} newPwd
 * @return {string}
 */
function setAdminPassword_(newPwd) {
  newPwd = String(newPwd == null ? '' : newPwd).trim();
  if (newPwd.length < 6) throw new Error('導師密碼至少 6 碼');
  PropertiesService.getScriptProperties().setProperty(CFG.PROP_ADMIN, newPwd);
  return '✅ 導師密碼已更新';
}

/**
 * 診斷：掃描三張表有沒有「整列被填成同一個值」的受損資料。
 *
 * 起因（M4 實測發現）：多欄範圍誤用 setValue() 會把整個範圍填成第一個值，
 * 例如 Grades 一整列 8 欄全變成 Ysem「1151」。程式碼已改為 setValues()，
 * 此函式用來找出歷史受損列。**唯讀，不修改任何資料。**
 *
 * 用法：在指令碼編輯器直接執行，結果印在「執行記錄」。
 * @return {string}
 */
function scanCorruptedRows() {
  const bad = [];

  /**
   * @param {string} name 工作表名
   * @param {string[]} headers 標頭
   * @param {number} from 從第幾欄開始檢查（0 起）
   * @param {string} label 描述
   */
  function scan(name, headers, from, label) {
    const sh = getSheet_(name, headers);
    const values = sh.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const cells = values[i].slice(from).map(function (x) {
        return String(x == null ? '' : x).trim();
      });
      if (!cells.length) continue;
      if (cells.some(function (c) { return c === ''; })) continue; // 有空欄 → 不是「整列同一值」
      if (cells.every(function (c) { return c === cells[0]; })) {
        bad.push(name + ' 第 ' + (i + 1) + ' 列（' + label + '＝「' + cells[0] + '」）');
      }
    }
  }

  scan(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES, 0, '8 欄全同');
  scan(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS, 1, 'Seat_No～Auth_Code 全同');
  scan(CFG.SHEETS.TA, CFG.HEADERS.TA, 1, 'Subject～Subject_NA 全同');

  const msg = bad.length
    ? '⚠️ 找到 ' + bad.length + ' 列受損資料：\n  ' + bad.join('\n  ') +
      '\n→ 請在 Google Sheet 直接刪除這些列，再重新匯入學生／重新登記成績。'
    : '✅ 三張表皆未發現受損列';
  // 明細只進執行記錄（M7-1：回傳值會送到任何直呼本公開函式的訪客瀏覽器）
  console.log(msg);
  return bad.length
    ? '⚠️ 找到 ' + bad.length + ' 列受損資料，完整清單請看「執行記錄」。'
    : '✅ 三張表皆未發現受損列';
}
