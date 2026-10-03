/**
 * ============================================================
 * Sheet 存取層 (Storage.gs)
 * - 單次整表讀取 + 30 秒快取
 * - 寫入時鎖定 + flush + 快取失效
 * - 所有 Ysem / Student_ID 以文字處理
 * ============================================================
 */

/**
 * 取得（必要時建立）試算表。
 * 若 Script Properties 未綁定 SPREADSHEET_ID，自動建立一張新試算表並綁定。
 * @return {Spreadsheet}
 */
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(CFG.PROP_SSID);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // 被刪除或無權限 → 重新建立
      console.warn('既有試算表無法開啟，改用新試算表：%s', e.message);
    }
  }
  const ss = SpreadsheetApp.create('LearningPerformance_資料庫');
  props.setProperty(CFG.PROP_SSID, ss.getId());
  return ss;
}

/**
 * 取得工作表，不存在則建立並寫入標頭與文字欄格式。
 * @param {string} name
 * @param {string[]} headers
 * @return {Sheet}
 */
function getSheet_(name, headers) {
  const ss = getSS_();
  let sh = ss.getSheetByName(name);
  if (sh) {
    ensureTextFormats_(sh, name); // 既有工作表也補上文字格式（相容 M1 前建立的表）
    return sh;
  }

  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold')
    .setBackground('#e2e8f0');
  sh.setFrozenRows(1);
  applyTextFormats_(sh, name);
  return sh;
}

/**
 * 依設定將指定欄設為文字格式，避免 1151 → 1151.0。
 * @param {Sheet} sh
 * @param {string} key  CFG.SHEETS 的值
 */
function applyTextFormats_(sh, key) {
  const cols = CFG.TEXT_COLS[key];
  if (!cols || !cols.length) return;
  const last = Math.max(sh.getMaxRows(), 1);
  cols.forEach(function (c) {
    // 設到整欄，未來插入列仍受保護
    sh.getRange(1, c + 1, last, 1).setNumberFormat('@');
  });
}

/**
 * 確認文字欄格式（只在尚未設定時才寫入，避免每次讀取都改格式）。
 * @param {Sheet} sh
 * @param {string} key CFG.SHEETS 的值
 */
function ensureTextFormats_(sh, key) {
  const cols = CFG.TEXT_COLS[key];
  if (!cols || !cols.length) return;
  cols.forEach(function (c) {
    if (sh.getRange(1, c + 1).getNumberFormat() !== '@') {
      sh.getRange(1, c + 1, Math.max(sh.getMaxRows(), 1), 1).setNumberFormat('@');
    }
  });
}

/**
 * 本次請求內的讀取記憶體（name → {t, rows}）。
 *
 * 為什麼不用 CacheService：
 *   分散式快取是「最終一致性」，寫入後緊接著的讀取可能拿到舊值，
 *   而且舊值會被重新 put、延長 TTL → 出現「已儲存但畫面沒更新」（M4 實測）。
 * 現在改為：
 *   - 只在「同一次 api() 請求內」去重（api() 一開頭呼叫 resetReadMemo_）
 *   - 任何寫入後也清空（withWriteLock_ → invalidateCaches_）
 *   - 跨請求一律重新讀 Sheet（Sheet 本身在 flush 後是強一致的）
 * @type {Object<string, {t:number, rows:Object[]}>}
 */
let ROWS_MEMO_ = {};

/** 記憶體快取有效期（ms）：僅作為非 api() 路徑（指令碼編輯器直跑）的後備上限 */
const ROWS_MEMO_TTL_ = 60000;

/**
 * 清空讀取記憶體。
 */
function resetReadMemo_() {
  ROWS_MEMO_ = {};
}

/**
 * 整表讀取（含標頭轉物件）。
 * 同一次請求內重複讀取同一張表會命中記憶體，跨請求一律重讀。
 *
 * @param {string} name  工作表名
 * @param {string[]} headers 標頭（作為物件鍵）
 * @return {Object[]} 每列一個物件
 */
function readRows_(name, headers) {
  const hit = ROWS_MEMO_[name];
  if (hit && (Date.now() - hit.t) < ROWS_MEMO_TTL_) return hit.rows;

  const sh = getSheet_(name, headers);
  const values = sh.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    // 跳過完全空白列
    if (v.every(function (x) { return x === '' || x === null; })) continue;
    const o = {};
    for (let c = 0; c < headers.length; c++) {
      // Date 物件轉固定字串，避免 JSON 序列化後時區位移、比對失敗
      o[headers[c]] = (v[c] instanceof Date)
        ? Utilities.formatDate(v[c], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : v[c];
    }
    rows.push(o);
  }
  ROWS_MEMO_[name] = { t: Date.now(), rows: rows };
  return rows;
}

/**
 * 寫入前取鎖，寫入後 flush 並清空讀取記憶體。
 * 用法：
 *   withWriteLock_(function(){ ...指定 Sheet 寫入... });
 * @param {Function} fn 要執行的寫入函式
 * @return {*} fn 的回傳值
 */
function withWriteLock_(fn) {
  const lock = LockService.getScriptLock();
  // 等待 10 秒仍未取得鎖則放棄，避免前端無限等待
  if (!lock.tryLock(10000)) {
    throw new Error('系統忙碌中（另一位使用者正在寫入），請稍後再試');
  }
  try {
    const out = fn();
    SpreadsheetApp.flush();
    invalidateCaches_();
    return out;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 失效所有 Sheet 讀取記憶體（寫入後呼叫，確保後續讀到新資料）。
 */
function invalidateCaches_() {
  resetReadMemo_();
}

/**
 * 取得科目中文名（以 Semester_TA_List 為準，支援自訂科目）。
 * 查找順序：同學期該科目 → 任一學期該代碼 → 內建對照表 → 回傳代碼本身。
 *
 * @param {string} ysem 學年學期（可省略）
 * @param {string} code 短碼或複合碼
 * @return {string}
 */
function subjectNA_(ysem, code) {
  const c = subjectCodeOf_(code);
  if (ysem) {
    const want = String(ysem) + '_' + c;
    const rows = readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].Subject).trim() === want) {
        const na = String(rows[i].Subject_NA).trim();
        if (na) return na;
      }
    }
    for (let j = 0; j < rows.length; j++) {
      if (subjectCodeOf_(rows[j].Subject) === c) {
        const na2 = String(rows[j].Subject_NA).trim();
        if (na2) return na2;
      }
    }
  }
  for (let k = 0; k < CFG.SUBJECTS.length; k++) {
    if (CFG.SUBJECTS[k].code === c) return CFG.SUBJECTS[k].na;
  }
  return c;
}
