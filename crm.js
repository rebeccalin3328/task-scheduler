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
    var ak = store.get('adminKey', '');
    if (ak) body.adminKey = ak;
    // A text/plain body keeps this a "simple" request, which Google's server accepts from the browser.
    // Three kinds of failure, told apart so the message says what really happened:
    // 'offline' (no answer at all), 'page' (Google sent a web page, not data) and 'rejected' (the sheet said no).
    return fetch(c.url, { method: 'POST', body: JSON.stringify(body), keepalive: !!keepalive })
      .catch(function () { throw fail('offline', 'No connection to the CRM sheet'); })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (res) {
        var j;
        try { j = JSON.parse(res.text); } catch (e) {
          console.warn('CRM answered with a page', res.status, res.text.slice(0, 300));
          throw fail('page', 'The CRM script sent back a Google page instead of data (HTTP ' + res.status + '). It may be busy, or need redeploying');
        }
        if (!j.ok) throw fail(j.error === 'Wrong team key' ? 'key' : 'rejected', j.error || 'Save failed');
        return j;
      });
  }
  function fail(kind, msg) { var e = new Error(msg); e.kind = kind; return e; }

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
  var flushP = null;
  // Upload queued saves one by one. Calling it while it runs returns the same run, which ends when the queue is empty.
  // A save the sheet refuses (for example a calendar you can't use) is set aside in 'crmFailed' instead of blocking
  // everything after it. The run resolves to { done, rejected: [{ item, error }] }.
  function flush(keepalive) {
    if (flushing) return flushP;
    flushing = true;
    flushP = run(keepalive, { done: 0, rejected: [] });
    return flushP;
  }
  function run(keepalive, res) {
    if (!queue.length || !cfg().url) {
      flushing = false;
      if (res.rejected.length) setTimeout(function () { note(res.rejected.length + ' save(s) refused by the CRM sheet: ' + res.rejected[0].error + '.'); }, 3000);
      return Promise.resolve(res);
    }
    var item = queue[0];
    return api(item, keepalive).then(function () {
      queue.shift(); keep('crmQueue2', queue); res.done++;
      return run(keepalive, res);
    }, function (err) {
      if (err.kind === 'rejected') {
        queue.shift(); keep('crmQueue2', queue);
        var failed = load('crmFailed', []); failed.push({ item: item, error: err.message, at: Date.now() }); keep('crmFailed', failed);
        res.rejected.push({ item: item, error: err.message });
        console.warn('CRM refused a save', err.message, item);
        return run(keepalive, res);
      }
      flushing = false;
      note('Not saved to the CRM sheet yet: ' + (err.message === 'no-link' ? 'no CRM link' : err.message) + '. ' + queue.length + ' waiting on this phone. Will retry.');
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
      cache = { clients: j.clients, tasks: j.tasks, team: j.team || [], me: j.me || '', calendars: j.calendars || [], isAdmin: !!j.isAdmin, picks: j.picks || null, files: j.files || [], at: Date.now() };
      if (window.FILES) FILES.refresh();
      if (window.PICKS) PICKS.refresh();
      fillCalendars();
      if (window.CAL) CAL.changed();
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
  var lastSaved = null;
  function inAppCal() { var v = $('cal').value; return v.indexOf('c:') === 0 ? v.slice(2) : ''; }
  function recordTask(e) {
    var q = formClient(), ev = A.eventData(), calId = inAppCal();
    var pk = window.PICKS ? PICKS.current() : {};
    // Roles that aren't clients (family, staff...) never go into the client list.
    if (pk.role && !pk.saveContact) q = { none: true };
    else if (!q && pk.role) q = { none: true };
    if (calId && e && e.currentTarget === $('appBtn')) return; // just a phone reminder; the save happens on the main button
    if (calId && e) e.preventDefault();
    if (!ev || !cfg().url) { if (calId) $('calNote').textContent = 'Fill in a date first.'; return; }
    var due = $('date').value + ($('allDay').checked ? '' : ' ' + $('start').value);
    var ref = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    lastSaved = { ref: ref, title: ev.title, date: $('date').value, role: (window.PICKS ? PICKS.current().role : ''), topic: (window.PICKS ? PICKS.current().topic : ''),
      client: (q && !q.none) ? ((find(q) || {}).company || q.company || q.name || '') : '', withTask: !!(q || pk.role) };
    var desc = [$('desc').value.trim(), $('msg').value.trim() ? 'Message:\n' + $('msg').value.trim() : ''].filter(Boolean).join('\n\n');
    var slot = calId ? { calendarId: calId, start: $('date').value + ($('allDay').checked ? '' : 'T' + $('start').value),
      end: ($('endDate').value || $('date').value) + ($('allDay').checked ? '' : 'T' + $('end').value), allDay: $('allDay').checked,
      location: $('location').value.trim() } : {};
    if (!q) {
      if (!calId) return;
      // No client: just an event on the chosen calendar.
      queue.push({ action: 'addEvent', event: Object.assign({ title: ev.title, description: desc, ref: ref }, slot) });
      keep('crmQueue2', queue);
      done('Added to the ' + calName(calId) + ' calendar.');
      return;
    }
    var item = { action: 'save', client: q, task: Object.assign({ title: ev.title, due: due, description: desc, ref: ref, role: pk.role || '', topic: pk.topic || '' }, slot) };
    if (!q.none) applyLocal(q, item.task);
    var jobs = [item];
    if ($('followUp').value && !q.none) {
      var known = find(q) || {};
      var f = { action: 'save', client: q, task: { title: 'Follow up: ' + (known.company || q.company || q.name || q.phone), due: $('followUp').value, ref: ref + 'f' } };
      applyLocal(q, f.task); jobs.push(f);
    }
    jobs.forEach(function (j) { queue.push(j); });
    keep('crmQueue2', queue);
    render();
    if (calId) done('Added to the ' + calName(calId) + ' calendar' + (q.none ? '' : ' and to the client\'s record') + '.');
    else flush(true).then(list, function () {});
  }
  function calName(id) { var c = (cache.calendars || []).filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; }
  function done(msg) {
    var chip = $('chip'); chip.className = 'chip ok'; chip.textContent = '✓ ' + msg + ' Saving…';
    window.scrollTo(0, 0);
    flush(true).then(function () { chip.textContent = '✓ ' + msg; if (window.CAL) CAL.changed(); return list(); },
      function () { chip.className = 'chip warn'; chip.textContent = msg + ' It will upload when you are back online.'; });
  }
  function fillCalendars() {
    var sel = $('cal'), keepVal = sel.value, grp = $('calLinkGroup');
    Array.prototype.slice.call(sel.querySelectorAll('option[value^="c:"]')).forEach(function (o) { o.remove(); });
    var og = sel.querySelector('optgroup[data-app]');
    if (og) og.remove();
    var cals = (cache.calendars || []).filter(function (c) { return c.active !== false; });
    if (cals.length) {
      og = document.createElement('optgroup'); og.label = 'Task Scheduler calendars'; og.setAttribute('data-app', '1');
      cals.forEach(function (c) { var o = document.createElement('option'); o.value = 'c:' + c.id; o.textContent = '● ' + c.name; og.appendChild(o); });
      sel.insertBefore(og, grp);
    }
    var pref = store.get('lastCal', '');
    sel.value = keepVal && keepVal.indexOf('c:') === 0 && sel.querySelector('option[value="' + keepVal + '"]') ? keepVal
      : pref && sel.querySelector('option[value="' + pref + '"]') ? pref : cals.length ? 'c:' + cals[0].id : (keepVal || 'team');
    A.refreshLinks();
  }
  $('cal').addEventListener('change', function () { store.set('lastCal', $('cal').value); });
  $('addBtn').addEventListener('click', recordTask);
  $('appBtn').addEventListener('click', recordTask);
  ['company', 'status', 'followUp'].forEach(function (id) { $(id).addEventListener('change', matchForm); });

  // ---- Views ----
  var VIEWS = { task: 'tabTask', cal: 'tabCal', ev: 'tabCal', adm: 'tabCal', clients: 'tabClients', detail: 'tabClients' };
  function show(view) {
    Object.keys(VIEWS).forEach(function (v) { $(v === 'task' ? 'taskView' : v + 'View').classList.toggle('hidden', v !== view); });
    ['tabTask', 'tabCal', 'tabClients'].forEach(function (t) { $(t).classList.toggle('on', VIEWS[view] === t); });
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
    var due = cache.tasks.filter(function (t) { return isOpen(t) && dueDay(t) && dueDay(t) <= today(); });
    $('dueCount').textContent = due.length;
    $('dueCount').classList.toggle('hidden', !due.length);
    $('dueCard').classList.toggle('hidden', !cache.tasks.length || !!q || !!st);
    var show = $('taskShow').value;
    var list = cache.tasks.filter(function (t) { return show === 'all' ? true : show === 'due' ? due.indexOf(t) >= 0 : isOpen(t); })
      .sort(byDue);
    var dl = $('dueList'); dl.innerHTML = '';
    if (!list.length) dl.appendChild(el('div', 'empty', show === 'due' ? 'Nothing due. 🎉' : 'No tasks.'));
    list.slice(0, taskLimit).forEach(function (t) { dl.appendChild(taskRow(t, true)); });
    $('taskMore').classList.toggle('hidden', list.length <= taskLimit);
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
    if (window.FILES) FILES.refresh();
    links();
    $('detailView').classList.contains('hidden') && show('detail');
    if (!keepScroll) window.scrollTo(0, 0);
  }
  // ---- Tasks: status, hide closed, delete ----
  var STATUSES = ['New', 'In progress', 'Waiting', 'Done', 'Cancelled'];
  var taskLimit = 30;
  function byDue(a, b) {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    if (!isOpen(a)) return String(b.completed || b.created).localeCompare(String(a.completed || a.created));
    var x = dueDay(a) || '9999', y = dueDay(b) || '9999';
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function taskRow(t, withClient) {
    var r = el('div', 'task' + (isOpen(t) ? '' : ' closed'));
    var m = el('div', 'meta'), c = t.contactId ? byId(t.contactId) : null;
    var tt = el('div', 'tt' + (withClient && c ? ' link' : ''), t.title);
    if (withClient && c) tt.onclick = function () { open(c); };
    m.appendChild(tt);
    var late = isOpen(t) && dueDay(t) && dueDay(t) <= today();
    var who = withClient ? (c ? c.company : [t.role, t.topic].filter(Boolean).join(' · ')) : '';
    m.appendChild(el('small', late ? 'due' : '', [t.due ? (dueDay(t) === today() ? 'Today' : 'Due ' + t.due) : '', who, t.assignee].filter(Boolean).join(' · ')));
    r.appendChild(m);
    var pending = /^pending-/.test(t.id);
    var sel = el('select', 'st'); sel.setAttribute('aria-label', 'Status');
    var cur = STATUSES.indexOf(t.status) >= 0 ? t.status : (isOpen(t) ? 'New' : 'Done');
    STATUSES.forEach(function (v) { var o = el('option', '', v); o.value = v; sel.appendChild(o); });
    sel.value = cur; sel.setAttribute('data-s', cur); sel.disabled = pending;
    sel.onchange = function () { setStatus(t, sel.value); };
    r.appendChild(sel);
    var del = el('button', 'del', '🗑'); del.type = 'button'; del.title = 'Delete task'; del.disabled = pending;
    del.onclick = function () {
      if (!del.classList.contains('sure')) {
        del.classList.add('sure'); del.textContent = 'Delete?';
        setTimeout(function () { del.classList.remove('sure'); del.textContent = '🗑'; }, 3000);
        return;
      }
      removeTask(t);
    };
    r.appendChild(del);
    return r;
  }
  function renderTasks(c) {
    var box = $('dTasks'); box.innerHTML = '';
    var all = cache.tasks.filter(function (t) { return t.contactId === c.id; });
    var hide = $('taskShow').value !== 'all';
    var ts = all.filter(function (t) { return !hide || isOpen(t); }).sort(byDue);
    if (!ts.length) box.appendChild(el('div', 'empty', all.length ? 'No open tasks.' : 'No tasks yet.'));
    ts.forEach(function (t) { box.appendChild(taskRow(t, false)); });
    var closed = all.length - ts.length;
    if (closed) {
      var b = el('button', 'btn secondary', 'Show ' + closed + ' closed'); b.type = 'button'; b.style.marginTop = '8px';
      b.onclick = function () { $('taskShow').value = 'all'; store.set('taskShow', 'all'); renderTasks(c); render(); };
      box.appendChild(b);
    }
  }
  function taskChanged(item) {
    keep('crmCache2', cache);
    if (current) renderTasks(current);
    render();
    if (window.CAL) CAL.changed();
    queue.push(item); keep('crmQueue2', queue);
    flush().then(list, function () {});
  }
  function setStatus(t, v) {
    t.status = v; t.completed = (v === 'Done' || v === 'Cancelled') ? today() : '';
    taskChanged({ action: 'taskStatus', taskId: t.id, status: v });
  }
  function removeTask(t) {
    cache.tasks = cache.tasks.filter(function (x) { return x !== t; });
    taskChanged({ action: 'deleteTask', taskId: t.id });
  }
  $('taskShow').value = store.get('taskShow', 'open');
  $('taskShow').onchange = function () { store.set('taskShow', $('taskShow').value); taskLimit = 30; render(); if (current) renderTasks(current); };
  $('taskMore').onclick = function () { taskLimit += 50; render(); };
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

  window.CRM = { currentClient: function () { return current; }, lastSaved: function () { return lastSaved; }, flush: function () { return flush(); }, findForm: function () { var q = formClient(); return q ? find(q) : null; }, sync: sync, matchForm: matchForm, render: render, api: api, show: show, cfg: cfg,
    state: function () { return cache; }, openClient: function (id) { var c = byId(id); if (c) open(c); },
    queueItem: function (item) { queue.push(item); keep('crmQueue2', queue); return flush(); }, list: list,
    waiting: function () { return queue.length; } };
  window.addEventListener('online', sync);
  fillTeam(); fillCalendars(); render(); matchForm();
  if (cfg().url) sync();
})();
