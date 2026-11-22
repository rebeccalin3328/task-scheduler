// CRM backend tests: node test-crm.js (runs crm-script.gs against a fake Google Sheet)
// Minimal in-memory stand-in for Google Apps Script, to run crm-script.gs locally.
const fs = require('fs'), vm = require('vm');
function mockGs(path) {
  const sheets = {};
  function Sheet(name) { this.name = name; this.rows = []; }
  Sheet.prototype = {
    getRange(a, b, c, d) { const sh = this;
      if (typeof a === 'string') return { setNumberFormat() { return this; } };
      return { setValues(v) { v.forEach((r, i) => { sh.rows[a - 1 + i] = r.slice(); }); return this; }, setFontWeight() { return this; },
        getValues() { const out = []; for (let i = 0; i < c; i++) out.push((sh.rows[a - 1 + i] || []).slice(b - 1, b - 1 + d)); return out; } }; },
    setFrozenRows() {}, appendRow(r) { this.rows.push(r.slice()); }, getLastRow() { return this.rows.length; },
    getDataRange() { const sh = this; return { getValues: () => sh.rows.map(r => r.slice()) }; }
  };
  let n = 0;
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n], insertSheet: nm => (sheets[nm] = new Sheet(nm)) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: { formatDate: (d, tz, f) => f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' '), getUuid: () => 'id' + (++n) + '-abcdefgh' },
    Session: { getScriptTimeZone: () => 'UTC' }, JSON, String, Object, Math, Date
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path, 'utf8'), ctx);
  return { ctx, sheets, call: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text) };
};

const G = mockGs(__dirname + '/crm-script.gs');
const k = 'change-me', assert = require('assert');
assert.equal(G.call({ key: 'x', action: 'list' }).ok, false);
let r = G.call({ key: k, action: 'save', client: { name: 'Ali Hassan', phone: '+60123456789' }, task: { title: 'Send quote', when: '2026-11-23 10:00', by: 'Rebecca', ref: 'a1' } });
assert.ok(r.ok, r.error); assert.equal(r.client.Status, 'Lead');
r = G.call({ key: k, action: 'save', client: { name: 'Ali', phone: '60123456789', company: 'ABC' }, task: { title: 'Call', ref: 'a2' } });
G.call({ key: k, action: 'save', client: { name: 'Ali', phone: '60123456789' }, task: { title: 'Call', ref: 'a2' } }); // resend: no dup
r = G.call({ key: k, action: 'save', client: { email: 'x@y.com' } });
assert.equal(r.client.Name, 'x@y.com');
const l = G.call({ key: k, action: 'list' });
assert.equal(l.clients.length, 2); assert.equal(l.clients[0].Company, 'ABC'); assert.equal(l.clients[0].Name, 'Ali');
assert.equal(l.history.length, 2);
r = G.call({ key: k, action: 'save', client: { id: l.clients[0].ID, name: 'Ali Hassan', notes: '', status: 'Customer', replaceBlank: true } });
assert.equal(r.client.Status, 'Customer'); assert.equal(r.client.Phone, '60123456789');
console.log('CRM sheet script: all checks passed');
