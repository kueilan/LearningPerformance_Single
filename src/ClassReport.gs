/** 報表專用唯讀讀取：不建立試算表、不修復欄格式、不寫回資料。 */
function reportRows_(name, headers) {
  const id = PropertiesService.getScriptProperties().getProperty(CFG.PROP_SSID);
  if (!id) throw new Error('尚未設定資料試算表，請聯絡管理者');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error('找不到資料工作表：' + name);
  const values = sheet.getDataRange().getValues();
  if (!headers.every(function (h, i) { return values[0] && values[0][i] === h; })) {
    throw new Error('資料工作表標頭不符：' + name + '，請聯絡管理者');
  }
  return values.slice(1).filter(function (row) { return row.some(function (v) { return v !== ''; }); })
    .map(function (row) {
      const item = {};
      headers.forEach(function (h, i) { item[h] = row[i]; });
      return item;
    });
}

function reportSemester_(value) {
  const ysem = String(value || '').trim();
  if (!/^\d{4}$/.test(ysem)) throw new Error('請選擇 4 碼學年學期');
  return ysem;
}

function reportExamKey_(subject, date, scope) {
  return JSON.stringify([subject.toUpperCase(), date, scope]);
}

function reportDataset_(ysem) {
  const grades = reportRows_(CFG.SHEETS.GRADES, CFG.HEADERS.GRADES)
    .filter(function (r) { return String(r.Ysem).trim() === ysem; });
  const subjects = Object.create(null);
  reportRows_(CFG.SHEETS.TA, CFG.HEADERS.TA).forEach(function (r) {
    if (String(r.Ysem).trim() !== ysem) return;
    const code = subjectCodeOf_(r.Subject);
    subjects[code.toUpperCase()] = { code: code, na: String(r.Subject_NA || code), exams: [] };
  });
  const seen = Object.create(null);
  grades.forEach(function (r) {
    const code = subjectCodeOf_(r.Subject);
    if (!code) return;
    const up = code.toUpperCase();
    if (!subjects[up]) {
      const fallback = CFG.SUBJECTS.find(function (s) { return s.code.toUpperCase() === up; });
      subjects[up] = { code: code, na: fallback ? fallback.na : code, exams: [] };
    }
    const date = examDateStr_(r.Exam_Date), scope = String(r.Exam_Scope || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const key = reportExamKey_(code, date, scope);
    if (seen[key]) return;
    seen[key] = true;
    subjects[up].exams.push({ examDate: date, examScope: scope });
  });
  const list = Object.keys(subjects).map(function (key) {
    subjects[key].exams.sort(function (a, b) {
      return a.examDate.localeCompare(b.examDate) || a.examScope.localeCompare(b.examScope);
    });
    return subjects[key];
  });
  return { grades: grades, subjects: list };
}

function classReportOptions_(value) {
  const ysem = reportSemester_(value);
  return { ysem: ysem, subjects: reportDataset_(ysem).subjects };
}

/** 總分相同時，按指定段考科目比較；全部相同則並列。 */
function compareClassRank_(a, b) {
  if (a.total !== b.total) return b.total - a.total;
  for (let i = 0; i < a.tieScores.length; i++) {
    const av = a.tieScores[i] === null ? 0 : a.tieScores[i];
    const bv = b.tieScores[i] === null ? 0 : b.tieScores[i];
    if (av !== bv) return av > bv ? -1 : 1;
  }
  return 0;
}

function classReport_(payload) {
  const ysem = reportSemester_(payload.ysem);
  const stage = String(payload.stage || '').trim();
  if (!stage || stage.length > 40) throw new Error('請輸入階段名稱，最多 40 字');
  if (!Array.isArray(payload.exams) || !payload.exams.length || payload.exams.length > 50) {
    throw new Error('請指定科目與段考場次');
  }
  const data = reportDataset_(ysem);
  const selected = Object.create(null), columns = [];
  payload.exams.forEach(function (e) {
    const subject = data.subjects.find(function (s) {
      return s.code.toUpperCase() === String(e.subject || '').toUpperCase();
    });
    if (!subject || selected[subject.code.toUpperCase()]) throw new Error('科目不存在或重複');
    const exam = subject.exams.find(function (x) {
      return x.examDate === e.examDate && x.examScope === e.examScope;
    });
    const noExam = !subject.exams.length && e.examDate === '' && e.examScope === '';
    if (!exam && !noExam) throw new Error('找不到所選場次：' + subject.na);
    const item = { subject: subject.code, subjectNA: subject.na, examDate: exam ? exam.examDate : '',
      examScope: exam ? exam.examScope : '', display: e.display === true, scores: Object.create(null) };
    selected[subject.code.toUpperCase()] = item;
    if (item.display) columns.push(item);
  });
  if (!columns.length) throw new Error('請至少勾選一科顯示並計入總分');
  const tieNames = ['國文', '英文', '數學', '自然', '歷史', '地理', '公民'];
  if (!Array.isArray(payload.tieSubjects) || payload.tieSubjects.length !== 7) {
    throw new Error('請設定七科的同分比較科目');
  }
  const tieSubjects = payload.tieSubjects.map(function (code) {
    const key = String(code || '').toUpperCase();
    if (key && !selected[key]) throw new Error('同分比較科目須先指定段考場次');
    return key;
  });
  const mapped = tieSubjects.filter(Boolean);
  if (new Set(mapped).size !== mapped.length) throw new Error('同分比較不可重複使用同一科目');
  data.grades.forEach(function (r) {
    const item = selected[subjectCodeOf_(r.Subject).toUpperCase()];
    if (!item || examDateStr_(r.Exam_Date) !== item.examDate || String(r.Exam_Scope || '').trim() !== item.examScope) return;
    const id = String(r.Student_ID || '').trim(), raw = r.Score;
    const value = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : null;
    item.scores[id] = value !== null && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
  });
  const roster = reportRows_(CFG.SHEETS.STUDENTS, CFG.HEADERS.STUDENTS)
    .filter(function (r) { return String(r.Ysem).trim() === ysem && String(r.Student_ID || '').trim(); });
  const ids = new Set();
  const rows = roster.map(function (r) {
    const id = String(r.Student_ID).trim();
    if (ids.has(id)) throw new Error('名單有重複學號，請先確認資料：' + id);
    ids.add(id);
    function score(item) { return Object.prototype.hasOwnProperty.call(item.scores, id) ? item.scores[id] : null; }
    const scores = columns.map(score);
    return { seatNo: Number(r.Seat_No) || 0, studentId: id, name: String(r.Name || '').trim(),
      scores: scores, total: scores.reduce(function (a, b) { return a + (b === null ? 0 : b); }, 0),
      tieScores: tieSubjects.map(function (key) { return key ? score(selected[key]) : null; }), rank: null };
  });
  const ranked = rows.slice().sort(compareClassRank_);
  ranked.forEach(function (r, i) {
    r.rank = i > 0 && compareClassRank_(r, ranked[i - 1]) === 0 ? ranked[i - 1].rank : i + 1;
  });
  rows.sort(function (a, b) { return a.seatNo - b.seatNo || a.studentId.localeCompare(b.studentId); });
  return { ysem: ysem, stage: stage, columns: columns.map(function (c) {
    return { subject: c.subject, subjectNA: c.subjectNA, examDate: c.examDate, examScope: c.examScope };
  }), rows: rows, rankedCount: ranked.length,
    tieOrder: tieNames.map(function (name, i) {
      return { name: name, subjectNA: tieSubjects[i] ? selected[tieSubjects[i]].subjectNA : '' };
    }) };
}
