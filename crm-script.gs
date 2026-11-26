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
 * Reference (admin only): links shared in WhatsApp chats, summarised and sorted, kept in a separate private sheet.
 *   See REFERENCE-SETUP.md.
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
var TASK_STATUSES = ['New', 'In progress', 'Waiting', 'Done', 'Cancelled']; // choices in the app; Done and Cancelled count as closed
var PRIORITIES = ['Urgent', 'High', 'Normal', 'Low']; // Task.Priority; the app lists Urgent first
var DELETED_STATUS = 'Deleted';  // deleted tasks keep their row (for the record) but are hidden everywhere
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
    if (/^ref[A-Z]/.test(String(req.action || ''))) return ref_(req); // Reference: admin only, private sheet
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
      if (req.action === 'taskStatus') return setTaskStatus_(req.taskId, req.status, me, who);
      if (req.action === 'taskPriority') return setTaskPriority_(req.taskId, req.priority, me);
      if (req.action === 'deleteTask') return setTaskStatus_(req.taskId, DELETED_STATUS, me, who);
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
  return t.rows.filter(function (r) { return r[t.col.TaskID] && String(r[t.col.Status]) !== DELETED_STATUS; }).map(function (r) {
    return { id: get_(t, r, 'TaskID'), title: get_(t, r, 'Title'), contactId: get_(t, r, 'ContactID'),
      role: get_(t, r, 'ForRole'), topic: get_(t, r, 'Topic'), priority: get_(t, r, 'Priority') || 'Normal',
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
    ContactID: contactId, AssignedTo: uid, CreatedBy: uid, DueDate: due, Priority: PRIORITIES.indexOf(String(task.priority)) >= 0 ? String(task.priority) : 'Normal', Status: OPEN_STATUS, CreatedAt: now,
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

/** Set a task's status. Closing it fills CompletedAt; deleting it also removes its calendar entries. */
function setTaskStatus_(taskId, status, me, who) {
  status = String(status || '');
  if (status !== DELETED_STATUS && TASK_STATUSES.indexOf(status) < 0) throw new Error('Unknown status: ' + status);
  var t = tab_('Task');
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][t.col.TaskID]) !== String(taskId)) continue;
    var now = new Date(), closed = status === 'Done' || status === 'Cancelled';
    setCell_(t, i, 'Status', status);
    setCell_(t, i, 'CompletedAt', closed || status === DELETED_STATUS ? now : '');
    append_(tab_('Activity'), { ActivityID: 'A-' + hex_(12), Timestamp: now, UserID: me ? me.id : '', ActionType: status === DELETED_STATUS ? 'Task deleted' : 'Task status',
      ContactID: t.rows[i][t.col.ContactID], TaskID: taskId, Description: (status === DELETED_STATUS ? 'Deleted' : 'Status set to ' + status) + ' in Task Scheduler' });
    if (status === DELETED_STATUS) removeTaskEvents_(taskId, who);
    return { ok: true, status: status };
  }
  throw new Error('Task not found');
}
function setTaskPriority_(taskId, priority, me) {
  priority = String(priority || '');
  if (PRIORITIES.indexOf(priority) < 0) throw new Error('Unknown priority: ' + priority);
  var t = tab_('Task');
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][t.col.TaskID]) !== String(taskId)) continue;
    setCell_(t, i, 'Priority', priority);
    append_(tab_('Activity'), { ActivityID: 'A-' + hex_(12), Timestamp: new Date(), UserID: me ? me.id : '', ActionType: 'Task priority',
      ContactID: t.rows[i][t.col.ContactID], TaskID: taskId, Description: 'Priority set to ' + priority + ' in Task Scheduler' });
    return { ok: true, priority: priority };
  }
  throw new Error('Task not found');
}
function removeTaskEvents_(taskId, who) {
  var e = tab_('Event');
  e.rows.forEach(function (r, k) {
    var cid = String(r[e.col.CalendarID]);
    if (String(r[e.col.TaskID]) !== String(taskId) || /^deleted:/.test(cid)) return;
    var gid = String(r[e.col.GoogleEventID] || '');
    if (gid) {
      try {
        var ct = calTab_(), row = ct.rows.filter(function (x) { return String(x[ct.col.CalendarID]) === cid; })[0];
        var g = row && gcal_(calObj_(ct, row)).getEventById(gid);
        if (g) g.deleteEvent();
      } catch (err) {}
    }
    setCell_(e, k, 'CalendarID', 'deleted:' + cid);
  });
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
    if (c.toGoogle && calObj_(t, t.rows[i]).type === 'App') toGoogle_(t, i, c.toGoogle === true || c.toGoogle === 'new' ? '' : String(c.toGoogle));
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

/** Move an app calendar onto Google Calendar (so phones get reminders): an existing Google Calendar of yours
 *  (googleId) or, without one, a new one with the same name. Its events are copied over. */
function toGoogle_(t, i, googleId) {
  var c = calObj_(t, t.rows[i]), g;
  if (googleId) {
    t.rows.forEach(function (r) { if (String(r[t.col.GoogleCalendarID]) === googleId) throw new Error('That Google Calendar is already used by another calendar'); });
    g = CalendarApp.getCalendarById(googleId);
    if (!g) throw new Error('Google Calendar not found');
  } else {
    g = CalendarApp.createCalendar(c.name);
    try { g.setColor(c.color); } catch (err) {}
  }
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

// ---------- Reference (admin only) ----------
// Links shared in WhatsApp chats, each opened, summarised and put in a category. Only someone with ADMIN_KEY can use it.
// Kept in a separate, private spreadsheet ("Task Scheduler Reference (private)", made in your Drive the first time),
// so team members who can open the CRM sheet never see your chats. Links arrive two ways:
// - reference-sync.py on your PC reads the chat you picked through the read-only WhatsApp MCP and sends its links here.
// - In the app you paste a chat (or open a WhatsApp "Export chat" .txt) and the phone sends the links.
// Nothing here ever sends a WhatsApp message.
var REF_SHEET_NAME = 'Task Scheduler Reference (private)';
var REF_BATCH = 3;              // links opened and summarised per request (Apps Script stops a request after 6 minutes)
var REF_MAX_HTML = 500000;      // characters of a page that are read
// Optional, free: a Gemini API key (aistudio.google.com, free tier) in Project Settings > Script properties as
// GEMINI_API_KEY gives written summaries. Without it, summaries come from the page's own description and first lines.
var REF_AI_MODEL = 'gemini-2.5-flash';
// Categories, checked in this order. Each: [name, website patterns, words in the title or text].
var REF_CATEGORIES = [
  ['Video', ['youtube.com', 'youtu.be', 'tiktok.com', 'vimeo.com', 'fb.watch', 'facebook.com/watch', 'facebook.com/reel', 'instagram.com/reel', 'bilibili.com', 'douyin.com'], ['video', 'watch', 'episode', 'vlog', '视频']],
  ['Social post', ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'threads.net', 'xiaohongshu.com', 'xhslink.com', 'weibo.com'], ['post', 'posted']],
  ['Maps & places', ['maps.google', 'goo.gl/maps', 'maps.app.goo.gl', 'waze.com', 'google.com/maps'], ['directions', 'location', 'lokasi', '地址']],
  ['Documents & files', ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'dropbox.com', 'onedrive.live.com', '1drv.ms', 'sharepoint.com', 'canva.com', 'wetransfer.com', '.pdf'], ['pdf', 'document', 'spreadsheet', 'brochure', 'catalogue', 'catalog']],
  ['Meetings & events', ['eventbrite', 'zoom.us', 'meet.google.com', 'teams.microsoft.com', 'calendly.com', 'lu.ma'], ['webinar', 'seminar', 'expo', 'exhibition', 'conference', 'workshop', 'register now', 'pameran', '研讨会', '展览']],
  ['Government & rules', ['.gov.my', '.gov', 'hasil.gov.my', 'ssm.com.my', 'kwsp.gov.my', 'perkeso.gov.my', 'st.gov.my', 'seda.gov.my', 'tnb.com.my', 'jkr.gov.my', 'mida.gov.my', 'mof.gov.my'], ['regulation', 'act ', 'akta', 'guideline', 'garis panduan', 'permit', 'licence', 'license', 'tax', 'cukai', 'compliance', 'gazette', 'warta', '法令', '税']],
  ['Shopping & suppliers', ['shopee.', 'lazada.', 'amazon.', 'aliexpress.', 'alibaba.', '1688.com', 'taobao.', 'tmall.', 'carousell.', 'mudah.my', 'temu.com', 'made-in-china.com'], ['price', 'buy now', 'add to cart', 'harga', 'beli', 'supplier', 'wholesale', 'quotation', 'sebut harga', '价格', '购买', '供应商']],
  ['Products & technical', [], ['datasheet', 'specification', 'spec sheet', 'btu', 'hvac', 'aircond', 'air-cond', 'air conditioner', 'inverter', 'compressor', 'chiller', 'ventilation', 'solar', 'pv ', 'energy efficiency', 'kwh', 'installation', 'model no', 'manual', '冷气', '空调', '规格']],
  ['News', ['thestar.com.my', 'nst.com.my', 'malaymail.com', 'freemalaysiatoday.com', 'bernama.com', 'malaysiakini.com', 'theedgemalaysia.com', 'sinchew.com.my', 'chinapress.com.my', 'orientaldaily.com.my', 'utusan.com.my', 'hmetro.com.my', 'bharian.com.my', 'says.com', 'bbc.', 'cnn.com', 'reuters.com', 'channelnewsasia.com', 'straitstimes.com', 'scmp.com'], ['news', 'berita', 'breaking', 'reported', 'said on', '新闻', '报道']],
  ['Money & business', ['maybank', 'cimb', 'publicbank', 'rhbgroup', 'hongleong', 'bursamalaysia', 'investing.com', 'bloomberg.com'], ['loan', 'pinjaman', 'grant', 'geran', 'financing', 'invest', 'pelaburan', 'interest rate', 'stock', 'saham', 'revenue', 'profit', '贷款', '投资']],
  ['Learning & how-to', ['wikipedia.org', 'medium.com', 'udemy.com', 'coursera.org', 'khanacademy.org', 'stackoverflow.com', 'github.com'], ['how to', 'tutorial', 'guide', 'tips', 'learn', 'course', 'cara ', 'panduan', '教程', '如何']],
  ['Other', [], []]
];

function refSheet_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('refSheet'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(REF_SHEET_NAME); props.setProperty('refSheet', ss.getId()); }
  return ss;
}
var REF_HEADERS = {
  RefChat: ['ChatID', 'Name', 'Kind', 'RequestedAt', 'SyncedAt', 'LinkCount', 'Note'],
  Reference: ['RefID', 'ChatID', 'ChatName', 'Url', 'UrlKey', 'Domain', 'Title', 'Summary', 'Category', 'CategoryBy', 'SharedBy', 'SharedAt',
    'Message', 'Status', 'Error', 'Tries', 'FetchedAt', 'AddedAt', 'Source']
};
function refTab_(name) {
  var ss = refSheet_(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(REF_HEADERS[name]); sh.setFrozenRows(1); }
  return read_(sh);
}

function ref_(req) {
  var admin = !!req.adminKey && String(req.adminKey) === ADMIN_KEY && ADMIN_KEY !== 'change-me-too';
  if (!admin) throw new Error('Only the admin can use Reference');
  var a = req.action;
  if (a === 'refProcess') return refProcess_(req.chatId);
  var lock = refLock_();
  lock.waitLock(30000);
  try {
    if (a === 'refChats') return { ok: true, chats: refChats_(), pcSeen: PropertiesService.getScriptProperties().getProperty('refPcSeen') || '', categories: refCategoryNames_() };
    if (a === 'refLinks') return { ok: true, links: refLinks_(req.chatId), categories: refCategoryNames_() };
    if (a === 'refRequest') return { ok: true, chat: refRequest_(req.chatId, req.name) };
    if (a === 'refPushChats') { refSeen_(); return { ok: true, count: refPushChats_(req.chats || []) }; }
    if (a === 'refPending') { refSeen_(); return { ok: true, chats: refPending_() }; }
    if (a === 'refPush') { if (req.source === 'pc') refSeen_(); return refPush_(req.chat || {}, req.links || [], req.source || 'app'); }
    if (a === 'refUpdate') return { ok: true, link: refUpdate_(req.id, req) };
    throw new Error('Unknown action');
  } finally { lock.releaseLock(); }
}
/** Reference's own lock: separate from the one the team's syncs use, so neither ever waits for the other. */
function refLock_() { return LockService.getDocumentLock() || LockService.getScriptLock(); }
/** Add many rows with one write. (One appendRow per row takes about a second each, which is far too slow for thousands.) */
function appendMany_(t, objs) {
  if (!objs.length) return;
  var rows = objs.map(function (o) { return t.head.map(function (h) { return o[h] !== undefined ? o[h] : ''; }); });
  t.sh.getRange(t.rows.length + 2, 1, rows.length, t.head.length).setValues(rows);
  rows.forEach(function (r) { t.rows.push(r); });
}
var REF_CHAT_ID = /@(s\.whatsapp\.net|g\.us|lid|c\.us)$/; // people and groups; not status updates, channels or broadcast lists
function refSeen_() { PropertiesService.getScriptProperties().setProperty('refPcSeen', fmt_(new Date(), 'yyyy-MM-dd HH:mm')); }
function refCategoryNames_() { return REF_CATEGORIES.map(function (c) { return c[0]; }); }

function refChats_() {
  var t = refTab_('RefChat'), r = refTab_('Reference'), count = {}, pending = {};
  r.rows.forEach(function (x) {
    var id = get_(r, x, 'ChatID'), st = get_(r, x, 'Status');
    count[id] = (count[id] || 0) + 1;
    if (st === 'Pending' || st === 'Working') pending[id] = (pending[id] || 0) + 1;
  });
  return t.rows.filter(function (x) { return x[t.col.ChatID]; }).map(function (x) {
    var id = get_(t, x, 'ChatID');
    return { id: id, name: get_(t, x, 'Name'), kind: get_(t, x, 'Kind'), requestedAt: get_(t, x, 'RequestedAt'), syncedAt: get_(t, x, 'SyncedAt'),
      links: count[id] || 0, pending: pending[id] || 0 };
  });
}
function refChatRow_(t, id) {
  for (var i = 0; i < t.rows.length; i++) if (get_(t, t.rows[i], 'ChatID') === id) return i;
  return -1;
}
/** Add or rename a chat; returns its row index. */
function refUpsertChat_(t, c) {
  var id = String(c.id || '').trim(), name = String(c.name || '').trim();
  if (!id) throw new Error('No chat');
  var i = refChatRow_(t, id);
  if (i < 0) { append_(t, { ChatID: id, Name: name || id, Kind: c.kind || (/@g\.us$/.test(id) ? 'Group' : 'Contact') }); return t.rows.length - 1; }
  if (name && name !== get_(t, t.rows[i], 'Name')) setCell_(t, i, 'Name', name);
  return i;
}
function refPushChats_(chats) {
  var t = refTab_('RefChat'), at = {}, add = [], renamed = false, n = 0;
  t.rows.forEach(function (r, i) { at[String(r[t.col.ChatID])] = i; });
  chats.slice(0, 20000).forEach(function (c) {
    var id = String(c && c.id || '').trim(), name = String(c && c.name || '').trim();
    if (!REF_CHAT_ID.test(id)) return;
    n++;
    if (at[id] === undefined) {
      at[id] = -1;
      add.push({ ChatID: id, Name: name || id.split('@')[0], Kind: c.kind || (/@g\.us$/.test(id) ? 'Group' : 'Contact') });
    } else if (at[id] >= 0 && name && name !== String(t.rows[at[id]][t.col.Name])) {
      t.rows[at[id]][t.col.Name] = name; renamed = true;
    }
  });
  if (renamed && t.rows.length) t.sh.getRange(2, t.col.Name + 1, t.rows.length, 1).setValues(t.rows.map(function (r) { return [r[t.col.Name]]; }));
  appendMany_(t, add);
  return n;
}
/** The app asks for a chat's links. reference-sync.py on your PC sees the request and sends them. */
function refRequest_(id, name) {
  var t = refTab_('RefChat'), i = refUpsertChat_(t, { id: id, name: name });
  setCell_(t, i, 'RequestedAt', new Date());
  return refChats_().filter(function (c) { return c.id === String(id).trim(); })[0];
}
function refMs_(v) { if (v instanceof Date) return v.getTime(); var d = v ? new Date(String(v).replace(' ', 'T')) : null; return d && !isNaN(d) ? d.getTime() : 0; }
function refPending_() {
  var t = refTab_('RefChat');
  return t.rows.filter(function (x) {
    var req = refMs_(x[t.col.RequestedAt]), syn = refMs_(x[t.col.SyncedAt]);
    return req && req > syn;
  }).map(function (x) { return { id: get_(t, x, 'ChatID'), name: get_(t, x, 'Name'), since: get_(t, x, 'SyncedAt') }; });
}

/** Same link, written differently: no tracking tags, no #part, lower-case site, no trailing slash. */
function refKey_(url) {
  var m = String(url || '').trim().match(/^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) return '';
  var host = m[2].toLowerCase().replace(/^www\./, ''), path = m[3].replace(/\/+$/, '');
  var q = (m[4] || '').slice(1).split('&').filter(function (p) { return p && !/^(utm_[a-z]+|fbclid|gclid|igshid|igsh|si|mibextid|ref_src)=/i.test(p); });
  return host + path + (q.length ? '?' + q.join('&') : '');
}
/** A link as typed in a chat, without the full stop or bracket after it. Keeps (…) that belong to it, as in Wikipedia links. */
function refCleanUrl_(url) {
  var u = String(url || '').trim().replace(/^<+/, ''), n = function (c) { return u.split(c).length - 1; };
  while (u) {
    var last = u.slice(-1);
    if (/[\]}>.,;:!?'"*_~]/.test(last) || last === ')' && n(')') > n('(')) u = u.slice(0, -1); else break;
  }
  return u;
}
function refPush_(chat, links, source) {
  var c = refTab_('RefChat'), t = refTab_('Reference'), ci = refUpsertChat_(c, chat), have = {}, added = 0;
  var chatId = get_(c, c.rows[ci], 'ChatID'), chatName = get_(c, c.rows[ci], 'Name');
  t.rows.forEach(function (r) { if (get_(t, r, 'ChatID') === chatId) have[get_(t, r, 'UrlKey')] = 1; });
  var add = [];
  links.slice(0, 5000).forEach(function (l) {
    var url = refCleanUrl_(l.url), key = refKey_(url);
    if (!key || have[key]) return;
    have[key] = 1;
    add.push({ RefID: 'REF-' + hex_(8), ChatID: chatId, ChatName: chatName, Url: url, UrlKey: key, Domain: key.split('/')[0],
      SharedBy: String(l.sharedBy || '').slice(0, 80), SharedAt: String(l.sharedAt || '').slice(0, 40), Message: String(l.message || '').slice(0, 300),
      Status: 'Pending', Tries: 0, AddedAt: new Date(), Source: source });
    added++;
  });
  appendMany_(t, add);
  setCell_(c, ci, 'SyncedAt', new Date());
  var total = t.rows.filter(function (r) { return get_(t, r, 'ChatID') === chatId; }).length;
  setCell_(c, ci, 'LinkCount', total);
  return { ok: true, added: added, total: total, chatId: chatId };
}
function refObj_(t, r) {
  var o = {};
  [['id', 'RefID'], ['chatId', 'ChatID'], ['chat', 'ChatName'], ['url', 'Url'], ['domain', 'Domain'], ['title', 'Title'], ['summary', 'Summary'],
   ['category', 'Category'], ['categoryBy', 'CategoryBy'], ['by', 'SharedBy'], ['at', 'SharedAt'], ['message', 'Message'], ['status', 'Status'],
   ['error', 'Error'], ['addedAt', 'AddedAt']].forEach(function (p) { o[p[0]] = get_(t, r, p[1]); });
  return o;
}
function refLinks_(chatId) {
  var t = refTab_('Reference');
  return t.rows.filter(function (r) { return r[t.col.RefID] && (!chatId || get_(t, r, 'ChatID') === chatId); })
    .map(function (r) { return refObj_(t, r); }).reverse().slice(0, 1500);
}
function refFind_(t, id) {
  for (var i = 0; i < t.rows.length; i++) if (get_(t, t.rows[i], 'RefID') === id) return i;
  throw new Error('Link not found');
}
/** Change a link's category by hand, or try a failed link again. */
function refUpdate_(id, p) {
  var t = refTab_('Reference'), i = refFind_(t, id);
  if (p.category !== undefined) {
    if (refCategoryNames_().indexOf(p.category) < 0) throw new Error('Unknown category');
    setCell_(t, i, 'Category', p.category); setCell_(t, i, 'CategoryBy', 'You');
  }
  if (p.retry) { setCell_(t, i, 'Status', 'Pending'); setCell_(t, i, 'Tries', 0); setCell_(t, i, 'Error', ''); }
  return refObj_(t, t.rows[i]);
}

/**
 * Open and summarise up to REF_BATCH waiting links (of one chat first, if given). The pages are fetched outside the
 * lock, so the rest of the app is never kept waiting. Returns how many are still waiting.
 */
function refProcess_(chatId) {
  var lock = refLock_(), picked = [], now = Date.now();
  lock.waitLock(30000);
  try {
    var t = refTab_('Reference'), order = [];
    t.rows.forEach(function (r, i) {
      var st = get_(t, r, 'Status'), fetched = r[t.col.FetchedAt];
      var stale = st === 'Working' && (!(fetched instanceof Date) || now - fetched.getTime() > 10 * 60000);
      if (st === 'Pending' || stale) order.push(i);
    });
    if (chatId) order.sort(function (a, b) { return (get_(t, t.rows[b], 'ChatID') === chatId) - (get_(t, t.rows[a], 'ChatID') === chatId); });
    order.slice(0, REF_BATCH).forEach(function (i) {
      setCell_(t, i, 'Status', 'Working'); setCell_(t, i, 'FetchedAt', new Date());
      picked.push({ id: get_(t, t.rows[i], 'RefID'), url: get_(t, t.rows[i], 'Url'), message: get_(t, t.rows[i], 'Message'), tries: +t.rows[i][t.col.Tries] || 0 });
    });
  } finally { lock.releaseLock(); }

  var results = picked.map(function (p) {
    try { return { p: p, s: refSummarise_(p.url, p.message) }; } catch (err) { return { p: p, err: String(err.message || err).slice(0, 200) }; }
  });

  lock.waitLock(30000);
  try {
    var t2 = refTab_('Reference'), left = 0;
    results.forEach(function (x) {
      var i = refFind_(t2, x.p.id);
      if (x.s) {
        setCell_(t2, i, 'Title', x.s.title); setCell_(t2, i, 'Summary', x.s.summary);
        if (get_(t2, t2.rows[i], 'CategoryBy') !== 'You') { setCell_(t2, i, 'Category', x.s.category); setCell_(t2, i, 'CategoryBy', x.s.by); }
        setCell_(t2, i, 'Status', 'Done'); setCell_(t2, i, 'Error', '');
      } else {
        var tries = x.p.tries + 1;
        setCell_(t2, i, 'Tries', tries); setCell_(t2, i, 'Error', x.err);
        setCell_(t2, i, 'Status', tries >= 2 ? 'Failed' : 'Pending');
        // Still give it a category from the link and message alone.
        if (get_(t2, t2.rows[i], 'CategoryBy') !== 'You') { setCell_(t2, i, 'Category', refCategorise_(x.p.url, '', x.p.message)); setCell_(t2, i, 'CategoryBy', 'Link only'); }
      }
      setCell_(t2, i, 'FetchedAt', new Date());
    });
    t2.rows.forEach(function (r) { var st = get_(t2, r, 'Status'); if (st === 'Pending' || st === 'Working') left++; });
    return { ok: true, done: results.length, left: left };
  } finally { lock.releaseLock(); }
}
/** Run every few minutes from a time trigger (optional): Triggers > Add trigger > summariseReferences > Time-driven. */
function summariseReferences() { for (var k = 0; k < 5; k++) { if (!refProcess_('').left) break; } }

function refFetch_(url, opt) {
  return UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8,zh;q=0.7' } }, opt || {}));
}
/** { title, summary, category, by } for one link. */
function refSummarise_(url, message) {
  var info = { title: '', description: '', text: '', kind: '' };
  var key = refKey_(url), host = key.split('/')[0];
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) {
    var o = refFetch_('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
    if (o.getResponseCode() === 200) { var j = JSON.parse(o.getContentText()); info.title = j.title || ''; info.author = j.author_name || ''; info.kind = 'YouTube video'; }
  }
  var res = refFetch_(url), code = res.getResponseCode(), type = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
  if (code >= 400 && !info.title) throw new Error('The page answered ' + code + (code === 403 || code === 401 ? ' (it needs a login, or blocks robots)' : ''));
  if (/pdf/i.test(type) || /\.pdf$/i.test(key)) {
    info.kind = 'PDF';
    info.title = info.title || decodeURIComponent(key.split('/').pop().replace(/\.pdf$/i, '')).replace(/[-_+]+/g, ' ');
    info.text = 'PDF document, ' + Math.round(res.getBlob().getBytes().length / 1024) + ' KB.';
    try { info.text = refPdfText_(res.getBlob()) || info.text; } catch (e) {}
  } else if (/image\//i.test(type)) {
    info.kind = 'Image'; info.text = 'An image (' + type.split(';')[0] + ').';
  } else if (code < 400) {
    var page = refPage_(res.getContentText().slice(0, REF_MAX_HTML));
    info.title = info.title || page.title; info.description = page.description; info.text = page.text; info.site = page.site;
  }
  var ai = refAi_(url, info, message);
  if (ai) return { title: (info.title || ai.title || key).slice(0, 200), summary: ai.summary, category: ai.category, by: 'AI' };
  return { title: (info.title || key).slice(0, 200), summary: refSummaryOf_(info), category: refCategorise_(url, info.title + ' ' + info.description, info.text + ' ' + (message || '')), by: 'Auto' };
}
/** A PDF's first words, through Drive's free text conversion (needs the Drive API advanced service; skipped without it). */
function refPdfText_(blob) {
  if (typeof Drive === 'undefined' || !Drive.Files) return '';
  var f = Drive.Files.create({ name: 'ref-tmp', mimeType: 'application/vnd.google-apps.document' }, blob);
  try { return DocumentApp.openById(f.id).getBody().getText().replace(/\s+/g, ' ').slice(0, 3000); }
  finally { try { Drive.Files.remove(f.id); } catch (e) { DriveApp.getFileById(f.id).setTrashed(true); } }
}

function refDecode_(s) {
  return String(s || '').replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
/** Title, description and readable text of an HTML page. */
function refPage_(html) {
  var meta = function (names) {
    for (var i = 0; i < names.length; i++) {
      var re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + names[i] + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
      var re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + names[i] + '["\']', 'i');
      var m = html.match(re1) || html.match(re2);
      if (m && refDecode_(m[1])) return refDecode_(m[1]);
    }
    return '';
  };
  var t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var body = html.replace(/<(script|style|noscript|svg|nav|header|footer|form|aside|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  var paras = [];
  body.replace(/<(p|h1|h2|li)[^>]*>([\s\S]*?)<\/\1>/gi, function (m, tag, inner) {
    var s = refDecode_(inner.replace(/<[^>]+>/g, ' '));
    if (s.length >= (tag === 'p' ? 40 : 20) && !/cookie|subscribe|sign in|log in|javascript|all rights reserved|copyright/i.test(s)) paras.push(s);
    return m;
  });
  if (!paras.length) { var plain = refDecode_(body.replace(/<[^>]+>/g, ' ')); if (plain) paras.push(plain.slice(0, 2000)); }
  return { title: meta(['og:title', 'twitter:title']) || refDecode_(t ? t[1] : ''), description: meta(['og:description', 'description', 'twitter:description']),
    site: meta(['og:site_name']), text: paras.join(' ').slice(0, 4000) };
}
/** Two or three sentences: the page's own description, topped up with its first lines. */
function refSummaryOf_(info) {
  var d = info.description || '', text = info.text || '';
  var sentences = function (s) { return (s.match(/[^.!?。！？]+[.!?。！？]+["')\]]?|[^.!?。！？]+$/g) || []).map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 2; }); };
  var out = d;
  if (out.length < 120) {
    var extra = sentences(text).filter(function (s) { return out.indexOf(s.slice(0, 30)) < 0 && s !== info.title; });
    while (extra.length && out.length < 220) out = (out ? out + ' ' : '') + extra.shift();
  }
  if (!out) out = info.kind ? info.kind + (info.author ? ' by ' + info.author : '') + '.' : 'No description on this page.';
  else if (info.kind === 'YouTube video' && info.author) out = 'YouTube video by ' + info.author + '. ' + out;
  return out.length > 320 ? out.slice(0, 317).replace(/\s+\S*$/, '') + '…' : out;
}
/** The best-matching category: a website match counts most, then words in the title, then words in the text. */
function refCategorise_(url, title, text) {
  var u = String(url || '').toLowerCase(), ti = ' ' + String(title || '').toLowerCase() + ' ', tx = ' ' + String(text || '').toLowerCase() + ' ';
  var best = 'Other', bestScore = 0;
  REF_CATEGORIES.forEach(function (c) {
    var score = 0;
    c[1].forEach(function (d) { if (u.indexOf(d) >= 0) score += 6; });
    c[2].forEach(function (w) { if (ti.indexOf(w) >= 0) score += 2; if (tx.indexOf(w) >= 0) score += 1; });
    if (score > bestScore) { best = c[0]; bestScore = score; }
  });
  return best;
}
/** Optional free AI summary (Gemini free tier). Returns null when no key is set or anything goes wrong. */
function refAi_(url, info, message) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return null;
  try {
    var cats = refCategoryNames_();
    var prompt = 'Summarise this web page in 2 or 3 short sentences in English, and pick one category from: ' + cats.join(', ') +
      '. Reply only with JSON {"title":"...","summary":"...","category":"..."}.\nURL: ' + url + '\nTitle: ' + info.title +
      '\nDescription: ' + info.description + '\nText: ' + String(info.text || '').slice(0, 6000) + '\nShared with the message: ' + String(message || '').slice(0, 300);
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + REF_AI_MODEL + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }) });
    if (r.getResponseCode() !== 200) return null;
    var j = JSON.parse(JSON.parse(r.getContentText()).candidates[0].content.parts[0].text);
    if (!j.summary) return null;
    return { title: String(j.title || ''), summary: String(j.summary).slice(0, 500), category: cats.indexOf(j.category) >= 0 ? j.category : refCategorise_(url, info.title, info.text) };
  } catch (e) { return null; }
}
