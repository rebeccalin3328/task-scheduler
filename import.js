// Add a batch of tasks from a link: index.html#import=<base64url JSON>.
// The list is shown first, and nothing is saved until you tap Add. Saving uses the CRM link and team key already on
// this phone, so the link itself carries no keys. The part after # never leaves the phone (browsers don't send it).
// Payload: { tasks: [{ ref, title, due: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM', description, role, topic,
//                      client: { name, phone, company } or null }] }
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
  // One save request per task, in the same shape the New task form uses.
  function items(tasks) {
    return tasks.map(function (t) {
      var c = t.client && (t.client.phone || t.client.name || t.client.company) ? t.client : { none: true };
      return { action: 'save', client: c, task: { title: t.title, due: t.due || '', description: t.description || '', ref: t.ref,
        role: t.role || '', topic: t.topic || '' } };
    });
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
      tasks.map(function (t, i) {
        return '<label style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)">' +
          '<input type="checkbox" data-i="' + i + '" checked style="margin-top:4px;width:20px;height:20px">' +
          '<span><b>' + esc(t.title) + '</b><br><small>' + esc(when(t.due)) +
          (t.role ? ' · ' + esc(t.role) : '') + (t.client && t.client.name ? ' · ' + esc(t.client.name) : '') + '</small></span></label>';
      }).join('') +
      '<div id="importNote" class="chip hidden"></div>' +
      '<button class="btn primary" id="importGo" style="margin-top:12px">Add selected tasks</button>' +
      '<button class="btn secondary" id="importNo">Cancel</button></section>';
    document.body.appendChild(box);

    function close() { box.remove(); history.replaceState(null, '', location.pathname + location.search); }
    $('importNo').onclick = close;
    $('importGo').onclick = function () {
      var note = $('importNote');
      if (!window.CRM || !CRM.cfg().url) {
        note.className = 'chip warn'; note.textContent = 'Add the CRM link and team key in ⚙︎ first, then open this link again.';
        return;
      }
      var picked = tasks.filter(function (t, i) { return box.querySelector('input[data-i="' + i + '"]').checked; });
      if (!picked.length) { close(); return; }
      this.disabled = true;
      note.className = 'chip ok'; note.textContent = 'Saving ' + picked.length + ' tasks…';
      var last;
      items(picked).forEach(function (it) { last = CRM.queueItem(it); });
      last.then(function () {
        note.textContent = '✓ Added ' + picked.length + ' tasks to the CRM sheet.';
        CRM.list();
        setTimeout(close, 1500);
      }, function () {
        note.className = 'chip warn';
        note.textContent = 'Saved on this phone. They will upload to the CRM sheet when you are back online.';
      });
    };
  }

  var m = location.hash.match(/^#import=([A-Za-z0-9_-]+)$/);
  if (m) { try { show(decode(m[1])); } catch (e) { console.warn('Bad import link', e); } }
  window.IMPORT = { decode: decode, items: items };
})();
