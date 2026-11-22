# Client list (CRM) setup

Every task you add with a contact also saves that client to one shared Google Sheet. Free, about 5 minutes, done once by one person (Rebecca).

```
 WhatsApp msg ─copy─▶ Task Scheduler ─▶ Google Calendar (the task)
                           │
                           └──▶ Google Sheet  ─ "Clients" tab: one row per client
                                               ─ "History" tab: one row per task
```

## 1. Make the sheet (Rebecca, on a computer)
1. Go to sheets.new and name it **Team Clients**.
2. Click **Extensions → Apps Script**.
3. Delete what's there and paste everything from [`crm-script.gs`](crm-script.gs).
4. On the line `var TEAM_KEY = 'change-me';`, replace `change-me` with a word only your team knows. Click 💾 Save.
5. Click **Deploy → New deployment**. Click the ⚙︎ next to "Select type" and choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy**, then **Authorize access** and pick your Google account. If you see "Google hasn't verified this app", click **Advanced → Go to (unsafe)**. This is your own script, so it's safe.
7. Copy the **Web app URL** (it ends in `/exec`).
8. Share the sheet with your team (Share button, as Editor) so they can also open it in Google Sheets.

## 2. Connect each phone
1. Open Task Scheduler and tap ⚙︎.
2. Paste the **CRM link** (the Web app URL), type the **Team key**, and **Your name**. Tap Save.
3. Open the **Clients** tab. It should say "Synced".

Send your team the link and key on WhatsApp so they can do step 2.

## Using it
- **New task tab:** paste a message as usual. If the contact is already a client, you'll see "✓ Existing client". Set the Company, Status and Next follow-up if you want, then tap Add to team calendar. The client and task are saved to the sheet.
- **Clients tab:** search, filter by status, and see **Follow-ups due** at the top (the red number on the tab).
- **Tap a client:** WhatsApp, call or email them, edit notes and status, put the follow-up in the calendar, start a new task, and see their task history.
- **No signal?** Saves wait on the phone and upload when you're back online.

## If you change the script later
Use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**, so the link stays the same.
