/**
 * ============================================================
 * 學生資料匯入 (Students.gs) — M3
 * 規格書 4.1-2：CSV 快速貼上，四欄免標頭
 *   座號, 學號, 姓名, 學生登入驗證碼
 * 決策：D6 四欄免標頭 / D13 以 Ysem+Student_ID 覆蓋更新
 *      驗證失敗 → 整批不寫入，回傳全部錯誤列
 * ============================================================
 */

/** 學生驗證碼格式（4–16 碼英數字） */
var STUDENT_AUTH_RE_ = /^[A-Za-z0-9]{4,16}$/;

/**
 * 以逗號切一行 CSV（支援雙引號包覆與雙引號跳脫）。
 * @param {string} line
 * @return {string[]} 已 trim 的欄位
 */
function splitCsvLine_(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(function (s) { return s.trim(); });
}

/**
 * 正規化使用者貼上的文字 → 列陣列。
 * 處理：BOM、CRLF、全形逗號/頓號、分號、Tab 分隔、空白行、標頭列偵測。
 *
 * @param {string} text
 * @return {string[]} 純資料列（已去空白、已略過標頭）
 */
function normalizeStudentText_(text) {
  text = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/，/g, ',')
    .replace(/、/g, ',')
    .replace(/;/g, ',');

  const lines = text.split('\n');
  const out = [];
  let sawFirst = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    // Tab 分隔 → 逗號
    if (line.indexOf(',') < 0 && line.indexOf('\t') >= 0) line = line.split('\t').join(',');
    // 偽裝成 CSV 的純 Tab 欄位
    line = line.replace(/\t+/g, ',');

    if (!sawFirst) {
      sawFirst = true;
      // 標頭列偵測：含「座號」或英文 seat/student_id 等關鍵字
      if (/座號|学号|學號|seat\s*no|student\s*id/i.test(line) && !/\d/.test(line.split(',')[0])) {
        continue; // 略過標頭
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * 解析並逐列驗證（收集全部錯誤，不中途放棄）。
 *
 * @param {string} text 使用者貼上的內容
 * @param {Object} ctx  { existing: Object[], taPwds: Object, adminPwd: string }
 * @return {{rows:Object[], errors:Object[]}}
 */
function parseStudentRows_(text, ctx) {
  const lines = normalizeStudentText_(text);
  const rows = [];
  const errors = [];

  if (!lines.length) {
    errors.push({ line: 0, msg: '未解析到任何資料列' });
    return { rows: rows, errors: errors };
  }

  const seenSeat = {}, seenId = {}, seenAuth = {};
  const existById = {}, existBySeat = {}, existByAuth = {};

  // 既有資料索引（同學期）
  (ctx.existing || []).forEach(function (r) {
    const id = String(r.Student_ID).trim();
    const seat = String(r.Seat_No).trim();
    const auth = String(r.Auth_Code).trim();
    existById[id] = r;
    existBySeat[seat] = id;
    existByAuth[auth] = id;
  });

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const cols = splitCsvLine_(lines[i]);

    if (cols.length < 4) {
      errors.push({ line: lineNo, msg: '欄位不足（需 4 欄：座號, 學號, 姓名, 驗證碼），目前 ' + cols.length + ' 欄' });
      continue;
    }
    if (cols.length > 4) {
      // 姓名含逗號時可嘗試合併第 3、4 欄之前的欄位？此處嚴格要求，避免誤判
      errors.push({ line: lineNo, msg: '欄位過多（需正好 4 欄），請檢查姓名或驗證碼是否含逗號' });
      continue;
    }

    const seatStr = cols[0], idStr = cols[1], name = cols[2], auth = cols[3];

    if (!/^\d{1,3}$/.test(seatStr) || Number(seatStr) < 1) {
      errors.push({ line: lineNo, msg: '座號「' + seatStr + '」無效：需為 1–999 的整數' });
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9\-]{0,19}$/.test(idStr)) {
      errors.push({ line: lineNo, msg: '學號「' + idStr + '」無效：需為 1–20 碼英數字或連字號' });
      continue;
    }
    if (!name || name.length > 20) {
      errors.push({ line: lineNo, msg: '姓名「' + name + '」無效：不可為空且上限 20 字' });
      continue;
    }
    if (!STUDENT_AUTH_RE_.test(auth)) {
      errors.push({ line: lineNo, msg: '驗證碼「' + auth + '」無效：需為 4–16 碼英數字' });
      continue;
    }

    /* --- 同批內唯一性 --- */
    if (seenSeat[seatStr]) { errors.push({ line: lineNo, msg: '座號 ' + seatStr + ' 在本批中重複（第 ' + seenSeat[seatStr] + ' 列已使用）' }); continue; }
    if (seenId[idStr]) { errors.push({ line: lineNo, msg: '學號 ' + idStr + ' 在本批中重複（第 ' + seenId[idStr] + ' 列已使用）' }); continue; }
    if (seenAuth[auth]) { errors.push({ line: lineNo, msg: '驗證碼 ' + auth + ' 在本批中重複（第 ' + seenAuth[auth] + ' 列已使用）' }); continue; }

    /* --- 與既有資料的衝突（同學期） --- */
    const seatOwner = existBySeat[seatStr];
    if (seatOwner && seatOwner !== idStr) {
      errors.push({ line: lineNo, msg: '座號 ' + seatStr + ' 已被學號 ' + seatOwner + ' 佔用，請先更正' });
      continue;
    }
    const authOwner = existByAuth[auth];
    if (authOwner && authOwner !== idStr) {
      errors.push({ line: lineNo, msg: '驗證碼 ' + auth + ' 已由學號 ' + authOwner + ' 使用，請改用其他驗證碼' });
      continue;
    }
    // 跨學期衝突：學生登入是全域比對驗證碼，同碼不同人會被誤認
    const globalOwner = ctx.globalAuth ? ctx.globalAuth[auth] : null;
    if (globalOwner && globalOwner !== idStr) {
      errors.push({ line: lineNo, msg: '驗證碼 ' + auth + ' 已由學號 ' + globalOwner + '（其他學期）使用，請改用其他驗證碼' });
      continue;
    }

    /* --- 與系統登入碼衝突（避免搶走 TA / 導師登入） --- */
    if (ctx.taPwds[auth]) {
      errors.push({ line: lineNo, msg: '驗證碼 ' + auth + ' 與 ' + ctx.taPwds[auth] + ' 的 TA 密碼相同，請改用其他驗證碼' });
      continue;
    }
    if (ctx.adminPwd && auth === ctx.adminPwd) {
      errors.push({ line: lineNo, msg: '驗證碼與導師密碼相同，請改用其他驗證碼' });
      continue;
    }

    seenSeat[seatStr] = lineNo;
    seenId[idStr] = lineNo;
    seenAuth[auth] = lineNo;

    rows.push({
      line: lineNo,
      seatNo: Number(seatStr),
      studentId: idStr,
      name: name,
      authCode: auth
    });
  }

  return { rows: rows, errors: errors };
}

/**
 * 匯入學生資料（規格書 4.1-2）。
 * 驗證失敗 → 完全不寫入，回傳全部錯誤列。
 *
 * @param {string} ysem 學年學期
 * @param {string} csvText 使用者貼上的內容
 * @return {Object} {errors, parsed, created, updated, roster}
 */
function importStudents_(ysem, csvText) {
  ysem = String(ysem == null ? '' : ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');

  // 登入碼衝突檢查所需的來源
  const taPwds = {};
  readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA).forEach(function (r) {
    const pwd = String(r.TA_Password).trim();
    taPwds[pwd] = String(r.Ysem).trim() + ' ' + String(r.Subject_NA).trim() + ' 科';
  });
  const adminPwd = PropertiesService.getScriptProperties().getProperty(CFG.PROP_ADMIN) || '';

  const existing = readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS)
    .filter(function (r) { return String(r.Ysem).trim() === ysem; });

  // 全域驗證碼索引（所有學期，供跨學期衝突檢查）
  const globalAuth = {};
  readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS).forEach(function (r) {
    const a = String(r.Auth_Code).trim();
    if (a && !globalAuth[a]) globalAuth[a] = String(r.Student_ID).trim();
  });

  const parsed = parseStudentRows_(csvText, {
    existing: existing,
    globalAuth: globalAuth,
    taPwds: taPwds,
    adminPwd: adminPwd
  });

  if (parsed.errors.length) {
    // 整批不寫入（決策：先修正再送出）
    return { errors: parsed.errors, parsed: parsed.rows.length, created: 0, updated: 0, roster: null };
  }
  if (!parsed.rows.length) {
    return { errors: [{ line: 0, msg: '未解析到任何有效資料列' }], parsed: 0, created: 0, updated: 0, roster: null };
  }

  const sh = getSheet_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS);
  let created = 0, updated = 0;

  withWriteLock_(function () {
    const values = sh.getDataRange().getValues();
    const byId = {};
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() !== ysem) continue;
      byId[String(values[i][2]).trim()] = i + 1; // 學號 → 列號
    }

    const appends = [];
    parsed.rows.forEach(function (p) {
      const rowNo = byId[p.studentId];
      if (rowNo) {
        // D13：同學號覆蓋更新（座號/姓名/驗證碼取最新）
        sh.getRange(rowNo, 2, 1, 4).setValues([[p.seatNo, p.studentId, p.name, p.authCode]]);
        updated++;
      } else {
        appends.push([ysem, p.seatNo, p.studentId, p.name, p.authCode]);
        created++;
      }
    });

    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, CFG.HEADERS.STUDENTS.length).setValues(appends);
    }
  });

  // 寫入後核對（withWriteLock_ 已清空讀取記憶體 → 這裡讀到的是表裡最新狀態）
  const roster = readRoster_(ysem);
  const byId = {};
  roster.forEach(function (s) { byId[s.studentId] = s; });
  const mismatch = parsed.rows.filter(function (p) {
    const s = byId[p.studentId];
    return !s || Number(s.seatNo) !== p.seatNo || s.name !== p.name;
  });
  if (mismatch.length) {
    throw new Error('匯入後核對失敗：學號 ' + mismatch[0].studentId +
      ' 寫入後與表內資料不一致（資料已寫入，屬異常警告），請在編輯器執行 scanCorruptedRows() 檢查');
  }

  return {
    errors: [],
    parsed: parsed.rows.length,
    created: created,
    updated: updated,
    roster: roster
  };
}

/**
 * 讀取指定學期的名單（座號升冪）。
 * @param {string} ysem
 * @return {Object[]}
 */
function readRoster_(ysem) {
  return readRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS)
    .filter(function (r) { return String(r.Ysem).trim() === ysem; })
    .map(function (r) {
      return {
        seatNo: Number(r.Seat_No),
        studentId: String(r.Student_ID).trim(),
        name: String(r.Name).trim()
      };
    })
    .sort(function (a, b) { return a.seatNo - b.seatNo; });
}
