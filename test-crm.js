// CRM backend tests: node test-crm.js
// Runs crm-script.gs against a fake airnergy_crm_backend (made-up data, real column names) and a fake, empty CRM sheet.
const fs = require('fs'), vm = require('vm'), assert = require('assert');

function fakeSheet(tabs) {
  const source = {}, sheets = {};
  Object.keys(tabs).forEach(n => { source[n] = { rows: tabs[n].map(r => r.slice()) }; });
  const api = sh => ({
    getDataRange: () => ({ getValues: () => sh.rows.map(r => r.slice()) }),
    appendRow: r => { sh.rows.push(r.slice()); },
    setFrozenRows() {},
    getRange: (row, col, nr, nc) => ({
      setValue: v => { sh.rows[row - 1][col - 1] = v; },
      setValues: vals => { vals.forEach((r, i) => { sh.rows[row - 1 + i] = sh.rows[row - 1 + i] || []; r.forEach((v, j) => { sh.rows[row - 1 + i][col - 1 + j] = v; }); }); }
    })
  });
  const props = {};
  let n = 0;
  const ctx = {
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: nm => source[nm] && api(source[nm]) }),
      getActiveSpreadsheet: () => ({ getSheetByName: nm => sheets[nm] && api(sheets[nm]), insertSheet: nm => api(sheets[nm] = { rows: [] }) })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      formatDate: (d, tz, f) => { const p = x => String(x).padStart(2, '0');
        return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
          .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())); },
      getUuid: () => (++n).toString(16).padStart(8, '0') + '-aaaa-bbbb-cccc-dddddddddddd'
    },
    Session: { getScriptTimeZone: () => 'Asia/Kuala_Lumpur' }, JSON, String, Object, Math, Date
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/crm-script.gs', 'utf8'), ctx);
  return { sheets, source, props, call: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text) };
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
assert.deepEqual(Object.keys(G.sheets).sort(), ['Activity', 'Contact', 'ContactPerson', 'Task'], 'CRM sheet has only the CRM tabs (no User copy)');

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

console.log('CRM sheet script: all checks passed');
