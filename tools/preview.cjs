// Local preview with in-memory sample data. No Google services are contacted.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const countArg = process.argv.find(arg => arg.startsWith('--students='));
const portArg = process.argv.find(arg => arg.startsWith('--port='));
const studentCount = countArg ? Number(countArg.split('=')[1]) : 3;
const port = portArg ? Number(portArg.split('=')[1]) : 8765;
const examHistory = process.argv.includes('--exam-history');
if (!Number.isInteger(studentCount) || studentCount < 1 || studentCount > 2000) throw new Error('students must be 1–2000');
const headers = {
  Semester_TA_List:['Ysem','Subject','Subject_NA','TA_Password'],
  Students:['Ysem','Seat_No','Student_ID','Name','Auth_Code'],
  Grades:['Ysem','Seat_No','Student_ID','Name','Subject','Exam_Date','Score','Exam_Scope']
};
const tables = Object.fromEntries(Object.entries(headers).map(([name, row]) => [name, [row]]));
const subjects = [['Chi','國文'],['Eng','英文'],['Math','數學'],['Sci','自然'],['Hist','歷史'],['Geo','地理'],['Civ','公民']];
subjects.forEach(([code, name]) => tables.Semester_TA_List.push(['1151','1151_' + code,name,'demo']));
Array.from({length:studentCount}, (_, i) => ['示範學生甲','示範學生乙','示範學生丙'][i] || '示範學生' + (i + 1)).forEach((name, i) => {
  tables.Students.push(['1151',i + 1,'DEMO' + (i + 1),name,'demo']);
  subjects.forEach(([code], j) => tables.Grades.push(['1151',i + 1,'DEMO' + (i + 1),name,'1151_' + code,'2026-10-01',i === 2 && j === 6 ? '' : 80 + (i === 0 && j === 0 ? 5 : i === 1 && j === 1 ? 5 : 0),'第一次段考']));
});
if (examHistory) {
  const original = tables.Grades.slice(1);
  original.forEach(row => {
    tables.Grades.push([...row.slice(0, 5), '2026-09-15', row[6], '開學複習']);
    const subjectIndex = subjects.findIndex(([code]) => row[4] === '1151_' + code);
    tables.Grades.push([...row.slice(0, 5), subjectIndex % 2 ? '2026-10-16' : '2026-10-15', row[6], '第二次段考']);
    if (subjectIndex === 6) tables.Grades.push([...row.slice(0, 5), '2026-10-15', row[6], '第二次段考補充']);
  });
}
const properties = {SPREADSHEET_ID:'local-demo', ANNOUNCEMENTS_V1:JSON.stringify({revision:1,items:[
  {id:'demo-notice',title:'段考成績查詢提醒',body:'本頁為本機模擬預覽。\n可使用 demo-admin 登入查看公告管理與全班成績單。',published:true,updatedAt:'2026-10-13T01:00:00Z'}
]})};
const context = vm.createContext({console, Buffer,
  PropertiesService:{getScriptProperties:() => ({getProperty:key => properties[key] || null,setProperty:(key,value) => {properties[key] = value;}})},
  SpreadsheetApp:{openById:() => ({getSheetByName:name => ({getDataRange:() => ({getValues:() => tables[name]})})})},
  LockService:{getScriptLock:() => ({waitLock(){},releaseLock(){}})},
  Utilities:{getUuid:() => require('node:crypto').randomUUID(),newBlob:text => ({getBytes:() => Buffer.from(text)})},
  subjectCodeOf_:value => String(value).split('_').pop(), resetReadMemo_(){},
  requireAuth_:token => {if (token !== 'demo-token') throw new Error('請先使用示範帳號登入'); return {role:'admin',label:'示範導師'};},
  login_:code => {if (code !== 'demo-admin') throw new Error('本機預覽驗證碼：demo-admin'); return {token:'demo-token',profile:{role:'admin',label:'示範導師'}};},
  listYsems_:() => ['1151'], listSemesters_:() => [], logout_(){},
});
for (const name of ['Code.gs','Grades.gs','ClassReport.gs','Announcements.gs']) vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),context);
function expand(name) {
  return fs.readFileSync(path.join(root,'src',name.endsWith('.html') ? name : name + '.html'),'utf8')
    .replace(/<\?!=\s*include_\('([^']+)'\)\s*\?>/g,(_,child) => expand(child))
    .replace(/<\?!=\s*defaultSubjectsText_\(\)\s*\?>/g, subjects.map(s => s.join(', ')).join('\n'));
}
const override = `<div style="position:fixed;bottom:0;right:0;z-index:100;background:#fef3c7;padding:8px;font:14px sans-serif">本機模擬預覽｜驗證碼 demo-admin｜不連線到 Google 資料</div>
<script>window.rpc=function(action,payload){payload=payload||{};if(APP.token)payload.token=APP.token;return fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,payload:payload})}).then(function(r){return r.json();}).then(function(r){if(!r.ok)throw r.msg;return r.data;});};</script>`;
const html = expand('Index').replace('</body>',override + '</body>');
http.createServer((req,res) => {
  if (req.url === '/' && req.method === 'GET') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); return;}
  if (req.url === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data',chunk => {body += chunk; if (body.length > 20000) req.destroy();});
    req.on('end',() => {
      let result;
      try {const request = JSON.parse(body); result = context.api(request.action,request.payload);}
      catch (err) {result = {ok:false,msg:err.message};}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404);res.end();
}).listen(port,'127.0.0.1',() => console.log('Local sample preview: http://127.0.0.1:' + port + ' — demo-admin (' + studentCount + ' students)'));
