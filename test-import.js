// Import link tests: node test-import.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const win = { location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, atob: s => Buffer.from(s, 'base64').toString('binary'),
  TextDecoder, console, document: { getElementById() {} }, Uint8Array, JSON };
win.window = win;
vm.runInNewContext(fs.readFileSync(__dirname + '/import.js', 'utf8'), win);
const enc = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const data = { tasks: [{ ref: 'wa1', title: 'Buy milk 买牛奶', due: '2030-01-02', role: 'Family', client: null },
  { ref: 'wa2', title: 'Site visit', due: '2030-01-02 10:00', role: 'Supplier', client: { name: 'Test Person', phone: '60120000000', company: 'ALPHA SDN BHD' } }] };
const back = win.IMPORT.decode(enc(data));
assert.strictEqual(JSON.stringify(back), JSON.stringify(data), 'round trip keeps text, including Chinese');
const it = win.IMPORT.items(back.tasks);
assert.strictEqual(JSON.stringify(it[0].client), '{"none":true}', 'no client: saved as a task only');
assert.strictEqual(it[1].client.phone, '60120000000');
assert.strictEqual(it[1].task.ref, 'wa2', 'ref is kept so a second tap does not add duplicates');
assert.strictEqual(it[1].task.due, '2030-01-02 10:00');
console.log('import tests passed');
