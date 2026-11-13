// Contact and email tests: node test-contacts.js
const P = require('./parser.js');
const now = new Date(2026, 10, 13, 21, 0); // Fri 13 Nov 2026 9pm
const pad = n => String(n).padStart(2, '0');
const cases = [
  { name: 'WhatsApp saved contact', text: '[13/11, 4:02 pm] Ali Hassan: Hantar sebut harga esok 10 pagi\n[13/11, 4:03 pm] Ali Hassan: ok?',
    expect: { name: 'Ali Hassan', when: '2026-11-14 10:00' } },
  { name: 'WhatsApp unsaved number', text: '[13/11, 4:02 pm] +60 12-345 6789: Call me tmr 3pm',
    expect: { phone: '60123456789', when: '2026-11-14 15:00' } },
  { name: 'Number in message', text: 'Pls call Ahmad 012-3456789 tomorrow 11am',
    expect: { name: 'Ahmad', phone: '60123456789', when: '2026-11-14 11:00' } },
  { name: 'Labelled HP + Encik', text: 'Delivery to Encik Rahman on 20/11 9am. HP: 019 876 5432',
    expect: { name: 'Encik Rahman', phone: '60198765432', when: '2026-11-20 09:00' } },
  { name: 'Chinese name + phone', text: '明天下午三点联系陈先生，电话 016-222 3333',
    expect: { name: '陈先生', phone: '60162223333', when: '2026-11-14 15:00' } },
  { name: 'Contact person label', text: 'Site visit next mon 10am\nContact person: Siti Aminah\nTel: 03-7890 1234',
    expect: { name: 'Siti Aminah', phone: '60378901234', when: '2026-11-16 10:00' } },
  { name: 'Outlook email', text: [
      'From: Lim Wei Jie <weijie.lim@abc.com.my>',
      'Sent: Friday, 13 November 2026 3:45 PM',
      'To: Rebecca',
      'Subject: RE: Quotation follow-up meeting',
      '',
      'Hi Rebecca,',
      '',
      'Can we meet on 18 Nov at 2.30pm at our office to go through the quotation?',
      '',
      'Best regards,',
      'Lim Wei Jie',
      'Sales Manager, ABC Sdn Bhd',
      'Mobile: +60 17-555 1234 | Fax: 03-1111 2222',
      '',
      '-----Original Message-----',
      'From: Rebecca',
      'Sent: Thursday, 12 November 2026 9:00 AM',
      'Subject: Quotation',
      'Please send the quote by Monday.'
    ].join('\n'),
    expect: { title: 'Quotation follow-up meeting', name: 'Lim Wei Jie', phone: '60175551234', email: 'weijie.lim@abc.com.my', when: '2026-11-18 14:30' } },
  { name: 'Gmail reply with quote', text: [
      'Noted, I will send the documents by Wednesday 5pm.',
      '',
      'Thanks,',
      'Aisyah',
      '',
      'On Fri, 13 Nov 2026 at 10:15, Rebecca <rebecca@example.com> wrote:',
      '> Hi Aisyah, please send the documents on Monday 9am.'
    ].join('\n'),
    expect: { name: 'Aisyah', when: '2026-11-18 17:00', title: 'Noted, I will send the documents by Wednesday 5pm.' } },
  { name: 'Malay email', text: [
      'Daripada: Puan Noraini <noraini@syarikat.my>',
      'Tarikh: 13 November 2026',
      'Subjek: Mesyuarat bulanan',
      '',
      'Salam Puan Rebecca,',
      'Mesyuarat bulanan akan diadakan pada Isnin depan pukul 10 pagi.',
      'Terima kasih.',
      'Noraini',
      'No. Tel: 012-998 7766'
    ].join('\n'),
    expect: { title: 'Mesyuarat bulanan', name: 'Puan Noraini', phone: '60129987766', when: '2026-11-16 10:00' } },
  { name: 'Chinese email', text: [
      '发件人: 王小红 <xh.wang@abc.cn>',
      '主题: 回复: 下周三开会',
      '',
      '您好，',
      '下周三上午10点在公司开会。',
      '谢谢',
      '王小红',
      '手机: +86 138 1234 5678'
    ].join('\n'),
    expect: { title: '下周三开会', name: '王小红', phone: '8613812345678', when: '2026-11-18 10:00' } },
  { name: 'Forwarded email', text: [
      '---------- Forwarded message ---------',
      'From: Tan Ah Kow <ahkow@supplier.my>',
      'Date: Thu, 12 Nov 2026 at 16:20',
      'Subject: Stock arrival',
      'To: Rebecca',
      '',
      'Stock will arrive on 25/11 at 11am. Please arrange 2 people to receive.',
      '',
      'Regards,',
      'Ah Kow',
      'H/P 012 345 6789'
    ].join('\n'),
    expect: { title: 'Stock arrival', name: 'Tan Ah Kow', phone: '60123456789', email: 'ahkow@supplier.my', when: '2026-11-25 11:00' } },
  { name: 'Invoice number not a phone', text: 'Pay invoice INV-2026-1113 by 30 Nov', expect: { phone: '', when: '2026-11-30 allday' } },
  { name: 'Event with Date: label (not email)', text: 'Company dinner\nDate: 28/11\nTime: 7.30pm\nVenue: Hilton KL', expect: { when: '2026-11-28 19:30', title: 'Company dinner' } },
];
let pass = 0;
for (const c of cases) {
  const r = P.parse(c.text, now);
  const got = {
    title: r.title, name: r.contacts.names[0] || '', phone: P.waNumber(r.contacts.phones[0] || ''),
    email: r.contacts.emails[0] || '',
    when: `${r.date.y}-${pad(r.date.m)}-${pad(r.date.d)} ` + (r.time ? `${pad(r.time.h)}:${pad(r.time.min)}` : 'allday')
  };
  const bad = Object.keys(c.expect).filter(k => got[k] !== c.expect[k]);
  if (!bad.length) pass++;
  console.log(bad.length ? 'FAIL' : 'PASS', c.name, bad.length ? JSON.stringify(bad.map(k => [k, got[k], c.expect[k]])) : '', '| names:', r.contacts.names.join(' / '), '| phones:', r.contacts.phones.join(' / '));
}
console.log(pass + '/' + cases.length);
