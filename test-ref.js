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
console.log('reference parser tests passed');
