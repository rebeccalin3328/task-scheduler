/**
 * Task Scheduler CRM: free backend that stores the team's clients in this Google Sheet.
 *
 * Setup (once):
 * 1. Open the Google Sheet you want to use, then Extensions > Apps Script.
 * 2. Delete what is there, paste this whole file, and change TEAM_KEY below to a word only your team knows.
 * 3. Click Deploy > New deployment > type "Web app".
 *    Execute as: Me. Who has access: Anyone. Click Deploy and allow access.
 * 4. Copy the Web app URL. In the Task Scheduler app, tap the gear and paste it under "CRM link",
 *    with the same team key.
 * The "Clients" and "History" tabs are created automatically the first time the app saves.
 */
var TEAM_KEY = 'change-me';

var CLIENT_COLS = ['ID', 'Name', 'Phone', 'Email', 'Company', 'Status', 'Owner', 'Last contact', 'Next follow-up', 'Notes', 'Created'];
var HISTORY_COLS = ['Logged', 'Client ID', 'Client', 'Task', 'Task date', 'Added by', 'Message', 'Ref'];
var FIELDS = { name: 'Name', phone: 'Phone', email: 'Email', company: 'Company', status: 'Status', owner: 'Owner',
  lastContact: 'Last contact', followUp: 'Next follow-up', notes: 'Notes' };

function doGet(e) { return handle_(e.parameter || {}); }
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return handle_(body);
}

function handle_(req) {
  var out;
  try {
    if (String(req.key || '') !== TEAM_KEY) throw new Error('Wrong team key');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (req.action === 'list') out = { ok: true, clients: readAll_(sheet_('Clients', CLIENT_COLS)), history: readAll_(sheet_('History', HISTORY_COLS)).slice(-500) };
      else if (req.action === 'save') out = { ok: true, client: save_(req.client || {}, req.task) };
      else throw new Error('Unknown action');
    } finally { lock.releaseLock(); }
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:Z').setNumberFormat('@'); // keep phone numbers and dates as typed
  }
  return sh;
}

function readAll_(sh) {
  var v = sh.getDataRange().getValues();
  var head = v.shift();
  return v.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? Utilities.formatDate(r[i], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(r[i]); });
    return o;
  });
}

function norm_(s) { return String(s || '').trim().toLowerCase(); }

/** Find the client by ID, then phone, then email, then exact name; update it or add a new row. */
function save_(c, task) {
  var sh = sheet_('Clients', CLIENT_COLS);
  var v = sh.getDataRange().getValues();
  var head = v[0], col = {};
  head.forEach(function (h, i) { col[h] = i; });
  var row = -1;
  for (var i = 1; i < v.length && row < 0; i++) {
    var r = v[i];
    if ((c.id && String(r[col.ID]) === c.id) ||
        (c.phone && String(r[col.Phone]).replace(/\D/g, '') === String(c.phone).replace(/\D/g, '')) ||
        (c.email && norm_(r[col.Email]) === norm_(c.email)) ||
        (!c.phone && !c.email && c.name && norm_(r[col.Name]) === norm_(c.name))) row = i;
  }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rec;
  if (row < 0) {
    rec = head.map(function () { return ''; });
    rec[col.ID] = Utilities.getUuid().slice(0, 8);
    rec[col.Created] = today;
    rec[col.Status] = 'Lead';
  } else {
    rec = v[row].map(String);
  }
  Object.keys(FIELDS).forEach(function (k) {
    if (c[k] !== undefined && c[k] !== null && (String(c[k]) !== '' || c.replaceBlank)) rec[col[FIELDS[k]]] = String(c[k]);
  });
  if (task) rec[col['Last contact']] = today;
  if (!rec[col.Name]) rec[col.Name] = String(c.phone || c.email || 'Unnamed');
  if (row < 0) sh.appendRow(rec); else sh.getRange(row + 1, 1, 1, rec.length).setValues([rec]);

  if (task && !logged_(task.ref)) {
    sheet_('History', HISTORY_COLS).appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
      rec[col.ID], rec[col.Name], String(task.title || ''), String(task.when || ''), String(task.by || ''),
      String(task.message || '').slice(0, 2000), String(task.ref || '')
    ]);
  }
  var o = {};
  head.forEach(function (h, i) { o[h] = String(rec[i]); });
  return o;
}

/** True if a task with this reference was already logged (the app may resend after a lost connection). */
function logged_(ref) {
  if (!ref) return false;
  var sh = sheet_('History', HISTORY_COLS);
  var n = sh.getLastRow();
  if (n < 2) return false;
  var from = Math.max(2, n - 300);
  var refs = sh.getRange(from, HISTORY_COLS.length, n - from + 1, 1).getValues();
  return refs.some(function (r) { return String(r[0]) === String(ref); });
}
