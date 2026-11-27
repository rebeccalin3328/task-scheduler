// Reference (admin only): pick a WhatsApp chat, and every link shared in it is opened, summarised and put in a category.
// Links come from your PC (reference-sync.py reads the chat through the read-only WhatsApp MCP), or from a chat you paste
// or open here (WhatsApp > chat > ⋮ > More > Export chat > Without media). Only works with the admin key on this phone.
// Nothing here sends WhatsApp messages.
(function () {
  // ---- Chat text → links (also used by test-ref.js) ----
  // Message headers WhatsApp uses:
  //   export (Android): 26/11/2026, 13:47 - Ali: text      11/26/26, 1:47 PM - Ali: text
  //   export (iPhone):  [26/11/2026, 13:47:01] Ali: text
  //   copied messages:  [13:47, 26/11/2026] Ali: text
  var HEAD = [
    /^‎?\[?(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[AaPp]\.?\s?[Mm]\.?)?)\]?\s*(?:[-–]\s*)?([^:\n]{1,60}?):\s?(.*)$/,
    /^‎?\[(\d{1,2}[:.]\d{2}(?:\s?[AaPp]\.?\s?[Mm]\.?)?),\s*(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\]\s*([^:\n]{1,60}?):\s?(.*)$/
  ];
  var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

  function cleanUrl(url) {
    var u = String(url || '').trim().replace(/^<+/, ''), n = function (c) { return u.split(c).length - 1; };
    while (u) {
      var last = u.slice(-1);
      if (/[\]}>.,;:!?'"*_~]/.test(last) || last === ')' && n(')') > n('(')) u = u.slice(0, -1); else break;
    }
    return /^www\./i.test(u) ? 'https://' + u : u;
  }
  function parseChat(text) {
    var msgs = [], cur = null;
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var m = HEAD[0].exec(line), when;
      if (m) when = m[1] + ' ' + m[2];
      else if ((m = HEAD[1].exec(line))) when = m[2] + ' ' + m[1];
      if (m) { cur = { by: m[3].replace(/^‎/, '').trim(), at: when, text: m[4] }; msgs.push(cur); }
      else if (cur) cur.text += '\n' + line;
      else { cur = { by: '', at: '', text: line }; msgs.push(cur); }
    });
    var out = [], seen = {};
    msgs.forEach(function (msg) {
      (msg.text.match(URL_RE) || []).forEach(function (raw) {
        var url = cleanUrl(raw);
        if (!/^https?:\/\/[^\/\s]+\.[^\/\s]+/i.test(url) || seen[url]) return;
        seen[url] = 1;
        out.push({ url: url, sharedBy: msg.by, sharedAt: msg.at, message: msg.text.trim().slice(0, 300) });
      });
    });
    return out;
  }
  // ---- Excel export: sorted by category (in the app's order), then newest first ----
  // "26/11/2026 13:48", "11/26/26 9:05 PM", "2026-11-20 09:15" → sortable number (0 if unknown).
  function dateNum(s) {
    s = String(s || '');
    var m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/), y, mo, d, h = 0, mi = 0;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = +(m[4] || 0); mi = +(m[5] || 0); }
    else if ((m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([AaPp])?)?/))) {
      d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000;
      if (mo > 12 || m[6]) { var t = d; d = mo; mo = t; } // US style (12-hour exports): month first
      h = +(m[4] || 0); mi = +(m[5] || 0);
      if (m[6] && /p/i.test(m[6]) && h < 12) h += 12; if (m[6] && /a/i.test(m[6]) && h === 12) h = 0;
    } else return 0;
    return ((y * 100 + mo) * 100 + d) * 10000 + h * 100 + mi;
  }
  var XL_HEAD = ['Category', 'Title', 'Summary', 'Link', 'Website', 'Shared by', 'Shared on', 'Chat', 'Status'];
  function exportRows(list, catOrder) {
    var rank = function (c) { var i = (catOrder || []).indexOf(c); return c ? (i < 0 ? 900 : i) : 999; };
    return list.slice().sort(function (a, b) {
      return rank(a.category) - rank(b.category) || dateNum(b.at) - dateNum(a.at) || String(a.title).localeCompare(String(b.title));
    }).map(function (l) {
      return [l.category || 'Not sorted yet', l.title || '', l.summary || (l.status === 'Failed' ? 'Could not open: ' + (l.error || '') : ''),
        { link: l.url }, l.domain || '', l.by || '', l.at || '', l.chat || '', l.status === 'Done' ? '' : l.status || ''];
    });
  }
  window.REFPARSE = { parseChat: parseChat, cleanUrl: cleanUrl, dateNum: dateNum, exportRows: exportRows, HEAD: XL_HEAD };
  if (typeof document === 'undefined' || !document.getElementById('refView')) return;

  // ---- Screen ----
  var $ = function (id) { return document.getElementById(id); };
  var C = window.CRM;
  var pcSeen = '';
  // The PC helper checks in every minute; more than 3 minutes of silence means it's off (or the PC is asleep).
  function pcAgeMin() { var d = pcSeen ? new Date(pcSeen.replace(' ', 'T')) : null; return d && !isNaN(d) ? (Date.now() - d.getTime()) / 60000 : Infinity; }
  function pcOnline() { return pcAgeMin() < 3; }
  function drawPc() {
    $('refPc').textContent = !pcSeen ? '🔴 Your PC helper has never connected. See REFERENCE-SETUP.md to start it.'
      : pcOnline() ? '🟢 Your PC is connected.' : '🔴 Your PC is offline (last seen ' + pcSeen + '). Turn it on, or paste the chat below.';
  }
  var chats = [], links = [], cats = [], chatId = '', filter = '', busy = false, waitTimer = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function admin() { return !!(C && C.state().isAdmin); }
  function note(t) { $('refNote').textContent = t || ''; }
  function chatName(id) { var c = chats.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; }

  function changed() {
    $('tabRef').classList.toggle('hidden', !admin());
    if (!admin() && !$('refView').classList.contains('hidden')) C.show('task');
  }
  // Opens this screen itself too, so it still works while the phone has an older copy of crm.js cached.
  $('tabRef').onclick = function () {
    C.show('ref');
    ['taskView', 'calView', 'evView', 'admView', 'clientsView', 'detailView'].forEach(function (v) { if ($(v)) $(v).classList.add('hidden'); });
    $('refView').classList.remove('hidden');
    ['tabTask', 'tabCal', 'tabClients'].forEach(function (t) { $(t).classList.remove('on'); });
    $('tabRef').classList.add('on');
    note('Loading your chats…');
    var slow = setTimeout(function () { if ($('refNote').textContent === 'Loading your chats…') note('Still loading… the sheet may be busy summarising links. Give it a minute.'); }, 15000);
    loadChats().then(function () { clearTimeout(slow); });
  };

  function loadChats() {
    return C.api({ action: 'refChats' }).then(function (j) {
      chats = j.chats || []; cats = j.categories || cats;
      chats.sort(function (a, b) { return (b.links - a.links) || a.name.localeCompare(b.name); });
      var dl = $('refChatList'); dl.innerHTML = '';
      chats.forEach(function (c) { var o = el('option'); o.value = c.name; dl.appendChild(o); });
      pcSeen = j.pcSeen || ''; drawPc();
      note(chats.length ? '' : 'No chats yet. Start reference-sync.py on your PC, or paste a chat below.');
      drawRecent(); drawMatches();
      loadLinks();
    }, function (err) { note(err.kind === 'rejected' ? err.message : 'Could not load: ' + err.message); });
  }
  function drawRecent() {
    var box = $('refRecent'); box.innerHTML = '';
    var all = el('button', chatId ? '' : 'on', 'All chats'); all.onclick = function () { pick(''); }; box.appendChild(all);
    chats.filter(function (c) { return c.links || c.id === chatId; }).slice(0, 30).forEach(function (c) {
      var b = el('button', c.id === chatId ? 'on' : '', (c.kind === 'Group' ? '👥 ' : '👤 ') + c.name + ' · ' + c.links);
      b.onclick = function () { pick(c.id); };
      box.appendChild(b);
    });
  }
  function drawMatches() {
    var box = $('refMatches'); box.innerHTML = '';
    var q = $('refFind').value.trim().toLowerCase();
    if (chatId && q === chatName(chatId).toLowerCase()) return;
    var list = chats.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0 || c.id.indexOf(q) === 0; });
    list.slice(0, q ? 30 : 8).forEach(function (c) {
      var r = el('div', 'client');
      var av = el('div', 'av', c.kind === 'Group' ? '👥' : '👤');
      var meta = el('div', 'meta'); meta.appendChild(el('div', 'nm', c.name));
      meta.appendChild(el('div', 'sub', c.links ? c.links + ' links' : (c.kind === 'Group' ? 'Group' : 'Contact')));
      r.appendChild(av); r.appendChild(meta);
      r.onclick = function () { pick(c.id); };
      box.appendChild(r);
    });
    if (list.length > (q ? 30 : 8)) box.appendChild(el('div', 'empty', (list.length - (q ? 30 : 8)) + ' more. Type part of the name.'));
    if (q && !list.length) box.appendChild(el('div', 'empty', 'No chat matches "' + $('refFind').value + '".'));
  }
  $('refFind').addEventListener('input', drawMatches);
  function pick(id) {
    chatId = id; filter = '';
    $('refFind').value = id ? chatName(id) : '';
    $('refGet').disabled = !id || /^paste:/.test(id);
    drawRecent(); drawMatches(); loadLinks();
  }
  $('refFind').addEventListener('change', function () {
    var v = $('refFind').value.trim().toLowerCase();
    var c = chats.filter(function (x) { return x.name.toLowerCase() === v; })[0];
    if (c) pick(c.id);
    else if (!v) pick('');
    else note('No chat called "' + $('refFind').value + '" yet. Your PC sends the chat list when it runs. You can also paste the chat below.');
  });

  // Ask the PC for this chat's links, then wait for them.
  $('refGet').onclick = function () {
    if (!chatId) return;
    var online = pcOnline();
    note(online ? 'Asking your PC for the links in ' + chatName(chatId) + '…' : 'Saving your request…');
    C.api({ action: 'refRequest', chatId: chatId }).then(function () {
      if (online) return waitForPc(chatId, Date.now());
      // PC off: the request is kept and answered when it's back. Meanwhile, offer the paste option.
      note('Your PC is offline, so this will run when it is back on. To get the links now, paste or open the chat below.');
      $('refPasteBox').open = true;
    },
      function (err) { note('Not sent: ' + err.message); });
  };
  function waitForPc(id, since) {
    clearTimeout(waitTimer);
    var before = (chats.filter(function (c) { return c.id === id; })[0] || {}).syncedAt;
    waitTimer = setTimeout(function check() {
      if ($('refView').classList.contains('hidden')) return;
      C.api({ action: 'refChats' }).then(function (j) {
        chats = j.chats || chats; pcSeen = j.pcSeen || pcSeen; drawPc();
        var c = chats.filter(function (x) { return x.id === id; })[0] || {};
        if (c.syncedAt && c.syncedAt !== before) { note('Got ' + c.links + ' links from your PC.'); drawRecent(); loadLinks(); return; }
        if (Date.now() - since > 5 * 60000 || !pcOnline()) { note('Your PC has not answered. It will when it is back on. To get the links now, paste or open the chat below.'); $('refPasteBox').open = true; return; }
        note('Waiting for your PC… (it checks every minute)');
        waitTimer = setTimeout(check, 10000);
      }, function () { waitTimer = setTimeout(check, 15000); });
    }, 4000);
  }

  // Paste a chat, or open an exported .txt
  $('refFile').onchange = function () {
    var f = $('refFile').files[0];
    if (!f) return;
    if (/zip/i.test(f.type) || /\.zip$/i.test(f.name)) { note('That is a .zip. Open it in Files first, then pick the .txt inside.'); return; }
    var r = new FileReader();
    r.onload = function () {
      $('refPaste').value = String(r.result || '');
      var m = f.name.match(/WhatsApp Chat (?:with|-|dengan)?\s*(.+?)\.txt$/i);
      if (m && !$('refPasteName').value) $('refPasteName').value = m[1];
      $('refPasteGo').click();
    };
    r.readAsText(f);
  };
  $('refPasteGo').onclick = function () {
    var found = parseChat($('refPaste').value);
    if (!found.length) { note('No links found in that text.'); return; }
    var name = $('refPasteName').value.trim(), id = chatId;
    if (!id) {
      if (!name) { note('Type the chat name (or pick a chat above), so the links are filed under it.'); $('refPasteName').focus(); return; }
      var same = chats.filter(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })[0];
      id = same ? same.id : 'paste:' + name.toLowerCase();
    }
    note('Sending ' + found.length + ' links…');
    C.api({ action: 'refPush', source: 'app', chat: { id: id, name: name || chatName(id), kind: 'Pasted' }, links: found }).then(function (j) {
      $('refPaste').value = ''; $('refFile').value = '';
      note(j.added + ' new links, ' + (found.length - j.added) + ' already there.');
      return loadChats().then(function () { pick(j.chatId); });
    }, function (err) { note('Not sent: ' + err.message); });
  };

  function loadLinks() {
    return C.api({ action: 'refLinks', chatId: chatId }).then(function (j) {
      links = j.links || []; cats = j.categories || cats;
      render();
      if (links.some(waiting)) work();
    }, function (err) { note('Could not load links: ' + err.message); });
  }
  function waiting(l) { return l.status === 'Pending' || l.status === 'Working'; }
  // Summarise waiting links a few at a time while this screen is open.
  function work() {
    if (busy) return;
    busy = true;
    (function step() {
      if ($('refView').classList.contains('hidden')) { busy = false; return; }
      C.api({ action: 'refProcess', chatId: chatId }).then(function (j) {
        return C.api({ action: 'refLinks', chatId: chatId }).then(function (k) {
          links = k.links || links; render();
          if (j.left && j.done) setTimeout(step, 300); else busy = false;
        });
      }, function (err) { busy = false; note('Summaries paused: ' + err.message); });
    })();
  }

  function render() {
    var q = $('refSearch').value.trim().toLowerCase();
    var shown = links.filter(function (l) {
      return (!filter || l.category === filter) && (!q || (l.title + ' ' + l.summary + ' ' + l.url + ' ' + l.by + ' ' + l.chat).toLowerCase().indexOf(q) >= 0);
    });
    var count = {};
    links.forEach(function (l) { var k = l.category || 'Waiting'; count[k] = (count[k] || 0) + 1; });
    var box = $('refCats'); box.innerHTML = '';
    var all = el('button', filter ? '' : 'on', 'All · ' + links.length); all.onclick = function () { filter = ''; render(); }; box.appendChild(all);
    cats.filter(function (c) { return count[c]; }).forEach(function (c) {
      var b = el('button', filter === c ? 'on' : '', c + ' · ' + count[c]); b.onclick = function () { filter = filter === c ? '' : c; render(); }; box.appendChild(b);
    });
    var left = links.filter(waiting).length;
    $('refTitle').textContent = (chatId ? chatName(chatId) : 'All chats') + (left ? ' · summarising ' + left + '…' : '');
    var list = $('refList'); list.innerHTML = '';
    if (!shown.length) list.appendChild(el('div', 'empty', links.length ? 'No links match.' : chatId ? 'No links yet. Tap "Get links" or paste the chat below.' : 'Pick a chat to start.'));
    shown.slice(0, 300).forEach(function (l) { list.appendChild(card(l)); });
  }
  $('refSearch').addEventListener('input', render);

  // Download what is on screen (this chat or all chats, the chosen category and search) as an Excel file.
  function shownLinks() {
    var q = $('refSearch').value.trim().toLowerCase();
    return links.filter(function (l) {
      return (!filter || l.category === filter) && (!q || (l.title + ' ' + l.summary + ' ' + l.url + ' ' + l.by + ' ' + l.chat).toLowerCase().indexOf(q) >= 0);
    });
  }
  $('refExport').onclick = function () {
    var list = shownLinks();
    if (!list.length) { note('Nothing to export yet.'); return; }
    var rows = exportRows(list, cats);
    var bytes = XLSX.build('Reference', XL_HEAD, rows, [20, 40, 70, 45, 22, 18, 17, 24, 10]);
    var d = new Date(), day = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var who = (chatId ? chatName(chatId) : 'All chats') + (filter ? ' ' + filter : '');
    var name = ('Reference ' + who + ' ' + day).replace(/[\\\/:*?"<>|&]+/g, ' ').replace(/\s+/g, '_') + '.xlsx';
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    var a = el('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    note('Saved ' + rows.length + ' links to ' + name + ' (in Downloads).');
  };

  function card(l) {
    var d = el('div', 'ref');
    var a = el('a', 'rt', l.title || l.domain || l.url); a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    d.appendChild(a);
    var sub = el('div', 'rs', [l.domain, l.by && 'from ' + l.by, l.at, !chatId && l.chat].filter(Boolean).join(' · '));
    d.appendChild(sub);
    if (waiting(l)) d.appendChild(el('p', 'rsum muted', '⏳ Reading the page…'));
    else if (l.status === 'Failed') {
      d.appendChild(el('p', 'rsum muted', '⚠️ Could not open it: ' + (l.error || 'unknown error')));
      var retry = el('button', 'linkbtn', 'Try again');
      retry.onclick = function () { C.api({ action: 'refUpdate', id: l.id, retry: true }).then(loadLinks); };
      d.appendChild(retry);
    } else d.appendChild(el('p', 'rsum', l.summary));
    var sel = el('select', 'rcat');
    cats.forEach(function (c) { var o = el('option', null, c); o.value = c; sel.appendChild(o); });
    if (!l.category) { var o = el('option', null, 'Category…'); o.value = ''; sel.insertBefore(o, sel.firstChild); }
    sel.value = l.category || '';
    sel.title = l.categoryBy === 'You' ? 'Set by you' : 'Set automatically. Change it if it is wrong.';
    sel.onchange = function () {
      C.api({ action: 'refUpdate', id: l.id, category: sel.value }).then(function (j) { l.category = j.link.category; l.categoryBy = 'You'; render(); },
        function (err) { note('Not changed: ' + err.message); });
    };
    d.appendChild(sel);
    return d;
  }

  window.REF = { changed: changed, reload: loadChats };
  changed();
})();
