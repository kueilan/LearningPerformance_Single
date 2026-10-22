const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const properties = { SPREADSHEET_ID: 'existing-database' };
  const tables = {
    Semester_TA_List: [['Ysem', 'Subject', 'Subject_NA', 'TA_Password']],
    Students: [['Ysem', 'Seat_No', 'Student_ID', 'Name', 'Auth_Code']],
    Grades: [['Ysem', 'Seat_No', 'Student_ID', 'Name', 'Subject', 'Exam_Date', 'Score', 'Exam_Scope']]
  };
  const codes = ['Chi', 'Eng', 'Math', 'Sci', 'Hist', 'Geo', 'Civ', 'Other'];
  const names = ['國文', '英文', '數學', '自然', '歷史', '地理', '公民', '其他'];
  codes.forEach((c, i) => tables.Semester_TA_List.push(['1151', '1151_' + c, names[i], 'private']));
  ['A', 'B', 'C'].forEach((id, i) => {
    tables.Students.push(['1151', i + 1, id, '學生' + id, 'secret-code']);
    codes.forEach(c => tables.Grades.push(['1151', i + 1, id, '學生' + id, '1151_' + c, '2026-10-01', 80, '第一次段考']));
  });
  let propertyWrites = 0, lockReleases = 0;
  const ctx = vm.createContext({ console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] || null,
      setProperty: (key, value) => { propertyWrites++; assert.equal(key, 'ANNOUNCEMENTS_V1'); properties[key] = value; } }) },
    SpreadsheetApp: { openById: id => {
      assert.equal(id, 'existing-database');
      return {getSheetByName: name => tables[name] ? {getDataRange: () => ({getValues: () => tables[name]})} : null};
    } },
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {lockReleases++;}})},
    Utilities: {getUuid: () => 'new-id', newBlob: text => ({getBytes: () => Buffer.from(text)})},
    subjectCodeOf_: value => String(value).split('_').pop(), resetReadMemo_() {},
    requireAuth_: token => { if (!token) throw new Error('登入必要'); return {role:token}; }
  });
  ['Code.gs', 'Grades.gs', 'ClassReport.gs', 'Announcements.gs'].forEach(name => vm.runInContext(fs.readFileSync('src/' + name, 'utf8'), ctx));
  const payload = {ysem:'1151', stage:'第一次段考', exams:codes.map(subject => ({subject,
    examDate:'2026-10-01', examScope:'第一次段考', display:subject === 'Other'})), tieSubjects:codes.slice(0, 7)};
  function score(id, code, value) { tables.Grades.find(r => r[2] === id && r[4] === '1151_' + code)[6] = value; }
  return {ctx, tables, properties, payload, score, writes:() => propertyWrites, releases:() => lockReleases};
}

test('same totals compare each of the seven tie subjects in the requested order', () => {
  for (let index = 0; index < 7; index++) {
    const f = fixture();
    f.score('B', f.payload.tieSubjects[index], 90);
    for (let later = index + 1; later < 7; later++) f.score('A', f.payload.tieSubjects[later], 100);
    const before = JSON.stringify(f.tables);
    const report = f.ctx.classReport_(f.payload);
    assert.equal(JSON.stringify(f.tables), before);
    assert.equal(report.rows.find(r => r.studentId === 'B').rank, 1);
    assert.equal(f.writes(), 0);
    assert(!JSON.stringify(report).includes('secret-code'));
  }
});

test('total takes priority; identical scores share rank with competition gaps', () => {
  const f = fixture();
  f.score('C', 'Other', 70); f.score('C', 'Chi', 100);
  const report = f.ctx.classReport_(f.payload);
  assert.deepEqual(Array.from(report.rows, r => r.rank), [1, 1, 3]);
});

test('missing scores count as zero for totals and tie-breaking while retaining the missing marker', () => {
  const f = fixture();
  f.score('C', 'Other', ''); f.score('A', 'Chi', ''); f.score('B', 'Chi', 0);
  const report = f.ctx.classReport_(f.payload);
  assert.deepEqual(Array.from(report.rows, r => r.rank), [1, 1, 3]);
  assert.equal(report.rows[2].total, 0);
  assert.equal(report.rows[2].scores[0], null);
  assert.equal(report.rankedCount, 3);
});

test('all missing scores and actual zero scores share a rank without changing stored grades', () => {
  const f = fixture();
  for (const code of ['Chi', 'Eng', 'Math', 'Sci', 'Hist', 'Geo', 'Civ', 'Other']) {
    f.score('A', code, ''); f.score('B', code, 0);
  }
  const before = JSON.stringify(f.tables);
  const report = f.ctx.classReport_(f.payload);
  assert.deepEqual(Array.from(report.rows, r => r.rank), [2, 2, 1]);
  assert.equal(report.rows[0].scores[0], null);
  assert.equal(report.rows[1].scores[0], 0);
  assert.equal(JSON.stringify(f.tables), before);
  assert.equal(f.writes(), 0);
});

test('a subject without any exam remains visible as missing and contributes zero without writes', () => {
  const f = fixture();
  f.tables.Grades = f.tables.Grades.filter((r, i) => i === 0 || r[4] !== '1151_Other');
  const exam = f.payload.exams.find(e => e.subject === 'Other');
  exam.examDate = ''; exam.examScope = '';
  const before = JSON.stringify(f.tables);
  const report = f.ctx.classReport_(f.payload);
  assert.deepEqual(Array.from(report.rows, r => r.total), [0, 0, 0]);
  assert.deepEqual(Array.from(report.rows, r => r.rank), [1, 1, 1]);
  assert(report.rows.every(r => r.scores[0] === null));
  assert.equal(JSON.stringify(f.tables), before);
  assert.equal(f.writes(), 0);
});

test('only exact selected exam contributes; last duplicate grade wins; other semesters excluded', () => {
  const f = fixture();
  f.tables.Grades.push(['1151', 1, 'A', '學生A', '1151_Other', '2026-10-02', 100, '第一次段考']);
  f.tables.Grades.push(['1151', 1, 'A', '學生A', '1151_Other', '2026-10-01', 1, '其他範圍']);
  f.tables.Grades.push(['1152', 1, 'A', '學生A', '1152_Other', '2026-10-01', 100, '第一次段考']);
  f.tables.Grades.push(['1151', 1, 'A', '學生A', '1151_Other', '2026-10-01', 85, '第一次段考']);
  assert.equal(f.ctx.classReport_(f.payload).rows[0].total, 85);
  assert.equal(f.ctx.classReport_(f.payload).rows[0].rank, 1);
});

test('blank or malformed stored scores are marked missing and counted as zero', () => {
  for (const raw of ['   ', true, false, 'NaN', -1, 101, 80.5]) {
    const f = fixture(); f.score('A', 'Other', raw);
    const row = f.ctx.classReport_(f.payload).rows[0];
    assert.equal(row.scores[0], null);
    assert.equal(row.total, 0);
    assert.equal(row.rank, 3);
  }
});

test('invalid selections and duplicate roster are rejected without writing', () => {
  const f = fixture();
  f.payload.exams[0].examDate = '2026-01-01';
  assert.throws(() => f.ctx.classReport_(f.payload), /找不到所選場次/);
  f.payload.exams[0].examDate = '2026-10-01';
  f.tables.Students.push(f.tables.Students[1]);
  assert.throws(() => f.ctx.classReport_(f.payload), /重複學號/);
  assert.equal(f.writes(), 0);
});

test('new report reader fails safely on missing database or sheet; never creates replacements', () => {
  const f = fixture();
  delete f.properties.SPREADSHEET_ID;
  assert.throws(() => f.ctx.classReportOptions_('1151'), /尚未設定/);
  f.properties.SPREADSHEET_ID = 'existing-database'; delete f.tables.Grades;
  assert.throws(() => f.ctx.classReportOptions_('1151'), /找不到資料工作表/);
  assert.equal(f.writes(), 0);
});

test('admin APIs deny anonymous, student and TA; public announcements work anonymously', () => {
  const f = fixture();
  for (const token of ['', 'student', 'ta']) {
    for (const action of ['classReport', 'classReportOptions', 'adminAnnouncements', 'saveAnnouncement']) {
      assert.equal(f.ctx.api(action, {...f.payload, token}).ok, false);
    }
  }
  assert.equal(f.ctx.api('publicAnnouncements', {}).ok, true);
  assert.equal(f.writes(), 0);
});

test('announcement publishing, unpublishing and conflict checks preserve other properties and hide drafts', () => {
  const f = fixture();
  const created = f.ctx.saveAnnouncement_({revision:0, title:'<img onerror=alert(1)>', body:'純文字\n第二行', published:false});
  assert.equal(f.ctx.publicAnnouncements_().length, 0);
  f.ctx.saveAnnouncement_({id:created.items[0].id, revision:1, title:'公告', body:'內容', published:true});
  assert.equal(f.ctx.publicAnnouncements_().length, 1);
  assert.throws(() => f.ctx.saveAnnouncement_({id:'new-id', revision:1, title:'舊公告', body:'舊內容', published:true}), /其他視窗/);
  assert.equal(f.ctx.publicAnnouncements_()[0].title, '公告');
  f.ctx.saveAnnouncement_({id:'new-id', revision:2, title:'公告', body:'內容', published:false});
  assert.equal(f.ctx.publicAnnouncements_().length, 0);
  assert.equal(f.properties.SPREADSHEET_ID, 'existing-database');
  assert.equal(f.releases(), 4);
});

test('all server scripts and inline scripts parse; new server helpers are private', () => {
  for (const name of fs.readdirSync('src')) {
    const source = fs.readFileSync('src/' + name, 'utf8');
    if (name.endsWith('.gs')) new vm.Script(source, {filename:name});
    if (name.endsWith('.html')) for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1], {filename:name});
  }
  for (const name of ['ClassReport.gs', 'Announcements.gs']) {
    for (const m of fs.readFileSync('src/' + name, 'utf8').matchAll(/^function\s+(\w+)\(/gm)) assert(m[1].endsWith('_'));
  }
});
