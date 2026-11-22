// Built-in calendar: month, week and day views of the calendars shared with you, plus the admin screen
// for creating, linking and sharing calendars. Data comes from the CRM sheet script (crm-script.gs).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var A = window.App, C = window.CRM, store = A.store, pad = A.pad;
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  var mode = store.get('calMode', 'week'), cursor = new Date(), events = [], loadedKey = '', hidden = load('calHidden', {});
  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  $('calMode').value = mode;

  // ---- dates (local time) ----
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function startOfWeek(d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); }
  function parse(s) { var m = String(s).match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/); return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)); }
  function time(s) { var d = parse(s); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function range() {
    if (mode === 'day') { var d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()); return [d, addDays(d, 1)]; }
    if (mode === 'week') { var w = startOfWeek(cursor); return [w, addDays(w, 7)]; }
    var first = new Date(cursor.getFullYear(), cursor.getMonth(), 1), s = startOfWeek(first);
    return [s, addDays(s, 42)];
  }

  function cals() { return (C.state().calendars || []).filter(function (c) { return c.active !== false; }); }
  function calById(id) { return cals().filter(function (c) { return c.id === id; })[0] || { name: '?', color: '#999' }; }
  function shown(e) { return !hidden[e.calendarId] && calById(e.calendarId).name !== '?'; }

  // ---- loading ----
  function fetchEvents(force) {
    if (!C.cfg().url) { status('Tap ⚙︎ and add the CRM link to use the calendar.'); render(); return; }
    var r = range(), key = ymd(r[0]) + '/' + ymd(r[1]);
    if (!force && key === loadedKey) { render(); return; }
    var cached = load('calCache', {});
    if (cached.key === key) { events = cached.events; render(); }
    status('Loading…');
    C.api({ action: 'events', from: ymd(r[0]), to: ymd(r[1]) }).then(function (j) {
      if (key !== ymd(range()[0]) + '/' + ymd(range()[1])) return; // user moved on
      events = j.events; loadedKey = key; keep('calCache', { key: key, events: events });
      status(''); render();
    }, function (err) {
      status(err.message === 'no-link' ? 'Tap ⚙︎ and add the CRM link.' : 'Offline. Showing what was last loaded.');
      render();
    });
  }
  function status(t) { $('calStatus').textContent = t; }

  // ---- rendering ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function onDay(d) {
    var a = ymd(d);
    return events.filter(function (e) { return shown(e) && e.start.slice(0, 10) <= a && e.end.slice(0, 10) >= a; })
      .sort(function (x, y) { return (y.allDay - x.allDay) || (x.start < y.start ? -1 : 1); });
  }
  function chips() {
    var box = $('calChips'); box.innerHTML = '';
    cals().forEach(function (c) {
      var b = el('button', hidden[c.id] ? 'off' : '');
      var dot = el('span', 'dot'); dot.style.background = c.color; b.appendChild(dot);
      b.appendChild(document.createTextNode(c.name + (c.type === 'Google' ? ' (Google)' : '')));
      b.onclick = function () { hidden[c.id] = !hidden[c.id]; keep('calHidden', hidden); render(); };
      box.appendChild(b);
    });
    $('calManage').classList.toggle('hidden', !C.state().isAdmin);
  }
  function render() {
    chips();
    var body = $('calBody'); body.innerHTML = '';
    var r = range(), today = ymd(new Date());
    if (mode === 'month') {
      $('calTitle').textContent = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      var g = el('div', 'month');
      DOW.forEach(function (d) { g.appendChild(el('div', 'dow', d)); });
      for (var i = 0; i < 42; i++) (function (d) {
        var cell = el('div', 'day' + (d.getMonth() !== cursor.getMonth() ? ' other' : '') + (ymd(d) === today ? ' today' : ''));
        cell.appendChild(el('span', 'num', d.getDate()));
        var list = onDay(d);
        list.slice(0, 3).forEach(function (e) {
          var p = el('span', 'pill', e.title);
          p.style.background = calById(e.calendarId).color; cell.appendChild(p);
        });
        if (list.length > 3) cell.appendChild(el('span', 'more', '+' + (list.length - 3) + ' more'));
        cell.onclick = function () { cursor = d; setMode('day'); };
        g.appendChild(cell);
      })(addDays(r[0], i));
      body.appendChild(g);
      return;
    }
    var days = mode === 'week' ? 7 : 1;
    $('calTitle').textContent = mode === 'day'
      ? cursor.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      : r[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' – ' + addDays(r[0], 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    var ag = el('div', 'agenda');
    for (var k = 0; k < days; k++) {
      var d = addDays(r[0], k), list = onDay(d);
      if (mode === 'week') ag.appendChild(el('h3', ymd(d) === today ? 'today' : '', d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) + (ymd(d) === today ? ' · Today' : '')));
      if (!list.length) ag.appendChild(el('div', 'hint', mode === 'day' ? 'Nothing on this day. Tap ＋ to add.' : 'Nothing planned'));
      list.forEach(function (e) { ag.appendChild(evRow(e)); });
    }
    body.appendChild(ag);
  }
  function evRow(e) {
    var c = calById(e.calendarId), r = el('div', 'ev');
    var bar = el('div', 'bar'); bar.style.background = c.color; r.appendChild(bar);
    var m = el('div', 'meta');
    m.appendChild(el('div', 'tt', e.title || '(no title)'));
    var client = e.contactId ? (C.state().clients || []).filter(function (x) { return x.id === e.contactId; })[0] : null;
    m.appendChild(el('small', '', [e.allDay ? 'All day' : time(e.start) + ' – ' + time(e.end), c.name, client ? '👤 ' + client.company : '', e.location].filter(Boolean).join(' · ')));
    r.appendChild(m);
    r.onclick = function () { openEvent(e); };
    return r;
  }
  function setMode(m) { mode = m; $('calMode').value = m; store.set('calMode', m); fetchEvents(); }
  function move(n) {
    cursor = mode === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, n * (mode === 'week' ? 7 : 1));
    fetchEvents();
  }
  $('calPrev').onclick = function () { move(-1); };
  $('calNext').onclick = function () { move(1); };
  $('calToday').onclick = function () { cursor = new Date(); fetchEvents(); };
  $('calMode').onchange = function () { setMode($('calMode').value); };
  $('tabCal').onclick = function () { C.show('cal'); fetchEvents(true); };

  // ---- event editor ----
  var editing = null;
  function fillCalSelect(sel, value) {
    sel.innerHTML = '';
    cals().forEach(function (c) { var o = el('option', '', c.name + (c.type === 'Google' ? ' (Google)' : '')); o.value = c.id; sel.appendChild(o); });
    if (value) sel.value = value;
  }
  function toggleEvTime() { $('evTimeRow').classList.toggle('hidden', $('evAllDay').checked); }
  $('evAllDay').onchange = toggleEvTime;
  function openEvent(e) {
    editing = e || null;
    var d = mode === 'day' ? cursor : new Date();
    var start = e ? e.start : ymd(d) + 'T09:00', end = e ? e.end : ymd(d) + 'T10:00';
    $('evTitle').value = e ? e.title : '';
    fillCalSelect($('evCal'), e ? e.calendarId : (store.get('lastCal', '').replace(/^c:/, '') || (cals()[0] || {}).id));
    $('evCal').disabled = !!e;
    $('evDate').value = start.slice(0, 10); $('evEndDate').value = end.slice(0, 10);
    $('evAllDay').checked = e ? !!e.allDay : false;
    $('evStart').value = start.slice(11, 16) || '09:00'; $('evEnd').value = end.slice(11, 16) || '10:00';
    $('evLoc').value = e ? e.location || '' : ''; $('evDesc').value = e ? e.description || '' : '';
    $('evMeta').textContent = e ? [calById(e.calendarId).name + ' calendar', e.by ? 'added by ' + e.by : ''].filter(Boolean).join(' · ') : 'New event';
    $('evClient').classList.toggle('hidden', !(e && e.contactId));
    $('evDelete').classList.toggle('hidden', !e);
    $('evNote').textContent = '';
    toggleEvTime();
    C.show('ev');
    if (!e) $('evTitle').focus();
  }
  $('calAdd').onclick = function () {
    if (!cals().length) { status(C.cfg().url ? 'No calendars are shared with you yet. Ask Rebecca.' : 'Tap ⚙︎ and add the CRM link first.'); return; }
    openEvent(null);
  };
  $('evBack').onclick = function () { C.show('cal'); render(); };
  $('evClient').onclick = function () { if (editing) C.openClient(editing.contactId); };
  function evData() {
    var allDay = $('evAllDay').checked, d = $('evDate').value, ed = $('evEndDate').value || d;
    if (ed < d) ed = d;
    return { title: $('evTitle').value.trim() || 'Event', calendarId: $('evCal').value, allDay: allDay,
      start: allDay ? d : d + 'T' + ($('evStart').value || '09:00'), end: allDay ? ed : ed + 'T' + ($('evEnd').value || $('evStart').value || '10:00'),
      location: $('evLoc').value.trim(), description: $('evDesc').value.trim() };
  }
  $('evSave').onclick = function () {
    if (!$('evDate').value) { $('evNote').textContent = 'Pick a date.'; return; }
    var ev = evData(), req;
    if (editing) { ev.id = editing.id; req = { action: 'updateEvent', event: ev }; }
    else { ev.ref = Date.now().toString(36); req = { action: 'addEvent', event: ev }; }
    $('evNote').textContent = 'Saving…'; $('evSave').disabled = true;
    C.api(req).then(function () {
      $('evSave').disabled = false; cursor = parse(ev.start); C.show('cal'); fetchEvents(true);
    }, function (err) { $('evSave').disabled = false; $('evNote').textContent = 'Not saved: ' + (err.message === 'Failed to fetch' ? 'no connection.' : err.message); });
  };
  $('evDelete').onclick = function () {
    if (!editing) return;
    if ($('evDelete').dataset.sure !== '1') { $('evDelete').dataset.sure = '1'; $('evDelete').textContent = 'Tap again to delete'; return; }
    $('evDelete').dataset.sure = ''; $('evDelete').textContent = 'Delete';
    C.api({ action: 'deleteEvent', event: { id: editing.id } }).then(function () { C.show('cal'); fetchEvents(true); },
      function (err) { $('evNote').textContent = 'Not deleted: ' + err.message; });
  };

  // ---- admin ----
  var adm = null, admEditing = null, admColor = '';
  $('calManage').onclick = function () { C.show('adm'); loadAdmin(); };
  $('admBack').onclick = function () { C.show('cal'); fetchEvents(true); };
  function loadAdmin() {
    $('admStatus').textContent = 'Loading…';
    C.api({ action: 'adminInfo' }).then(function (j) { adm = j; $('admStatus').textContent = ''; renderAdmin(); },
      function (err) { $('admStatus').textContent = 'Could not load: ' + err.message; });
  }
  function shareText(c) {
    if (/^\s*everyone\s*$/i.test(c.sharedWith || '')) return 'Everyone';
    var em = String(c.sharedWith || '').split(/[,;\s]+/).filter(Boolean);
    if (!em.length) return 'Only you';
    return em.map(function (e) { var p = adm.team.filter(function (t) { return t.email === e.toLowerCase(); })[0]; return p ? p.name.split(' ')[0] : e; }).join(', ');
  }
  function renderAdmin() {
    var list = $('admList'); list.innerHTML = '';
    adm.calendars.forEach(function (c) {
      var r = el('div', 'client');
      var av = el('div', 'av', ''); av.style.background = c.color; r.appendChild(av);
      var m = el('div', 'meta'); m.appendChild(el('div', 'nm', c.name));
      m.appendChild(el('div', 'sub', (c.type === 'Google' ? 'Google Calendar' : 'App calendar') + ' · ' + shareText(c) + (c.active ? '' : ' · hidden')));
      r.appendChild(m);
      r.onclick = function () { editCal(c); };
      list.appendChild(r);
    });
    var sel = $('admLinkSel'); sel.innerHTML = '';
    var free = adm.google.filter(function (g) { return !g.linked; });
    if (!free.length) { var o = el('option', '', 'No other Google Calendars found'); o.value = ''; sel.appendChild(o); }
    free.forEach(function (g) { var o = el('option', '', g.name); o.value = g.id; sel.appendChild(o); });
  }
  function editCal(c) {
    admEditing = c;
    $('admEdit').classList.remove('hidden');
    $('admEditTitle').textContent = c.id ? 'Edit ' + c.name : c.type === 'Google' ? (c.googleId ? 'Link Google Calendar' : 'New Google Calendar') : 'New app calendar';
    $('admName').value = c.name || '';
    var used = adm.calendars.map(function (x) { return x.color; });
    admColor = c.color || adm.colors.filter(function (x) { return used.indexOf(x) < 0; })[0] || adm.colors[0];
    var sw = $('admColors'); sw.innerHTML = '';
    adm.colors.forEach(function (col) {
      var b = el('button', col === admColor ? 'on' : ''); b.style.background = col; b.type = 'button'; b.setAttribute('aria-label', col);
      b.onclick = function () { admColor = col; Array.prototype.forEach.call(sw.children, function (x) { x.classList.toggle('on', x === b); }); };
      sw.appendChild(b);
    });
    var everyone = !c.id || /^\s*everyone\s*$/i.test(c.sharedWith || '');
    $('admEveryone').checked = everyone; $('admChosen').checked = !everyone;
    var chosen = String(c.sharedWith || '').toLowerCase().split(/[,;\s]+/);
    var pp = $('admPeople'); pp.innerHTML = '';
    adm.team.forEach(function (t) {
      var l = el('label'); var cb = el('input'); cb.type = 'checkbox'; cb.value = t.email; cb.checked = chosen.indexOf(t.email) >= 0;
      cb.onchange = function () { $('admChosen').checked = true; };
      l.appendChild(cb); l.appendChild(document.createTextNode(t.name)); pp.appendChild(l);
    });
    $('admActive').checked = c.active !== false;
    $('admType').textContent = c.type === 'Google'
      ? (c.googleId ? 'Linked Google Calendar. Events added here go straight into it, and phone reminders work as usual.' : 'A new Google Calendar will be created in your Google account.')
      : 'App calendar: events are kept in the CRM sheet.';
    $('admNote').textContent = '';
    $('admEdit').scrollIntoView({ behavior: 'smooth' });
    $('admName').focus();
  }
  $('admNewApp').onclick = function () { editCal({ type: 'App' }); };
  $('admNewGoogle').onclick = function () { editCal({ type: 'Google' }); };
  $('admLink').onclick = function () {
    var id = $('admLinkSel').value;
    if (!id) return;
    var g = adm.google.filter(function (x) { return x.id === id; })[0];
    editCal({ type: 'Google', googleId: id, name: g.name });
  };
  $('admSave').onclick = function () {
    var c = admEditing;
    var people = Array.prototype.filter.call($('admPeople').querySelectorAll('input'), function (x) { return x.checked; }).map(function (x) { return x.value; });
    var body = { id: c.id, type: c.type, googleId: c.googleId, name: $('admName').value.trim() || 'Calendar', color: admColor,
      sharedWith: $('admEveryone').checked ? 'Everyone' : people.join(', '), active: $('admActive').checked };
    $('admNote').textContent = 'Saving…'; $('admSave').disabled = true;
    C.api({ action: 'saveCalendar', calendar: body }).then(function () {
      $('admSave').disabled = false; $('admNote').textContent = 'Saved.'; $('admEdit').classList.add('hidden');
      loadAdmin(); C.list();
    }, function (err) { $('admSave').disabled = false; $('admNote').textContent = 'Not saved: ' + err.message; });
  };

  window.CAL = { changed: function () { loadedKey = ''; if (!$('calView').classList.contains('hidden')) fetchEvents(true); else chips(); } };
  render();
})();
