# Reference (Rebecca only)

Pick a WhatsApp contact or group in the app's **Reference** tab. Every link shared in that chat is opened, summarised and put in a category.

```
 App: Reference tab ──"Get links"──▶ CRM web app ◀── asks every minute ── reference-sync.py (your PC, WSL)
        ▲                               │                                       │ reads only
        │                               │ opens each page,                      ▼
        └──── links, summaries, ◀───────┤ summarises, sorts          WhatsApp MCP (--read-only)
              categories                ▼
                         Task Scheduler Reference (private)  ← a sheet only you can open
```

- **Only you:** the tab appears only on a phone with your admin key, and the script refuses every Reference request without it.
- **Private:** chats, links and summaries go to a new sheet, **Task Scheduler Reference (private)**, made in your Drive. Nothing goes in the team CRM sheet, and airnergy_crm_backend is never touched.
- **Read only:** the PC helper starts the WhatsApp MCP with `--read-only` and can only call its reading tools. It never sends a message.
- **Free:** Apps Script fetches the pages. Summaries come from each page's own description and first lines. For written summaries, you can add a free Gemini key (step 4).

## 1. Update the CRM script (once, 2 minutes)
1. Open the **Task Scheduler CRM** sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with the new [`crm-script.gs`](crm-script.gs). Keep your own `TEAM_KEY` and `ADMIN_KEY` lines.
3. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** Google asks once more for permission, because the script now opens web pages ("connect to an external service").

## 2. Start the PC helper (once, in WSL on DESKTOP-L6EUSK4)
1. Copy [`reference-sync.py`](reference-sync.py) into your WSL home, for example `~/reference-sync/`.
2. Run `python3 ~/reference-sync/reference-sync.py`. It makes `reference-sync.json` next to it.
3. Open that file and fill in `crm_url` (the `/exec` link), `team_key` and `admin_key`. Leave the rest.
4. Run it again. It should say "Connected to the WhatsApp MCP (read only)" and "Sent … chat names". Leave the window open.

If Claude is already using the WhatsApp MCP, the helper can't start a second copy. It then reads the MCP's message store directly, opened read only, and says so.

**Start it with Windows (optional):** Task Scheduler → Create Basic Task → *When I log on* → Program `wsl.exe`, arguments `-e python3 /home/<you>/reference-sync/reference-sync.py`.

## 3. Use it
1. In the app, tap **Reference**, type the chat's name and pick it.
2. Tap **🔗 Get links from this chat**. Within a minute your PC sends the links, and the summaries fill in.
3. Tap a category to filter, search, or change a link's category with its menu. Your own choice is kept.

**No PC?** Tap *Or paste / open the chat here*. In WhatsApp: chat → ⋮ → More → **Export chat → Without media** → save to Files, then pick the .txt. Or copy some messages and paste them.

## 4. Better summaries (optional, free)
1. Get a key at **aistudio.google.com** → Get API key (free tier).
2. Apps Script → ⚙︎ Project Settings → Script properties → add `GEMINI_API_KEY` with the key.
Each link's page text is then sent to Google's Gemini for a 2–3 sentence summary. Google may use free-tier text to improve its models, so skip this if your chats share private pages. Without the key, nothing leaves Google Apps Script.

**Summarise in the background (optional):** Apps Script → Triggers → Add trigger → `summariseReferences`, time-driven, every 10 minutes. Without it, links are summarised while the Reference tab is open or the PC helper is running.

## Problems
- **"Could not open it: 403"**: the page needs a login or blocks robots. Tap the link to read it yourself, and set its category by hand.
- **Chat not in the list**: the helper sends chat names every 30 minutes. Run `python3 reference-sync.py --chats` to send them now.
- **Helper finds no links**: run `python3 reference-sync.py --dump "Chat name"` and send Claude what it prints.
- Categories are listed in `REF_CATEGORIES` at the Reference section of `crm-script.gs`. Add words or websites there.
