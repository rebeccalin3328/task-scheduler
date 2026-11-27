// CRM backend tests: node test-crm.js
// Runs crm-script.gs against a fake airnergy_crm_backend (made-up data, real column names) and a fake, empty CRM sheet.
const fs = require('fs'), vm = require('vm'), assert = require('assert');

function fakeSheet(tabs, patch) {
  const source = {}, sheets = {};
  Object.keys(tabs).forEach(n => { source[n] = { rows: tabs[n].map(r => r.slice()) }; });
  const api = sh => ({
    getDataRange: () => ({ getValues: () => sh.rows.map(r => r.slice()) }),
    appendRow: r => { sh.writes = (sh.writes || 0) + 1; sh.rows.push(r.slice()); },
    setFrozenRows() {},
    getRange: (row, col, nr, nc) => ({
      setValue: v => { sh.writes = (sh.writes || 0) + 1; sh.rows[row - 1][col - 1] = v; },
      setValues: vals => { sh.writes = (sh.writes || 0) + 1; vals.forEach((r, i) => { sh.rows[row - 1 + i] = sh.rows[row - 1 + i] || []; r.forEach((v, j) => { sh.rows[row - 1 + i][col - 1 + j] = v; }); }); }
    })
  });
  const props = {};
  // Private Reference spreadsheet, and fake web pages for UrlFetchApp
  const refSheets = {}, pages = {}, fetched = [];
  const refSS = { getId: () => 'ref-sheet', getSheetByName: nm => refSheets[nm] && api(refSheets[nm]), insertSheet: nm => api(refSheets[nm] = { rows: [] }) };
  // Fake Google Calendar
  const gcals = {};
  const mkCal = (id, name) => {
    const evs = [];
    const cal = { id, name, evs, getId: () => id, getName: () => name, getColor: () => '#039be5', setName(n) { name = n; }, setColor(c) { cal.color = c; },
      getEvents: (a, b) => evs.filter(e => !e.gone && e.end > a && e.start < b).map(wrap),
      getEventById: gid => wrap(evs.find(e => e.id === gid)),
      createEvent: (t, s0, e0, o) => wrap(evs[evs.push({ id: 'gev' + evs.length, title: t, start: s0, end: e0, allDay: false, desc: o.description }) - 1]),
      createAllDayEvent: (t, s0, e0, o) => wrap(evs[evs.push({ id: 'gev' + evs.length, title: t, start: s0, end: e0, allDay: true, desc: o.description }) - 1]) };
    const wrap = e => e && ({ getId: () => e.id, getTitle: () => e.title, getDescription: () => e.desc || '', getLocation: () => '',
      getStartTime: () => e.start, getEndTime: () => e.end, isAllDayEvent: () => e.allDay, setTitle: v => { e.title = v; },
      setDescription: v => { e.desc = v; }, setLocation() {}, setTime: (a, b) => { e.start = a; e.end = b; }, setAllDayDates: (a, b) => { e.start = a; e.end = b; },
      deleteEvent: () => { e.gone = true; }, removeAllReminders: () => { e.rem = []; }, addPopupReminder: m => { (e.rem = e.rem || []).push(m); } });
    return (gcals[id] = cal);
  };
  mkCal('sales@group.calendar.google.com', 'Sales');
  mkCal('personal@group.calendar.google.com', 'Rebecca personal');
  // Fake Google Drive
  const drive = { folders: {} };
  const mkFolder = name => {
    const f = { id: 'fold' + Object.keys(drive.folders).length, name, files: [], editors: [], sharing: null };
    drive.folders[f.id] = f;
    return { getId: () => f.id, addEditor: e => f.editors.push(e), setSharing: (a, p) => { f.sharing = a + '/' + p; },
      getFilesByName: n => { const m = f.files.filter(x => x.name === n); return { hasNext: () => m.length > 0 }; },
      createFile: blob => { const x = Object.assign({ id: 'file' + f.files.length }, blob); f.files.push(x);
        return { getId: () => x.id, getUrl: () => 'https://drive.google.com/file/d/' + x.id, setDescription: d => { x.desc = d; } }; } };
  };
  const folderApi = {};
  let n = 0;
  const ctx = {
    SpreadsheetApp: {
      openById: id => id === 'ref-sheet' ? refSS : ({ getSheetByName: nm => source[nm] && api(source[nm]) }),
      create: name => { refSS.name = name; return refSS; },
      getActiveSpreadsheet: () => ({ getSheetByName: nm => sheets[nm] && api(sheets[nm]), insertSheet: nm => api(sheets[nm] = { rows: [] }) })
    },
    DriveApp: { createFolder: n => { const f = mkFolder(n); folderApi[f.getId()] = f; return f; }, getFolderById: id => { if (!folderApi[id]) throw new Error('gone'); return folderApi[id]; },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' } },
    CalendarApp: { getCalendarById: id => gcals[id] || null, getAllCalendars: () => Object.values(gcals),
      createCalendar: name => mkCal('new' + Object.keys(gcals).length + '@group.calendar.google.com', name) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: { fetch: (url, o) => { fetched.push(url); const pg = pages[url] || { code: 404, body: 'not found', type: 'text/html' };
      return { getResponseCode: () => pg.code || 200, getHeaders: () => ({ 'Content-Type': pg.type || 'text/html; charset=utf-8' }),
        getContentText: () => pg.body, getBlob: () => ({ getBytes: () => new Array(pg.size || 2048) }) }; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }), getDocumentLock: () => ({ waitLock() {}, releaseLock() {}, doc: true }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      formatDate: (d, tz, f) => { const p = x => String(x).padStart(2, '0');
        return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
          .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())); },
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      getUuid: () => (++n).toString(16).padStart(8, '0') + '-aaaa-bbbb-cccc-dddddddddddd'
    },
    Session: { getScriptTimeZone: () => 'Asia/Kuala_Lumpur' }, JSON, String, Object, Math, Date
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(__dirname + '/crm-script.gs', 'utf8');
  vm.runInContext(patch ? patch(code) : code, ctx);
  return { sheets, source, props, gcals, drive, refSheets, refSS, pages, fetched, ctx, call: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text) };
}

const tabs = {
  Contact: [['ContactID', 'Source', 'AccNo', 'CompanyName', 'PIC', 'Phone', 'PrimaryEmail', 'Address', 'CreditTerm', 'CreditLimit', 'IsActive', 'AssignedAgent', 'DefaultServiceBranch', 'CRMTags', 'CRMNotes', 'LastSyncedAt'],
    ['c-aaaaaaaaaaaa', 'AutoCount Debtor', '300-0001', 'ALPHA SDN BHD', 'Mr Tan', '+6012-3223360', 'tan@alpha.my', 'Shah Alam', 'Net 30 days', 30000, true, '', '', 'VIP', '', '2026-10-21 23:05'],
    ['c-bbbbbbbbbbbb', 'AutoCount Debtor', '300-0002', 'BETA ENGINEERING', 'Mr. Loo', '06-764 1973 / 017-277 2470', 'beta@gmail.com;acc@beta.my', 'Melaka', 'Net 30 days', 30000, true, '', '', '', '', '2026-10-21 23:05']],
  ContactPerson: [['PersonID', 'ContactID', 'FullName', 'Role', 'Phone', 'Email', 'IsPrimary', 'Notes'],
    ['p-111111111111', 'c-aaaaaaaaaaaa', 'Adam', 'Purchaser', '019-876 5432', '', false, '']],
  User: [['UserID', 'FullName', 'Email', 'Phone', 'Role', 'Department', 'Branch', 'IsActive', 'EPF No', 'SOCSO No', 'Tax No (LHDN)', 'JoinDate', 'ResignDate', 'BankName', 'SWIFT CODE', 'BankAccount'],
    ['U-SECRET-1', 'Rebecca Lin', 'rebecca@example.my', '', 'Admin', '', '', true, 'EPF-SECRET', '', '', '', '', 'Bank', '', 'ACCT-SECRET']],
  Task: [['TaskID', 'Title', 'Description', 'ContactID', 'LeadID', 'ServiceJobID', 'AssignedTo', 'CreatedBy', 'DueDate', 'Priority', 'Status', 'BlockedReason', 'CompletedAt', 'CreatedAt']],
  Activity: [['ActivityID', 'Timestamp', 'UserID', 'ActionType', 'ContactID', 'LeadID', 'TaskID', 'ServiceJobID', 'Description', 'Attachment']]
};

const masterBefore = JSON.stringify(tabs);
const G = fakeSheet(tabs), key = 'change-me', me = 'Rebecca@example.my';
const call = b => G.call(Object.assign({ key, me }, b));
const rows = n => G.sheets[n].rows;

assert.equal(G.call({ key: 'x', action: 'list' }).ok, false, 'wrong key is refused');

// Known company by its phone, written differently
let r = call({ action: 'save', client: { name: 'Mr Tan', phone: '012-322 3360' }, task: { title: 'Send quote', due: '2026-11-23 10:00', ref: 'r1' } });
assert.ok(r.ok, r.error); assert.equal(r.id, 'c-aaaaaaaaaaaa'); assert.equal(r.created, false);
assert.equal(rows('Task').length, 2);
const task = rows('Task')[1];
assert.equal(task[0], 'T-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-001');
assert.equal(task[3], 'c-aaaaaaaaaaaa'); assert.equal(task[6], 'U-SECRET-1'); assert.equal(task[10], 'New');
assert.ok(task[8] instanceof Date && task[8].getHours() === 10);
assert.equal(rows('Contact')[1][11], 'Rebecca Lin', 'empty agent gets the person adding the task');

// Resent save (lost connection) does not add a second task
call({ action: 'save', client: { phone: '012-322 3360' }, task: { title: 'Send quote', due: '2026-11-23 10:00', ref: 'r1' } });
assert.equal(rows('Task').length, 2);

// Contact person's phone and a second number in the same cell both match
assert.equal(call({ action: 'save', client: { phone: '+60 19-876 5432' } }).id, 'c-aaaaaaaaaaaa');
assert.equal(call({ action: 'save', client: { phone: '0172772470' } }).id, 'c-bbbbbbbbbbbb');
assert.equal(call({ action: 'save', client: { email: 'ACC@beta.my' } }).id, 'c-bbbbbbbbbbbb');

// New person at a known company (matched by company name) becomes a ContactPerson
call({ action: 'save', client: { name: 'Siti', phone: '011-1234 5678', company: 'beta engineering' } });
assert.equal(rows('ContactPerson').length, 3); assert.equal(rows('ContactPerson')[2][1], 'c-bbbbbbbbbbbb');

// Unknown number becomes a new WhatsApp contact with status in CRMTags, and a backup in Activity
r = call({ action: 'save', client: { name: 'Ali', phone: '013-999 8888', status: 'Prospect' }, task: { title: 'Site visit', due: '2026-11-25', ref: 'r2' } });
assert.ok(r.created); const newId = r.id;
let row = rows('Contact').find(x => x[0] === newId);
assert.equal(row[1], 'WhatsApp'); assert.equal(row[3], 'Ali'); assert.equal(row[13], 'Prospect');

// Status change keeps other tags; AutoCount details can't be edited from the app
call({ action: 'save', client: { id: 'c-aaaaaaaaaaaa', status: 'Customer', notes: 'Wants bulk discount', company: 'HACKED', edit: true } });
row = rows('Contact')[1];
assert.equal(row[13], 'Customer, VIP'); assert.equal(row[14], 'Wants bulk discount'); assert.equal(row[3], 'ALPHA SDN BHD');

// List: no private User data goes out
const l = call({ action: 'list' });
assert.equal(l.me, 'Rebecca Lin'); assert.deepEqual(l.team, ['Rebecca Lin']);
assert.equal(l.clients.length, 3); assert.equal(l.clients[0].status, 'Customer'); assert.equal(l.clients[0].people.length, 1);
assert.equal(l.tasks[0].assignee, 'Rebecca Lin');
const json = JSON.stringify(l);
['U-SECRET-1', 'EPF-SECRET', 'ACCT-SECRET'].forEach(s => assert.ok(json.indexOf(s) < 0, s + ' must not leak'));

// Mark done
assert.ok(call({ action: 'done', taskId: l.tasks[0].id }).ok);
assert.equal(rows('Task')[1][10], 'Done');

// The master sheet was never written to
assert.equal(JSON.stringify(Object.fromEntries(Object.entries(G.source).map(([k, v]) => [k, v.rows]))), masterBefore, 'airnergy_crm_backend unchanged');
assert.deepEqual(Object.keys(G.sheets).sort(), ['Activity', 'Calendar', 'Contact', 'ContactPerson', 'File', 'Picklist', 'Task'], 'CRM sheet has only the CRM tabs (no User copy)');

// Hourly copy: master changes flow in, CRM notes and WhatsApp contacts are kept
G.source.Contact.rows[1][5] = '+6012-0000000';           // AutoCount phone changed
G.source.Contact.rows[1][14] = 'note typed in AppSheet'; // master note: CRM note already set, so kept
G.source.Contact.rows.push(['c-cccccccccccc', 'AutoCount Debtor', '300-0003', 'GAMMA', '', '', '', '', '', '', true, '', '', '', '', '']);
call({ action: 'list' });
assert.equal(rows('Contact').length, 4, 'not copied again within the hour');
G.props.lastCopy = '0';
const l3 = call({ action: 'list' });
const alpha = l3.clients.find(c => c.id === 'c-aaaaaaaaaaaa');
assert.equal(alpha.phone, '+6012-0000000'); assert.equal(alpha.notes, 'Wants bulk discount'); assert.equal(alpha.status, 'Customer');
assert.ok(l3.clients.some(c => c.id === 'c-cccccccccccc'), 'new master contact copied');
assert.ok(l3.clients.some(c => c.id === newId), 'WhatsApp contact kept');
assert.equal(l3.clients.length, 4);

// ---------- Calendars ----------
// Default Team calendar, shared with everyone; admin tools refused without the admin key
let L = call({ action: 'list' });
assert.deepEqual(L.calendars.map(c => c.name), ['Team']); assert.equal(L.isAdmin, false);
assert.equal(call({ action: 'saveCalendar', calendar: { name: 'X' } }).ok, false, 'not admin: refused');
assert.equal(call({ action: 'adminInfo', adminKey: 'change-me-too' }).ok, false, 'default admin key never works');

// Admin (with the key set) creates calendars and chooses who sees them
const tabs3 = JSON.parse(masterBefore);
tabs3.User.push(['U-2', 'Siti Staff', 'siti@example.my', '', '', '', '', true, '', '', '', '', '', '', '', ''],
                ['U-3', 'Ahmad Tech', 'ahmad@example.my', '', '', '', '', true, '', '', '', '', '', '', '', '']);
const G3 = fakeSheet(tabs3, src => src.replace("var ADMIN_KEY = 'change-me-too';", "var ADMIN_KEY = 'boss';"));
const as = (email, b, adminKey) => G3.call(Object.assign({ key, me: email }, adminKey ? { adminKey } : {}, b));
const boss = b => as('rebecca@example.my', b, 'boss');

const info = boss({ action: 'adminInfo' });
assert.ok(info.ok, info.error);
assert.deepEqual(info.team.map(t => t.email), ['rebecca@example.my', 'siti@example.my', 'ahmad@example.my']);
assert.deepEqual(info.google.map(g => g.name), ['Sales', 'Rebecca personal']);
assert.equal(as('siti@example.my', { action: 'adminInfo' }, 'guess').ok, false, 'wrong admin key refused');

const service = boss({ action: 'saveCalendar', calendar: { name: 'Service', type: 'App', sharedWith: 'ahmad@example.my' } }).calendar;
const sales = boss({ action: 'saveCalendar', calendar: { name: 'Sales', type: 'Google', googleId: 'sales@group.calendar.google.com', sharedWith: 'siti@example.my, rebecca@example.my' } }).calendar;
const made = boss({ action: 'saveCalendar', calendar: { name: 'Projects', type: 'Google', sharedWith: 'Everyone' } }).calendar;
assert.ok(made.googleId && G3.gcals[made.googleId], 'new Google Calendar created');
assert.equal(boss({ action: 'saveCalendar', calendar: { name: 'Again', type: 'Google', googleId: 'sales@group.calendar.google.com' } }).ok, false, 'no double link');

const seen = email => as(email, { action: 'list' }).calendars.map(c => c.name).sort().join(',');
assert.equal(seen('siti@example.my'), 'Projects,Sales,Team');
assert.equal(seen('ahmad@example.my'), 'Projects,Service,Team');
assert.equal(seen('nobody@x.my'), 'Projects,Team');
assert.ok(!JSON.stringify(as('siti@example.my', { action: 'list' }).calendars).includes('group.calendar'), 'Google IDs hidden from staff');

// Events: app calendar and Google calendar, with access checks
assert.equal(as('siti@example.my', { action: 'addEvent', event: { calendarId: service.id, title: 'x', start: '2026-11-24T10:00' } }).ok, false, 'Siti cannot use Service');
let ev = as('ahmad@example.my', { action: 'addEvent', event: { calendarId: service.id, title: 'Aircond service', start: '2026-11-24T10:00', end: '2026-11-24T12:00', ref: 'e1' } });
assert.ok(ev.ok, ev.error);
as('ahmad@example.my', { action: 'addEvent', event: { calendarId: service.id, title: 'Aircond service', start: '2026-11-24T10:00', ref: 'e1' } });
let g = as('siti@example.my', { action: 'addEvent', event: { calendarId: sales.id, title: 'Meet ABC', start: '2026-11-25', end: '2026-11-25', allDay: true } });
assert.ok(g.ok, g.error); assert.equal(G3.gcals['sales@group.calendar.google.com'].evs.length, 1, 'written to Google Calendar');

// Imported task: first saved without a calendar, then the same link opened again with one. One task, one event.
const nTasks = () => G3.sheets.Task.rows.length, nEvents = () => G3.sheets.Event.rows.length;
as('ahmad@example.my', { action: 'save', client: { none: true }, task: { title: 'Piano exam form', due: '2026-12-01', ref: 'imp1' } });
const t0 = nTasks(), e0 = nEvents();
as('ahmad@example.my', { action: 'save', client: { none: true }, task: { title: 'Piano exam form', due: '2026-12-01', ref: 'imp1', calendarId: service.id, start: '2026-12-01', end: '2026-12-01', allDay: true } });
as('ahmad@example.my', { action: 'save', client: { none: true }, task: { title: 'Piano exam form', due: '2026-12-01', ref: 'imp1', calendarId: service.id, start: '2026-12-01', end: '2026-12-01', allDay: true } });
assert.equal(nTasks(), t0, 'reopening the import link does not add the task again');
assert.equal(nEvents(), e0 + 1, 'but puts it on the chosen calendar once');

// Reminders: Google events get a popup reminder
assert.deepEqual(G3.gcals['sales@group.calendar.google.com'].evs[0].rem, [240], 'all-day: reminder the evening before');
as('siti@example.my', { action: 'addEvent', event: { calendarId: sales.id, title: 'Timed', start: '2026-11-25T09:00' } });
assert.deepEqual(G3.gcals['sales@group.calendar.google.com'].evs[1].rem, [30], 'timed: 30 minutes before');
G3.gcals['sales@group.calendar.google.com'].evs[1].gone = true;

// Turning an app calendar into a Google Calendar copies its events over, once
const rayCal = boss({ action: 'saveCalendar', calendar: { name: 'Ray', type: 'App', sharedWith: 'boss@x.my' } }).calendar;
boss({ action: 'addEvent', event: { calendarId: rayCal.id, title: 'Piano', start: '2026-12-04T19:30', end: '2026-12-04T20:15', ref: 'p1' } });
const conv = boss({ action: 'saveCalendar', calendar: { id: rayCal.id, name: 'Ray', sharedWith: 'boss@x.my', active: true, toGoogle: true } }).calendar;
assert.equal(conv.type, 'Google'); assert.ok(G3.gcals[conv.googleId], 'Google Calendar made');
assert.equal(G3.gcals[conv.googleId].evs.length, 1, 'event copied'); assert.deepEqual(G3.gcals[conv.googleId].evs[0].rem, [30]);
boss({ action: 'saveCalendar', calendar: { id: rayCal.id, name: 'Ray', sharedWith: 'boss@x.my', active: true, toGoogle: true } });
assert.equal(G3.gcals[conv.googleId].evs.length, 1, 'not copied twice');
// ...or onto an existing Google Calendar you pick
const kid = boss({ action: 'saveCalendar', calendar: { name: 'Kid', type: 'App', sharedWith: 'boss@x.my' } }).calendar;
boss({ action: 'addEvent', event: { calendarId: kid.id, title: 'Swim', start: '2026-12-05T16:50', ref: 'k1' } });
const gBefore = Object.keys(G3.gcals).length;
const picked = boss({ action: 'saveCalendar', calendar: { id: kid.id, name: 'Kid', sharedWith: 'boss@x.my', active: true, toGoogle: conv.googleId } });
assert.equal(picked.ok, false, 'a Google Calendar already used by another calendar is refused');
const free = 'personal@group.calendar.google.com';
const ok2 = boss({ action: 'saveCalendar', calendar: { id: kid.id, name: 'Kid', sharedWith: 'boss@x.my', active: true, toGoogle: free } }).calendar;
assert.equal(ok2.googleId, free, 'linked to the chosen Google Calendar'); assert.equal(Object.keys(G3.gcals).length, gBefore, 'no new calendar made');
assert.ok(G3.gcals[free].evs.some(e => e.title === 'Swim'), 'events copied into it');
const rayEv = boss({ action: 'events', from: '2026-12-04', to: '2026-12-05' }).events.filter(e => e.calendarId === rayCal.id);
assert.equal(rayEv.length, 1, 'shown once, from Google'); assert.ok(/^g:/.test(rayEv[0].id));

// Task status and delete
const stTask = as('ahmad@example.my', { action: 'save', client: { none: true }, task: { title: 'Status test', due: '2026-12-02 09:00', ref: 'st1', calendarId: service.id, start: '2026-12-02T09:00' } });
assert.equal(as('ahmad@example.my', { action: 'taskStatus', taskId: stTask.taskId, status: 'Waiting' }).ok, true);
let found = as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === stTask.taskId);
assert.equal(found.status, 'Waiting'); assert.equal(found.completed, '');
as('ahmad@example.my', { action: 'taskStatus', taskId: stTask.taskId, status: 'Done' });
assert.ok(as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === stTask.taskId).completed, 'closing fills CompletedAt');
as('ahmad@example.my', { action: 'taskStatus', taskId: stTask.taskId, status: 'In progress' });
assert.equal(as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === stTask.taskId).completed, '', 'reopening clears it');
assert.equal(as('ahmad@example.my', { action: 'taskStatus', taskId: stTask.taskId, status: 'Bogus' }).ok, false);
assert.equal(as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === stTask.taskId).priority, 'Normal', 'default priority');
as('ahmad@example.my', { action: 'taskPriority', taskId: stTask.taskId, priority: 'Urgent' });
assert.equal(as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === stTask.taskId).priority, 'Urgent');
assert.equal(as('ahmad@example.my', { action: 'taskPriority', taskId: stTask.taskId, priority: 'Whenever' }).ok, false);
const hp = as('ahmad@example.my', { action: 'save', client: { none: true }, task: { title: 'Imported high', due: '2026-12-03', ref: 'hp1', priority: 'High' } });
assert.equal(as('ahmad@example.my', { action: 'list' }).tasks.find(t => t.id === hp.taskId).priority, 'High', 'priority can come with a new task');
const evBefore = boss({ action: 'events', from: '2026-12-02', to: '2026-12-03' }).events.filter(e => e.taskId === stTask.taskId).length;
assert.equal(evBefore, 1);
as('ahmad@example.my', { action: 'deleteTask', taskId: stTask.taskId });
assert.ok(!as('ahmad@example.my', { action: 'list' }).tasks.some(t => t.id === stTask.taskId), 'deleted task hidden');
assert.equal(boss({ action: 'events', from: '2026-12-02', to: '2026-12-03' }).events.filter(e => e.taskId === stTask.taskId).length, 0, 'its calendar entry is gone');
assert.ok(G3.sheets.Task.rows.some(r => r.includes(stTask.taskId) && r.includes('Deleted')), 'row kept, marked Deleted');

const week = email => as(email, { action: 'events', from: '2026-11-23', to: '2026-11-30' }).events.map(e => e.title + '@' + e.start).sort();
assert.deepEqual(week('ahmad@example.my'), ['Aircond service@2026-11-24T10:00']);
assert.deepEqual(week('siti@example.my'), ['Meet ABC@2026-11-25T00:00']);
assert.equal(week('rebecca@example.my').length, 1, 'Rebecca (no admin key) sees only calendars shared with her');
assert.equal(as('rebecca@example.my', { action: 'events', from: '2026-11-23', to: '2026-11-30' }, 'boss').events.length, 2, 'admin sees all');

// Task with a calendar from the New task form also creates the event, linked to the client
const t2 = as('siti@example.my', { action: 'save', client: { phone: '012-322 3360' },
  task: { title: 'Quote follow-up', due: '2026-11-26 09:00', ref: 't9', calendarId: sales.id, start: '2026-11-26T09:00', end: '2026-11-26T10:00' } });
assert.ok(t2.ok && t2.event, t2.error);
const sitiWeek = as('siti@example.my', { action: 'events', from: '2026-11-23', to: '2026-11-30' }).events;
const linked = sitiWeek.find(e => e.title === 'Quote follow-up');
assert.equal(linked.contactId, 'c-aaaaaaaaaaaa'); assert.ok(linked.taskId);

// Edit and delete
const appEv = as('ahmad@example.my', { action: 'events', from: '2026-11-23', to: '2026-11-30' }).events[0];
assert.ok(as('ahmad@example.my', { action: 'updateEvent', event: Object.assign({}, appEv, { title: 'Aircond service (2 units)', start: '2026-11-24T14:00', end: '2026-11-24T16:00' }) }).ok);
assert.deepEqual(week('ahmad@example.my'), ['Aircond service (2 units)@2026-11-24T14:00']);
assert.ok(as('siti@example.my', { action: 'deleteEvent', event: { id: linked.id } }).ok);
assert.ok(as('ahmad@example.my', { action: 'deleteEvent', event: { id: appEv.id } }).ok);
assert.deepEqual(week('ahmad@example.my'), []);
assert.deepEqual(week('siti@example.my'), ['Meet ABC@2026-11-25T00:00']);

// Unshare: Ahmad loses Service
boss({ action: 'saveCalendar', calendar: { id: service.id, sharedWith: 'siti@example.my' } });
assert.equal(seen('ahmad@example.my'), 'Projects,Team');
assert.equal(seen('siti@example.my'), 'Projects,Sales,Service,Team');
assert.equal(JSON.stringify(Object.fromEntries(Object.entries(G3.source).map(([k, v]) => [k, v.rows]))), JSON.stringify(tabs3), 'master still unchanged');


// ---------- Quick picks ----------
let P = call({ action: 'list' }).picks;
assert.deepEqual(P.roles.map(r => r.name), ['Customer', 'Supplier', 'Staff', 'Your child', 'Husband']);
assert.ok(P.topics['Your child'].includes('Piano Lesson')); assert.ok(P.phrases['*'].includes('Follow up'));
P = call({ action: 'addPick', pick: { type: 'role', value: 'Landlord', saveContact: false } }).picks;
P = call({ action: 'addPick', pick: { type: 'topic', role: 'Your child', value: 'Chinese Subject' } }).picks;
P = call({ action: 'addPick', pick: { type: 'topic', role: 'your child', value: 'piano lesson' } }).picks; // duplicate
assert.ok(P.roles.some(r => r.name === 'Landlord' && !r.saveContact));
assert.equal(P.topics['Your child'].filter(x => /piano/i.test(x)).length, 1);
assert.ok(P.topics['Your child'].includes('Chinese Subject'));
const tk = call({ action: 'save', client: { phone: '012-322 3360' }, task: { title: 'Piano Lesson: Pay fees', due: '2026-11-27', ref: 'p1', role: 'Your child', topic: 'Piano Lesson' } });
const trow = rows('Task').find(r => r[0] === tk.taskId);
assert.equal(trow[14], 'Your child'); assert.equal(trow[15], 'Piano Lesson');

const before = rows('Contact').length;
const fam = call({ action: 'save', client: { none: true }, task: { title: 'Swimming Lessons: Bring', due: '2026-11-28', ref: 'p2', role: 'Your child', topic: 'Swimming Lessons' } });
assert.ok(fam.ok && fam.taskId && !fam.id); assert.equal(rows('Contact').length, before, 'family task adds no contact');

// ---------- Files ----------
const b64 = Buffer.from('%PDF-1.4 hello').toString('base64');
let up = call({ action: 'upload', file: { name: 'exam form (1).pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + b64,
  taskRef: 'p1', role: 'Your child', topic: 'Piano Lesson', title: 'Piano Lesson: Pay fees', date: '2026-11-27', ref: 'u1' } });
assert.ok(up.ok, up.error);
const clientName = G.sheets.Contact.rows.find(r => r[0] === rows('Task').find(t => t[0] === tk.taskId)[3])[3].replace(/ /g, '-');
assert.equal(up.file.name, '2026-11-27_Your-child_Piano-Lesson_Pay-fees_exam-form-(1)_' + clientName + '.pdf');
assert.equal(up.file.taskId, tk.taskId, 'linked to the task saved earlier, found by its reference'); assert.ok(up.file.contactId);
const folder = Object.values(G.drive.folders)[0];
assert.equal(folder.name, 'Task Scheduler Files'); assert.deepEqual(folder.editors, ['rebecca@example.my'], 'shared with the team by work email');
assert.equal(folder.files[0].mime, 'application/pdf'); assert.equal(Buffer.from(folder.files[0].bytes).toString(), '%PDF-1.4 hello');
call({ action: 'upload', file: { name: 'exam form (1).pdf', data: b64, taskRef: 'p1', ref: 'u1' } }); // resend: no duplicate
up = call({ action: 'upload', file: { name: 'exam form (1).pdf', mime: 'application/pdf', data: b64, taskRef: 'p1', role: 'Your child', topic: 'Piano Lesson', title: 'Piano Lesson: Pay fees', date: '2026-11-27', ref: 'u2' } });
assert.equal(up.file.name, '2026-11-27_Your-child_Piano-Lesson_Pay-fees_exam-form-(1)_' + clientName + '-2.pdf', 'same name gets -2');
up = call({ action: 'upload', file: { name: 'IMG_2031.JPG', mime: 'image/jpeg', data: b64, contactId: 'c-bbbbbbbbbbbb', title: 'Re: Site photos / roof', date: '2026-11-30', ref: 'u3' } });
assert.equal(up.file.name, '2026-11-30_Site-photos-roof_BETA-ENGINEERING.JPG');
assert.equal(folder.files.length, 3);
assert.equal(call({ action: 'list' }).files.length, 3);

// ---------- Reference (admin only, private sheet) ----------
{
  const R = fakeSheet(JSON.parse(masterBefore), src => src.replace("var ADMIN_KEY = 'change-me-too';", "var ADMIN_KEY = 'boss';"));
  const sheetBefore = JSON.stringify(R.source);
  const asTeam = b => R.call(Object.assign({ key, me: 'siti@example.my' }, b));
  const ref = b => R.call(Object.assign({ key, me: 'rebecca@example.my', adminKey: 'boss' }, b));
  assert.equal(asTeam({ action: 'refChats' }).ok, false, 'no admin key: Reference refused');
  assert.equal(asTeam({ action: 'refChats', adminKey: 'change-me-too' }).ok, false, 'default admin key never works');
  assert.equal(R.call({ key: 'nope', adminKey: 'boss', action: 'refChats' }).error, 'Wrong team key');

  // The PC script sends the chat list; the app asks for one chat; the PC sees the request
  assert.equal(ref({ action: 'refPushChats', chats: [{ id: '60123@s.whatsapp.net', name: 'Ali Supplier' }, { id: '1203@g.us', name: 'Sales team' }] }).count, 2);
  let chats = ref({ action: 'refChats' });
  assert.deepEqual(chats.chats.map(c => [c.name, c.kind]), [['Ali Supplier', 'Contact'], ['Sales team', 'Group']]);
  assert.ok(chats.pcSeen, 'remembers when the PC last checked in');
  assert.deepEqual(ref({ action: 'refPending' }).chats, [], 'nothing asked for yet');
  ref({ action: 'refRequest', chatId: '1203@g.us' });
  assert.deepEqual(ref({ action: 'refPending' }).chats.map(c => c.id), ['1203@g.us']);

  R.pages['https://news.example.com/aircond-tax'] = { body: '<html><head><title>Ignored</title><meta property="og:title" content="New tax guideline for building owners">' +
    '<meta name="description" content="The government will add a tax on inefficient air conditioners from 2027."></head><body><script>var x=1</script>' +
    '<p>Short.</p><p>Suppliers say prices of non-inverter units may rise by up to 10 percent next year.</p></body></html>' };
  R.pages['https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://youtu.be/abc123?si=track')] = { body: JSON.stringify({ title: 'How to clean a split unit', author_name: 'CoolFix' }) };
  R.pages['https://youtu.be/abc123?si=track'] = { body: '<html><head><meta name="description" content="Step by step cleaning of a wall-mounted air conditioner."></head></html>' };
  R.pages['https://shopee.com.my/item/9'] = { body: '<title>Filter set | Shopee Malaysia</title><p>Buy now. Price RM 25.00 for a pack of 3 replacement filters.</p>' };

  const push = ref({ action: 'refPush', source: 'pc', chat: { id: '1203@g.us', name: 'Sales team' }, links: [
    { url: 'https://news.example.com/aircond-tax).', sharedBy: 'Ali', sharedAt: '2026-11-20 09:15', message: 'Read this (https://news.example.com/aircond-tax).' },
    { url: 'https://news.example.com/aircond-tax?utm_source=wa', sharedBy: 'Siti' },
    { url: 'https://youtu.be/abc123?si=track', sharedBy: 'Ahmad' },
    { url: 'https://shopee.com.my/item/9' },
    { url: 'https://gone.example.com/x' },
    { url: 'not a link' }] });
  assert.equal(push.added, 4, 'same link with tracking tags or trailing punctuation is added once; non-links skipped');
  assert.equal(ref({ action: 'refPush', chat: { id: '1203@g.us' }, links: [{ url: 'https://shopee.com.my/item/9/' }] }).added, 0, 'sending again adds nothing');
  assert.deepEqual(ref({ action: 'refPending' }).chats, [], 'request answered');
  assert.equal(R.refSS.name, 'Task Scheduler Reference (private)');
  assert.ok(!R.sheets.Reference && !R.sheets.RefChat, 'nothing about chats is written to the team CRM sheet');
  assert.equal(JSON.stringify(R.source), sheetBefore, 'airnergy_crm_backend untouched');

  const w0 = R.refSheets.Reference.writes || 0;
  let p = ref({ action: 'refProcess', chatId: '1203@g.us' });
  assert.equal(R.refSheets.Reference.writes - w0, 6, 'two writes per link (picked, then done), not one per cell');
  assert.equal(p.done, 3); assert.equal(p.left, 1);
  p = ref({ action: 'refProcess' });
  assert.equal(p.left, 1, 'a page that fails is tried once more');
  p = ref({ action: 'refProcess' });
  assert.equal(p.left, 0);
  const links = ref({ action: 'refLinks', chatId: '1203@g.us' }).links;
  const by = u => links.find(l => l.url === u);
  const news = by('https://news.example.com/aircond-tax');
  assert.equal(news.title, 'New tax guideline for building owners');
  assert.ok(/inefficient air conditioners/.test(news.summary) && /non-inverter/.test(news.summary), 'description topped up with the first real paragraph: ' + news.summary);
  assert.equal(news.category, 'Government & rules');
  assert.equal(news.by, 'Ali'); assert.equal(news.status, 'Done');
  const vid = by('https://youtu.be/abc123?si=track');
  assert.equal(vid.title, 'How to clean a split unit'); assert.equal(vid.category, 'Video');
  assert.ok(/^YouTube video by CoolFix\./.test(vid.summary), vid.summary);
  assert.equal(by('https://shopee.com.my/item/9').category, 'Shopping & suppliers');
  const gone = by('https://gone.example.com/x');
  assert.equal(gone.status, 'Failed'); assert.ok(/404/.test(gone.error));

  // Not authorised to fetch yet: the link waits without using up its tries, and is redone once allowed
  {
    const realFetch = R.ctx.UrlFetchApp.fetch;
    R.pages['https://late.example.com/a'] = { body: '<title>Late page</title><p>This page opens fine once the script may fetch pages.</p>' };
    ref({ action: 'refPush', chat: { id: '1203@g.us' }, links: [{ url: 'https://late.example.com/a' }] });
    R.ctx.UrlFetchApp.fetch = () => { throw new Error('You do not have permission to call UrlFetchApp.fetch. Required permissions: https://www.googleapis.com/auth/script.external_request'); };
    assert.equal(ref({ action: 'refProcess' }).left, 0);
    let late = ref({ action: 'refLinks' }).links.find(l => l.url === 'https://late.example.com/a');
    assert.equal(late.status, 'Failed'); assert.ok(/run doGet once/.test(late.error), late.error);
    R.ctx.UrlFetchApp.fetch = realFetch;
    ref({ action: 'refProcess' });
    late = ref({ action: 'refLinks' }).links.find(l => l.url === 'https://late.example.com/a');
    assert.equal(late.status, 'Done', 'redone by itself once allowed'); assert.equal(late.title, 'Late page');
  }

  // Fix a category by hand; a retry keeps it
  assert.equal(ref({ action: 'refUpdate', id: news.id, category: 'News' }).link.category, 'News');
  assert.equal(ref({ action: 'refUpdate', id: news.id, category: 'Nonsense' }).ok, false);
  ref({ action: 'refUpdate', id: news.id, retry: true }); ref({ action: 'refProcess' });
  assert.equal(ref({ action: 'refLinks' }).links.find(l => l.id === news.id).category, 'News', 'your own category is kept');
  chats = ref({ action: 'refChats' }).chats;
  assert.equal(chats.find(c => c.id === '1203@g.us').links, 5);
  assert.equal(asTeam({ action: 'list' }).ok, true, 'the rest of the app still works');

  // Thousands of chats are saved in one write, not one per chat (that took minutes and held the lock)
  {
    const sh = R.refSheets.RefChat;
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: '60' + (100000 + i) + '@s.whatsapp.net', name: 'Person ' + i }));
    many.push({ id: 'status@broadcast', name: 'Status' }, { id: '123@newsletter', name: 'Channel' }, { id: '1203@g.us', name: 'Sales team (renamed)' });
    const before = sh.rows.length, w0 = sh.writes || 0;
    assert.equal(ref({ action: 'refPushChats', chats: many }).count, 3001, 'status and channels are left out');
    assert.ok(sh.writes - w0 <= 2, 'one write for new chats, one for renames: ' + (sh.writes - w0));
    assert.equal(sh.rows.length, before + 3000);
    const ids = ref({ action: 'refChats' }).chats;
    assert.equal(ids.find(c => c.id === '1203@g.us').name, 'Sales team (renamed)');
    assert.ok(!ids.some(c => c.id === 'status@broadcast'));
    assert.equal(ref({ action: 'refPushChats', chats: many }).count, 3001);
    assert.equal(sh.rows.length, before + 3000, 'sending again adds nothing');
  }
}

console.log('CRM sheet script: all checks passed');
