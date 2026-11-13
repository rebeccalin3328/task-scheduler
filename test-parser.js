const P = require('./parser.js');
const now = new Date(2026, 10, 12, 18, 23); // Thu 12 Nov 2026 6:23pm
const cases = [
 ["Meeting with client tmr 3pm", "2026-11-13 15:00"],
 ["Pls submit report by Friday 5.30pm", "2026-11-13 17:30"],
 ["Site visit next mon 10am", "2026-11-16 10:00"],
 ["Call supplier at 3", "2026-11-13 15:00"],
 ["Delivery on 20/11 at 9:30am", "2026-11-20 09:30"],
 ["Team lunch 25 Nov 12.30pm", "2026-11-25 12:30"],
 ["Dec 3rd quarterly review 2pm", "2026-12-03 14:00"],
 ["Mesyuarat esok pukul 3 petang", "2026-11-13 15:00"],
 ["Hantar dokumen hari Jumaat jam 10 pagi", "2026-11-13 10:00"],
 ["Lusa kita jumpa pkl 8 malam", "2026-11-14 20:00"],
 ["Isnin depan bayar invois", "2026-11-16 allday"],
 ["Bayar sewa 1 Dis", "2026-12-01 allday"],
 ["明天下午三点开会", "2026-11-13 15:00"],
 ["下周三上午10点半见客户", "2026-11-18 10:30"],
 ["11月20日晚上8点聚餐", "2026-11-20 20:00"],
 ["后天交报告", "2026-11-14 allday"],
 ["15号交货", "2026-11-15 allday"],
 ["[12/11/2026, 3:45 pm] Ali: Remind me to pay vendor tomorrow 11am", "2026-11-13 11:00"],
 ["Buy printer ink", "2026-11-13 allday"],
 ["Meeting 3-5pm tomorrow", "2026-11-13 15:00"],["Briefing 11-1pm tmr","2026-11-13 11:00"],
 ["Pick up stock 1500hrs today", "2026-11-12 15:00"],
 ["Dinner tonight 8", "2026-11-12 20:00"],
 ["Order 30 units at 3 tomorrow", "2026-11-13 15:00"],
 ["Call Ahmad 012-3456789 tomorrow", "2026-11-13 allday"],
];
let pass=0;
for (const [txt, exp] of cases) {
  const r = P.parse(txt, now);
  const d = `${r.date.y}-${String(r.date.m).padStart(2,'0')}-${String(r.date.d).padStart(2,'0')}`;
  const got = d + ' ' + (r.time ? `${String(r.time.h).padStart(2,'0')}:${String(r.time.min).padStart(2,'0')}` : 'allday');
  const ok = got === exp; if (ok) pass++;
  console.log(ok?'PASS':'FAIL', JSON.stringify(txt), '=>', got, ok?'':'(expected '+exp+')', '| title:', r.title);
}
console.log(pass+'/'+cases.length);
