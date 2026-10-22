const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
const source = fs.readFileSync('src/ClassReportPdf.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
vm.runInContext(source, context);
function report(subjectCount = 7) {
  return {ysem:'1151', stage:'第一次段考', columns:Array.from({length:subjectCount}, (_, i) => ({subjectNA:'科目' + i})),
    rows:[{seatNo:1, studentId:'001', name:'王小明', scores:Array.from({length:subjectCount}, (_, i) => i ? 80 : null), total:480, rank:2}]};
}
test('PDF field options work in all eight combinations and preserve source data', () => {
  for (const showName of [false, true]) for (const showRank of [false, true]) for (const parentSignature of [false, true]) {
    const data = report(); const before = JSON.stringify(data);
    const groups = context.classReportPdfGroups(data, {showName, showRank, parentSignature});
    for (const group of groups) {
      assert.equal(group.headers.includes('學生姓名'), showName);
      assert.equal(group.headers.includes('名次'), showRank);
      assert.equal(group.headers.includes('家長簽名'), false);
      assert.equal(group.rows[0].includes('王小明'), showName);
      assert(group.rows[0].includes('0（缺成績）'));
      assert.equal(group.rows[0].length, group.headers.length);
    }
    assert.equal(JSON.stringify(data), before);
  }
});
test('wide reports split into readable portrait column groups without losing subjects', () => {
  const data = report(50);
  const groups = context.classReportPdfGroups(data, {parentSignature:true});
  const subjects = [];
  groups.forEach(group => {
    assert(Math.abs(Array.from(group.widths).reduce((a, b) => a + b, 0) - 718) < 0.001);
    group.headers.forEach((label, i) => { if (label.startsWith('科目')) { subjects.push(label); assert(group.widths[i] >= 46); } });
    assert(group.headers.includes('學生姓名'));
    assert(!group.headers.includes('家長簽名'));
  });
  assert.deepEqual(subjects, data.columns.map(c => c.subjectNA));
});
test('pagination preserves every complete row and handles exact page boundaries', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(context.paginateClassReportPdf([40, 60, 100, 10], 100))), [[0, 1], [2], [3]]);
  assert.throws(() => context.paginateClassReportPdf([101], 100), /超出/);
});
test('pagination reserves signature space only on the last page without losing rows', () => {
  const paginate = (rows, capacity, reserve) => JSON.parse(JSON.stringify(context.paginateClassReportPdf(rows, capacity, reserve)));
  assert.deepEqual(paginate([40, 40], 100, 20), [[0, 1]]);
  assert.deepEqual(paginate([40, 40, 20], 100, 30), [[0], [1, 2]]);
  assert.deepEqual(paginate([50, 50, 40, 40], 100, 30), [[0, 1], [2], [3]]);
  // An exceptionally tall row remains intact even when the signature needs its own final page.
  assert.deepEqual(paginate([95], 100, 20), [[0], []]);
  assert.throws(() => paginate([], 100, 101), /簽名區/);
});

// Exercise the actual renderer with a minimal layout/canvas adapter, without a browser or Google services.
async function render(rowCount, parentSignature = true, subjectCount = 7) {
  const images = [], footers = [], pages = [], html = [], renderedHtml = [];
  let current = '';
  const rowCountInHtml = () => (current.match(/<td /g) || []).length / (current.match(/<col style/g) || []).length;
  const height = () => 58 + rowCountInHtml() * 36 + (current.includes('data-parent-signature') ? 102 : 0);
  const host = {style:{}, firstChild:{getBoundingClientRect:() => ({height:height()})},
    querySelectorAll:() => Array.from({length:(current.match(/<td /g) || []).length / (current.match(/<col style/g) || []).length}, () => ({getBoundingClientRect:() => ({height:36})}))};
  Object.defineProperty(host, 'innerHTML', {set(value) { current = value; if (value) html.push(value); }});
  const body = {appendChild(node) {node.parentNode = body;}, removeChild(node) {node.parentNode = null;}};
  const ctx = vm.createContext({document:{body, createElement:() => host}, esc:s => String(s == null ? '' : s),
    html2canvas:async () => { renderedHtml.push(current); return {width:1436, height:height() * 2, toDataURL:() => 'data:image/jpeg;base64,mock'}; },
    window:{jspdf:{jsPDF:function (options) {
      assert.equal(options.orientation, 'portrait'); assert.equal(options.format, 'a4');
      this.addPage = () => pages.push(1); this.addImage = (...args) => images.push(args);
      this.setFontSize = () => {}; this.setTextColor = () => {};
      this.text = (...args) => footers.push(args); this.save = () => {};
    }}}});
  vm.runInContext(source, ctx);
  const data = report(subjectCount); data.rows = Array.from({length:rowCount}, () => data.rows[0]);
  await ctx.exportClassReportPdf(data, {parentSignature});
  assert.equal(host.parentNode, null);
  assert(html.every(s => !s.includes('同分比較') && !s.includes('產生時間') && !s.includes('考試範圍')));
  assert.equal(renderedHtml.filter(s => s.includes('data-parent-signature')).length, parentSignature ? 1 : 0);
  if (parentSignature) assert(renderedHtml[renderedHtml.length - 1].includes('data-parent-signature'));
  assert(renderedHtml.every(s => !s.includes('>家長簽名</th>')));
  return {count:images.length, footers, renderedHtml};
}
test('actual renderer omits numbering for one/two pages, numbers every page when there are more than two', async () => {
  for (const count of [3, 45, 70]) {
    const rendered = await render(count);
    const expected = count === 3 ? 1 : count === 45 ? 2 : 3;
    assert.equal(rendered.count, expected);
    assert.equal(rendered.footers.length, expected > 2 ? expected : 0);
    if (expected > 2) assert.deepEqual(Array.from(rendered.footers, f => f[0]), ['1 / 3', '2 / 3', '3 / 3']);
  }
});
test('signature appears once across multiple subject groups and can be omitted', async () => {
  const wide = await render(27, true, 50);
  const groups = context.classReportPdfGroups(report(50), {});
  assert.equal(wide.renderedHtml.reduce((n, s) => n + (s.match(/<td /g) || []).length / (s.match(/<col style/g) || []).length, 0), 27 * groups.length);
  const without = await render(27, false);
  const withSignature = await render(27, true);
  assert.equal(without.count, 2);
  assert.equal(withSignature.count, 2);
  // 25 students exactly fit the table-only page, but the signature must push trailing rows to a second page.
  assert.equal((await render(25, false)).count, 1);
  assert.equal((await render(25, true)).count, 2);
});
