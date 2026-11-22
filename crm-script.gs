/**
 * Task Scheduler CRM backend.
 *
 * Two sheets:
 * - airnergy_crm_backend (SOURCE_ID) is READ ONLY. Contacts and contact persons are copied from it, and its User tab
 *   is read to turn a team member's work email into their UserID. Nothing is ever written to it.
 * - The CRM sheet this script is attached to holds everything the app writes: Contact, ContactPerson, Task and
 *   Activity tabs (same column names as the master, created automatically).
 *
 * Copying: contacts are copied from the master the first time and then at most once an hour, when the app syncs.
 * AutoCount details are refreshed from the master; CRM fields (AssignedAgent, CRMTags, CRMNotes) and contacts added
 * from WhatsApp are kept. Nothing is deleted. You can also copy now from the sheet menu: Task Scheduler > Copy contacts now.
 *
 * Calendars: the Calendar tab lists app calendars (events kept in the Event tab) and linked Google Calendars
 * (events read and written in Google Calendar). Each is shared with Everyone or with chosen work emails.
 * Only someone with ADMIN_KEY can create, link or share calendars.
 *
 * Setup: see CRM-SETUP.md. In short: in the CRM sheet, Extensions > Apps Script, paste this file, set TEAM_KEY,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 */
var TEAM_KEY = 'change-me';
var ADMIN_KEY = 'change-me-too'; // only Rebecca: lets the app create, link and share calendars
var SOURCE_ID = '1zwAriAqdWsEjeR5TzSpMYy5B2R5v_kTGFG0adR3t6y4'; // airnergy_crm_backend (read only)
var COPY_EVERY_MINUTES = 60;
var FILES_FOLDER = 'Task Scheduler Files'; // made in your Google Drive the first time someone uploads
var FILE_SHARING = 'team';  // 'team' = work emails in the User tab, 'link' = anyone with the link, 'private' = only you
var MAX_FILE_MB = 20;
// Phone reminders for events the app puts on Google Calendars (minutes before; 0 = use the calendar's own defaults).
var REMINDER_MINUTES = 30;          // timed events: 30 minutes before
var ALL_DAY_REMINDER_MINUTES = 240; // all-day events: 8 pm the evening before

var NEW_SOURCE = 'WhatsApp';     // Contact.Source for people added from the app
var OPEN_STATUS = 'New';         // Task.Status for new tasks
var DONE_STATUS = 'Done';        // Task.Status when ticked off in the app
var STATUS_TAGS = ['Lead', 'Prospect', 'Customer', 'Inactive']; // kept in Contact.CRMTags

function doGet(e) { return out_(handle_(e.parameter || {})); }
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return out_(handle_(body));
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle_(req) {
  try {
    if (String(req.key || '') !== TEAM_KEY) throw new Error('Wrong team key');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var me = user_(req.me);
      copyContacts_(false); // first run, then at most hourly
      var admin = !!req.adminKey && String(req.adminKey) === ADMIN_KEY && ADMIN_KEY !== 'change-me-too';
      var who = { me: me, email: low_(req.me), admin: admin };
      if (req.action === 'list') return { ok: true, me: me ? me.name : '', team: team_(), clients: clients_(), tasks: tasks_(),
        calendars: calendars_(who), isAdmin: admin, picks: picks_(), files: files_() };
      if (req.action === 'upload') return { ok: true, file: upload_(req.file || {}, me) };
      if (req.action === 'addPick') return { ok: true, picks: addPick_(req.pick || {}, me) };
      if (req.action === 'save') return save_(req.client || {}, req.task, me, who);
      if (req.action === 'done') return done_(req.taskId, me);
      if (req.action === 'events') return { ok: true, events: events_(who, req.from, req.to) };
      if (req.action === 'addEvent') return { ok: true, event: addEvent_(who, req.event || {}, '', '') };
      if (req.action === 'updateEvent') return { ok: true, event: updateEvent_(who, req.event || {}) };
      if (req.action === 'deleteEvent') return deleteEvent_(who, req.event || {});
      if (req.action === 'adminInfo') return adminInfo_(who);
      if (req.action === 'saveCalendar') return { ok: true, calendar: saveCalendar_(who, req.calendar || {}) };
      throw new Error('Unknown action');
    } finally { lock.releaseLock(); }
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------- sheet helpers ----------
var HEADERS = {
  Task: ['TaskID', 'Title', 'Description', 'ContactID', 'LeadID', 'ServiceJobID', 'AssignedTo', 'CreatedBy', 'DueDate', 'Priority', 'Status', 'BlockedReason', 'CompletedAt', 'CreatedAt', 'ForRole', 'Topic'],
  File: ['FileID', 'FileName', 'OriginalName', 'DriveFileID', 'Url', 'MimeType', 'SizeKB', 'TaskID', 'ContactID', 'Role', 'Topic', 'UploadedBy', 'UploadedAt', 'Ref'],
  Picklist: ['Type', 'Role', 'Value', 'SaveContact', 'CreatedBy', 'CreatedAt'],
  Calendar: ['CalendarID', 'Name', 'Color', 'Type', 'GoogleCalendarID', 'SharedWith', 'IsActive', 'CreatedAt'],
  Event: ['EventID', 'CalendarID', 'Title', 'Description', 'Start', 'End', 'AllDay', 'Location', 'ContactID', 'TaskID', 'CreatedBy', 'CreatedAt', 'GoogleEventID', 'Ref'],
  Activity: ['ActivityID', 'Timestamp', 'UserID', 'ActionType', 'ContactID', 'LeadID', 'TaskID', 'ServiceJobID', 'Description', 'Attachment']
};
function crm_() { return SpreadsheetApp.getActiveSpreadsheet(); }
/** A tab of the CRM sheet, created with the master's column names if it doesn't exist yet. */
function tab_(name) {
  var ss = crm_(), sh = ss.getSheetByName(name);
  if (!sh) {
    var head = HEADERS[name] || src_(name).head;
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
  }
  return read_(sh);
}
/** A tab of airnergy_crm_backend. Read only: nothing in this script writes to it. */
function src_(name) {
  var sh = SpreadsheetApp.openById(SOURCE_ID).getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found in airnergy_crm_backend');
  var t = read_(sh);
  t.sh = null; // no write access by accident
  return t;
}
function read_(sh) {
  var v = sh.getDataRange().getValues();
  var head = v.shift().map(String), col = {};
  head.forEach(function (h, i) { col[h] = i; });
  return { sh: sh, head: head, col: col, rows: v };
}
function get_(t, r, name) { var v = r[t.col[name]]; return v instanceof Date ? fmt_(v, v.getHours() || v.getMinutes() ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd') : String(v == null ? '' : v); }
function append_(t, obj) {
  var row = t.head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  t.sh.appendRow(row);
  t.rows.push(row);
  return row;
}
function setCell_(t, rowIndex, name, value) {
  if (t.col[name] === undefined) return;
  t.sh.getRange(rowIndex + 2, t.col[name] + 1).setValue(value);
  t.rows[rowIndex][t.col[name]] = value;
}
function fmt_(d, f) { return Utilities.formatDate(d, Session.getScriptTimeZone(), f); }
function hex_(n) { return Utilities.getUuid().replace(/-/g, '').slice(0, n); }
function low_(s) { return String(s || '').trim().toLowerCase(); }
function truthy_(v) { return v === true || /^(true|yes|1)$/i.test(String(v)); }

/** Malaysian-style phone numbers to one form: 60123456789. A cell may hold several, split by / , ; */
function phones_(s) {
  return String(s || '').split(/[\/,;]| or /).map(function (p) {
    var d = p.replace(/\D/g, '');
    if (/^0\d{8,10}$/.test(d)) d = '6' + d;
    return d.length >= 9 ? d : '';
  }).filter(String);
}
function emails_(s) { return String(s || '').split(/[;,\s]+/).map(low_).filter(function (e) { return e.indexOf('@') > 0; }); }

// ---------- users ----------
function user_(email) {
  email = low_(email);
  if (!email) return null;
  var t = src_('User');
  for (var i = 0; i < t.rows.length; i++) {
    if (low_(t.rows[i][t.col.Email]) === email) return { id: get_(t, t.rows[i], 'UserID'), name: get_(t, t.rows[i], 'FullName'), email: email };
  }
  return null;
}
function team_() {
  var t = src_('User'), names = {};
  t.rows.forEach(function (r) { if (truthy_(r[t.col.IsActive]) && r[t.col.FullName]) names[get_(t, r, 'FullName')] = 1; });
  return Object.keys(names).sort();
}
function userNames_() {
  var t = src_('User'), m = {};
  t.rows.forEach(function (r) { m[get_(t, r, 'UserID')] = get_(t, r, 'FullName'); });
  return m;
}

// ---------- read ----------
function clients_() {
  var c = tab_('Contact'), p = tab_('ContactPerson'), people = {};
  p.rows.forEach(function (r) {
    var id = get_(p, r, 'ContactID');
    if (!id) return;
    (people[id] = people[id] || []).push({ id: get_(p, r, 'PersonID'), name: get_(p, r, 'FullName'), role: get_(p, r, 'Role'),
      phone: get_(p, r, 'Phone'), email: get_(p, r, 'Email') });
  });
  return c.rows.filter(function (r) { return r[c.col.ContactID]; }).map(function (r) {
    var id = get_(c, r, 'ContactID'), tags = get_(c, r, 'CRMTags');
    return { id: id, company: get_(c, r, 'CompanyName'), name: get_(c, r, 'PIC'), phone: get_(c, r, 'Phone'),
      email: get_(c, r, 'PrimaryEmail'), source: get_(c, r, 'Source'), accNo: get_(c, r, 'AccNo'),
      active: r[c.col.IsActive] === '' ? true : truthy_(r[c.col.IsActive]), owner: get_(c, r, 'AssignedAgent'),
      tags: tags, status: statusOf_(tags), notes: get_(c, r, 'CRMNotes'), people: people[id] || [] };
  });
}
function tasks_() {
  var t = tab_('Task'), names = userNames_();
  return t.rows.filter(function (r) { return r[t.col.TaskID]; }).map(function (r) {
    return { id: get_(t, r, 'TaskID'), title: get_(t, r, 'Title'), contactId: get_(t, r, 'ContactID'),
      due: get_(t, r, 'DueDate'), status: get_(t, r, 'Status'), assignee: names[get_(t, r, 'AssignedTo')] || '',
      by: names[get_(t, r, 'CreatedBy')] || '', created: get_(t, r, 'CreatedAt'), completed: get_(t, r, 'CompletedAt') };
  }).slice(-1500);
}
function statusOf_(tags) {
  var parts = String(tags || '').split(/\s*,\s*/);
  for (var i = 0; i < STATUS_TAGS.length; i++) if (parts.indexOf(STATUS_TAGS[i]) >= 0) return STATUS_TAGS[i];
  return '';
}
function withStatus_(tags, status) {
  var parts = String(tags || '').split(/\s*,\s*/).filter(function (x) { return x && STATUS_TAGS.indexOf(x) < 0; });
  if (status) parts.unshift(status);
  return parts.join(', ');
}

// ---------- write ----------
/** Find the contact by ID, then phone (contact or contact person), then email, then company name. */
function find_(c, p, q) {
  var i;
  if (q.id) for (i = 0; i < c.rows.length; i++) if (String(c.rows[i][c.col.ContactID]) === q.id) return { row: i };
  var ph = phones_(q.phone)[0], em = low_(q.email), co = low_(q.company);
  if (ph) {
    for (i = 0; i < c.rows.length; i++) if (phones_(c.rows[i][c.col.Phone]).indexOf(ph) >= 0) return { row: i, how: 'phone' };
    for (i = 0; i < p.rows.length; i++) if (phones_(p.rows[i][p.col.Phone]).indexOf(ph) >= 0) return byId_(c, p.rows[i][p.col.ContactID], 'person');
  }
  if (em) {
    for (i = 0; i < c.rows.length; i++) if (emails_(c.rows[i][c.col.PrimaryEmail]).indexOf(em) >= 0) return { row: i, how: 'email' };
    for (i = 0; i < p.rows.length; i++) if (emails_(p.rows[i][p.col.Email]).indexOf(em) >= 0) return byId_(c, p.rows[i][p.col.ContactID], 'person');
  }
  if (co) for (i = 0; i < c.rows.length; i++) if (low_(c.rows[i][c.col.CompanyName]) === co) return { row: i, how: 'company' };
  return null;
}
function byId_(c, id, how) {
  for (var i = 0; i < c.rows.length; i++) if (String(c.rows[i][c.col.ContactID]) === String(id)) return { row: i, how: how };
  return null;
}

function save_(q, task, me, who) {
  var c = tab_('Contact'), p = tab_('ContactPerson');
  var hit = q.none ? null : find_(c, p, q), id = '', created = false;
  if (q.none) {
    // Not a client (for example a family member): only the task and calendar event are saved.
  } else if (!hit) {
    if (!q.name && !q.phone && !q.email && !q.company) throw new Error('No name, phone or email');
    id = 'c-' + hex_(12);
    append_(c, { ContactID: id, Source: NEW_SOURCE, CompanyName: q.company || q.name || q.phone || q.email, PIC: q.name || '',
      Phone: q.phone || '', PrimaryEmail: q.email || '', IsActive: true, AssignedAgent: q.owner || (me ? me.name : ''),
      CRMTags: withStatus_('', q.status || 'Lead'), CRMNotes: q.notes || '' });
    created = true;
  } else {
    var r = hit.row, row = c.rows[r];
    id = String(row[c.col.ContactID]);
    var own = String(row[c.col.Source]) === NEW_SOURCE; // only contacts made here may have their details edited
    if (q.edit && own) {
      if (q.company !== undefined) setCell_(c, r, 'CompanyName', q.company || q.name || '');
      if (q.name !== undefined) setCell_(c, r, 'PIC', q.name);
      if (q.phone !== undefined) setCell_(c, r, 'Phone', q.phone);
      if (q.email !== undefined) setCell_(c, r, 'PrimaryEmail', q.email);
    }
    if (q.status !== undefined && q.status !== '') setCell_(c, r, 'CRMTags', withStatus_(row[c.col.CRMTags], q.status));
    if (q.owner) setCell_(c, r, 'AssignedAgent', q.owner);
    else if (!row[c.col.AssignedAgent] && me) setCell_(c, r, 'AssignedAgent', me.name);
    if (q.notes !== undefined && (q.notes !== '' || q.edit)) setCell_(c, r, 'CRMNotes', q.notes);
    if (q.active !== undefined && q.edit) setCell_(c, r, 'IsActive', !!q.active);
    // A new person for a known company (matched by email or company name): add them as a contact person.
    if (!q.edit && (hit.how === 'company' || hit.how === 'email') && q.name && q.phone) {
      var ph = phones_(q.phone)[0], known = phones_(row[c.col.Phone]).indexOf(ph) >= 0 ||
        p.rows.some(function (x) { return String(x[p.col.ContactID]) === id && phones_(x[p.col.Phone]).indexOf(ph) >= 0; });
      if (!known) append_(p, { PersonID: 'p-' + hex_(12), ContactID: id, FullName: q.name, Phone: q.phone, Email: q.email || '',
        IsPrimary: false, Notes: 'Added from Task Scheduler' });
    }
  }
  var taskId = '';
  var event = null;
  if (task && task.title) {
    taskId = addTask_(id, task, me);
    if (task.calendarId && task.start) event = addEvent_(who || { me: me }, {
      calendarId: task.calendarId, title: task.title, description: task.description, location: task.location,
      start: task.start, end: task.end, allDay: task.allDay, ref: task.ref }, id, taskId);
  }
  return { ok: true, id: id, created: created, taskId: taskId, event: event };
}

function addTask_(contactId, task, me) {
  var a = tab_('Activity');
  var tag = task.ref ? '[ref:' + task.ref + ']' : '';
  if (tag) for (var i = a.rows.length - 1; i >= Math.max(0, a.rows.length - 400); i--) {
    var d = String(a.rows[i][a.col.Description]);
    if (d.indexOf(tag) >= 0) { var m = d.match(/\[task:([^\]]+)\]/); return m ? m[1] : 'dup'; }
  }
  var t = tab_('Task'), now = new Date(), prefix = 'T-' + fmt_(now, 'yyyyMMdd') + '-', n = 0;
  t.rows.forEach(function (r) { var x = String(r[t.col.TaskID]); if (x.indexOf(prefix) === 0) n = Math.max(n, +x.slice(prefix.length) || 0); });
  var taskId = prefix + ('00' + (n + 1)).slice(-3);
  var due = task.due ? new Date(task.due.replace(' ', 'T') + (task.due.length <= 10 ? 'T00:00:00' : ':00')) : '';
  var uid = me ? me.id : '';
  append_(t, { TaskID: taskId, Title: String(task.title).slice(0, 200), Description: String(task.description || '').slice(0, 4000),
    ContactID: contactId, AssignedTo: uid, CreatedBy: uid, DueDate: due, Priority: 'Normal', Status: OPEN_STATUS, CreatedAt: now,
    ForRole: String(task.role || ''), Topic: String(task.topic || '') });
  append_(a, { ActivityID: 'A-' + hex_(12), Timestamp: now, UserID: uid, ActionType: 'Task', ContactID: contactId, TaskID: taskId,
    Description: 'Added from Task Scheduler: ' + String(task.title).slice(0, 200) + ' ' + tag + ' [task:' + taskId + ']' });
  return taskId;
}

function done_(taskId, me) {
  var t = tab_('Task');
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][t.col.TaskID]) === String(taskId)) {
      var now = new Date();
      setCell_(t, i, 'Status', DONE_STATUS);
      setCell_(t, i, 'CompletedAt', now);
      append_(tab_('Activity'), { ActivityID: 'A-' + hex_(12), Timestamp: now, UserID: me ? me.id : '', ActionType: 'Task done',
        ContactID: t.rows[i][t.col.ContactID], TaskID: taskId, Description: 'Marked done in Task Scheduler' });
      return { ok: true };
    }
  }
  throw new Error('Task not found');
}

// ---------- copying contacts from airnergy_crm_backend ----------
var CRM_FIELDS = ['AssignedAgent', 'CRMTags', 'CRMNotes']; // edited in the CRM sheet, so never overwritten

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Scheduler').addItem('Copy contacts now', 'copyContactsNow').addToUi();
}
function copyContactsNow() { copyContacts_(true); }

function copyContacts_(force) {
  var props = PropertiesService.getScriptProperties();
  var last = +props.getProperty('lastCopy') || 0;
  if (!force && Date.now() - last < COPY_EVERY_MINUTES * 60000) return false;
  mergeTab_('Contact', 'ContactID', CRM_FIELDS);
  mergeTab_('ContactPerson', 'PersonID', []);
  props.setProperty('lastCopy', String(Date.now()));
  return true;
}

/** Add new rows from the master and refresh existing ones, keeping keepFields when the CRM sheet has a value. */
function mergeTab_(name, idCol, keepFields) {
  var s = src_(name), t = tab_(name), at = {};
  // Columns the master has that the CRM tab doesn't yet: add them at the end.
  s.head.forEach(function (h) {
    if (t.col[h] === undefined) { t.col[h] = t.head.length; t.head.push(h); t.rows.forEach(function (r) { r.push(''); }); }
  });
  t.rows.forEach(function (r, i) { if (r[t.col[idCol]]) at[String(r[t.col[idCol]])] = i; });
  s.rows.forEach(function (r) {
    var id = String(r[s.col[idCol]] || '');
    if (!id) return;
    var i = at[id], row;
    if (i === undefined) { row = t.head.map(function () { return ''; }); t.rows.push(row); at[id] = t.rows.length - 1; }
    else row = t.rows[i];
    s.head.forEach(function (h, j) {
      if (keepFields.indexOf(h) >= 0 && row[t.col[h]] !== '' && row[t.col[h]] != null) return;
      row[t.col[h]] = r[j];
    });
  });
  t.sh.getRange(1, 1, 1, t.head.length).setValues([t.head]);
  if (t.rows.length) t.sh.getRange(2, 1, t.rows.length, t.head.length).setValues(t.rows);
}

// ---------- calendars ----------
var COLORS = ['#039be5', '#33b679', '#f4511e', '#8e24aa', '#f6bf26', '#e67c73', '#3f51b5', '#0b8043', '#616161'];

function calTab_() {
  var t = tab_('Calendar');
  if (!t.rows.length) append_(t, { CalendarID: 'cal-team', Name: 'Team', Color: COLORS[0], Type: 'App', SharedWith: 'Everyone', IsActive: true, CreatedAt: new Date() });
  return t;
}
function calObj_(t, r) {
  return { id: get_(t, r, 'CalendarID'), name: get_(t, r, 'Name'), color: get_(t, r, 'Color') || COLORS[0], type: get_(t, r, 'Type') || 'App',
    googleId: get_(t, r, 'GoogleCalendarID'), sharedWith: get_(t, r, 'SharedWith'), active: r[t.col.IsActive] === '' || truthy_(r[t.col.IsActive]) };
}
function canSee_(cal, who) {
  if (who.admin) return true;
  if (!cal.active) return false;
  if (/^\s*everyone\s*$/i.test(cal.sharedWith)) return true;
  return !!who.email && emails_(cal.sharedWith).indexOf(who.email) >= 0;
}
/** Calendars this person may see and add to. Google Calendar IDs are only shown to the admin. */
function calendars_(who) {
  return visible_(who).map(function (c) {
    if (!who.admin) { delete c.googleId; delete c.sharedWith; }
    return c;
  });
}
function visible_(who) {
  var t = calTab_();
  return t.rows.filter(function (r) { return r[t.col.CalendarID]; }).map(function (r) { return calObj_(t, r); })
    .filter(function (c) { return canSee_(c, who); });
}
function cal_(who, id) {
  var t = calTab_();
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i][t.col.CalendarID]) === String(id)) {
    var c = calObj_(t, t.rows[i]);
    if (!canSee_(c, who) || !c.active) throw new Error('You don\'t have access to that calendar');
    return c;
  }
  throw new Error('Calendar not found');
}
function gcal_(c) {
  var g = CalendarApp.getCalendarById(c.googleId);
  if (!g) throw new Error('Google Calendar "' + c.name + '" is not available to the CRM owner');
  return g;
}

// Times travel as local 'yyyy-MM-ddTHH:mm' (or 'yyyy-MM-dd' for all-day) in the script's time zone.
function parse_(s) {
  var m = String(s || '').match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/);
  if (!m) throw new Error('Bad date: ' + s);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
function iso_(d) { return fmt_(d, 'yyyy-MM-dd') + 'T' + fmt_(d, 'HH:mm'); }

function events_(who, from, to) {
  var a = parse_(from), b = parse_(to), out = [];
  var e = tab_('Event'), byGoogle = {};
  var cals = visible_(who).filter(function (c) { return c.active; });
  var ids = {};
  cals.forEach(function (c) { ids[c.id] = c; });
  e.rows.forEach(function (r) {
    var cid = get_(e, r, 'CalendarID'), gid = get_(e, r, 'GoogleEventID');
    if (gid) { byGoogle[gid] = { contactId: get_(e, r, 'ContactID'), taskId: get_(e, r, 'TaskID'), by: get_(e, r, 'CreatedBy') }; return; }
    var c = ids[cid];
    if (!c || c.type !== 'App') return;
    var s = r[e.col.Start] instanceof Date ? r[e.col.Start] : parse_(r[e.col.Start]);
    var en = r[e.col.End] instanceof Date ? r[e.col.End] : (r[e.col.End] ? parse_(r[e.col.End]) : s);
    if (en < a || s >= b) return;
    out.push({ id: get_(e, r, 'EventID'), calendarId: cid, title: get_(e, r, 'Title'), description: get_(e, r, 'Description'),
      location: get_(e, r, 'Location'), start: iso_(s), end: iso_(en), allDay: truthy_(r[e.col.AllDay]),
      contactId: get_(e, r, 'ContactID'), taskId: get_(e, r, 'TaskID'), by: get_(e, r, 'CreatedBy') });
  });
  cals.forEach(function (c) {
    if (c.type !== 'Google' || !c.googleId) return;
    var g;
    try { g = gcal_(c); } catch (err) { return; }
    g.getEvents(a, b).forEach(function (ev) {
      var link = byGoogle[ev.getId()] || {}, allDay = ev.isAllDayEvent();
      var en = ev.getEndTime();
      if (allDay) en = new Date(en.getTime() - 60000); // Google's all-day end is the next midnight
      out.push({ id: 'g:' + c.id + ':' + ev.getId(), calendarId: c.id, title: ev.getTitle(), description: ev.getDescription(),
        location: ev.getLocation(), start: iso_(ev.getStartTime()), end: iso_(en), allDay: allDay,
        contactId: link.contactId || '', taskId: link.taskId || '', by: link.by || '' });
    });
  });
  return out.sort(function (x, y) { return x.start < y.start ? -1 : 1; });
}

function addEvent_(who, ev, contactId, taskId) {
  var c = cal_(who, ev.calendarId), e = tab_('Event');
  if (ev.ref) for (var i = e.rows.length - 1; i >= 0; i--) if (String(e.rows[i][e.col.Ref]) === String(ev.ref)) return { id: get_(e, e.rows[i], 'EventID'), dup: true };
  var start = parse_(ev.start), end = ev.end ? parse_(ev.end) : new Date(start.getTime() + 3600000);
  if (ev.allDay) { start = parse_(String(ev.start).slice(0, 10)); end = parse_(String(ev.end || ev.start).slice(0, 10)); }
  if (end < start) end = start;
  var title = String(ev.title || 'Event').slice(0, 200), gid = '';
  if (c.type === 'Google') {
    var g = gcal_(c), opt = { description: String(ev.description || ''), location: String(ev.location || '') };
    gid = gEvent_(g, title, start, end, !!ev.allDay, opt).getId();
  }
  var id = 'E-' + hex_(12), by = who.me ? who.me.name : (who.email || '');
  append_(e, { EventID: id, CalendarID: c.id, Title: title, Description: String(ev.description || '').slice(0, 4000), Start: start, End: end,
    AllDay: !!ev.allDay, Location: String(ev.location || ''), ContactID: contactId || ev.contactId || '', TaskID: taskId || '',
    CreatedBy: by, CreatedAt: new Date(), GoogleEventID: gid, Ref: ev.ref || '' });
  return { id: gid ? 'g:' + c.id + ':' + gid : id, calendarId: c.id, title: title, start: iso_(start), end: iso_(end), allDay: !!ev.allDay };
}

/** Make a Google Calendar event with a phone (popup) reminder. */
function gEvent_(g, title, start, end, allDay, opt) {
  var gev = allDay ? g.createAllDayEvent(title, start, new Date(end.getTime() + 86400000), opt) : g.createEvent(title, start, end, opt);
  var mins = allDay ? ALL_DAY_REMINDER_MINUTES : REMINDER_MINUTES;
  if (mins > 0) { try { gev.removeAllReminders(); gev.addPopupReminder(mins); } catch (err) {} }
  return gev;
}

function findEvent_(who, id) {
  var e = tab_('Event');
  if (/^g:/.test(id)) {
    var parts = id.split(':'), c = cal_(who, parts[1]), gid = parts.slice(2).join(':');
    return { cal: c, gev: gcal_(c).getEventById(gid), gid: gid, e: e };
  }
  for (var i = 0; i < e.rows.length; i++) if (String(e.rows[i][e.col.EventID]) === String(id)) {
    return { cal: cal_(who, e.rows[i][e.col.CalendarID]), row: i, e: e };
  }
  throw new Error('Event not found');
}
function updateEvent_(who, ev) {
  var f = findEvent_(who, ev.id), start = parse_(ev.start), end = ev.end ? parse_(ev.end) : start;
  if (ev.allDay) { start = parse_(String(ev.start).slice(0, 10)); end = parse_(String(ev.end || ev.start).slice(0, 10)); }
  if (end < start) end = start;
  if (f.gev) {
    f.gev.setTitle(String(ev.title || ''));
    f.gev.setDescription(String(ev.description || ''));
    f.gev.setLocation(String(ev.location || ''));
    if (ev.allDay) f.gev.setAllDayDates(start, new Date(end.getTime() + 86400000)); else f.gev.setTime(start, end);
  } else {
    var e = f.e, r = f.row;
    setCell_(e, r, 'Title', String(ev.title || '')); setCell_(e, r, 'Description', String(ev.description || ''));
    setCell_(e, r, 'Location', String(ev.location || '')); setCell_(e, r, 'Start', start); setCell_(e, r, 'End', end);
    setCell_(e, r, 'AllDay', !!ev.allDay);
  }
  return { id: ev.id };
}
function deleteEvent_(who, ev) {
  var f = findEvent_(who, ev.id);
  if (f.gev) f.gev.deleteEvent();
  else {
    // Rows are never deleted: the event is emptied and marked, so it no longer shows.
    setCell_(f.e, f.row, 'CalendarID', 'deleted:' + f.cal.id);
  }
  return { ok: true };
}

// ---------- admin ----------
function needAdmin_(who) { if (!who.admin) throw new Error('Only the admin can do this'); }
function adminInfo_(who) {
  needAdmin_(who);
  var u = src_('User'), team = [];
  u.rows.forEach(function (r) {
    if (truthy_(r[u.col.IsActive]) && r[u.col.Email]) team.push({ name: get_(u, r, 'FullName'), email: low_(r[u.col.Email]) });
  });
  var t = calTab_(), linked = {};
  var cals = t.rows.map(function (r) { var c = calObj_(t, r); if (c.googleId) linked[c.googleId] = 1; return c; });
  var google = [];
  try {
    CalendarApp.getAllCalendars().forEach(function (g) {
      google.push({ id: g.getId(), name: g.getName(), color: g.getColor(), linked: !!linked[g.getId()] });
    });
  } catch (err) {}
  return { ok: true, calendars: cals, team: team, google: google, colors: COLORS };
}
/** Create (App, new Google, or linked Google) or update a calendar. */
function saveCalendar_(who, c) {
  needAdmin_(who);
  var t = calTab_(), shared = /^\s*everyone\s*$/i.test(c.sharedWith || '') ? 'Everyone' : emails_(c.sharedWith).join(', ');
  for (var i = 0; i < t.rows.length; i++) if (c.id && String(t.rows[i][t.col.CalendarID]) === c.id) {
    if (c.name) setCell_(t, i, 'Name', String(c.name));
    if (c.color) setCell_(t, i, 'Color', String(c.color));
    setCell_(t, i, 'SharedWith', shared);
    if (c.active !== undefined) setCell_(t, i, 'IsActive', !!c.active);
    if (c.toGoogle && calObj_(t, t.rows[i]).type === 'App') toGoogle_(t, i);
    var cur = calObj_(t, t.rows[i]);
    if (cur.type === 'Google' && c.name) { try { gcal_(cur).setName(String(c.name)); } catch (err) {} }
    return cur;
  }
  var type = c.type === 'Google' ? 'Google' : 'App', gid = '';
  if (type === 'Google') {
    if (c.googleId) gid = String(c.googleId);
    else gid = CalendarApp.createCalendar(String(c.name || 'New calendar')).getId();
    t.rows.forEach(function (r) { if (String(r[t.col.GoogleCalendarID]) === gid) throw new Error('That Google Calendar is already linked'); });
    if (!CalendarApp.getCalendarById(gid)) throw new Error('Google Calendar not found');
  }
  var row = append_(t, { CalendarID: 'cal-' + hex_(8), Name: String(c.name || 'New calendar'), Color: c.color || COLORS[t.rows.length % COLORS.length],
    Type: type, GoogleCalendarID: gid, SharedWith: shared || '', IsActive: true, CreatedAt: new Date() });
  return calObj_(t, row);
}

/** Turn an app calendar into a new Google Calendar (so phones get reminders). Its events are copied over. */
function toGoogle_(t, i) {
  var c = calObj_(t, t.rows[i]), g = CalendarApp.createCalendar(c.name);
  try { g.setColor(c.color); } catch (err) {}
  var e = tab_('Event');
  e.rows.forEach(function (r, k) {
    if (String(r[e.col.CalendarID]) !== c.id || r[e.col.GoogleEventID]) return;
    var s = r[e.col.Start] instanceof Date ? r[e.col.Start] : parse_(r[e.col.Start]);
    var en = r[e.col.End] instanceof Date ? r[e.col.End] : (r[e.col.End] ? parse_(r[e.col.End]) : s);
    var gev = gEvent_(g, String(r[e.col.Title] || 'Event'), s, en < s ? s : en, truthy_(r[e.col.AllDay]),
      { description: String(r[e.col.Description] || ''), location: String(r[e.col.Location] || '') });
    setCell_(e, k, 'GoogleEventID', gev.getId());
  });
  setCell_(t, i, 'Type', 'Google');
  setCell_(t, i, 'GoogleCalendarID', g.getId());
}

// ---------- quick picks: who the task is for, what it's about, and ready-made phrases ----------
// Type Role: Value = role name, SaveContact = TRUE if people with this role belong in the client list.
// Type Topic / Phrase: Role = the role it belongs to ("*" = every role).
var DEFAULT_PICKS = {
  roles: [['Customer', true], ['Supplier', true], ['Staff', false], ['Your child', false], ['Husband', false]],
  topics: {
    'Customer': ['Quotation', 'Site survey', 'Installation', 'Service / maintenance', 'Repair', 'Payment collection', 'Complaint'],
    'Supplier': ['Quotation', 'Purchase order', 'Delivery', 'Invoice', 'Payment', 'Warranty / return'],
    'Staff': ['Site visit', 'Service job', 'Meeting', 'Training', 'Leave', 'Claims', 'Report'],
    'Your child': ['SRI KL International School', 'Tuition Center', 'ECA', 'Piano Lesson', 'Swimming Lessons', 'Homework', 'Project', 'English Subject'],
    'Husband': ['Family event', 'Dinner', 'Bills', 'Car service', 'Travel', 'Anniversary']
  },
  phrases: {
    '*': ['Call', 'Follow up', 'Reminder'],
    'Customer': ['Send quotation', 'Call back', 'Schedule site visit', 'Collect payment'],
    'Supplier': ['Request quotation', 'Confirm delivery date', 'Make payment'],
    'Staff': ['Please follow up', 'Submit report', 'Meeting at office'],
    'Your child': ['Pay fees', 'Pick up', 'Bring', 'Submit homework', 'Parent-teacher meeting', 'Practice'],
    'Husband': ['Remind', 'Pay', 'Book']
  }
};
function pickTab_() {
  var t = tab_('Picklist');
  if (!t.rows.length) {
    var now = new Date(), rows = [];
    DEFAULT_PICKS.roles.forEach(function (r) { rows.push(['Role', '', r[0], r[1], 'Starter list', now]); });
    Object.keys(DEFAULT_PICKS.topics).forEach(function (r) { DEFAULT_PICKS.topics[r].forEach(function (v) { rows.push(['Topic', r, v, '', 'Starter list', now]); }); });
    Object.keys(DEFAULT_PICKS.phrases).forEach(function (r) { DEFAULT_PICKS.phrases[r].forEach(function (v) { rows.push(['Phrase', r, v, '', 'Starter list', now]); }); });
    rows.forEach(function (r) { append_(t, { Type: r[0], Role: r[1], Value: r[2], SaveContact: r[3], CreatedBy: r[4], CreatedAt: r[5] }); });
  }
  return t;
}
function picks_() {
  var t = pickTab_(), out = { roles: [], topics: {}, phrases: {} };
  t.rows.forEach(function (r) {
    var type = get_(t, r, 'Type'), role = get_(t, r, 'Role'), v = get_(t, r, 'Value');
    if (!v) return;
    if (type === 'Role') out.roles.push({ name: v, saveContact: truthy_(r[t.col.SaveContact]) });
    else if (type === 'Topic') (out.topics[role] = out.topics[role] || []).push(v);
    else if (type === 'Phrase') (out.phrases[role] = out.phrases[role] || []).push(v);
  });
  return out;
}
/** Anyone in the team can add a role, topic or phrase. Duplicates (ignoring case) are skipped. */
function addPick_(p, me) {
  var type = { role: 'Role', topic: 'Topic', phrase: 'Phrase' }[String(p.type || '').toLowerCase()];
  var v = String(p.value || '').trim().slice(0, 80), role = type === 'Role' ? '' : String(p.role || '*').trim().slice(0, 80);
  if (!type || !v) throw new Error('Nothing to add');
  var t = pickTab_();
  var dup = t.rows.some(function (r) { return get_(t, r, 'Type') === type && low_(get_(t, r, 'Role')) === low_(role) && low_(get_(t, r, 'Value')) === low_(v); });
  if (!dup) append_(t, { Type: type, Role: role, Value: v, SaveContact: type === 'Role' ? !!p.saveContact : '', CreatedBy: me ? me.name : '', CreatedAt: new Date() });
  return picks_();
}

// ---------- files ----------
function folder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('filesFolder'), f = null;
  if (id) { try { f = DriveApp.getFolderById(id); } catch (e) { f = null; } }
  if (!f) {
    f = DriveApp.createFolder(FILES_FOLDER);
    props.setProperty('filesFolder', f.getId());
    shareFolder_(f);
  }
  return f;
}
function shareFolder_(f) {
  if (FILE_SHARING === 'link') f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  if (FILE_SHARING === 'team') {
    var u = src_('User');
    u.rows.forEach(function (r) {
      var e = low_(r[u.col.Email]);
      if (e && truthy_(r[u.col.IsActive])) { try { f.addEditor(e); } catch (err) {} }
    });
  }
}
/** Run from the Apps Script editor after adding people to the User tab, to give them access to the files folder. */
function shareFilesFolderAgain() { shareFolder_(folder_()); }

/** The original file name, unless it's a camera or app default like IMG_2031 or WhatsApp Image 2026-11-22. */
function stem_(name) {
  var s = String(name || '').replace(/\.[^.]+$/, '');
  return /^(img|dsc|pxl|vid|screenshot|scan|image|photo|whatsapp (image|video|document)|document|doc|file|untitled)[\s_\-]*[\d\s_\-.:at]*(\(\d+\))?$/i.test(s) || /^[\d\s_\-.()]+$/.test(s) ? '' : s;
}
/** "2026-11-27_Your-child_Piano-Lesson_Pay-fees_Exam-form_Client.pdf": date, who it's for, topic, task, file, client. */
function fileName_(f, ext) {
  var clean = function (s, n) {
    return String(s || '').replace(/^(re|fw|fwd):\s*/i, '').replace(/[\\\/:*?"<>|#%{}~&]+/g, ' ').replace(/\s+/g, ' ').trim()
      .slice(0, n).trim().replace(/ /g, '-');
  };
  var title = String(f.title || String(f.name || '').replace(/\.[^.]+$/, ''));
  if (f.topic && title.toLowerCase().indexOf(String(f.topic).toLowerCase() + ':') === 0) title = title.slice(String(f.topic).length + 1);
  var parts = [String(f.date || '').slice(0, 10) || fmt_(new Date(), 'yyyy-MM-dd'), clean(f.role, 20), clean(f.topic, 30),
    clean(title, 40), clean(stem_(f.name), 25), clean(f.client, 30)];
  var seen = {};
  parts = parts.filter(function (p) { var k = p.toLowerCase(); if (!p || seen[k]) return false; seen[k] = 1; return true; });
  return parts.join('_') + (ext ? '.' + ext : '');
}
function upload_(f, me) {
  if (!f.data) throw new Error('No file');
  var t = tab_('File');
  if (f.ref) for (var i = t.rows.length - 1; i >= 0; i--) if (String(t.rows[i][t.col.Ref]) === String(f.ref)) return fileObj_(t, t.rows[i]);
  var bytes = Utilities.base64Decode(String(f.data).replace(/^data:[^,]*,/, ''));
  if (bytes.length > MAX_FILE_MB * 1048576) throw new Error('File is over ' + MAX_FILE_MB + ' MB');
  var ext = (String(f.name || '').match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || '';
  // The task may have just been saved in the same sync: find it by the reference the app gave it.
  var taskId = f.taskId || '';
  if (!taskId && f.taskRef) {
    var a = tab_('Activity'), tag = '[ref:' + f.taskRef + ']';
    for (var j = a.rows.length - 1; j >= 0 && !taskId; j--) {
      var d = String(a.rows[j][a.col.Description]);
      if (d.indexOf(tag) >= 0) { var m = d.match(/\[task:([^\]]+)\]/); if (m) taskId = m[1]; }
    }
  }
  var contactId = f.contactId || '', client = f.client || '';
  if (taskId && !contactId) {
    var tk = tab_('Task');
    tk.rows.forEach(function (r) { if (String(r[tk.col.TaskID]) === taskId) contactId = String(r[tk.col.ContactID] || ''); });
  }
  if (contactId && !client) {
    var c = tab_('Contact');
    c.rows.forEach(function (r) { if (String(r[c.col.ContactID]) === contactId) client = String(r[c.col.CompanyName] || r[c.col.PIC] || ''); });
  }
  var folder = folder_(), base = fileName_({ date: f.date, role: f.role, topic: f.topic, title: f.title, name: f.name, client: client }, ''), name = base + (ext ? '.' + ext : '');
  for (var n = 2; folder.getFilesByName(name).hasNext(); n++) name = base + '-' + n + (ext ? '.' + ext : '');
  var blob = Utilities.newBlob(bytes, f.mime || 'application/octet-stream', name);
  var file = folder.createFile(blob);
  file.setDescription('Uploaded from Task Scheduler' + (taskId ? ' for task ' + taskId : '') + (client ? ' · ' + client : '') + (f.name ? ' · original name: ' + f.name : ''));
  var row = append_(t, { FileID: 'F-' + hex_(10), FileName: name, OriginalName: String(f.name || ''), DriveFileID: file.getId(), Url: file.getUrl(),
    MimeType: f.mime || '', SizeKB: Math.round(bytes.length / 1024), TaskID: taskId, ContactID: contactId, Role: f.role || '', Topic: f.topic || '',
    UploadedBy: me ? me.name : '', UploadedAt: new Date(), Ref: f.ref || '' });
  return fileObj_(t, row);
}
function fileObj_(t, r) {
  return { id: get_(t, r, 'FileID'), name: get_(t, r, 'FileName'), original: get_(t, r, 'OriginalName'), url: get_(t, r, 'Url'),
    mime: get_(t, r, 'MimeType'), sizeKB: get_(t, r, 'SizeKB'), taskId: get_(t, r, 'TaskID'), contactId: get_(t, r, 'ContactID'),
    role: get_(t, r, 'Role'), topic: get_(t, r, 'Topic'), by: get_(t, r, 'UploadedBy'), at: get_(t, r, 'UploadedAt') };
}
function files_() {
  var t = tab_('File');
  return t.rows.filter(function (r) { return r[t.col.FileID]; }).map(function (r) { return fileObj_(t, r); }).slice(-500);
}
