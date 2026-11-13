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

  // ---------- Email handling ----------
  var HEADER = /^\s*(from|sent|date|to|cc|bcc|subject|reply-to|dari|daripada|kepada|tarikh|dihantar|subjek|perkara|发件人|發件人|寄件者|收件人|收件者|抄送|日期|发送时间|發送時間|时间|時間|主题|主旨|主題)\s*[:：]\s*(.*)$/i;
  var FROM_KEYS = /^(from|dari|daripada|发件人|發件人|寄件者)$/i;
  var SUBJECT_KEYS = /^(subject|subjek|perkara|主题|主旨|主題)$/i;
  var CUT_MARK = /^\s*(?:on\s.{4,120}wrote\s*:|pada\s.{4,120}menulis\s*:|在.{2,80}写道[:：]?|-{2,}\s*original message\s*-{2,}|-{2,}\s*mesej asal\s*-{2,}|_{8,})\s*$/i;
  var DROP_LINE = /^\s*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:?|sent from my .{1,30}|dihantar dari .{1,30}|get outlook for .{1,20}|发自我的.{1,20})\s*$/i;
  var SIGNOFF = /^\s*(?:best\s+regards|kind\s+regards|warm\s+regards|warmest\s+regards|regards|rgds|br|thanks(?:\s*(?:&|and)\s*(?:best\s+)?regards)?|thank\s+you|thanks\s+a\s+lot|many\s+thanks|sincerely|yours\s+(?:sincerely|faithfully|truly)|cheers|best|terima\s+kasih|tq|tqvm|sekian|sekian,?\s*terima\s+kasih|yang\s+benar|salam\s+hormat|谢谢|謝謝|此致敬礼|此致|敬礼|祝好|顺祝商祺|順祝商祺)\s*[,，.!。]*\s*$/i;
  var GREETING = /^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|hai|helo|salam|assalamualaikum|selamat\s+\w+|tuan\/puan|您好|你好|大家好|各位)\b.{0,40}$/i;

  // Split pasted text into subject, sender, main body and signature.
  function parseEmail(text) {
    var lines = text.split(/\r?\n/);
    var headers = {}, out = [], isEmail = false, i;
    for (i = 0; i < lines.length; i++) {
      var h = lines[i].match(HEADER);
      if (h && (FROM_KEYS.test(h[1]) || SUBJECT_KEYS.test(h[1]))) { isEmail = true; break; }
    }
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (DROP_LINE.test(line)) continue;
      if (CUT_MARK.test(line) && out.join('').trim()) break;
      if (/^\s*>/.test(line)) continue;
      var m = isEmail && line.match(HEADER);
      if (m) {
        var key = FROM_KEYS.test(m[1]) ? 'from' : SUBJECT_KEYS.test(m[1]) ? 'subject' : m[1].toLowerCase();
        if (!headers[key]) headers[key] = m[2].trim();
        continue;
      }
      out.push(line);
    }
    var body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    var bl = body.split('\n'), sigAt = -1;
    for (i = 0; i < bl.length; i++) {
      if (/^\s*--\s*$/.test(bl[i]) || SIGNOFF.test(bl[i])) { sigAt = i; break; }
    }
    var subject = (headers.subject || '').replace(/^\s*((re|fw|fwd|balas|回复|回覆|转发|轉寄)\s*[:：]\s*)+/i, '').trim();
    return {
      isEmail: isEmail,
      subject: subject,
      from: headers.from || '',
      body: body,
      main: sigAt >= 0 ? bl.slice(0, sigAt).join('\n') : body,
      signature: sigAt >= 0 ? bl.slice(sigAt + 1, sigAt + 10).join('\n') : ''
    };
  }

  // ---------- Contacts ----------
  var PHONE_LABEL = /(?:\b(?:tel|telephone|phone|ph|mobile|mob|hp|h\/p|cell|handphone|contact(?:\s*no)?|telefon|whatsapp|wa|fax)\b|no\.?\s*(?:tel|hp|telefon|phone)|电话|電話|手机|手機|联系电话|聯絡電話)\s*(?:no\.?)?\s*[:：.]?\s*(\+?[\d\s().-]{8,22}\d)/gi;
  var PHONE_ANY = /(?:\+\s?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}(?!\d)/g;
  var EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  var HONORIFIC = /\b((?:Mr|Mrs|Ms|Miss|Mdm|Madam|Dr|Encik|En|Puan|Pn|Cik|Tuan|Datuk|Dato'?|Datin|Tan Sri|Ir|Prof|Haji|Hajah|Ustaz)\.?\s+[A-Z][\w'@-]*(?:\s+(?:bin|binti|bt|bin|a\/l|a\/p|[A-Z][\w'-]*)){0,3})/;
  var CN_NAME = /(?:联系|聯繫|联络|聯絡|打给|打給|找|给|給|问|問|和|跟|与|與|请|請|通知)?([一-鿿]{1,2}(?:先生|小姐|女士|太太|经理|經理|总|總|老板|老闆|医生|醫生|老师|老師))/;
  var ACTION_NAME = /\b(?:call|contact|ask|whatsapp|wa|ping|text|email|hubungi|telefon|tanya|jumpa|meet)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
  var NAME_LABEL = /^\s*(?:name|nama|contact\s*person|contact|pic|person\s+in\s+charge|attn|attention|u\.p\.?|联系人|聯絡人|姓名)\s*[:：]\s*(.{2,60})$/im;

  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  // Digits for a wa.me link; Malaysian local numbers get the 60 country code.
  function waNumber(phone) {
    var d = digits(phone);
    if (/^0\d{8,10}$/.test(d)) d = '6' + d;
    else if (/^1\d{8,9}$/.test(d)) d = '60' + d;
    return d.length >= 10 && d.length <= 15 ? d : '';
  }
  function plausiblePhone(raw) {
    var d = digits(raw);
    if (d.length < 9 || d.length > 14) return false;
    if (/^\+/.test(raw.trim())) return true;
    return /^(?:0[1-9]|60|65|86|852|1[0-9])/.test(d);
  }
  function looksLikeName(s) {
    s = s.trim();
    return s.length >= 2 && s.length <= 40 && !/\d|@|https?:|www\./i.test(s) && !SIGNOFF.test(s) && !GREETING.test(s) &&
      (/[一-鿿]/.test(s) || /^[A-Za-z][A-Za-z.'@\/ -]+$/.test(s));
  }
  function addUnique(list, v, keyFn) {
    v = (v || '').trim(); if (!v) return;
    var k = keyFn ? keyFn(v) : v.toLowerCase();
    for (var i = 0; i < list.length; i++) if ((keyFn ? keyFn(list[i]) : list[i].toLowerCase()) === k) return;
    list.push(v);
  }
  function phoneKey(p) { return waNumber(p) || digits(p); }

  function findContacts(raw, email) {
    var names = [], phones = [], emails = [], m;
    // 1. WhatsApp copy headers
    var hdr = /^\s*\[[^\]\n]{4,40}\]\s*([^:\n]{1,40}):/gm;
    while ((m = hdr.exec(raw))) {
      var who = m[1].trim();
      if (/^[+\d][\d\s\-()]{7,}$/.test(who)) addUnique(phones, who, phoneKey); else addUnique(names, who);
    }
    // 2. Email sender: "Name <a@b.com>" / "a@b.com"
    if (email.from) {
      var em = email.from.match(EMAIL_RE);
      var nm = email.from.replace(/<[^>]*>|\[[^\]]*\]|\([^)]*@[^)]*\)/g, '').replace(EMAIL_RE, '').replace(/["']/g, '').trim();
      if (nm && looksLikeName(nm)) addUnique(names, nm);
      if (em) addUnique(emails, em[0]);
    }
    var body = email.body;
    // 3. Labelled names ("Contact person: Ali", "联系人：陈先生")
    m = body.match(NAME_LABEL);
    if (m) addUnique(names, m[1].replace(/[\s,;]+(?:tel|hp|phone|电话|手机).*$/i, '').replace(/\s*[\(\[].*$/, ''));
    // 4. Signature: first name-like line after the sign-off
    if (email.signature) {
      var sl = email.signature.split('\n');
      for (var i = 0; i < Math.min(sl.length, 3); i++) {
        if (!sl[i].trim()) continue;
        if (looksLikeName(sl[i])) { addUnique(names, sl[i].trim()); }
        break;
      }
    }
    // 5. Honorifics and "call Ahmad" style mentions
    var mainText = (email.subject + '\n' + body);
    m = mainText.match(HONORIFIC); if (m) addUnique(names, m[1]);
    m = mainText.match(CN_NAME); if (m) addUnique(names, m[1]);
    m = mainText.match(ACTION_NAME); if (m && !/^(Me|Us|Them|Him|Her|You|The|Back|Again)$/.test(m[1])) addUnique(names, m[1]);
    // Phones: labelled first, then any plausible number
    PHONE_LABEL.lastIndex = 0;
    while ((m = PHONE_LABEL.exec(body))) {
      var lbl = m[0].slice(0, m[0].indexOf(m[1])).toLowerCase();
      if (/fax/.test(lbl)) continue;
      if (plausiblePhone(m[1])) addUnique(phones, m[1].trim(), phoneKey);
    }
    var faxFree = body.replace(/\bfax\b[^\n]*/gi, '');
    PHONE_ANY.lastIndex = 0;
    while ((m = PHONE_ANY.exec(faxFree))) {
      if (plausiblePhone(m[0])) addUnique(phones, m[0].trim(), phoneKey);
    }
    // Emails
    var ems = body.match(EMAIL_RE) || [];
    ems.forEach(function (e) { addUnique(emails, e); });
    return { names: names, phones: phones, emails: emails };
  }

  function makeTitle(email) {
    if (email.subject) return email.subject.length > 80 ? email.subject.slice(0, 77) + '…' : email.subject;
    var lines = email.main.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var first = '';
    for (var i = 0; i < lines.length; i++) {
      if (GREETING.test(lines[i]) && lines.length > 1) continue;
      first = lines[i]; break;
    }
    if (first.length > 80) first = first.slice(0, 77).replace(/\s+\S*$/, '') + '…';
    return first;
  }

  function parse(text, now) {
    now = now || new Date();
    var clean = cleanWhatsApp(text);
    var email = parseEmail(clean);
    var contacts = findContacts(String(text || ''), email);
    // Look for the date only in the subject and main message, never in headers, signatures, numbers or links.
    var t = (email.subject + '\n' + email.main)
      .replace(EMAIL_RE, ' ')
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(PHONE_ANY, function (p) { return plausiblePhone(p) ? ' ' : p; })
      .toLowerCase();
    var notes = [];
    var date = findDate(t, now, notes);
    var time = findTime(t, notes);
    var found = { date: !!date, time: !!time };
    if (!date && time) {
      var later = time.h * 60 + time.min > now.getHours() * 60 + now.getMinutes();
      date = addDays(now, later ? 0 : 1);
    }
    if (!date) date = addDays(now, 1);
    return {
      contacts: contacts,
      isEmail: email.isEmail,
      title: makeTitle(email),
      details: email.body,
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
