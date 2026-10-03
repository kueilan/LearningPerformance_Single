/* ============================================================
 * 綜合查詢 (Query.gs) — M5
 * - 導師：學年學期 + 學號/姓名（空＝全班）+ 科目（空＝全科）
 * - 小老師：強制本人學期 + 本科（後端鎖定，前端繞過也無效）
 * - 學生：強制本人學號（忽略關鍵字），可跨學期看自己的紀錄
 *
 * 回傳欄位對應規格書 4.1-4：
 *   學年學期 | 座號 | 學號 | 姓名 | 科目 | 考試日期 | 成績 | 考試範圍
 * ============================================================ */

/**
 * 該學期的科目下拉清單 = TA 表科目 ∪ 成績表實際出現過的科目。
 * 取聯集可避免「已登成績但科目清單尚未建立」時下拉空白。
 * 中文名統一交給 subjectNA_（TA 表 → 內建 8 科 → 代碼本身）。
 *
 * @param {string} ysem
 * @return {Object[]} [{code, na}]
 */
function listSubjectsOf_(ysem) {
  const out = [];
  const seen = {};

  function push(code) {
    const c = String(code == null ? '' : code).trim();
    if (!c) return;
    const k = c.toUpperCase();
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ code: c, na: subjectNA_(ysem, c) });
  }

  readRows_(CFG.SHEETS.TA, CFG.HEADERS.TA).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    push(subjectCodeOf_(r.Subject));
  });
  readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    push(subjectCodeOf_(r.Subject));
  });
  return out;
}

/**
 * 綜合查詢：三條件任意組合，回規格書 4.1-4 的欄位。
 *
 * @param {Object} ctx 使用者情境
 * @param {Object} payload {ysem, subject?, studentKeyword?}
 * @return {{rows:Object[], count:number, subjects:Object[]}}
 */
function query_(ctx, payload) {
  payload = payload || {};
  const ysem = String(payload.ysem == null ? '' : payload.ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');

  let subject = String(payload.subject == null ? '' : payload.subject).trim();
  let keyword = String(payload.studentKeyword == null ? '' : payload.studentKeyword).trim();
  let forceStudentId = '';

  if (ctx.role === 'student') {
    // 學生：一律強制本人，關鍵字忽略（前端被竄改也不會放寬）
    forceStudentId = String(ctx.studentId || '').trim();
    if (!forceStudentId) throw new Error('無法辨識學生身分，請重新登入');
    keyword = '';
  }
  // 學期／科目範圍閘道（導師全權、小老師鎖學期鎖本科、學生限可讀學期）
  subject = assertSubjectScope_(ctx, ysem, subject);

  // D14：指定科目必須存在於該學期科目清單
  if (subject) subject = resolveSubject_(ysem, subject);
  const up = subject ? subject.toUpperCase() : '';

  const rows = [];
  readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    const code = subjectCodeOf_(String(r.Subject));
    if (up && code.toUpperCase() !== up) return;

    const id = String(r.Student_ID == null ? '' : r.Student_ID).trim();
    if (!id) return;
    if (forceStudentId) {
      if (id !== forceStudentId) return;
    } else if (keyword) {
      const hitId = id.toLowerCase().indexOf(keyword.toLowerCase()) >= 0;
      const hitName = String(r.Name == null ? '' : r.Name).indexOf(keyword) >= 0;
      if (!hitId && !hitName) return;
    }

    const date = examDateStr_(r.Exam_Date);
    if (!date) return; // 無日期的異常列不列入報表
    const raw = r.Score;
    const score = (raw === '' || raw === null || raw === undefined) ? null : Number(raw);

    rows.push({
      ysem: ysem,
      seatNo: Number(r.Seat_No) || 0,
      studentId: id,
      name: String(r.Name == null ? '' : r.Name).trim(),
      subject: code,
      subjectNA: subjectNA_(ysem, code),
      examDate: date,
      score: (score !== null && isFinite(score)) ? score : null,
      examScope: String(r.Exam_Scope == null ? '' : r.Exam_Scope).trim()
    });
  });

  // 預設排序：座號 → 科目代碼 → 考試日期 → 考試範圍（同一生跨科按時間排）
  rows.sort(function (a, b) {
    if (a.seatNo !== b.seatNo) return a.seatNo - b.seatNo;
    const ka = a.subject.toUpperCase();
    const kb = b.subject.toUpperCase();
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.examDate !== b.examDate) return a.examDate < b.examDate ? -1 : 1;
    if (a.examScope !== b.examScope) return a.examScope < b.examScope ? -1 : 1;
    return a.studentId < b.studentId ? -1 : (a.studentId > b.studentId ? 1 : 0);
  });

  return { rows: rows, count: rows.length, subjects: listSubjectsOf_(ysem) };
}
