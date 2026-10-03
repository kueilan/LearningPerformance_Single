/* ============================================================
 * 成長曲線資料組裝 (Chart.gs) — M6
 *
 * 回傳形狀（一次 RPC 拿全，前端自行拆卡）：
 *   {
 *     ysem, mode, subject,
 *     studentId,                              // personal 模式本次實際繪製的學生
 *     subjectList: [{code, na}],              // 科目下拉（與 query_ 同源）
 *     subjects: [{
 *       code, na,
 *       exams:  [{key, date, scope}],        // 該科全部場次，時間序
 *       avg:    [number|null],               // 對應 exams 的全班平均（1 位小數）
 *       students: [{studentId, seatNo, name, scores:[number|null]}]
 *     }],
 *     roster: [{seatNo, studentId, name}],    // 供導師個人模式下拉（學生回空）
 *     empty: boolean                          // subjects 是否為空
 *   }
 *
 * - personal 模式：students 恰 1 人；僅回「該生有成績的科目」（規格 4.3-3）
 * - class 模式（D10）：須指定單一科目；students = 全班（含名單外但有成績者）
 * - 班平均一律以**全班該科該場次**計算，不受所選學生影響
 * - 學生端 mode 恒為 personal、studentId 恒為本人，故只會拿到班平均聚合，
 *   不會回傳他人個別成績（規格 §3）
 * ============================================================ */

/**
 * 載入成長曲線資料。
 *
 * @param {Object} ctx 使用者情境
 * @param {Object} payload {ysem, mode?, subject?, studentId?}
 * @return {Object} 見檔頭
 */
function chartData_(ctx, payload) {
  payload = payload || {};
  const ysem = String(payload.ysem == null ? '' : payload.ysem).trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('學年學期格式錯誤，需為 4 碼數字（例：1151）');

  let mode = payload.mode === 'class' ? 'class' : 'personal';
  let subject = String(payload.subject == null ? '' : payload.subject).trim();
  let studentId = String(payload.studentId == null ? '' : payload.studentId).trim();

  if (ctx.role === 'student') {
    // 學生沒有「全班模式」，一律只取本人
    mode = 'personal';
    studentId = String(ctx.studentId || '').trim();
    if (!studentId) throw new Error('無法辨識學生身分，請重新登入');
  }

  // 權限閘道（D19：先閘道、後科目清單）
  subject = assertSubjectScope_(ctx, ysem, subject);

  if (mode === 'class' && !subject) throw new Error('全班模式請先選擇單一科目');
  if (subject) subject = resolveSubject_(ysem, subject);
  const up = subject ? subject.toUpperCase() : '';

  // 個人模式：校正學生（未指定／跨學期帶入的舊學號不在本學期名單 → 取名單第一位）
  if (mode === 'personal' && ctx.role !== 'student') {
    const rlist = readRoster_(ysem);
    if (rlist.length && !rlist.some(function (s) { return s.studentId === studentId; })) {
      studentId = rlist[0].studentId;
    }
  }
  if (mode === 'personal' && !studentId) {
    throw new Error('此學期尚無學生名單，請先到「學生資料匯入」匯入');
  }

  const subjectList = listSubjectsOf_(ysem); // 科目下拉（與 query_ 同一來源）

  /* ---------- ① 掃描成績：科目 → 場次 → 各生分數 ---------- */
  const subs = {}; // code -> {exams:{key:{date,scope,scores:{}}}, scorers:{id:{...}}}

  readRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    const code = subjectCodeOf_(String(r.Subject));
    if (up && code.toUpperCase() !== up) return;
    const date = examDateStr_(r.Exam_Date);
    if (!date) return;
    const id = String(r.Student_ID == null ? '' : r.Student_ID).trim();
    if (!id) return;

    // D9：空分數＝未登錄，不計入；非數值髒資料略過
    const raw = r.Score;
    if (raw === '' || raw === null || raw === undefined) return;
    const v = Number(raw);
    if (!isFinite(v)) return;

    let m = subs[code];
    if (!m) m = subs[code] = { exams: {}, scorers: {} };
    const scope = String(r.Exam_Scope == null ? '' : r.Exam_Scope).trim();
    const key = date + '\u0001' + scope;
    let e = m.exams[key];
    if (!e) e = m.exams[key] = { date: date, scope: scope, scores: {} };
    e.scores[id] = v; // 同一生重複列：最後一列為準（與 readExamScores_ 一致）

    if (!m.scorers[id]) {
      m.scorers[id] = {
        studentId: id,
        seatNo: Number(r.Seat_No) || 0,
        name: String(r.Name == null ? '' : r.Name).trim()
      };
    }
  });

  /* ---------- ② 依科目清單順序輸出（多出來的代碼補在後面） ---------- */
  const byUp = {};
  Object.keys(subs).forEach(function (c) { byUp[c.toUpperCase()] = c; });

  const codes = [];
  subjectList.forEach(function (s) {
    const real = byUp[s.code.toUpperCase()];
    if (real && codes.indexOf(real) < 0) codes.push(real);
  });
  Object.keys(subs).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });

  const roster = ctx.role === 'student' ? [] : readRoster_(ysem);
  const rosterById = {};
  roster.forEach(function (s) { rosterById[s.studentId] = s; });

  const out = [];

  codes.forEach(function (code) {
    const m = subs[code];
    const examList = Object.keys(m.exams).map(function (k) { return m.exams[k]; });
    examList.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : 0);
    });

    const exams = examList.map(function (e) {
      return { key: e.date + '\u0001' + e.scope, date: e.date, scope: e.scope };
    });

    // 班平均：該場次所有有分數者的平均，四捨五入到 1 位（D12）
    const avg = examList.map(function (e) {
      const ids = Object.keys(e.scores);
      if (!ids.length) return null;
      let s = 0;
      ids.forEach(function (id) { s += e.scores[id]; });
      return Math.round((s / ids.length) * 10) / 10;
    });

    /* ---- ③ 決定要輸出哪些學生 ---- */
    let targets;
    if (mode === 'class') {
      targets = roster.slice(); // readRoster_ 已是座號序
      const seen = {};
      roster.forEach(function (s) { seen[s.studentId] = 1; });
      Object.keys(m.scorers).forEach(function (id) { // 名單外但有成績（名單調整過）
        if (!seen[id]) targets.push(m.scorers[id]);
      });
      // 座號升冪；無座號（名單外殘留列）排最後
      targets.sort(function (a, b) {
        const x = Number(a.seatNo) || 0, y = Number(b.seatNo) || 0;
        if (!x && !y) return 0;
        if (!x) return 1;
        if (y) return x - y;
        return -1;
      });
    } else {
      const hit = rosterById[studentId] || m.scorers[studentId];
      targets = hit ? [hit] : [];
    }

    const students = targets.map(function (s) {
      return {
        studentId: s.studentId,
        seatNo: Number(s.seatNo) || 0,
        name: String(s.name == null ? '' : s.name),
        scores: examList.map(function (e) {
          return Object.prototype.hasOwnProperty.call(e.scores, s.studentId)
            ? e.scores[s.studentId] : null;
        })
      };
    });

    if (mode === 'personal') {
      // 該生此科一場都沒考 → 不產生空卡
      const has = students.length > 0 && students[0].scores.some(function (v) { return v !== null; });
      if (!has) return;
    } else if (!examList.length) {
      return;
    }

    out.push({
      code: code,
      na: subjectNA_(ysem, code),
      exams: exams,
      avg: avg,
      students: students
    });
  });

  return {
    ysem: ysem,
    mode: mode,
    subject: subject,
    studentId: mode === 'personal' ? studentId : '', // 本次實際繪製的學生
    subjectList: subjectList,
    subjects: out,
    roster: roster, // 學生回空（避免外洩全班名單）
    empty: out.length === 0
  };
}
