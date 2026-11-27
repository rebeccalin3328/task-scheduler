// Reference chat parser tests: node test-ref.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const win = {}; win.window = win;
vm.runInNewContext(fs.readFileSync(__dirname + '/ref.js', 'utf8'), win);
const { parseChat, cleanUrl } = win.REFPARSE;

const android = `26/11/2026, 13:47 - Messages and calls are end-to-end encrypted.
26/11/2026, 13:48 - Ali Supplier: New price list https://example.com/prices.pdf.
26/11/2026, 13:49 - Siti: see (https://en.wikipedia.org/wiki/Chiller_(HVAC)) and
www.shopee.com.my/item/9?utm_source=wa
11/27/26, 9:05 PM - +60 12-345 6789: https://youtu.be/abc123?si=x 👍`;
let l = parseChat(android);
assert.deepEqual(l.map(x => x.url), ['https://example.com/prices.pdf', 'https://en.wikipedia.org/wiki/Chiller_(HVAC)',
  'https://www.shopee.com.my/item/9?utm_source=wa', 'https://youtu.be/abc123?si=x']);
assert.equal(l[0].sharedBy, 'Ali Supplier'); assert.equal(l[0].sharedAt, '26/11/2026 13:48');
assert.equal(l[2].sharedBy, 'Siti', 'a link on the next line belongs to the same message');
assert.equal(l[3].sharedBy, '+60 12-345 6789'); assert.equal(l[3].sharedAt, '11/27/26 9:05 PM');

const iphone = `[26/11/2026, 13:47:01] Ahmad Tech: 看看这个 https://news.example.com/a?id=5, ok?
‎[26/11/2026, 13:48:00] Ahmad Tech: ‎image omitted`;
l = parseChat(iphone);
assert.deepEqual(l.map(x => [x.url, x.sharedBy, x.sharedAt]), [['https://news.example.com/a?id=5', 'Ahmad Tech', '26/11/2026 13:47:01']]);

const copied = `[13:47, 26/11/2026] Rebecca: https://maps.app.goo.gl/xyz
[13:50, 26/11/2026] Rebecca: same again https://maps.app.goo.gl/xyz`;
l = parseChat(copied);
assert.equal(l.length, 1, 'same link listed once'); assert.equal(l[0].sharedAt, '26/11/2026 13:47');

assert.deepEqual(parseChat('just text, no links. Call me at 3.30pm').length, 0);
assert.equal(parseChat('https://localhost').length, 0, 'not a real website');
assert.equal(cleanUrl('<https://a.com/x>,'), 'https://a.com/x');

// Excel export: sorted by category order, then newest first
const { dateNum, exportRows, HEAD } = win.REFPARSE;
assert.ok(dateNum('26/11/2026 13:48') > dateNum('25/11/2026 23:59'));
assert.equal(dateNum('11/26/26 9:05 PM'), dateNum('26/11/2026 21:05'), 'US 12-hour export dates');
assert.equal(dateNum('2026-11-20 09:15'), dateNum('20/11/2026 09:15'));
assert.equal(dateNum(''), 0);
const rows = exportRows([
  { category: 'Video', title: 'Old video', at: '01/11/2026 10:00', url: 'https://v/1', status: 'Done' },
  { category: '', title: 'Waiting', at: '', url: 'https://w/1', status: 'Pending' },
  { category: 'Video', title: 'New video', at: '2026-11-20 09:15', url: 'https://v/2', status: 'Done' },
  { category: 'News', title: 'Story 新闻', at: '05/11/2026 08:00', url: 'https://n/1', status: 'Failed', error: '403' }], ['Video', 'News', 'Other']);
assert.deepEqual(rows.map(r => r[1]), ['New video', 'Old video', 'Story 新闻', 'Waiting']);
assert.equal(rows[2][2], 'Could not open: 403'); assert.equal(rows[2][8], 'Failed'); assert.equal(rows[3][0], 'Not sorted yet');
assert.deepEqual(rows[0][3], { link: 'https://v/2' });
assert.equal(HEAD.length, rows[0].length);

// The .xlsx file itself (checked with openpyxl when Python has it)
const xctx = { TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, String, Math };
vm.runInNewContext(fs.readFileSync(__dirname + '/xlsx.js', 'utf8'), xctx);
const bytes = xctx.XLSX.build('Reference', HEAD, rows.concat([['Other', 'Odd <&> "chars"\u0001', 'x', { link: 'https://e.com/?a=1&b=2' }, '', '', '', '', '']]), [20, 40]);
const out = require('os').tmpdir() + '/ref-test.xlsx';
fs.writeFileSync(out, bytes);
const py = require('child_process').spawnSync('python3', ['-c', `
import sys
try:
    import openpyxl
except ImportError:
    print('skip'); sys.exit(0)
ws = openpyxl.load_workbook(sys.argv[1]).active
assert ws.title == 'Reference'
assert [c.value for c in ws[1]][:4] == ['Category', 'Title', 'Summary', 'Link']
assert ws['B2'].value == 'New video' and ws['B4'].value == 'Story 新闻'
assert ws['D2'].hyperlink.target == 'https://v/2'
assert ws['B6'].value == 'Odd <&> "chars"' and ws['D6'].hyperlink.target == 'https://e.com/?a=1&b=2'
assert ws.freeze_panes == 'A2' and ws.auto_filter.ref == 'A1:I6' and ws['A1'].font.b
print('ok')`, out], { encoding: 'utf8' });
assert.ok(/^(ok|skip)/.test(py.stdout), py.stdout + py.stderr);
console.log('reference parser and export tests passed (xlsx ' + py.stdout.trim() + ')');
