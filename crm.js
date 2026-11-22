// Team client list (CRM). Clients live in a shared Google Sheet through a small Apps Script web app
// (see crm-script.gs). This phone keeps a copy so the list opens offline, and queues saves until online.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var A = window.App, store = A.store, pad = A.pad;
  var STATUSES = ['Lead', 'Prospect', 'Customer', 'Inactive'];

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var cache = load('crmCache', { clients: [], history: [], at: 0 });
  var queue = load('crmQueue', []);

  function cfg() { return { url: store.get('crmUrl', ''), key: store.get('crmKey', ''), me: store.get('me', '') }; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function normPhone(p) { var wa = TaskParser.waNumber(p); return wa ? '+' + wa : String(p || '').trim(); }
  function low(s) { return String(s || '').trim().toLowerCase(); }

  function api(body, keepalive) {
    var c = cfg();
    if (!c.url) return Promise.reject(new Error('no-link'));
    body.key = c.key;
    // text/plain body keeps this a "simple" request, so Google's server accepts it from the browser.
    return fetch(c.url, { method: 'POST', body: JSON.stringify(body), keepalive: !!keepalive })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Save failed'); return j; });
  }

  function fromRow(o) {
    return { id: o.ID, name: o.Name, phone: o.Phone, email: o.Email, company: o.Company, status: o.Status || 'Lead',
      owner: o.Owner, lastContact: o['Last contact'], followUp: o['Next follow-up'], notes: o.Notes, created: o.Created };
  }
  function histFromRow(o) { return { at: o.Logged, id: o['Client ID'], task: o.Task, when: o['Task date'], by: o['Added by'], message: o.Message }; }

  function find(c) {
    var p = digits(normPhone(c.phone)), e = low(c.email), n = low(c.name);
    return cache.clients.filter(function (x) {
      return (c.id && x.id === c.id) || (p && digits(x.phone) === p) || (e && low(x.email) === e) ||
        (!p && !e && n && low(x.name) === n);
    })[0];
  }
  function upsertLocal(c, task) {
    var x = find(c);
    if (!x) { x = { id: c.id || 'new-' + Date.now(), status: 'Lead', created: today() }; cache.clients.push(x); }
    Object.keys(c).forEach(function (k) { if (k !== 'replaceBlank' && c[k] !== undefined && (c[k] || c.replaceBlank)) x[k] = c[k]; });
    if (!x.name) x.name = x.phone || x.email || 'Unnamed';
    if (task) {
      x.lastContact = today();
      cache.history.push({ at: today(), id: x.id, task: task.title, when: task.when, by: task.by, message: task.message });
    }
    keep('crmCache', cache);
    return x;
  }

  // ---- Saving ----
  var flushing = false;
  function flush(keepalive) {
    if (flushing || !queue.length || !cfg().url) return Promise.resolve();
    flushing = true;
    var item = queue[0];
    return api({ action: 'save', client: item.client, task: item.task }, keepalive).then(function () {
      queue.shift(); keep('crmQueue', queue); flushing = false;
      return flush(keepalive);
    }, function (err) {
      flushing = false;
      note('Not saved to the team sheet yet (' + (err.message === 'no-link' ? 'no CRM link' : err.message) + '). Will retry.');
      throw err;
    });
  }
  function enqueue(client, task) {
    queue.push({ client: client, task: task || null });
    keep('crmQueue', queue);
    upsertLocal(client, task);
    render();
    return flush(true).then(list, function () {});
  }

  function list() {
    if (!cfg().url) { note('Add the CRM link in ⚙︎ to share clients with your team. Until then they stay on this phone.'); return Promise.resolve(); }
    note('Syncing…');
    return api({ action: 'list' }).then(function (j) {
      cache = { clients: j.clients.map(fromRow), history: j.history.map(histFromRow), at: Date.now() };
      // Keep anything still waiting to upload visible.
      queue.forEach(function (q) { upsertLocal(q.client, q.task); });
      keep('crmCache', cache);
      note('Synced at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '. ' + cache.clients.length + ' clients.');
      render(); matchForm();
    }, function (err) {
      note('Could not reach the team sheet' + (err.message === 'Wrong team key' ? ': wrong team key.' : '. Showing the copy on this phone.'));
    });
  }
  function sync() { return flush().then(list, list); }
  function note(t) { $('syncNote').textContent = t; }

  // ---- Task form ----
  function formClient() {
    var name = $('contact').value.trim(), phone = $('phone').value.trim(), email = $('cemail').value.trim();
    if (!name && !phone && !email) return null;
    return { name: name, phone: normPhone(phone), email: email, company: $('company').value.trim(),
      status: $('status').value, followUp: $('followUp').value };
  }
  function matchForm() {
    var c = formClient(), hint = $('crmHint');
    if (!c) { hint.textContent = ''; return; }
    var x = find(c);
    if (x) {
      if (!$('company').value && x.company) $('company').value = x.company;
      if (!$('followUp').value && x.followUp && x.followUp >= today()) $('followUp').value = x.followUp;
      hint.textContent = '✓ Existing client: ' + x.name + ' · ' + (x.status || 'Lead') + (x.owner ? ' · ' + x.owner : '') +
        (x.lastContact ? ' · last contact ' + x.lastContact : '') + '. This task is added to their history.';
    } else {
      hint.textContent = 'New client. Saved to the ' + (cfg().url ? "team's client list" : 'client list on this phone') + ' when you add the task.';
    }
  }
  function recordTask() {
    var c = formClient(), ev = A.eventData();
    if (!c || !ev) return;
    var me = cfg().me;
    if (!find(c) && me) c.owner = me;
    var when = $('date').value + ($('allDay').checked ? '' : ' ' + $('start').value);
    enqueue(c, { title: ev.title, when: when, by: me, message: $('msg').value.slice(0, 2000),
      ref: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
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
    window.scrollTo(0, 0);
  }
  $('tabTask').onclick = function () { show('task'); };
  $('tabClients').onclick = function () { show('clients'); render(); if (Date.now() - cache.at > 60000) sync(); };
  $('backBtn').onclick = function () { show('clients'); render(); };
  $('syncBtn').onclick = sync;
  $('search').addEventListener('input', render);
  $('statusFilter').addEventListener('change', render);

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function isDue(c) { return c.followUp && c.followUp <= today() && c.status !== 'Inactive'; }
  function row(c) {
    var r = el('div', 'client');
    r.appendChild(el('div', 'av', (c.name || '?').trim().charAt(0).toUpperCase()));
    var m = el('div', 'meta');
    m.appendChild(el('div', 'nm', c.name));
    var sub = [c.company, c.phone].filter(Boolean).join(' · ');
    var s = el('div', 'sub', sub || c.email || '');
    if (c.followUp) {
      var f = el('span', isDue(c) ? 'due' : '', (sub ? ' · ' : '') + 'Follow up ' + (c.followUp === today() ? 'today' : c.followUp));
      s.appendChild(f);
    }
    m.appendChild(s);
    r.appendChild(m);
    r.appendChild(el('span', 'badge ' + (c.status || 'Lead'), c.status || 'Lead'));
    r.onclick = function () { open(c); };
    return r;
  }
  function render() {
    var q = low($('search').value), st = $('statusFilter').value, qd = digits(q);
    var all = cache.clients.slice().sort(function (a, b) {
      var da = isDue(a), db = isDue(b);
      if (da !== db) return da ? -1 : 1;
      if (da) return a.followUp < b.followUp ? -1 : 1;
      return String(b.lastContact || '').localeCompare(String(a.lastContact || '')) || String(a.name).localeCompare(String(b.name));
    });
    var due = all.filter(isDue);
    $('dueCount').textContent = due.length;
    $('dueCount').classList.toggle('hidden', !due.length);
    $('dueCard').classList.toggle('hidden', !due.length || !!q || !!st);
    var dl = $('dueList'); dl.innerHTML = '';
    due.forEach(function (c) { dl.appendChild(row(c)); });
    var shown = all.filter(function (c) {
      if (!q && !st && isDue(c)) return false; // already listed under follow-ups due
      if (st && (c.status || 'Lead') !== st) return false;
      if (!q) return true;
      return [c.name, c.company, c.email, c.notes, c.owner].some(function (v) { return low(v).indexOf(q) >= 0; }) ||
        (qd.length >= 3 && digits(c.phone).indexOf(qd.replace(/^0/, '')) >= 0);
    });
    var cl = $('clientList'); cl.innerHTML = '';
    if (!shown.length) cl.appendChild(el('div', 'empty', cache.clients.length ? (q || st ? 'No clients match.' : 'All clients are listed under follow-ups due.') : 'No clients yet. Add a task with a contact and they appear here.'));
    shown.forEach(function (c) { cl.appendChild(row(c)); });
  }

  // ---- Client detail ----
  var current = null;
  function open(c) {
    current = c;
    $('dName').value = c.name || ''; $('dPhone').value = c.phone || ''; $('dEmail').value = c.email || '';
    $('dCompany').value = c.company || ''; $('dStatus').value = c.status || 'Lead'; $('dOwner').value = c.owner || cfg().me;
    $('dFollow').value = c.followUp || ''; $('dNotes').value = c.notes || ''; $('dNote').textContent = '';
    $('dMeta').textContent = c.created || c.lastContact
      ? [c.created ? 'Added ' + c.created : '', c.lastContact ? 'Last contact ' + c.lastContact : ''].filter(Boolean).join(' · ') : 'New client';
    var h = $('dHist'); h.innerHTML = '';
    var items = cache.history.filter(function (x) { return c.id && x.id === c.id; }).reverse();
    if (!items.length) h.appendChild(el('div', 'empty', 'No tasks yet.'));
    items.forEach(function (x) {
      var d = el('div', 'hist', x.task);
      d.appendChild(el('small', '', [x.when ? 'For ' + x.when : '', x.by ? 'by ' + x.by : '', 'logged ' + x.at].filter(Boolean).join(' · ')));
      if (x.message) { d.title = x.message; }
      h.appendChild(d);
    });
    links();
    show('detail');
  }
  function links() {
    var wa = TaskParser.waNumber($('dPhone').value), mail = $('dEmail').value.trim(), name = $('dName').value.trim() || 'client';
    $('dWa').href = wa ? 'https://wa.me/' + wa : '#';
    $('dCall').href = $('dPhone').value ? 'tel:' + $('dPhone').value.replace(/[^\d+]/g, '') : '#';
    $('dMail').href = mail ? 'mailto:' + mail : '#';
    [['dWa', wa], ['dCall', $('dPhone').value], ['dMail', mail], ['dRemind', $('dFollow').value]].forEach(function (p) { $(p[0]).style.opacity = p[1] ? 1 : 0.4; });
    var f = $('dFollow').value;
    if (f) {
      var d = f.split('-').map(Number);
      $('dRemind').href = A.webLink({ title: 'Follow up: ' + name + ($('dCompany').value ? ' (' + $('dCompany').value + ')' : ''),
        details: ['Client: ' + [name, $('dPhone').value, mail].filter(Boolean).join(' · '), wa ? 'WhatsApp: https://wa.me/' + wa : '', $('dNotes').value].filter(Boolean).join('\n'),
        location: '', guests: [], rrule: '', busy: false, useTeam: true, allDay: true,
        start: new Date(d[0], d[1] - 1, d[2]), end: new Date(d[0], d[1] - 1, d[2] + 1) });
    } else $('dRemind').href = '#';
  }
  ['dName', 'dPhone', 'dEmail', 'dCompany', 'dFollow', 'dNotes'].forEach(function (id) { $(id).addEventListener('input', links); });
  ['dWa', 'dCall', 'dMail', 'dRemind'].forEach(function (id) { $(id).addEventListener('click', function (e) { if ($(id).getAttribute('href') === '#') e.preventDefault(); }); });
  $('dRemind').addEventListener('click', function () { if ($('dFollow').value) saveDetail(); });
  function detailClient() {
    return { id: current && current.id && current.id.indexOf('new-') !== 0 ? current.id : undefined,
      name: $('dName').value.trim(), phone: normPhone($('dPhone').value), email: $('dEmail').value.trim(),
      company: $('dCompany').value.trim(), status: $('dStatus').value, owner: $('dOwner').value.trim(),
      followUp: $('dFollow').value, notes: $('dNotes').value.trim(), replaceBlank: true };
  }
  function saveDetail() {
    var c = detailClient();
    if (!c.name && !c.phone && !c.email) { $('dNote').textContent = 'Add a name, phone or email first.'; return; }
    if (current && !c.id) c.id = current.id; // keep local match for clients not uploaded yet
    current = upsertLocal(c);
    if (c.id && c.id.indexOf('new-') === 0) delete c.id;
    $('dNote').textContent = cfg().url ? 'Saving to the team sheet…' : 'Saved on this phone. Add the CRM link in ⚙︎ to share with your team.';
    queue.push({ client: c, task: null }); keep('crmQueue', queue);
    flush().then(function () { $('dNote').textContent = 'Saved to the team sheet.'; return list(); }, function () {
      if (cfg().url) $('dNote').textContent = 'Saved on this phone. It will upload to the team sheet when you are back online.';
    });
  }
  $('dSave').onclick = saveDetail;
  $('newClientBtn').onclick = function () { open({ status: 'Lead', owner: cfg().me }); };
  $('dTask').onclick = function () {
    $('contact').value = $('dName').value; $('phone').value = $('dPhone').value; $('cemail').value = $('dEmail').value;
    $('company').value = $('dCompany').value; $('status').value = ''; $('followUp').value = '';
    show('task'); matchForm(); A.refreshLinks(); $('title').focus();
  };

  window.CRM = { sync: sync, matchForm: matchForm, render: render };
  window.addEventListener('online', sync);
  render(); matchForm();
  if (cfg().url) sync();
})();
