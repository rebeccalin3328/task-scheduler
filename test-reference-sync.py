# PC helper tests: python3 test-reference-sync.py
# Runs reference-sync.py against a fake WhatsApp MCP (stdio) and a fake message store. No network, no WhatsApp.
import importlib.util, json, os, sqlite3, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rs', os.path.join(HERE, 'reference-sync.py'))
rs = importlib.util.module_from_spec(spec); spec.loader.exec_module(rs)
tmp = tempfile.mkdtemp()

FAKE = r'''
import json, sys
calls = open(sys.argv[1], 'a')
TOOLS = [{'name': n, 'inputSchema': {'type': 'object', 'properties': p}} for n, p in [
  ('list_chats', {'limit': {'type': 'integer'}, 'account': {'type': 'string'}}),
  ('list_messages', {'chat': {'type': 'string'}, 'limit': {'type': 'integer'}}),
  ('send_message', {'to': {'type': 'string'}, 'text': {'type': 'string'}})]]
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    r = {}
    if m['method'] == 'initialize': r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fake'}}
    elif m['method'] == 'tools/list': r = {'tools': TOOLS}
    elif m['method'] == 'tools/call':
        name, a = m['params']['name'], m['params']['arguments']
        calls.write(name + ' ' + json.dumps(a) + '\n'); calls.flush()
        print(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/message', 'params': {'data': 'new message'}}), flush=True)
        if name == 'list_chats':
            data = {'chats': [{'jid': '60123@s.whatsapp.net', 'name': 'Ali Supplier'}, {'jid': '1203@g.us', 'name': 'Sales team', 'is_group': True}]}
        else:
            data = {'messages': [
              {'id': 'm1', 'sender_name': 'Ali', 'timestamp': 1795680000, 'text': 'Price list: https://example.com/p.pdf.', 'link_preview': {'url': 'https://example.com/p.pdf'}},
              {'id': 'm2', 'sender_name': 'Siti', 'timestamp': '2026-11-20T09:15:00', 'text': 'photo', 'media_url': 'https://mmg.whatsapp.net/abc'},
              {'id': 'm3', 'from_me': True, 'timestamp': 1795690000, 'text': 'See www.example.org/guide), thanks'}]}
        r = {'content': [{'type': 'text', 'text': json.dumps(data)}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
'''
fake = os.path.join(tmp, 'fake_mcp.py'); open(fake, 'w').write(FAKE)
log = os.path.join(tmp, 'calls.log')
cfg = {'mcp_command': [sys.executable, fake, log], 'account': 'work'}

m = rs.Mcp(cfg['mcp_command'])
assert set(m.tools) == {'list_chats', 'list_messages', 'send_message'}
chats = rs.mcp_chats(m, cfg)
assert chats == [{'id': '60123@s.whatsapp.net', 'name': 'Ali Supplier', 'kind': 'Contact'}, {'id': '1203@g.us', 'name': 'Sales team', 'kind': 'Group'}], chats
links = rs.mcp_links(m, cfg, '1203@g.us')
assert [l['url'] for l in links] == ['https://example.com/p.pdf', 'https://www.example.org/guide'], links
assert links[0]['sharedBy'] == 'Ali' and links[1]['sharedBy'] == 'You'
assert links[0]['message'].startswith('Price list')
try:
    m.tool('send_message', {'to': '1203@g.us', 'text': 'hi'}); raise SystemExit('FAIL: send was allowed')
except PermissionError:
    pass
m.close()
calls = open(log).read()
assert 'send_message' not in calls, 'nothing but reading tools ever reached the MCP'
assert 'list_messages {"chat": "1203@g.us", "limit": 5000}' in calls, calls
assert 'list_chats {"limit": 1000, "account": "work"}' in calls, calls

# One round: answer the chat the app asked for, send its links, then summarise them
sent = []
def fake_crm(cfg, body):
    sent.append(body)
    if body['action'] == 'refPending': return {'ok': True, 'chats': [{'id': '1203@g.us', 'name': 'Sales team'}]}
    if body['action'] == 'refPush': return {'ok': True, 'added': len(body['links'])}
    if body['action'] == 'refProcess': return {'ok': True, 'done': 2, 'left': 0 if len(sent) > 3 else 1}
    if body['action'] == 'refPushChats': return {'ok': True, 'count': len(body['chats'])}
rs.crm = fake_crm
class R:
    def links(self, cid): return [{'url': 'https://example.com/p.pdf'}] if cid == '1203@g.us' else []
assert rs.answer_requests(cfg, R()) == 1
assert [b['action'] for b in sent] == ['refPending', 'refPush', 'refProcess', 'refProcess'], sent
assert sent[1]['source'] == 'pc' and sent[1]['chat']['id'] == '1203@g.us'

# Fallback: the message store, opened read only
db = os.path.join(tmp, 'store.db')
c = sqlite3.connect(db)
c.executescript('''create table chats (jid text, name text); create table messages (id text, chat_jid text, sender_name text, timestamp int, text text);
insert into chats values ('1203@g.us', 'Sales team'), ('60123@s.whatsapp.net', null);
insert into messages values ('a', '1203@g.us', 'Ali', 1795680000, 'Read https://news.example.com/x?utm_source=wa'), ('b', '60123@s.whatsapp.net', 'Bo', 1, 'https://other.example.com');''')
c.commit(); c.close()
st = rs.Store(db)
assert st.chat_list() == [{'id': '1203@g.us', 'name': 'Sales team', 'kind': 'Group'}, {'id': '60123@s.whatsapp.net', 'name': '60123', 'kind': 'Contact'}]
assert [l['url'] for l in st.links('1203@g.us')] == ['https://news.example.com/x?utm_source=wa']
try:
    st.db.execute("insert into chats values ('x','y')"); raise SystemExit('FAIL: store was writable')
except sqlite3.OperationalError:
    pass

# Plain-text answers still work
assert rs.chats_from('Sales team (1203@g.us)\nAli - 60123@s.whatsapp.net')[0] == {'id': '1203@g.us', 'name': 'Sales team', 'kind': 'Group'}
assert [l['url'] for l in rs.links_from('[09:00] Ali: https://a.example.com/x, and https://chat.whatsapp.com/INVITE')] == ['https://a.example.com/x']
# A full round (--once): WhatsApp is opened only because there's work, and let go afterwards
sent.clear()
rs.load_config = lambda: dict(cfg, crm_url='https://x/exec', admin_key='a')
rs.HERE = tmp  # lock file goes here
opened = []
_Reader = rs.Reader
class CountingReader(_Reader):
    def __init__(self, c): opened.append(1); _Reader.__init__(self, c)
    def close(self): opened.append(-1); _Reader.close(self)
rs.Reader = CountingReader
sys.argv = ['reference-sync.py', '--once']
rs.main()
assert opened == [1, -1], opened
acts = [b['action'] for b in sent]
assert acts[:2] == ['refPending', 'refPush'] and 'refPushChats' in acts, acts
# Nothing asked and chat list not due: WhatsApp isn't opened at all
opened.clear(); sent.clear()
rs.CHATS_EVERY = 10 ** 12
def quiet(cfg, body):
    sent.append(body); return {'ok': True, 'chats': []}
rs.crm = quiet
rs.main()
assert opened == [], opened
print('reference-sync tests passed')
