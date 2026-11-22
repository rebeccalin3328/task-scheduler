// Quick picks: "Who is this task for?" → "What is it about?" → ready-made phrases.
// Lists come from the CRM sheet's Picklist tab (shared with the team). Without a CRM link, a starter list
// is used and anything added is kept on this phone.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var A = window.App, store = A.store;
  var STARTER = {
    roles: [{ name: 'Customer', saveContact: true }, { name: 'Supplier', saveContact: true }, { name: 'Staff', saveContact: false },
      { name: 'Your child', saveContact: false }, { name: 'Husband', saveContact: false }],
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
  var ICONS = { 'customer': '🤝', 'supplier': '📦', 'staff': '👷', 'your child': '🧒', 'husband': '💑', 'wife': '💑' };
  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function low(s) { return String(s || '').trim().toLowerCase(); }

  var sel = { role: '', topic: '', phrase: '' }, base = '', settingTitle = false, adding = null;

  function online() { return window.CRM && CRM.cfg().url; }
  function lists() {
    var st = window.CRM && CRM.state().picks;
    if (online() && st) return st;
    var local = load('picksLocal', null);
    return local || JSON.parse(JSON.stringify(STARTER));
  }
  function roleObj(name) { return lists().roles.filter(function (r) { return r.name === name; })[0]; }
  function uniq(a) { var seen = {}; return a.filter(function (x) { var k = low(x); if (seen[k]) return false; seen[k] = 1; return true; }); }

  function chip(text, on, fn, cls) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.className = (on ? 'on ' : '') + (cls || ''); b.onclick = fn; return b;
  }
  function render() {
    var L = lists();
    var rc = $('roleChips'); rc.innerHTML = '';
    L.roles.forEach(function (r) {
      rc.appendChild(chip((ICONS[low(r.name)] || '👤') + ' ' + r.name, sel.role === r.name, function () { pickRole(r.name); }));
    });
    rc.appendChild(chip('＋ New role', false, function () { startAdd('role'); }, 'add'));

    $('topicWrap').classList.toggle('hidden', !sel.role);
    $('phraseWrap').classList.toggle('hidden', !sel.role);
    if (sel.role) {
      $('topicLabel').textContent = sel.role === 'Your child' ? 'What is it about? (school, lesson, subject…)' : 'What is it about?';
      var tc = $('topicChips'); tc.innerHTML = '';
      (L.topics[sel.role] || []).forEach(function (t) { tc.appendChild(chip(t, sel.topic === t, function () { pickTopic(t); })); });
      tc.appendChild(chip('＋ Add', false, function () { startAdd('topic'); }, 'add'));
      var pc = $('phraseChips'); pc.innerHTML = '';
      uniq((L.phrases[sel.role] || []).concat(L.phrases['*'] || [])).forEach(function (p) {
        pc.appendChild(chip(p, sel.phrase === p, function () { pickPhrase(p); }));
      });
      pc.appendChild(chip('＋ Add', false, function () { startAdd('phrase'); }, 'add'));
    }
    var r = roleObj(sel.role);
    if (sel.role && r && !r.saveContact) $('crmHint').textContent = 'For ' + sel.role.toLowerCase() + ': saved as a task, not added to the client list.';
    else if (window.CRM) CRM.matchForm();
  }

  // Title = "Topic: phrase or the message's own words"
  function compose() {
    var main = sel.phrase || base;
    settingTitle = true;
    $('title').value = [sel.topic, main].filter(Boolean).join(': ') || base;
    settingTitle = false;
    A.refreshLinks();
  }
  function pickRole(name) {
    sel.role = sel.role === name ? '' : name; sel.topic = ''; sel.phrase = '';
    store.set('lastRole', sel.role);
    render(); compose();
  }
  function pickTopic(t) { sel.topic = sel.topic === t ? '' : t; render(); compose(); }
  function pickPhrase(p) { sel.phrase = sel.phrase === p ? '' : p; render(); compose(); }

  // ---- adding new roles, topics, phrases ----
  function startAdd(type) {
    adding = type;
    $('addBox').classList.remove('hidden');
    $('addLabel').textContent = type === 'role' ? 'New role (for example Landlord, Wife, Contractor)'
      : type === 'topic' ? 'New topic for ' + sel.role : 'New phrase for ' + sel.role;
    $('addContactRow').classList.toggle('hidden', type !== 'role');
    $('addContact').checked = false;
    $('addInput').value = ''; $('addInput').focus();
  }
  function endAdd() { adding = null; $('addBox').classList.add('hidden'); }
  $('addCancel').onclick = endAdd;
  $('addInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('addOk').click(); } });
  $('addOk').onclick = function () {
    var v = $('addInput').value.trim().replace(/\s+/g, ' ');
    if (!v || !adding) { endAdd(); return; }
    var pick = { type: adding, value: v, role: adding === 'role' ? '' : sel.role, saveContact: $('addContact').checked };
    // Show it straight away, then share it.
    var L = lists();
    if (adding === 'role') { if (!roleObj(v)) L.roles.push({ name: v, saveContact: pick.saveContact }); }
    else {
      var key = adding === 'topic' ? 'topics' : 'phrases';
      L[key][sel.role] = L[key][sel.role] || [];
      if (!L[key][sel.role].some(function (x) { return low(x) === low(v); })) L[key][sel.role].push(v);
    }
    if (online()) { CRM.state().picks = L; CRM.queueItem({ action: 'addPick', pick: pick }).catch(function () {}); }
    else keep('picksLocal', L);
    var type = adding;
    endAdd();
    if (type === 'role') pickRole(v); else if (type === 'topic') pickTopic(v); else pickPhrase(v);
  };

  // ---- keep in step with the rest of the form ----
  $('title').addEventListener('input', function () {
    if (settingTitle) return;
    // Typing in the title replaces the phrase; keep the topic as the prefix.
    var t = $('title').value, pre = sel.topic ? sel.topic + ': ' : '';
    base = pre && t.indexOf(pre) === 0 ? t.slice(pre.length) : t;
    sel.phrase = '';
    render();
  });
  function guessRole() {
    if (sel.role || !window.CRM) return;
    var c = CRM.findForm();
    if (!c) return;
    var name = /creditor|supplier/i.test(c.source || '') ? 'Supplier' : 'Customer';
    if (roleObj(name)) { sel.role = name; render(); }
  }
  // Called by detect() after a pasted message fills the form.
  function parsed() { base = $('title').value; sel = { role: '', topic: '', phrase: '' }; guessRole(); render(); }
  ['contact', 'phone', 'cemail', 'company'].forEach(function (id) { $(id).addEventListener('change', function () { guessRole(); }); });
  $('clearBtn').addEventListener('click', function () { sel = { role: '', topic: '', phrase: '' }; base = ''; endAdd(); render(); });

  window.PICKS = {
    current: function () { var r = roleObj(sel.role); return { role: sel.role, topic: sel.topic, saveContact: !!(r && r.saveContact) }; },
    refresh: render,
    parsed: parsed
  };
  base = $('title').value;
  render();
})();
