/**
 * ============================================================
 * 導師全班各科學業表現登錄系統 — 主控模組 (Code.gs)
 * 職責：Web App 入口、HTML include、API 單一入口與分發
 * 依據：PLAN.md (PLAN-GAS-1151-01)
 * ============================================================
 */

/** 全域設定（不可於執行期修改） */
const CFG = Object.freeze({
  /** 科目對照表：規格書 §2 */
  SUBJECTS: [
    { code: 'Chi',  na: '國文', role: 'ChineseTA' },
    { code: 'Eng',  na: '英文', role: 'EnglishTA' },
    { code: 'Math', na: '數學', role: 'MathematicsTA' },
    { code: 'Chem', na: '化學', role: 'ChemistryTA' },
    { code: 'Bio',  na: '生物', role: 'BiologyTA' },
    { code: 'Hist', na: '歷史', role: 'HistoryTA' },
    { code: 'Civ',  na: '公民', role: 'CivicsTA' },
    { code: 'Geo',  na: '地理', role: 'GeographyTA' }
  ],
  /** 工作表名稱：規格書 §3 */
  SHEETS: {
    TA: 'Semester_TA_List',
    STUDENTS: 'Students',
    GRADES: 'Grades'
  },
  /** 各表標頭（第 1 列固定） */
  HEADERS: {
    TA:       ['Ysem', 'Subject', 'Subject_NA', 'TA_Password'],
    STUDENTS: ['Ysem', 'Seat_No', 'Student_ID', 'Name', 'Auth_Code'],
    GRADES:   ['Ysem', 'Seat_No', 'Student_ID', 'Name', 'Subject', 'Exam_Date', 'Score', 'Exam_Scope']
  },
  /** 需以「文字」格式儲存的欄（避免 1151 被轉成 1151.0、日期被轉成 Date） */
  TEXT_COLS: {
    TA:       [0],
    STUDENTS: [0, 2],
    GRADES:   [0, 2, 5]
  },
  /** Token 有效期（秒），4 小時 */
  TOKEN_TTL: 14400,
  /** Script Properties 鍵 */
  PROP_SSID: 'SPREADSHEET_ID',
  PROP_ADMIN: 'ADMIN_PASSWORD',
  /**
   * 不需 token 即可呼叫的 action。
   * 其餘一律先經 requireAuth_() 驗證，再由 dispatch_() 驗角色。
   * 註：少了 login 會導致「自己登入自己」失敗（M1 已修過一次，勿刪）。
   */
  PUBLIC_ACTIONS: ['login']
});

/**
 * Web App 入口。
 * @param {Object} e 事件參數
 * @return {HtmlOutput}
 */
function doGet(e) {
  try {
    return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('導師全班各科學業表現登錄系統')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    // 模板 include 失敗時不要把預設錯誤頁（含堆疊）丟給使用者
    console.error('doGet: ' + (err && err.stack ? err.stack : err));
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;padding:32px;line-height:1.7">' +
      '<h3 style="margin:0 0 8px">頁面載入失敗</h3>' +
      '<p style="margin:0">請重新整理頁面再試一次，或稍後再試。詳細錯誤已記錄於指令碼編輯器的「執行記錄」。</p>' +
      '</div>')
      .setTitle('導師全班各科學業表現登錄系統')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/**
 * 供 HTML 模板 include 片段。
 * 以 template 方式取得，使被 include 的檔案也能使用 <?!= ?> scriptlet。
 *
 * **M7 起改為私有（尾碼 _）**：`google.script.run` 可直呼任何「公開的頂層函式」，
 * 而本函式只在伺服器端的模板 `<?!= include_(...) ?>` 執行，沒有任何理由公開。
 * 詳見 PLAN §9.8【M7-1】。
 *
 * @param {string} filename 不含副檔名的檔案名
 * @return {string}
 */
function include_(filename) {
  return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
}

/**
 * 科目清單預設內容（供前端 textarea 預填），每行「代碼, 中文名稱」。
 *
 * **M7 起改為私有**：只由模板 `<?!= defaultSubjectsText_() ?>` 於伺服器端呼叫。
 *
 * @return {string}
 */
function defaultSubjectsText_() {
  return CFG.SUBJECTS.map(function (s) { return s.code + ', ' + s.na; }).join('\n');
}

/**
 * 前端唯一 API 入口。
 * 統一負責：例外捕捉、Token 驗證、角色授權、回傳格式 {ok, data|msg}。
 *
 * @param {string} action  動作名稱
 * @param {Object} payload 載荷（須含 token，login 除外）
 * @return {{ok:boolean, data:Object=, msg:string=}}
 */
function api(action, payload) {
  payload = payload || {};
  // 每次請求重新開始：不沿用上一次請求的讀取記憶體（避免讀到舊資料）
  resetReadMemo_();
  try {
    let ctx = null;
    if (CFG.PUBLIC_ACTIONS.indexOf(action) === -1) {
      ctx = requireAuth_(payload.token);
    }
    return { ok: true, data: dispatch_(action, payload, ctx) };
  } catch (err) {
    // 不回傳堆疊，避免資訊外洩；僅回使用者可理解訊息。
    // M7-2：TypeError/ReferenceError/SyntaxError 一律是程式缺陷（不可能是刻意拋出的業務訊息），
    // 直接回傳會把內部結構透露給訪客，故一律替換成通用文案；其餘（我們拋出的中文明細）原樣回傳。
    console.error('api[%s] %s', action, err && err.stack ? err.stack : err);
    const name = err && err.name ? String(err.name) : '';
    const internal = (name === 'TypeError' || name === 'ReferenceError' || name === 'SyntaxError');
    return {
      ok: false,
      msg: internal ? '系統發生未預期錯誤，請稍後再試或聯絡管理者'
                    : ((err && err.message) ? err.message : '系統發生未預期錯誤')
    };
  }
}

/**
 * 動作分發（含角色授權）。
 * @param {string} action
 * @param {Object} payload
 * @param {Object} ctx 驗證後的使用者情境（login 時為 null）
 * @return {Object}
 */
function dispatch_(action, payload, ctx) {
  switch (action) {
    /* ---- 公開 ---- */
    case 'login':
      return login_(payload.code);

    /* ---- 任意已登入角色 ---- */
    case 'logout':
      logout_(payload.token);
      return { done: true };

    case 'bootstrap':
      // 回傳角色可見的學期清單，供下拉選單初始化
      return { profile: ctx, ysems: listYsems_(ctx) };

    /* ---- 導師 (Admin) ---- */
    case 'createSemester':
      assertRole_(ctx, ['admin']);
      return createSemester_(payload.ysem, payload.subjectsText, !!payload.confirmDelete);

    case 'listSemesters':
      assertRole_(ctx, ['admin']);
      return listSemesters_();

    /* ---- 小老師 / 導師（M4 起擴充） ---- */
    case 'getRoster':
      assertRole_(ctx, ['admin', 'ta']);
      return getRoster_(ctx, payload.ysem);

    case 'importStudents':
      assertRole_(ctx, ['admin']);
      return importStudents_(payload.ysem, payload.csvText);

    /* ---- M4 成績登記（導師全科 / 小老師鎖本科，於函式內再驗） ---- */
    case 'listExams':
      assertRole_(ctx, ['admin', 'ta']);
      return listExams_(ctx, payload.ysem, payload.subject);

    case 'getExam':
      assertRole_(ctx, ['admin', 'ta']);
      return getExam_(ctx, payload.ysem, payload.subject, payload.examDate, payload.examScope);

    case 'saveExam':
      assertRole_(ctx, ['admin', 'ta']);
      return saveExam_(ctx, payload);

    /* ---- M5 綜合查詢（導師全班／小老師鎖本科／學生僅本人，於 query_ 內再驗） ---- */
    case 'query':
      assertRole_(ctx, ['admin', 'ta', 'student']);
      return query_(ctx, payload);

    /* ---- M6 成長曲線（導師全班/個人、小老師鎖本科、學生僅本人，於 chartData_ 內再驗） ---- */
    case 'chartData':
      assertRole_(ctx, ['admin', 'ta', 'student']);
      return chartData_(ctx, payload);

    default:
      throw new Error('未知的操作：' + action);
  }
}

/**
 * 角色檢查（後端權限閘道）。
 * @param {Object} ctx
 * @param {string[]} roles 允許角色
 */
function assertRole_(ctx, roles) {
  if (!ctx || roles.indexOf(ctx.role) === -1) {
    throw new Error('權限不足，無法執行此操作');
  }
}
