/* Task Scheduler — date/time guesser for English, Malay and Chinese messages.
 * parse(text, now) -> { title, details, date, time, allDay, found: {date, time}, notes: [] }
 * date = {y, m (1-12), d} or null; time = {h, min} or null.
 */
(function (root) {
  'use strict';

  var MONTHS = {
    jan: 1, january: 1, januari: 1,
    feb: 2, february: 2, februari: 2,
    mar: 3, march: 3, mac: 3,
    apr: 4, april: 4,
    may: 5, mei: 5,
    jun: 6, june: 6,
    jul: 7, july: 7, julai: 7,
    aug: 8, august: 8, ogos: 8, ogo: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, okt: 10, oktober: 10,
    nov: 11, november: 11,
    dec: 12, december: 12, dis: 12, disember: 12
  };
  var MONTH_RE = Object.keys(MONTHS).sort(function (a, b) { return b.length - a.length; }).join('|');

  // 0 = Sunday
  var WEEKDAYS = [
    [/\b(?:sunday|sun|ahad)\b/, 0],
    [/\b(?:monday|mon|isnin)\b/, 1],
    [/\b(?:tuesday|tues|tue|selasa)\b/, 2],
    [/\b(?:wednesday|wed|rabu)\b/, 3],
    [/\b(?:thursday|thurs|thur|thu|khamis)\b/, 4],
    [/\b(?:friday|fri|jumaat|jumat)\b/, 5],
    [/\b(?:saturday|sat|sabtu)\b/, 6]
  ];
  var CN_WEEKDAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

  function cnNum(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var map = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (s === '十') return 10;
    var i = s.indexOf('十');
    if (i === -1) return map[s] !== undefined ? map[s] : NaN;
    var tens = i === 0 ? 1 : map[s.slice(0, i)];
    var ones = i === s.length - 1 ? 0 : map[s.slice(i + 1)];
    return tens * 10 + ones;
  }
  var CN_N = '(\\d{1,2}|[零〇一二两兩三四五六七八九十]{1,3})';

  function addDays(base, n) {
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  function validDate(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  // Pick the year so a date without one lands today or in the future.
  function futureYear(now, m, d) {
    var y = now.getFullYear();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (new Date(y, m - 1, d) < today) y += 1;
    return y;
  }
  function weekdayAhead(now, target, forceNext) {
    var diff = (target - now.getDay() + 7) % 7;
    if (diff === 0 && forceNext) diff = 7;
    return addDays(now, diff);
  }
  // Monday-based "next week": Monday of next week + offset.
  function nextWeekDay(now, target) {
    var dow = now.getDay() === 0 ? 7 : now.getDay();
    var t = target === 0 ? 7 : target;
    return addDays(now, 7 - dow + t);
  }

  // Remove WhatsApp copy headers like "[12/11/2026, 3:45 pm] Rebecca: "
  function cleanWhatsApp(text) {
    return String(text || '')
      .replace(/^\s*\[[^\]\n]{4,40}\]\s*[^:\n]{1,40}:\s*/gm, '')
      .replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\s+-\s+[^:\n]{1,40}:\s*/gim, '')
      .trim();
  }

  function findDate(t, now, notes) {
    var m;
    // 12/11, 12/11/2026, 12-11-26 (day first, Malaysian style)
    m = t.match(/(?:^|[^\d:])(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?![\d:])(?!\s*(?:am|pm|[ap]\.m))/);
    if (m) {
      var d = +m[1], mo = +m[2], y = m[3] ? +m[3] : null;
      if (y !== null && y < 100) y += 2000;
      if (y === null) y = futureYear(now, mo, d);
      if (mo >= 1 && mo <= 12 && validDate(y, mo, d)) { notes.push(m[0].trim()); return { y: y, m: mo, d: d }; }
    }
    // 12 Nov / 12th of November / 12 Disember 2026
    m = t.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(' + MONTH_RE + ')\\.?\\b(?:,?\\s*(\\d{4}))?'));
    if (m) {
      var mo2 = MONTHS[m[2]], d2 = +m[1], y2 = m[3] ? +m[3] : futureYear(now, mo2, d2);
      if (validDate(y2, mo2, d2)) { notes.push(m[0].trim()); return { y: y2, m: mo2, d: d2 }; }
    }
    // Nov 12 / November 12th, 2026
    m = t.match(new RegExp('\\b(' + MONTH_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?'));
    if (m) {
      var mo3 = MONTHS[m[1]], d3 = +m[2], y3 = m[3] ? +m[3] : futureYear(now, mo3, d3);
      if (validDate(y3, mo3, d3)) { notes.push(m[0].trim()); return { y: y3, m: mo3, d: d3 }; }
    }
    // 11月12日 / 11月12号
    m = t.match(new RegExp(CN_N + '\\s*月\\s*' + CN_N + '\\s*[日号號]?'));
    if (m) {
      var mo4 = cnNum(m[1]), d4 = cnNum(m[2]), y4 = futureYear(now, mo4, d4);
      if (validDate(y4, mo4, d4)) { notes.push(m[0]); return { y: y4, m: mo4, d: d4 }; }
    }
    // 15号 (this month, or next month if already passed)
    m = t.match(new RegExp(CN_N + '\\s*[号號]'));
    if (m) {
      var d5 = cnNum(m[1]), mo5 = now.getMonth() + 1, y5 = now.getFullYear();
      if (d5 < now.getDate()) { mo5 += 1; if (mo5 > 12) { mo5 = 1; y5 += 1; } }
      if (validDate(y5, mo5, d5)) { notes.push(m[0]); return { y: y5, m: mo5, d: d5 }; }
    }
    // Relative words (order matters: longer phrases first)
    var rel = [
      [/大[后後]天/, 3],
      [/\bday after (?:tomorrow|tmr|tmrw)\b|\blusa\b|[后後]天/, 2],
      [/\b(?:tomorrow|tmr|tmrw|tml|tmw|tomoro|tomorow|esok|besok|esk)\b|明天|明日|明早|明晚/, 1],
      [/\b(?:today|tonight|tdy|harini|hari ini|malam ini|mlm ni|malam ni|petang ni|ptg ni)\b|今天|今日|今晚|今早/, 0]
    ];
    for (var i = 0; i < rel.length; i++) {
      m = t.match(rel[i][0]);
      if (m) { notes.push(m[0]); return addDays(now, rel[i][1]); }
    }
    m = t.match(/\bin (\d{1,2}) days?\b|\b(\d{1,2}) hari lagi\b/);
    if (m) { notes.push(m[0]); return addDays(now, +(m[1] || m[2])); }
    // Chinese weekdays: 下周三 / 星期五 / 礼拜天
    m = t.match(/(下下|下|这|這|本)?\s*(?:周|週|星期|礼拜|禮拜)([一二三四五六日天])/);
    if (m) {
      var wd = CN_WEEKDAY[m[2]];
      notes.push(m[0]);
      if (m[1] === '下') return nextWeekDay(now, wd);
      if (m[1] === '下下') { var nw = nextWeekDay(now, wd); return addDays(new Date(nw.y, nw.m - 1, nw.d), 7); }
      return weekdayAhead(now, wd, false);
    }
    // English/Malay weekdays: "next fri", "this monday", "jumaat depan"
    for (var j = 0; j < WEEKDAYS.length; j++) {
      m = t.match(WEEKDAYS[j][0]);
      if (m) {
        var before = t.slice(Math.max(0, m.index - 12), m.index);
        var after = t.slice(m.index + m[0].length, m.index + m[0].length + 8);
        var isNextWeek = /\bnext week\b|minggu depan/.test(t) || /^\s*(?:depan|minggu depan)\b/.test(after);
        notes.push(m[0]);
        if (isNextWeek) return nextWeekDay(now, WEEKDAYS[j][1]);
        return weekdayAhead(now, WEEKDAYS[j][1], /\bnext\s*$/.test(before));
      }
    }
    m = t.match(/\bnext week\b|minggu depan|下周|下星期|下礼拜|下禮拜/);
    if (m) { notes.push(m[0]); return nextWeekDay(now, 1); }
    return null;
  }

  function periodShift(h, period) {
    if (!period) return h;
    if (/^(pm|p\.m\.?|petang|ptg|下午|午后|午後)$/.test(period)) return h < 12 ? h + 12 : h;
    if (/^(malam|mlm|晚上|晚|今晚|明晚|evening|night|tonight)$/.test(period)) return h === 12 ? 0 : (h >= 5 && h < 12 ? h + 12 : h);
    if (/^(tengah ?hari|tgh ?hari|中午)$/.test(period)) return h <= 4 ? h + 12 : h;
    if (/^(am|a\.m\.?|pagi|上午|早上|早|凌晨|morning)$/.test(period)) return h === 12 ? 0 : h;
    return h;
  }
  // Hour with no am/pm: guess from context words, else assume office hours (1–7 = afternoon).
  function guessHour(h, t) {
    var ctx = t.match(/\b(tonight|evening|night|morning|petang|ptg|malam|mlm|pagi|tengah ?hari|tgh ?hari)\b|(下午|晚上|今晚|明晚|上午|早上|中午|凌晨)/);
    if (ctx) return periodShift(h, ctx[1] || ctx[2]);
    if (h >= 1 && h <= 7) return h + 12;
    return h;
  }

  function findTime(t, notes) {
    var m, h, min;
    // 3pm, 3:30pm, 3.30 pm, 11 a.m.
    m = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)(?![a-z])/);
    if (m && +m[1] >= 1 && +m[1] <= 12) {
      var end = { h: periodShift(+m[1], m[3]), min: m[2] ? +m[2] : 0 };
      // Range like "3-5pm" or "3pm to 5pm": start takes the same am/pm unless that would come after the end.
      var r = t.slice(0, m.index).match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|hingga|sampai)\s*$/);
      if (r && +r[1] >= 1 && +r[1] <= 12) {
        var sh = periodShift(+r[1], r[3] || m[3]);
        if (!r[3] && sh * 60 > end.h * 60 + end.min) sh -= 12;
        notes.push(r[0] + m[0]);
        return { h: sh, min: r[2] ? +r[2] : 0, end: end };
      }
      notes.push(m[0]);
      return end;
    }
    // "tonight 8" / "malam 9"
    m = t.match(/\b(tonight|evening|malam|mlm|petang|ptg|pagi|morning)\s+(\d{1,2})(?![\d:.\/])/);
    if (m && +m[2] <= 12) { notes.push(m[0]); return { h: periodShift(+m[2], m[1]), min: 0 }; }
    // Malay: pukul 3 petang / jam 10.30 pagi / pkl 3 setengah
    m = t.match(/\b(?:pukul|pkul|pkl|jam)\s*(\d{1,2})(?:[:.](\d{2}))?(\s*setengah)?(?:\s*(pagi|tengah ?hari|tgh ?hari|petang|ptg|malam|mlm))?\b/);
    if (m && +m[1] <= 23) {
      notes.push(m[0]);
      h = +m[1]; min = m[2] ? +m[2] : (m[3] ? 30 : 0);
      return { h: m[4] ? periodShift(h, m[4]) : guessHour(h, t), min: min };
    }
    m = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|tengah ?hari|tgh ?hari|petang|ptg|malam|mlm)\b/);
    if (m && +m[1] <= 12) {
      notes.push(m[0]);
      return { h: periodShift(+m[1], m[3]), min: m[2] ? +m[2] : 0 };
    }
    // Chinese: 下午三点半 / 晚上8点15分 / 10點
    m = t.match(new RegExp('(上午|早上|早|中午|下午|晚上|晚|凌晨)?\\s*' + CN_N + '\\s*[点點时時](?:\\s*(半|' + CN_N + '\\s*分?))?'));
    if (m) {
      h = cnNum(m[2]);
      if (h >= 0 && h <= 23) {
        notes.push(m[0]);
        min = m[3] === '半' ? 30 : (m[4] ? cnNum(m[4]) : 0);
        return { h: m[1] ? periodShift(h, m[1]) : guessHour(h, t), min: min };
      }
    }
    // 24-hour or plain 15:00 / 3:00
    m = t.match(/(?:^|[^\d\/])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
    if (m) {
      notes.push(m[0].replace(/^[^\d]/, ''));
      h = +m[1];
      return { h: h >= 13 || m[1].length === 2 && m[1][0] === '0' ? h : guessHour(h, t), min: +m[2] };
    }
    // 1500hrs / 0930h
    m = t.match(/\b([01]\d|2[0-3])([0-5]\d)\s*(?:hrs?|h)\b/);
    if (m) { notes.push(m[0]); return { h: +m[1], min: +m[2] }; }
    m = t.match(/\b(noon|midday|tengah hari)\b|中午/);
    if (m) { notes.push(m[0]); return { h: 12, min: 0 }; }
    // "at 3", "3 o'clock"
    m = t.match(/\bat\s+(\d{1,2})(?![\d:.\/%])\b(?!\s*(?:people|pax|persons?|units?|pcs|%))|\b(\d{1,2})\s*o'?\s?clock\b/);
    if (m) {
      h = +(m[1] || m[2]);
      if (h >= 0 && h <= 23) { notes.push(m[0]); return { h: h > 12 ? h : guessHour(h, t), min: 0 }; }
    }
    return null;
  }

  // Sender names from copied headers ("[13/11, 4:02 pm] Ali: ...") and phone numbers anywhere.
  function findContacts(raw) {
    var names = [], phones = [];
    var hdr = /^\s*\[[^\]\n]{4,40}\]\s*([^:\n]{1,40}):/gm, h;
    while ((h = hdr.exec(raw))) {
      var n = h[1].trim();
      if (/^[+\d][\d\s\-()]{7,}$/.test(n)) { if (phones.indexOf(n) < 0) phones.push(n); }
      else if (names.indexOf(n) < 0) names.push(n);
    }
    var body = cleanWhatsApp(raw);
    var ph = /(?:\+?\d{1,3}[\s-]?)?\(?0?1\d\)?[\s-]?\d{3,4}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, q;
    while ((q = ph.exec(body))) { var v = q[0].trim(); if (phones.indexOf(v) < 0) phones.push(v); }
    return { names: names, phones: phones };
  }
  // Digits for a wa.me link; Malaysian 01x numbers get the 60 country code.
  function waNumber(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (/^0\d{8,10}$/.test(d)) d = '6' + d;
    return d.length >= 9 ? d : '';
  }

  function makeTitle(text) {
    var first = text.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0] || '';
    if (first.length > 80) first = first.slice(0, 77).replace(/\s+\S*$/, '') + '…';
    return first;
  }

  function parse(text, now) {
    now = now || new Date();
    var clean = cleanWhatsApp(text);
    var t = clean.toLowerCase();
    var notes = [];
    var date = findDate(t, now, notes);
    var time = findTime(t, notes);
    var found = { date: !!date, time: !!time };
    if (!date && time) {
      // Time only: today if still ahead, otherwise tomorrow.
      var later = time.h * 60 + time.min > now.getHours() * 60 + now.getMinutes();
      date = addDays(now, later ? 0 : 1);
    }
    if (!date) date = addDays(now, 1);
    var contacts = findContacts(text);
    return {
      contacts: contacts,
      title: makeTitle(clean),
      details: clean,
      date: date,
      time: time,
      allDay: !time,
      found: found,
      notes: notes
    };
  }

  var api = { parse: parse, cleanWhatsApp: cleanWhatsApp, waNumber: waNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskParser = api;
})(this);
