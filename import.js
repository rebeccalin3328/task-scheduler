// Add a batch of tasks from a link: index.html#import=<base64url JSON>.
// The list is shown first, and nothing is saved until you tap Add. Saving uses the CRM link and team key already on
// this phone, so the link itself carries no keys. The part after # never leaves the phone (browsers don't send it).
// Payload: { tasks: [{ ref, title, due: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM', description, role, topic,
//                      client: { name, phone, company } or null }] }
// You pick one calendar for the whole list, and can change it for any single task. Tasks with a date are also put on
// that calendar. Opening the same link again only adds the calendar entries: tasks are never added twice (same ref).
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function when(due) {
    if (!due) return 'No date';
    var p = due.split(' '), d = p[0].split('-').map(Number), dt = new Date(d[0], d[1] - 1, d[2]);
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + (p[1] ? ', ' + p[1] : '');
  }
  // Calendar fields for a task on calendar calId ('' = task list only). A date alone is an all-day entry;
  // with a time it is one hour long (the server fills in the end).
  function slot(due, calId) {
    if (!calId || !due) return {};
    var p = due.split(' ');
    return p[1] ? { calendarId: calId, start: p[0] + 'T' + p[1], allDay: false } : { calendarId: calId, start: p[0], end: p[0], allDay: true };
  }
  // One save request per task, in the same shape the New task form uses. calFor(i) gives task i's calendar id.
  function items(tasks, calFor) {
    return tasks.map(function (t, i) {
      var c = t.client && (t.client.phone || t.client.name || t.client.company) ? t.client : { none: true };
      return { action: 'save', client: c, task: Object.assign({ title: t.title, due: t.due || '', description: t.description || '', ref: t.ref,
        role: t.role || '', topic: t.topic || '' }, slot(t.due, calFor ? calFor(i) : '')) };
    });
  }
  function calendars() {
    var st = window.CRM && CRM.state();
    return ((st && st.calendars) || []).filter(function (c) { return c.active !== false; });
  }
  function options(cals, sel, first) {
    return first + cals.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>● ' + esc(c.name) + '</option>';
    }).join('') + '<option value=""' + (sel === '' ? ' selected' : '') + '>No calendar (task list only)</option>';
  }

  function show(data) {
    var tasks = (data && data.tasks || []).filter(function (t) { return t && t.title && t.ref; });
    if (!tasks.length) return;
    var box = document.createElement('div');
    box.id = 'importBox';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.45);overflow:auto;padding:16px');
    box.innerHTML = '<section class="card" style="max-width:560px;width:auto;margin:0 auto;box-sizing:border-box;overflow-wrap:anywhere">' +
      '<h2 style="margin:0 0 4px">Add ' + tasks.length + ' tasks?</h2>' +
      '<p style="margin:0 0 10px;opacity:.75">Found in your WhatsApp chats. Untick any you don\'t want.</p>' +
      '<label style="display:block;font-weight:600;margin:0 0 4px" for="importCal">📅 Put them on this calendar</label>' +
      '<select id="importCal" style="width:100%;margin-bottom:6px"></select>' +
      tasks.map(function (t, i) {
        return '<div style="padding:8px 0;border-top:1px solid var(--line)"><label style="display:flex;gap:10px;align-items:flex-start">' +
          '<input type="checkbox" data-i="' + i + '" checked style="margin-top:4px;width:20px;height:20px">' +
          '<span><b>' + esc(t.title) + '</b><br><small>' + esc(when(t.due)) +
          (t.role ? ' · ' + esc(t.role) : '') + (t.client && t.client.name ? ' · ' + esc(t.client.name) : '') + '</small></span></label>' +
          (t.due ? '<select data-cal="' + i + '" style="margin:6px 0 0 30px;max-width:calc(100% - 30px);font-size:.9em"></select>'
            : '<small style="display:block;margin:4px 0 0 30px;opacity:.7">No date, so task list only.</small>') + '</div>';
      }).join('') +
      '<div id="importNote" class="chip hidden"></div>' +
      '<button class="btn primary" id="importGo" style="margin-top:12px">Add selected tasks</button>' +
      '<button class="btn secondary" id="importNo">Cancel</button></section>';
    document.body.appendChild(box);

    function close() { box.remove(); history.replaceState(null, '', location.pathname + location.search); }
    // Calendar pickers: one for the whole list, and one per task ("Same as above" follows the main one).
    var hadCals = false; // until the calendars arrive, keep choosing the default
    function fillCals() {
      var cals = calendars(), main = $('importCal'), keep = main.value, had = hadCals;
      hadCals = cals.length > 0;
      var pref = String(window.App && App.store.get('lastCal', '') || '').replace(/^c:/, '');
      var dflt = had ? keep : cals.some(function (c) { return c.id === pref; }) ? pref : cals.length ? cals[0].id : '';
      main.innerHTML = options(cals, dflt, '');
      Array.prototype.forEach.call(box.querySelectorAll('select[data-cal]'), function (s) {
        var v = had ? s.value : '*';
        s.innerHTML = options(cals, v, '<option value="*"' + (v === '*' ? ' selected' : '') + '>Same as above</option>');
      });
    }
    function calFor(i) {
      var s = box.querySelector('select[data-cal="' + i + '"]');
      return !s ? '' : s.value === '*' ? $('importCal').value : s.value;
    }
    function calName(id) { var c = calendars().filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; }
    fillCals();
    if (window.CRM && CRM.cfg().url && !calendars().length) CRM.list().then(fillCals);
    $('importNo').onclick = close;
    $('importGo').onclick = function () {
      var note = $('importNote');
      if (!window.CRM || !CRM.cfg().url) {
        note.className = 'chip warn'; note.textContent = 'Add the CRM link and team key in ⚙︎ first, then open this link again.';
        return;
      }
      var idx = tasks.map(function (t, i) { return i; }).filter(function (i) { return box.querySelector('input[data-i="' + i + '"]').checked; });
      var picked = idx.map(function (i) { return tasks[i]; });
      if (!picked.length) { close(); return; }
      var cals = idx.map(calFor), names = {};
      cals.forEach(function (id) { if (id) names[calName(id) || id] = (names[calName(id) || id] || 0) + 1; });
      var where = Object.keys(names).map(function (n) { return names[n] + ' on ' + n; }).join(', ');
      this.disabled = true;
      note.className = 'chip ok'; note.textContent = 'Saving ' + picked.length + ' tasks…';
      var last;
      items(picked, function (j) { return cals[j]; }).forEach(function (it) { last = CRM.queueItem(it); });
      if ($('importCal').value) App.store.set('lastCal', 'c:' + $('importCal').value);
      last.then(function () {
        note.textContent = '✓ Added ' + picked.length + ' tasks' + (where ? ' (' + where + ' calendar)' : '') + '.';
        CRM.list();
        if (window.CAL) CAL.changed();
        setTimeout(close, 1500);
      }, function () {
        note.className = 'chip warn';
        note.textContent = 'Saved on this phone. They will upload to the CRM sheet when you are back online.';
      });
    };
  }

  var m = location.hash.match(/^#import=([A-Za-z0-9_-]+)$/);
  if (m) { try { show(decode(m[1])); } catch (e) { console.warn('Bad import link', e); } }
  window.IMPORT = { decode: decode, items: items, slot: slot };
})();
