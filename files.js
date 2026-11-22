// File uploads: pick files on the New task form or a client page. They go to the team's Drive folder
// ("Task Scheduler Files") with a readable name like 2026-11-27_Your-child_Piano-Lesson_Pay-fees.pdf,
// and are linked to the task and client in the CRM sheet's File tab.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var C = window.CRM, MAX_MB = 20;
  var picked = [];

  function icon(mime, name) {
    if (/^image\//.test(mime)) return '🖼️';
    if (/pdf/.test(mime) || /\.pdf$/i.test(name)) return '📄';
    if (/sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return '📊';
    if (/word|document/.test(mime) || /\.docx?$/i.test(name)) return '📝';
    if (/presentation|powerpoint/.test(mime) || /\.pptx?$/i.test(name)) return '📽️';
    if (/^video\//.test(mime)) return '🎬';
    if (/^audio\//.test(mime)) return '🎵';
    return '📎';
  }
  function size(kb) { kb = +kb || 0; return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB'; }
  function clean(s, n) {
    return String(s || '').replace(/^(re|fw|fwd):\s*/i, '').replace(/[\\\/:*?"<>|#%{}~&]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n).trim().replace(/ /g, '-');
  }
  function stem(name) {
    var s = String(name || '').replace(/\.[^.]+$/, '');
    return /^(img|dsc|pxl|vid|screenshot|scan|image|photo|whatsapp (image|video|document)|document|doc|file|untitled)[\s_\-]*[\d\s_\-.:at]*(\(\d+\))?$/i.test(s) || /^[\d\s_\-.()]+$/.test(s) ? '' : s;
  }
  // Same rule as the sheet script, to show the name before uploading.
  function previewName(f, meta) {
    var ext = (f.name.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || '';
    var title = meta.title || f.name.replace(/\.[^.]+$/, '');
    if (meta.topic && title.toLowerCase().indexOf(meta.topic.toLowerCase() + ':') === 0) title = title.slice(meta.topic.length + 1);
    var seen = {}, parts = [meta.date || new Date().toISOString().slice(0, 10), clean(meta.role, 20), clean(meta.topic, 30), clean(title, 40), clean(stem(f.name), 25), clean(meta.client, 30)]
      .filter(function (p) { var k = p.toLowerCase(); if (!p || seen[k]) return false; seen[k] = 1; return true; });
    return parts.join('_') + (ext ? '.' + ext : '');
  }
  function readB64(file) {
    return new Promise(function (ok, fail) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')); };
      r.onerror = function () { fail(new Error('Could not read ' + file.name)); };
      r.readAsDataURL(file);
    });
  }
  function upload(file, meta, ref) {
    if (file.size > MAX_MB * 1048576) return Promise.reject(new Error(file.name + ' is over ' + MAX_MB + ' MB'));
    return readB64(file).then(function (data) {
      return C.api({ action: 'upload', file: { name: file.name, mime: file.type, data: data, ref: ref, taskRef: meta.taskRef,
        contactId: meta.contactId, role: meta.role, topic: meta.topic, title: meta.title, date: meta.date, client: meta.client } });
    });
  }
  function uploadAll(files, meta, note) {
    var i = 0, okN = 0, fails = [];
    function next() {
      if (i >= files.length) {
        note(fails.length ? '⚠️ ' + okN + ' of ' + files.length + ' uploaded. ' + fails.join('; ') : '✓ ' + okN + ' file' + (okN === 1 ? '' : 's') + ' saved to Drive.');
        return C.list();
      }
      var f = files[i++];
      note('Uploading ' + i + ' of ' + files.length + ': ' + f.name + '…');
      return upload(f, meta, (meta.taskRef || 'c') + '-' + i + '-' + f.size).then(function () { okN++; }, function (e) { fails.push(e.message === 'Failed to fetch' ? f.name + ': no connection' : e.message); }).then(next);
    }
    return next();
  }

  // ---- New task form ----
  function meta() {
    var pk = window.PICKS ? PICKS.current() : {}, m = C.findForm && C.findForm();
    return { title: $('title').value.trim(), date: $('date').value, role: pk.role, topic: pk.topic,
      client: pk.role && !pk.saveContact ? '' : (m ? m.company : $('company').value || $('contact').value) };
  }
  function drawPicked() {
    var box = $('attachList'); box.innerHTML = '';
    var m = meta();
    picked.forEach(function (f, i) {
      var r = document.createElement('div'); r.className = 'file';
      r.innerHTML = '<span class="ic"></span><div class="meta"><div class="nm"></div><small></small></div><button class="x" type="button" aria-label="Remove">✕</button>';
      r.querySelector('.ic').textContent = icon(f.type, f.name);
      r.querySelector('.nm').textContent = previewName(f, m);
      r.querySelector('small').textContent = f.name + ' · ' + size(f.size / 1024) + (f.size > MAX_MB * 1048576 ? ' · too big' : '');
      r.querySelector('.x').onclick = function () { picked.splice(i, 1); drawPicked(); };
      box.appendChild(r);
    });
    $('attachHint').textContent = picked.length ? 'They upload when you tap Add. Names update as you fill in the task.'
      : 'Saved to the team\'s Drive folder with a clear name, and linked to this task and client.';
  }
  $('attachInput').addEventListener('change', function () {
    Array.prototype.push.apply(picked, Array.prototype.slice.call($('attachInput').files));
    $('attachInput').value = '';
    drawPicked();
  });
  ['title', 'date', 'contact', 'company'].forEach(function (id) { $(id).addEventListener('input', function () { if (picked.length) drawPicked(); }); });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#roleChips, #topicChips, #phraseChips') && picked.length) setTimeout(drawPicked, 0);
  });
  var lastRef = '';
  $('addBtn').addEventListener('click', function () {
    if (!picked.length) return;
    if (!C.cfg().url) { $('attachHint').textContent = 'Add the CRM link in ⚙︎ to upload files.'; return; }
    var s = C.lastSaved();
    if (!s || s.ref === lastRef) return;
    lastRef = s.ref;
    var files = picked.slice(), m = { title: s.title, date: s.date, role: s.role, topic: s.topic, client: s.client, taskRef: s.withTask ? s.ref : '' };
    picked = []; drawPicked();
    var note = function (t) { $('attachHint').textContent = t; };
    // Upload after the task itself is saved, so the files link to it.
    C.flush().then(function () { return uploadAll(files, m, note); }, function () {
      picked = files; drawPicked(); note('Task saved on this phone. Connect to the internet and tap Add again to upload the files.');
    });
  });
  $('clearBtn').addEventListener('click', function () { picked = []; drawPicked(); });

  // ---- Client page and event page ----
  function fileRow(f) {
    var a = document.createElement('a'); a.className = 'file'; a.href = f.url; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = '<span class="ic"></span><div class="meta"><div class="nm"></div><small></small></div>';
    a.querySelector('.ic').textContent = icon(f.mime, f.name);
    a.querySelector('.nm').textContent = f.name;
    a.querySelector('small').textContent = [size(f.sizeKB), f.by ? 'by ' + f.by : '', String(f.at || '').slice(0, 10)].filter(Boolean).join(' · ');
    return a;
  }
  function refresh() {
    var files = (C.state().files || []).slice().reverse();
    var c = C.currentClient && C.currentClient();
    var box = $('dFiles'); box.innerHTML = '';
    if (c) {
      var mine = files.filter(function (f) { return f.contactId === c.id; });
      if (!mine.length) { var e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No files yet.'; box.appendChild(e); }
      mine.forEach(function (f) { box.appendChild(fileRow(f)); });
    }
  }
  $('dAttach').addEventListener('change', function () {
    var c = C.currentClient(), files = Array.prototype.slice.call($('dAttach').files);
    $('dAttach').value = '';
    if (!c || !files.length) return;
    if (/^new-/.test(c.id)) { $('dAttachNote').textContent = 'Sync first, then add files.'; return; }
    var today = new Date(), d = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    uploadAll(files, { contactId: c.id, client: c.company || c.name, date: d }, function (t) { $('dAttachNote').textContent = t; });
  });
  // Event page: files linked to the event's task.
  var evBox = $('evFiles');
  new MutationObserver(function () {
    if ($('evView').classList.contains('hidden')) return;
    var title = $('evTitle').value;
    evBox.innerHTML = '';
    var ev = window.CAL && CAL.editing && CAL.editing();
    if (!ev || !ev.taskId) return;
    var list = (C.state().files || []).filter(function (f) { return f.taskId === ev.taskId; });
    if (!list.length) return;
    var h = document.createElement('label'); h.textContent = 'Files'; evBox.appendChild(h);
    list.forEach(function (f) { evBox.appendChild(fileRow(f)); });
  }).observe($('evView'), { attributes: true, attributeFilter: ['class'] });

  window.FILES = { refresh: refresh };
})();
