// Team CRM, stored in the "airnergy_crm_backend" Google Sheet through a small Apps Script web app (crm-script.gs).
// Reads Contact, ContactPerson and Task; adds tasks and new WhatsApp contacts. This phone keeps a copy so the list
// opens offline, and queues saves until it is back online.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var A = window.App, store = A.store, pad = A.pad;
  var MAX_ROWS = 80;

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var cache = load('crmCache2', { clients: [], tasks: [], team: [], me: '', at: 0 });
  var queue = load('crmQueue2', []);

  function cfg() { return { url: store.get('crmUrl', ''), key: store.get('crmKey', ''), me: store.get('me', '') }; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function low(s) { return String(s || '').trim().toLowerCase(); }
  // Same rules as the sheet script: 012-345 6789 and +60 12-345 6789 both become 60123456789.
  function phones(s) {
    return String(s || '').split(/[\/,;]| or /).map(function (p) {
      var d = p.replace(/\D/g, '');
      if (/^0\d{8,10}$/.test(d)) d = '6' + d;
      return d.length >= 9 ? d : '';
    }).filter(String);
  }
  function emails(s) { return String(s || '').split(/[;,\s]+/).map(low).filter(function (e) { return e.indexOf('@') > 0; }); }
  function isOpen(t) { return !t.completed && !/done|complete|cancel|closed/i.test(t.status || ''); }
  function dueDay(t) { return String(t.due || '').slice(0, 10); }

  function api(body, keepalive) {
    var c = cfg();
    if (!c.url) return Promise.reject(new Error('no-link'));
    body.key = c.key; body.me = c.me;
    // A text/plain body keeps this a "simple" request, which Google's server accepts from the browser.
    return fetch(c.url, { method: 'POST', body: JSON.stringify(body), keepalive: !!keepalive })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Save failed'); return j; });
  }

  // ---- Matching (same order as the sheet: phone, email, company) ----
  function find(q) {
    var list = cache.clients, i, ph = phones(q.phone)[0], em = low(q.email), co = low(q.company);
    if (q.id) for (i = 0; i < list.length; i++) if (list[i].id === q.id) return list[i];
    if (ph) for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (phones(c.phone).indexOf(ph) >= 0 || (c.people || []).some(function (p) { return phones(p.phone).indexOf(ph) >= 0; })) return c;
    }
    if (em) for (i = 0; i < list.length; i++) {
      var d = list[i];
      if (emails(d.email).indexOf(em) >= 0 || (d.people || []).some(function (p) { return emails(p.email).indexOf(em) >= 0; })) return d;
    }
    if (co) for (i = 0; i < list.length; i++) if (low(list[i].company) === co) return list[i];
    return null;
  }
  function personFor(c, q) {
    var ph = phones(q && q.phone)[0];
    return (c.people || []).filter(function (p) { return ph && phones(p.phone).indexOf(ph) >= 0; })[0];
  }

  // Show a save straight away, before the sheet answers.
  function applyLocal(q, task) {
    var c = find(q);
    if (!c) {
      c = { id: 'new-' + Date.now(), company: q.company || q.name || q.phone || q.email, name: q.name || '', phone: q.phone || '',
        email: q.email || '', source: 'WhatsApp', active: true, owner: q.owner || cache.me, status: q.status || 'Lead', notes: q.notes || '', people: [] };
      cache.clients.push(c);
    } else {
      if (q.edit && c.source === 'WhatsApp') ['company', 'name', 'phone', 'email'].forEach(function (k) { if (q[k] !== undefined) c[k] = q[k]; });
      if (q.status) c.status = q.status;
      if (q.owner) c.owner = q.owner;
      if (q.notes !== undefined && (q.notes || q.edit)) c.notes = q.notes;
    }
    if (task && task.title) cache.tasks.push({ id: 'pending-' + task.ref, title: task.title, contactId: c.id, due: task.due, status: 'New', assignee: cache.me, by: cache.me, created: today() });
    keep('crmCache2', cache);
    return c;
  }

  // ---- Upload queue ----
  var flushing = false;
  function flush(keepalive) {
    if (flushing || !queue.length || !cfg().url) return Promise.resolve();
    flushing = true;
    var item = queue[0];
    return api(item, keepalive).then(function () {
      queue.shift(); keep('crmQueue2', queue); flushing = false;
      return flush(keepalive);
    }, function (err) {
      flushing = false;
      note('Not saved to the CRM sheet yet (' + (err.message === 'no-link' ? 'no CRM link' : err.message) + '). Will retry.');
      throw err;
    });
  }
  function send(item) {
    queue.push(item); keep('crmQueue2', queue);
    return flush(true).then(list);
  }

  function list() {
    if (!cfg().url) { note('Tap ⚙︎ and add the CRM link to see the team\'s clients.'); return Promise.resolve(); }
    note('Syncing…');
    return api({ action: 'list' }).then(function (j) {
      cache = { clients: j.clients, tasks: j.tasks, team: j.team || [], me: j.me || '', at: Date.now() };
      queue.forEach(function (q) { if (q.action === 'save') applyLocal(q.client, q.task); });
      keep('crmCache2', cache);
      fillTeam();
      note('Synced at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '. ' +
        cache.clients.length + ' clients.' + (cfg().me && !cache.me ? ' Your email isn\'t in the User list, so tasks won\'t be assigned to you.' : ''));
      render(); matchForm();
      if (current) { var c = find({ id: current.id }); if (c) open(c, true); }
    }, function (err) {
      note('Could not reach the CRM sheet' + (err.message === 'Wrong team key' ? ': wrong team key.' : '. Showing the copy on this phone.'));
    });
  }
  function sync() { return flush().then(list, list); }
  function note(t) { $('syncNote').textContent = t; }
  function fillTeam() {
    var dl = $('teamList'); dl.innerHTML = '';
    cache.team.forEach(function (n) { var o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }

  // ---- New task form ----
  function formClient() {
    var name = $('contact').value.trim(), phone = $('phone').value.trim(), email = $('cemail').value.trim(), company = $('company').value.trim();
    if (!name && !phone && !email && !company) return null;
    return { name: name, phone: phone, email: email, company: company, status: $('status').value };
  }
  function matchForm() {
    var q = formClient(), hint = $('crmHint');
    if (!q) { hint.textContent = ''; return; }
    if (!cfg().url) { hint.textContent = 'Tap ⚙︎ and add the CRM link to save this client and task to the team\'s CRM.'; return; }
    var c = find(q);
    if (c) {
      var p = personFor(c, q);
      hint.textContent = '✓ ' + c.company + (p ? ' (' + p.name + ')' : c.name ? ' (' + c.name + ')' : '') +
        (c.accNo ? ' · AutoCount ' + c.accNo : '') + (c.status ? ' · ' + c.status : '') + (c.owner ? ' · agent ' + c.owner : '') +
        '. The task is added to their record.';
    } else {
      hint.textContent = 'New contact. Added to the CRM as a WhatsApp contact when you add the task.';
    }
  }
  function recordTask() {
    var q = formClient(), ev = A.eventData();
    if (!q || !ev || !cfg().url) return;
    var due = $('date').value + ($('allDay').checked ? '' : ' ' + $('start').value);
    var ref = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var desc = [$('desc').value.trim(), $('msg').value.trim() ? 'Message:\n' + $('msg').value.trim() : ''].filter(Boolean).join('\n\n');
    var item = { action: 'save', client: q, task: { title: ev.title, due: due, description: desc, ref: ref } };
    applyLocal(q, item.task);
    var jobs = [item];
    if ($('followUp').value) {
      var known = find(q) || {};
      var f = { action: 'save', client: q, task: { title: 'Follow up: ' + (known.company || q.company || q.name || q.phone), due: $('followUp').value, ref: ref + 'f' } };
      applyLocal(q, f.task); jobs.push(f);
    }
    jobs.forEach(function (j) { queue.push(j); });
    keep('crmQueue2', queue);
    render();
    flush(true).then(list, function () {});
  }
  $('addBtn').addEventListener('click', recordTask);
  $('appBtn').addEventListener('click', recordTask);
  ['company', 'status', 'followUp'].forEach(function (id) { $(id).addEventListener('change', matchForm); });

  // ---- Views ----
  function show(view) {
    $('taskView').classList.toggle('hidden', view !== 'task');
    $('clientsView').classList.toggle('hidden', view !== 'clients');
    $('detailView').classList.toggle('hidden', view !== 'detail');
    $('tabTask').classList.toggle('on', view === 'task');
    $('tabClients').classList.toggle('on', view !== 'task');
    if (view !== 'detail') current = null;
    window.scrollTo(0, 0);
  }
  $('tabTask').onclick = function () { show('task'); };
  $('tabClients').onclick = function () { show('clients'); render(); if (Date.now() - cache.at > 60000) sync(); };
  $('backBtn').onclick = function () { show('clients'); render(); };
  $('syncBtn').onclick = sync;
  $('search').addEventListener('input', render);
  $('statusFilter').addEventListener('change', render);

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function byId(id) { for (var i = 0; i < cache.clients.length; i++) if (cache.clients[i].id === id) return cache.clients[i]; return null; }
  function avatar(s) { return el('div', 'av', (String(s || '?').trim().replace(/^(mr|ms|mrs|dr|encik|puan)\.?\s+/i, '').charAt(0) || '?').toUpperCase()); }
  function clientRow(c, extra) {
    var r = el('div', 'client');
    r.appendChild(avatar(c.company));
    var m = el('div', 'meta');
    m.appendChild(el('div', 'nm', c.company || c.name));
    var s = el('div', 'sub', extra || [c.name, c.phone].filter(Boolean).join(' · ') || c.email || '');
    m.appendChild(s);
    r.appendChild(m);
    var st = c.status || (c.source === 'WhatsApp' ? 'New' : '');
    if (st) r.appendChild(el('span', 'badge ' + st, st));
    r.onclick = function () { open(c); };
    return r;
  }
  function lastTouch() {
    var m = {};
    cache.tasks.forEach(function (t) { var d = String(t.created || t.due || ''); if (!m[t.contactId] || d > m[t.contactId]) m[t.contactId] = d; });
    return m;
  }
  function render() {
    var q = low($('search').value), st = $('statusFilter').value, qp = phones(q)[0] || (q.replace(/\D/g, '').length >= 4 ? q.replace(/\D/g, '').replace(/^0/, '') : '');
    var due = cache.tasks.filter(function (t) { return isOpen(t) && dueDay(t) && dueDay(t) <= today(); })
      .sort(function (a, b) { return dueDay(a) < dueDay(b) ? -1 : 1; });
    $('dueCount').textContent = due.length;
    $('dueCount').classList.toggle('hidden', !due.length);
    $('dueCard').classList.toggle('hidden', !due.length || !!q || !!st);
    var dl = $('dueList'); dl.innerHTML = '';
    due.slice(0, 30).forEach(function (t) {
      var c = byId(t.contactId) || { company: 'Unknown client', id: t.contactId };
      var when = dueDay(t) === today() ? 'today' : dueDay(t);
      var r = clientRow(c, t.title + ' · ' + when + (t.assignee ? ' · ' + t.assignee : ''));
      r.querySelector('.sub').classList.add('due');
      dl.appendChild(r);
    });
    var touch = lastTouch();
    var shown = cache.clients.filter(function (c) {
      if (st === 'New') { if (c.source !== 'WhatsApp') return false; }
      else if (st && c.status !== st) return false;
      if (!q) return st || touch[c.id];
      if ([c.company, c.name, c.email, c.notes, c.owner, c.accNo].some(function (v) { return low(v).indexOf(q) >= 0; })) return true;
      if ((c.people || []).some(function (p) { return low(p.name).indexOf(q) >= 0; })) return true;
      if (qp) return [c.phone].concat((c.people || []).map(function (p) { return p.phone; }))
        .some(function (ph) { return phones(ph).some(function (x) { return x.indexOf(qp) >= 0; }); });
      return false;
    }).sort(function (a, b) {
      return String(touch[b.id] || '').localeCompare(String(touch[a.id] || '')) || String(a.company).localeCompare(String(b.company));
    });
    var cl = $('clientList'); cl.innerHTML = '';
    $('listTitle').textContent = q || st ? shown.length + ' found' : 'Recent clients';
    if (!shown.length) cl.appendChild(el('div', 'empty', q || st ? 'No clients match.' :
      cache.clients.length ? 'Search above to find any of the ' + cache.clients.length + ' clients.' : 'No clients yet. Tap ⚙︎ to add the CRM link, then Sync.'));
    shown.slice(0, MAX_ROWS).forEach(function (c) { cl.appendChild(clientRow(c)); });
    if (shown.length > MAX_ROWS) cl.appendChild(el('div', 'empty', 'Showing ' + MAX_ROWS + ' of ' + shown.length + '. Type more to narrow it down.'));
  }

  // ---- Client page ----
  var current = null;
  function open(c, keepScroll) {
    current = c;
    var mine = c.source === 'WhatsApp';
    $('dAv').textContent = avatar(c.company).textContent;
    $('dTitle').textContent = c.company || c.name;
    $('dSub').textContent = [c.accNo ? 'AutoCount ' + c.accNo : c.source, c.active === false ? 'inactive' : ''].filter(Boolean).join(' · ');
    var st = c.status || (mine ? 'New' : '');
    $('dBadge').textContent = st; $('dBadge').className = 'badge ' + st; $('dBadge').classList.toggle('hidden', !st);
    $('dCompany').value = c.company || ''; $('dName').value = c.name || ''; $('dPhone').value = c.phone || ''; $('dEmail').value = c.email || '';
    ['dCompany', 'dName', 'dPhone', 'dEmail'].forEach(function (id) { $(id).readOnly = !mine; });
    $('dLocked').classList.toggle('hidden', mine);
    $('dStatus').value = c.status || ''; $('dOwner').value = c.owner || ''; $('dNotes').value = c.notes || '';
    if (!keepScroll) { $('dNote').textContent = ''; $('dFollow').value = ''; }
    var pp = $('dPeople'); pp.innerHTML = '';
    (c.people || []).forEach(function (p) {
      var r = el('div', 'task');
      var m = el('div', 'meta'); m.appendChild(el('div', 'tt', p.name || '(no name)'));
      m.appendChild(el('small', '', [p.role, p.phone, p.email].filter(Boolean).join(' · ')));
      r.appendChild(m);
      var wa = phones(p.phone)[0];
      if (wa) { var a = el('a', 'btn secondary', '💬'); a.href = 'https://wa.me/' + wa; a.target = '_blank'; a.style.cssText = 'width:auto;margin:0;padding:6px 12px'; r.appendChild(a); }
      pp.appendChild(r);
    });
    $('dPeopleCard').classList.toggle('hidden', !(c.people || []).length);
    renderTasks(c);
    links();
    $('detailView').classList.contains('hidden') && show('detail');
    if (!keepScroll) window.scrollTo(0, 0);
  }
  function renderTasks(c) {
    var box = $('dTasks'); box.innerHTML = '';
    var ts = cache.tasks.filter(function (t) { return t.contactId === c.id; }).sort(function (a, b) {
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return isOpen(a) ? (dueDay(a) < dueDay(b) ? -1 : 1) : String(b.created).localeCompare(String(a.created));
    });
    if (!ts.length) box.appendChild(el('div', 'empty', 'No tasks yet.'));
    ts.forEach(function (t) {
      var r = el('label', 'task' + (isOpen(t) ? '' : ' done'));
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !isOpen(t); cb.disabled = !isOpen(t) || /^pending-/.test(t.id);
      cb.onchange = function () { markDone(t); };
      r.appendChild(cb);
      var m = el('div', 'meta'); m.appendChild(el('div', 'tt', t.title));
      var late = isOpen(t) && dueDay(t) && dueDay(t) <= today();
      var s = el('small', late ? 'due' : '', [t.due ? 'Due ' + t.due : '', t.assignee, t.status].filter(Boolean).join(' · '));
      m.appendChild(s); r.appendChild(m); box.appendChild(r);
    });
  }
  function markDone(t) {
    t.status = 'Done'; t.completed = today(); keep('crmCache2', cache);
    renderTasks(current); render();
    queue.push({ action: 'done', taskId: t.id }); keep('crmQueue2', queue);
    flush().then(list, function () {});
  }
  function links() {
    var wa = phones($('dPhone').value)[0], mail = emails($('dEmail').value)[0];
    $('dWa').href = wa ? 'https://wa.me/' + wa : '#';
    $('dCall').href = wa ? 'tel:+' + wa : '#';
    $('dMail').href = mail ? 'mailto:' + mail : '#';
    [['dWa', wa], ['dCall', wa], ['dMail', mail]].forEach(function (p) { $(p[0]).style.opacity = p[1] ? 1 : 0.4; });
  }
  ['dPhone', 'dEmail'].forEach(function (id) { $(id).addEventListener('input', links); });
  ['dWa', 'dCall', 'dMail'].forEach(function (id) { $(id).addEventListener('click', function (e) { if ($(id).getAttribute('href') === '#') e.preventDefault(); }); });

  function detailQuery() {
    var mine = current.source === 'WhatsApp';
    var q = { id: /^new-/.test(current.id) ? undefined : current.id, status: $('dStatus').value, owner: $('dOwner').value.trim(),
      notes: $('dNotes').value.trim(), edit: true };
    if (mine) { q.company = $('dCompany').value.trim(); q.name = $('dName').value.trim(); q.phone = $('dPhone').value.trim(); q.email = $('dEmail').value.trim(); }
    if (!q.id) { q.company = current.company; q.name = current.name; q.phone = current.phone; q.email = current.email; }
    return q;
  }
  function saved(msg) {
    $('dNote').textContent = 'Saving…';
    flush().then(function () { $('dNote').textContent = msg; return list(); }, function () {
      $('dNote').textContent = 'Saved on this phone. It will upload to the CRM sheet when you are back online.';
    });
  }
  $('dSave').onclick = function () {
    if (!current) return;
    var q = detailQuery();
    current = applyLocal(q);
    queue.push({ action: 'save', client: q }); keep('crmQueue2', queue);
    open(current, true);
    saved('Saved to the CRM sheet.');
  };
  $('dFollowBtn').onclick = function () {
    if (!current) return;
    var f = $('dFollow').value;
    if (!f) { $('dNote').textContent = 'Pick a follow-up date first.'; $('dFollow').focus(); return; }
    var name = current.company || current.name;
    var task = { title: 'Follow up: ' + name, due: f, ref: Date.now().toString(36) + 'f' };
    var q = detailQuery();
    applyLocal(q, task);
    queue.push({ action: 'save', client: q, task: task }); keep('crmQueue2', queue);
    renderTasks(current);
    // Also offer it on the calendar, like every other task.
    var d = f.split('-').map(Number), wa = phones(current.phone)[0];
    window.open(A.webLink({ title: task.title, details: ['Client: ' + [name, current.name, current.phone].filter(Boolean).join(' · '),
      wa ? 'WhatsApp: https://wa.me/' + wa : '', current.notes || ''].filter(Boolean).join('\n'),
      location: '', guests: [], rrule: '', busy: false, useTeam: true, allDay: true,
      start: new Date(d[0], d[1] - 1, d[2]), end: new Date(d[0], d[1] - 1, d[2] + 1) }), '_blank', 'noopener');
    saved('Follow-up added to the CRM. Save it in Google Calendar too.');
  };
  $('dTask').onclick = function () {
    if (!current) return;
    $('contact').value = current.name || ''; $('phone').value = current.phone || ''; $('cemail').value = emails(current.email)[0] || '';
    $('company').value = current.company || ''; $('status').value = ''; $('followUp').value = '';
    show('task'); matchForm(); A.refreshLinks(); $('msg').focus();
  };

  window.CRM = { sync: sync, matchForm: matchForm, render: render };
  window.addEventListener('online', sync);
  fillTeam(); render(); matchForm();
  if (cfg().url) sync();
})();
