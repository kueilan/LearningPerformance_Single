/**
 * ============================================================
 * 認證與權限閘道 (Auth.gs)
 * - 導師：Script Properties ADMIN_PASSWORD
 * - 小老師：Semester_TA_List.TA_Password
 * - 學生：Students.Auth_Code
 * Token 存於 ScriptCache，TTL 4 小時
 * ============================================================
 */

/**
 * 驗證碼登入，回傳 token 與 profile。
 * @param {string} code 使用者輸入的驗證碼
 * @return {{token:string, profile:Object}}
 */
function login_(code) {
  code = String(code == null ? '' : code).trim();
  if (!code) throw new Error('請輸入驗證碼');

  /* 1) 導師密碼 */
  const adminPwd = PropertiesService.getScriptProperties().getProperty(CFG.PROP_ADMIN);
  if (!adminPwd) {
    // 刻意在未設定時不暴露其他分支，先明確提示導師設定
    throw new Error('尚未設定導師密碼，請於指令碼編輯器「專案設定 → 腳本屬性」設定 ADMIN_PASSWORD');
  }
  if (code === adminPwd) {
    return issueToken_({ role: 'admin', label: '導師' });
  }

  /* 2) 小老師 TA 密碼：格式 [Ysem]+4 碼小寫英數 */
  const taRows = readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA);
  for (let i = 0; i < taRows.length; i++) {
    const r = taRows[i];
    if (String(r.TA_Password).trim() === code) {
      return issueToken_({
        role: 'ta',
        ysem: String(r.Ysem).trim(),
        subject: String(r.Subject).trim(),        // 複合碼 1151_Chi
        subjectCode: subjectCodeOf_(r.Subject),   // 短碼 Chi
        subjectNA: String(r.Subject_NA).trim(),
        label: String(r.Ysem).trim() + ' 學期 - ' + String(r.Subject_NA).trim() + ' 科登錄介面'
      });
    }
  }

  /* 3) 學生登入驗證碼（同碼跨學期時取最近學期） */
  const stuRows = readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS);
  let hit = null;
  for (let i = 0; i < stuRows.length; i++) {
    const r = stuRows[i];
    if (String(r.Auth_Code).trim() !== code) continue;
    if (!hit || String(r.Ysem).trim() > String(hit.Ysem).trim()) hit = r;
  }
  if (hit) {
    return issueToken_({
      role: 'student',
      ysem: String(hit.Ysem).trim(),
      seatNo: String(hit.Seat_No).trim(),
      studentId: String(hit.Student_ID).trim(),
      name: String(hit.Name).trim(),
      label: '座號 ' + String(hit.Seat_No).trim() + '｜學號 ' +
             String(hit.Student_ID).trim() + '｜姓名 ' + String(hit.Name).trim()
    });
  }

  throw new Error('驗證碼無效，請重新輸入');
}

/**
 * 簽發 token 並存入 Cache。
 * @param {Object} profile
 * @return {{token:string, profile:Object}}
 */
function issueToken_(profile) {
  const token = Utilities.getUuid();
  const cache = CacheService.getScriptCache();
  // 首次 put 需設定 TTL；使用函式包裝確保每次都延長有效期
  cache.put('tok_' + token, JSON.stringify(profile), CFG.TOKEN_TTL);
  return { token: token, profile: profile };
}

/**
 * 驗證 token，回傳 ctx（每次驗證皆延長有效期＝滑動過期）。
 * @param {string} token
 * @return {Object}
 */
function requireAuth_(token) {
  if (!token) throw new Error('尚未登入或登入已逾期');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + token;
  const raw = cache.get(key);
  if (!raw) throw new Error('登入已逾期，請重新登入');
  const profile = JSON.parse(raw);
  cache.put(key, raw, CFG.TOKEN_TTL); // 滑動延長
  return profile;
}

/**
 * 登出：立即銷毀 token。
 * @param {string} token
 */
function logout_(token) {
  if (token) CacheService.getScriptCache().remove('tok_' + token);
}

/**
 * 從複合科目代碼取出短碼：1151_Chi → Chi
 * @param {string} composite
 * @return {string}
 */
function subjectCodeOf_(composite) {
  const s = String(composite == null ? '' : composite);
  const p = s.indexOf('_');
  return p >= 0 ? s.substring(p + 1) : s;
}

/**
 * 學生是否可查閱某學年學期。
 * 本人學期一律可讀；其他學期須在名單（Students）上存在「學號 + 姓名皆相同」的列。
 * 學號可能跨年重複，故再比對姓名，避免看到同學號但不同人的資料。
 *
 * 同時是 `listYsems_` 下拉清單與 `query_` 查詢的共用判準（兩者必須一致，
 * 否則會出現「下拉選得到、後端卻拒絕」的矛盾）。
 *
 * @param {Object} ctx 使用者情境（student）
 * @param {string} ysem 候選學年學期
 * @return {boolean}
 */
function studentMayReadYsem_(ctx, ysem) {
  if (!ctx || ctx.role !== 'student') return false;
  const target = String(ysem).trim();
  if (String(ctx.ysem).trim() === target) return true;

  const sid = String(ctx.studentId || '').trim();
  const nm = String(ctx.name || '').trim();
  if (!sid || !nm) return false;

  const rows = readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r.Ysem).trim() === target &&
        String(r.Student_ID).trim() === sid &&
        String(r.Name).trim() === nm) return true;
  }
  return false;
}

/**
 * 查詢（query_）與圖表（chartData_）共用的資料範圍閘道（與 D19 同源）。
 * - **導師**：全權，科目依原樣回傳（空＝全科）
 * - **小老師**：僅本人學期；科目未指定即視為本科，指定他科直接拒絕
 * - **學生**：僅可查閱 studentMayReadYsem_ 通過的學期；科目不限（列資料另有強制本人）
 *
 * 抽成共用函式的目的：**閘道判準只存在一份**，避免 query 與 chart 各寫一次而漂移。
 *
 * @param {Object} ctx 使用者情境
 * @param {string} ysem 已正規化的學年學期
 * @param {string} subject 呼叫端傳入的科目（可空）
 * @return {string} 應使用的科目（'' 表示不限科目）
 */
function assertSubjectScope_(ctx, ysem, subject) {
  const s = String(subject == null ? '' : subject).trim();

  if (ctx.role === 'student') {
    if (!studentMayReadYsem_(ctx, ysem)) throw new Error('無權查閱 ' + ysem + ' 學期的資料');
    return s;
  }

  if (ctx.role === 'ta') {
    if (String(ctx.ysem) !== ysem) {
      throw new Error('小老師僅能查詢 ' + ctx.ysem + ' 學期的資料');
    }
    const mine = String(ctx.subjectCode || '').toUpperCase();
    if (s && subjectCodeOf_(s).toUpperCase() !== mine) {
      throw new Error('小老師僅能查詢本科（' + (ctx.subjectNA || ctx.subjectCode) + '）的成績');
    }
    return String(ctx.subjectCode || ''); // 未指定 → 本科（小老師沒有「全科」）
  }

  return s; // admin
}
