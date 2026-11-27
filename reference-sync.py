#!/usr/bin/env python3
"""
Reference sync: sends links from the WhatsApp chats you pick in the app's Reference tab to your private Reference sheet.

Runs on your PC (in WSL, next to the WhatsApp MCP). READ ONLY: it starts the MCP with --read-only, calls only the
reading tools listed in READ_TOOLS, and refuses anything else. It never sends a WhatsApp message.

How it works, every minute:
  1. Asks the CRM web app which chats you tapped "Get links" for.
  2. Reads those chats' messages through the WhatsApp MCP (or, if the MCP is busy, straight from its message store,
     opened read only), and picks out the links.
  3. Sends the links to the CRM web app, which opens each page, summarises it and picks a category.
Every 30 minutes it also sends the list of chat names, so you can pick them in the app.

Setup: see REFERENCE-SETUP.md. Python 3.8+, no extra packages.
  python3 reference-sync.py            keep running (checks every minute)
  python3 reference-sync.py --once     check once and stop
  python3 reference-sync.py --chats    send the chat list now and stop
  python3 reference-sync.py --dump "Sales team"   show what the MCP returns for one chat (for fixing problems)
  python3 reference-sync.py --install  keep it running in the background: starts hidden whenever you log in to
                                       Windows, and restarts if it stops. Log: reference-sync.log next to this file.
  python3 reference-sync.py --uninstall   stop that
  python3 reference-sync.py --status   is it running? shows the last lines of the log
"""
import fcntl
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'reference-sync.json')
LOG = os.path.join(HERE, 'reference-sync.log')
TASK = 'Task Scheduler Reference sync'  # the Windows scheduled task made by --install
# The only MCP tools this script may call. All of them only read.
READ_TOOLS = {'list_accounts', 'session_status', 'list_chats', 'get_chat', 'list_messages', 'search_contacts'}
CHECK_EVERY = 60          # seconds between checks for chats you asked for
CHATS_EVERY = 30 * 60     # seconds between sending the chat list
MAX_MESSAGES = 5000       # newest messages read per chat
URL_RE = re.compile(r'\b(?:https?://|www\.)[^\s<>"\'`]+', re.I)
SKIP_HOSTS = re.compile(r'^https?://(?:[^/]*\.)?(?:whatsapp\.net|whatsapp\.com|wa\.me)(?:[/?#]|$)', re.I)  # WhatsApp's own media and chat links


def log(*a):
    print(datetime.now().strftime('%H:%M:%S'), *a, flush=True)


def load_config():
    if not os.path.exists(CONFIG):
        sample = {'crm_url': 'https://script.google.com/macros/s/.../exec', 'team_key': '', 'admin_key': '', 'me': 'admin@airnergy.my',
                  'mcp_command': ['wa-mcp', 'serve', '--read-only'], 'account': '', 'store_db': ''}
        with open(CONFIG, 'w') as f:
            json.dump(sample, f, indent=2)
        os.chmod(CONFIG, 0o600)
        sys.exit('Made ' + CONFIG + '. Fill in crm_url, team_key and admin_key, then run this again.')
    with open(CONFIG) as f:
        c = json.load(f)
    if not c.get('crm_url', '').endswith('/exec') or not c.get('admin_key'):
        sys.exit('Fill in crm_url (ends in /exec), team_key and admin_key in ' + CONFIG)
    cmd = c.get('mcp_command') or ['wa-mcp', 'serve', '--read-only']
    if '--read-only' not in cmd:
        cmd = cmd + ['--read-only']  # always: write tools are hidden from this script
    local = os.path.expanduser('~/.local/bin/' + cmd[0])
    if os.sep not in cmd[0] and os.path.exists(local):
        cmd = [local] + cmd[1:]  # Windows Task Scheduler starts WSL without ~/.local/bin on PATH
    c['mcp_command'] = cmd
    return c


# ---------- CRM web app ----------
def crm(cfg, body):
    body = dict(body, key=cfg.get('team_key', ''), me=cfg.get('me', ''), adminKey=cfg['admin_key'])
    req = urllib.request.Request(cfg['crm_url'], data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'text/plain;charset=utf-8'})
    # Google answers a POST with a redirect to the result, which urllib follows as a GET.
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode('utf-8', 'replace')
    try:
        j = json.loads(text)
    except ValueError:
        raise RuntimeError('The CRM web app sent a page instead of data. Check crm_url, and that it is deployed for "Anyone".')
    if not j.get('ok'):
        raise RuntimeError(j.get('error') or 'CRM refused')
    return j


# ---------- WhatsApp MCP (stdio, JSON-RPC), read only ----------
class Mcp:
    def __init__(self, cmd):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)
        self.n = 0
        self.err = []
        threading.Thread(target=self._drain, daemon=True).start()
        self.call('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'reference-sync', 'version': '1.0'}})
        self._send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        self.tools = {}
        cursor = None
        while True:
            r = self.call('tools/list', {'cursor': cursor} if cursor else {})
            for t in r.get('tools', []):
                self.tools[t['name']] = t
            cursor = r.get('nextCursor')
            if not cursor:
                break

    def _drain(self):
        for line in self.p.stderr:
            self.err = (self.err + [line.rstrip()])[-20:]

    def _send(self, msg):
        self.p.stdin.write(json.dumps(msg) + '\n')
        self.p.stdin.flush()

    def call(self, method, params, timeout=120):
        self.n += 1
        my = self.n
        self._send({'jsonrpc': '2.0', 'id': my, 'method': method, 'params': params})
        end = time.time() + timeout
        while time.time() < end:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError('WhatsApp MCP stopped: ' + ' | '.join(self.err[-5:]))
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get('id') == my and 'method' not in m:
                if 'error' in m:
                    raise RuntimeError('MCP error: ' + json.dumps(m['error'])[:300])
                return m.get('result') or {}
            if 'method' in m and 'id' in m:  # the server asks us something: say we can't
                self._send({'jsonrpc': '2.0', 'id': m['id'], 'error': {'code': -32601, 'message': 'Not supported'}})
            # anything else is a live notification: ignored
        raise RuntimeError('WhatsApp MCP did not answer ' + method)

    def tool(self, name, args):
        if name not in READ_TOOLS:
            raise PermissionError('reference-sync only reads: refused to call ' + name)
        if name not in self.tools:
            raise RuntimeError('The WhatsApp MCP has no tool called ' + name)
        r = self.call('tools/call', {'name': name, 'arguments': args})
        if r.get('isError'):
            raise RuntimeError(name + ': ' + text_of(r)[:300])
        return r

    def param(self, tool, *words):
        """The tool's parameter whose name contains one of these words (the MCP's names aren't documented)."""
        props = ((self.tools.get(tool) or {}).get('inputSchema') or {}).get('properties') or {}
        for w in words:
            for p in props:
                if p.lower() == w:
                    return p
        for w in words:
            for p in props:
                if w in p.lower():
                    return p
        return None

    def close(self):
        try:
            self.p.stdin.close()
            self.p.terminate()
            self.p.wait(5)
        except Exception:
            pass


def text_of(result):
    return '\n'.join(c.get('text', '') for c in result.get('content', []) if c.get('type') == 'text')


def payload(result):
    """The tool's answer as data: structured content, else the text parsed as JSON, else the plain text."""
    if result.get('structuredContent') is not None:
        return result['structuredContent']
    parts = []
    for c in result.get('content', []):
        if c.get('type') == 'text':
            try:
                parts.append(json.loads(c['text']))
            except ValueError:
                parts.append(c['text'])
    return parts[0] if len(parts) == 1 else parts


def walk(o):
    """Every dict inside o."""
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def first(d, keys):
    for k in keys:
        for dk in d:
            if dk.lower() == k and d[dk] not in (None, ''):
                return d[dk]
    return None


JID_RE = re.compile(r'[\w.+-]+@(?:s\.whatsapp\.net|g\.us|lid|c\.us|newsletter)')


def chats_from(data):
    out, seen = [], set()
    for d in walk(data):
        jid = first(d, ['jid', 'chat_jid', 'chatjid', 'chat_id', 'id', 'remote_jid'])
        if not isinstance(jid, str) or not JID_RE.fullmatch(jid) or jid in seen:
            continue
        name = first(d, ['name', 'display_name', 'chat_name', 'title', 'subject', 'push_name', 'contact_name', 'full_name']) or jid.split('@')[0]
        group = jid.endswith('@g.us') or bool(first(d, ['is_group', 'isgroup', 'group']))
        seen.add(jid)
        out.append({'id': jid, 'name': str(name), 'kind': 'Group' if group else 'Contact'})
    if not out and isinstance(data, (str, list)):  # plain text answer: one chat per line
        for line in (data if isinstance(data, str) else '\n'.join(map(str, data))).splitlines():
            m = JID_RE.search(line)
            if m and m.group(0) not in seen:
                name = re.sub(r'[\[\]()|:*\-]+', ' ', line.replace(m.group(0), '')).strip() or m.group(0).split('@')[0]
                seen.add(m.group(0))
                out.append({'id': m.group(0), 'name': name[:80], 'kind': 'Group' if m.group(0).endswith('@g.us') else 'Contact'})
    return out


def when(v):
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
        n = float(v)
        n = n / 1000 if n > 1e11 else n
        return datetime.fromtimestamp(n, timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')
    return str(v or '')[:25].replace('T', ' ')


def clean_url(u):
    u = u.strip().lstrip('<')
    while u and (u[-1] in ']}>.,;:!?\'"*_~' or (u[-1] == ')' and u.count(')') > u.count('('))):
        u = u[:-1]
    return 'https://' + u if u.lower().startswith('www.') else u


def strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)


def links_from(data):
    """[{url, sharedBy, sharedAt, message}] from messages, whatever shape the answer has."""
    out, seen = [], set()

    def add(text_blob, by, at, msg):
        for raw in URL_RE.findall(text_blob):
            url = clean_url(raw)
            if not re.match(r'^https?://[^/\s]+\.[^/\s]+', url) or SKIP_HOSTS.search(url) or url in seen:
                continue
            seen.add(url)
            out.append({'url': url, 'sharedBy': str(by or '')[:80], 'sharedAt': when(at), 'message': str(msg or '')[:300]})

    msgs = [d for d in walk(data) if isinstance(first(d, ['text', 'body', 'content', 'message', 'caption', 'conversation']), str)]
    if msgs:
        for d in msgs:
            msg = first(d, ['text', 'body', 'content', 'message', 'caption', 'conversation'])
            by = first(d, ['sender_name', 'push_name', 'pushname', 'from_name', 'author', 'sender', 'from'])
            if isinstance(by, dict):
                by = first(by, ['name', 'push_name', 'jid'])
            if first(d, ['from_me', 'is_from_me', 'fromme']) is True:
                by = 'You'
            at = first(d, ['timestamp', 'time', 'date', 'sent_at', 'created_at', 'ts'])
            add('\n'.join(s for s in strings(d) if 'http' in s or 'www.' in s), by, at, msg)
    else:
        text = data if isinstance(data, str) else '\n'.join(strings(data))
        for line in text.splitlines():
            add(line, '', '', line)
    return out


# ---------- reading a chat ----------
def mcp_chats(m, cfg):
    args = {}
    lim = m.param('list_chats', 'limit', 'count', 'max')
    if lim:
        args[lim] = 1000
    acc = m.param('list_chats', 'account', 'alias')
    if acc and cfg.get('account'):
        args[acc] = cfg['account']
    return chats_from(payload(m.tool('list_chats', args)))


def mcp_links(m, cfg, chat_id):
    tool = 'list_messages'
    chat = m.param(tool, 'chat', 'jid', 'chat_jid', 'conversation', 'recipient')
    if not chat:
        raise RuntimeError('list_messages has no chat parameter: ' + json.dumps(m.tools[tool].get('inputSchema'))[:300])
    args = {chat: chat_id}
    lim = m.param(tool, 'limit', 'count', 'max')
    if lim:
        args[lim] = MAX_MESSAGES
    acc = m.param(tool, 'account', 'alias')
    if acc and cfg.get('account'):
        args[acc] = cfg['account']
    data, links, cursor_param, pages = None, [], m.param(tool, 'cursor', 'before', 'page_token'), 0
    while True:
        data = payload(m.tool(tool, args))
        links += links_from(data)
        nxt = None
        if cursor_param:
            for d in walk(data):
                nxt = first(d, ['next_cursor', 'nextcursor', 'cursor', 'next', 'before'])
                if nxt:
                    break
        pages += 1
        if not nxt or pages >= 20 or not isinstance(nxt, (str, int)) or args.get(cursor_param) == nxt:
            break
        args[cursor_param] = nxt
    return links


def store_dbs(cfg):
    if cfg.get('store_db'):
        return [os.path.expanduser(cfg['store_db'])]
    base = os.environ.get('WA_DATA_DIR') or os.path.expanduser('~/.local/share/wa-mcp')
    return sorted(glob.glob(os.path.join(base, 'accounts', cfg.get('account') or '*', 'store.db')) + glob.glob(os.path.join(base, 'store.db')))


class Store:
    """The MCP's own message store, opened READ ONLY. Used when the MCP can't be started (for example, it is already
    running for Claude). The table layout isn't documented, so it is worked out from the column names."""
    def __init__(self, path):
        self.db = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=10)
        self.db.row_factory = sqlite3.Row
        cols = {}
        for (t,) in self.db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '%fts%'"):
            cols[t] = [r[1] for r in self.db.execute('pragma table_info("%s")' % t.replace('"', ''))]
        self.msg = self.chatcol = self.chats = self.idcol = self.namecol = None
        for t, cs in cols.items():
            low = [c.lower() for c in cs]
            text = [c for c in cs if c.lower() in ('text', 'body', 'content', 'conversation', 'caption')]
            chat = [c for c in cs if 'chat' in c.lower() and ('jid' in c.lower() or c.lower() in ('chat', 'chat_id'))]
            if text and chat and 'msg' in t.lower() or text and chat and 'message' in t.lower():
                self.msg, self.chatcol = t, chat[0]
            if 'chat' in t.lower() and any(c in low for c in ('jid', 'chat_jid', 'id')) and any(c in low for c in ('name', 'subject', 'title')):
                self.chats = t
                self.idcol = next(c for c in cs if c.lower() in ('jid', 'chat_jid', 'id'))
                self.namecol = next(c for c in cs if c.lower() in ('name', 'subject', 'title'))
        if not self.msg:
            raise RuntimeError('Could not find the messages table in ' + path + ': ' + ', '.join(cols))

    def chat_list(self):
        if self.chats:
            rows = self.db.execute('select "%s" as id, "%s" as name from "%s"' % (self.idcol, self.namecol, self.chats))
            return [{'id': r['id'], 'name': r['name'] or r['id'].split('@')[0], 'kind': 'Group' if str(r['id']).endswith('@g.us') else 'Contact'}
                    for r in rows if r['id'] and JID_RE.fullmatch(str(r['id']))]
        rows = self.db.execute('select distinct "%s" as id from "%s"' % (self.chatcol, self.msg))
        return [{'id': r['id'], 'name': r['id'].split('@')[0], 'kind': 'Group' if r['id'].endswith('@g.us') else 'Contact'} for r in rows if r['id']]

    def links(self, chat_id):
        rows = self.db.execute('select * from "%s" where "%s" = ? limit %d' % (self.msg, self.chatcol, MAX_MESSAGES), (chat_id,))
        return links_from([dict(r) for r in rows])


class Reader:
    """Reads chats through the MCP, or the store if the MCP won't start."""
    def __init__(self, cfg):
        self.cfg, self.m, self.s = cfg, None, None
        try:
            self.m = Mcp(cfg['mcp_command'])
            log('Connected to the WhatsApp MCP (read only).')
        except Exception as e:
            log('WhatsApp MCP not available (' + str(e)[:200] + '). Trying its message store instead.')
            for p in store_dbs(cfg):
                try:
                    self.s = Store(p)
                    log('Reading', p, '(read only).')
                    break
                except Exception as e2:
                    log('Cannot use', p + ':', str(e2)[:200])
            if not self.s:
                raise RuntimeError('No way to read WhatsApp: the MCP did not start and no store.db was found. Set store_db in reference-sync.json.')

    def chats(self):
        return mcp_chats(self.m, self.cfg) if self.m else self.s.chat_list()

    def links(self, chat_id):
        return mcp_links(self.m, self.cfg, chat_id) if self.m else self.s.links(chat_id)

    def close(self):
        if self.m:
            self.m.close()
        if self.s:
            self.s.db.close()


# ---------- running in the background (Windows Task Scheduler, from WSL) ----------
def powershell(script):
    for exe in ('powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'):
        try:
            return subprocess.run([exe, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            continue
    sys.exit('Could not reach Windows PowerShell from WSL. Run this inside WSL on your PC.')


def install():
    distro = os.environ.get('WSL_DISTRO_NAME')
    if not distro:
        sys.exit('Run --install inside WSL (Ubuntu) on your Windows PC.')
    load_config()  # make sure the keys are filled in first
    me = os.path.abspath(__file__)
    if ' ' in me:
        sys.exit('Move this file to a folder without spaces in its name (for example ~/reference-sync/), then run --install again.')
    # conhost --headless runs WSL with no window, so closing windows can't stop it.
    arg = "--headless C:\\Windows\\System32\\wsl.exe -d %s -e python3 %s --log" % (distro, me)
    ps = '''$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\conhost.exe' -Argument "%s"
$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '%s' -Action $a -Trigger $t -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName '%s'
''' % (arg, TASK, TASK)
    r = powershell(ps)
    if r.returncode:
        sys.exit('Windows refused: ' + (r.stderr or r.stdout).strip()[:500])
    print('Installed. It now runs in the background, starts when you log in to Windows, and restarts if it stops.')
    print('Check on it any time with:  python3 ' + me + ' --status')


def uninstall():
    r = powershell("Stop-ScheduledTask -TaskName '%s' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '%s' -Confirm:$false" % (TASK, TASK))
    print('Removed.' if r.returncode == 0 else 'Not removed: ' + (r.stderr or r.stdout).strip()[:300])


def status():
    running = False
    try:
        with open(os.path.join(HERE, '.reference-sync.lock'), 'a') as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
    except OSError:
        running = True
    print('Running.' if running else 'NOT running. Start it with:  python3 ' + os.path.abspath(__file__) + ' --install')
    if os.path.exists(LOG):
        print('Last log lines:')
        with open(LOG, errors='replace') as f:
            print(''.join(f.readlines()[-8:]).rstrip())


def single_instance(background):
    """Only one copy at a time (a second one would fight the first for WhatsApp). The background copy waits its turn:
    if you also started one in a window, it takes over when that window closes."""
    f = open(os.path.join(HERE, '.reference-sync.lock'), 'a')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        if not background:
            sys.exit('reference-sync is already running in the background. Nothing to do. (Check it with --status.)')
        fcntl.flock(f, fcntl.LOCK_EX)
    return f


# ---------- main ----------
PERSON_OR_GROUP = re.compile(r'@(?:s\.whatsapp\.net|g\.us|lid|c\.us)$')  # not status updates, channels or broadcast lists


def send_chats(cfg, rd):
    chats = [c for c in rd.chats() if PERSON_OR_GROUP.search(c['id'])]
    if chats:
        n = crm(cfg, {'action': 'refPushChats', 'chats': chats})['count']
        log('Sent', n, 'chat names.')


def answer_requests(cfg, rd, pending=None):
    if pending is None:
        pending = crm(cfg, {'action': 'refPending'})['chats']
    for c in pending:
        log('Reading links in', c['name'] or c['id'], '…')
        links = rd.links(c['id'])
        j = crm(cfg, {'action': 'refPush', 'source': 'pc', 'chat': {'id': c['id'], 'name': c['name']}, 'links': links})
        log('  found', len(links), 'links,', j['added'], 'new.')
        for _ in range(100):  # summarise now, so they're ready when you look
            r = crm(cfg, {'action': 'refProcess', 'chatId': c['id']})
            if not r['left'] or not r['done']:
                break
        log('  summaries done.')
    return len(pending)


def main():
    args = sys.argv[1:]
    if args[:1] == ['--install']:
        return install()
    if args[:1] == ['--uninstall']:
        return uninstall()
    if args[:1] == ['--status']:
        return status()
    cfg = load_config()
    if args[:1] == ['--dump']:
        m = Mcp(cfg['mcp_command'])
        print('Tools:', ', '.join(sorted(m.tools)))
        for t in ('list_chats', 'list_messages'):
            print('\n' + t, json.dumps((m.tools.get(t) or {}).get('inputSchema'), indent=1)[:1500])
        chats = mcp_chats(m, cfg)
        print('\n%d chats, first: %s' % (len(chats), chats[:5]))
        want = (args[1] if len(args) > 1 else '').lower()
        c = next((x for x in chats if want and (want in x['name'].lower() or want == x['id'])), None)
        if c:
            chat = m.param('list_messages', 'chat', 'jid', 'chat_jid', 'conversation', 'recipient')
            raw = m.tool('list_messages', {chat: c['id']})
            print('\nRaw list_messages for', c['name'], ':\n', json.dumps(raw, ensure_ascii=False)[:3000])
            print('\nLinks found:', json.dumps(links_from(payload(raw)), ensure_ascii=False, indent=1)[:2000])
        m.close()
        return
    background = '--log' in args
    if background:  # background: write to reference-sync.log (kept under 1 MB)
        if os.path.exists(LOG) and os.path.getsize(LOG) > 1000000:
            os.replace(LOG, LOG + '.old')
        sys.stdout = sys.stderr = open(LOG, 'a', buffering=1)
        args = [a for a in args if a != '--log']
    keep = single_instance(background)  # noqa: F841 (held until exit)
    log('Starting. Checking for chats you ask for every minute.')
    if args[:1] == ['--chats']:
        with_reader(cfg, lambda rd: send_chats(cfg, rd))
        return
    last_chats = 0
    while True:
        # WhatsApp is opened only while there is something to read, then let go, so Claude's own WhatsApp
        # connection can use the account the rest of the time.
        try:
            pending = crm(cfg, {'action': 'refPending'})['chats']
            chats_due = time.time() - last_chats >= CHATS_EVERY
            if pending or chats_due:
                def work(rd):
                    answer_requests(cfg, rd, pending)
                    if chats_due:
                        send_chats(cfg, rd)
                with_reader(cfg, work)
                if chats_due:
                    last_chats = time.time()
        except Exception as e:
            msg = str(e)[:300]
            if 'Lock timeout' in msg:
                msg += ' (the sheet was busy)'
            log('Problem:', msg, '- trying again in a minute.')
            if args[:1] == ['--once']:
                raise
            if time.time() - last_chats >= CHATS_EVERY:
                last_chats = time.time() - CHATS_EVERY + 5 * 60  # chat list: try again in 5 minutes
        if args[:1] == ['--once']:
            break
        time.sleep(CHECK_EVERY)


def with_reader(cfg, fn):
    rd = Reader(cfg)
    try:
        return fn(rd)
    finally:
        rd.close()

if __name__ == '__main__':
    main()
