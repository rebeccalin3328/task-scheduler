# CRM setup

The app uses a **new CRM sheet** for everything it saves. Your **airnergy_crm_backend** sheet is only read and is never changed.

```
 airnergy_crm_backend (read only)            Task Scheduler CRM (new sheet, written by the app)
 ├─ Contact        ── copied hourly ──▶      ├─ Contact        + new WhatsApp contacts, status, agent, notes
 ├─ ContactPerson  ── copied hourly ──▶      ├─ ContactPerson  + new people found in messages
 └─ User           ── looked up only         ├─ Task           every task added in the app
                      (work email → UserID)  └─ Activity       a log line for each task

 WhatsApp msg ─copy─▶ Task Scheduler ─▶ Google Calendar (as before)
                           └──────────▶ Task Scheduler CRM
```

- **Same column names as the master**, so the CRM sheet can later be added to AppSheet or merged back if you want.
- **Copying:** the first sync copies all contacts. After that, at most once an hour, new AutoCount contacts are added and changed details (name, phone, email, address and so on) are refreshed. Your CRM fields (AssignedAgent, CRMTags status, CRMNotes) and WhatsApp contacts are always kept. Nothing is deleted.
- **Private data stays private:** the User tab is only used to match work emails. It is not copied, and it is never sent to phones.

## 1. Make the CRM sheet (Rebecca, once, on a computer, about 5 minutes)
1. Signed in as admin@airnergy.my, go to **sheets.new** and name it **Task Scheduler CRM**.
2. Click **Extensions → Apps Script**. Delete what's in `Code.gs` and paste the whole of [`crm-script.gs`](crm-script.gs).
3. Near the top, set two secret words and click 💾 Save:
   - `var TEAM_KEY = 'change-me';` : a word the whole team uses.
   - `var ADMIN_KEY = 'change-me-too';` : a different word that **only you** know. It unlocks creating, linking and sharing calendars. Admin tools stay off until you change it.
4. Click **Deploy → New deployment**. Click ⚙︎ next to "Select type", then **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, then **Authorize access** and choose admin@airnergy.my. If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It's your own script. Google will ask for access to your spreadsheets (to read airnergy_crm_backend) and your calendars (for linked Google Calendars).
6. Copy the **Web app URL** (it ends in `/exec`).
7. Share the CRM sheet with your team as Editor if they should see it in Google Sheets too.

"Anyone" only means the link answers requests. Without the team key it refuses everything.

The tabs appear the first time a phone syncs. To fill them straight away, reload the sheet and use the new menu **Task Scheduler → Copy contacts now**.

## 2. Connect each phone
1. Open Task Scheduler and tap ⚙︎.
2. Paste the **CRM link**, type the **Team key**, and enter **your work email**, which must match your row in the User tab of airnergy_crm_backend. Tap Save.
3. Open **Clients**. It should say "Synced … clients". The first sync takes a little longer while the contacts are copied.

## 3. Set up calendars (Rebecca only)
1. In the app, tap ⚙︎ and type your **Admin key**. Tap Save.
2. Open **Calendar** and tap **⚙︎ Manage calendars (admin)**.
3. A **Team** calendar, shared with everyone, is already there. You can also:
   - **＋ App calendar:** events are kept in the CRM sheet.
   - **＋ Google Calendar:** creates a new Google Calendar in your account. Events go straight into it, so phone reminders work.
   - **🔗 Link:** pick one of your existing Google Calendars.
4. Tap a calendar to rename it, pick a colour, and choose **Everyone** or **Only these people**. Untick Active to hide it.

Team members only see, and can only add to, the calendars shared with them.

```
            Team        Service      Sales (Google)
 Rebecca     ✓            ✓              ✓        (admin sees all)
 Siti        ✓                           ✓
 Ahmad       ✓            ✓
```

## Look and feel
Each person picks a style in ⚙︎ → **Look and feel**: Classic, Rainbow (kids), Big & Clear (larger text), Professional, Night or Pastel. The choice is saved on their own phone.

## Using it
- **Calendar tab:** month, week or day view. Tap the coloured chips to show or hide calendars, tap ＋ to add an event, and tap an event to edit or delete it or to open its client.
- **New task:** paste a message. If the phone, email or company is already a contact, you'll see "✓ ALPHA SDN BHD · AutoCount 300-0001". Otherwise it says "New contact". Pick a calendar and tap **Add to … calendar**. It's saved to the calendar and to the client's record in one step. **Also add a reminder on my phone** opens your phone's calendar if you want a personal alert. Set **Next follow-up** to add a second "Follow up" task.
- **Clients tab:** **Tasks due** is at the top (the red number), then recent clients. You can search every contact by company, person, phone or AutoCount number.
- **Client page:** WhatsApp, call or email the client; set status, agent and CRM notes; see contact persons; tick tasks done; add a follow-up (this also opens Google Calendar).
- **No signal?** Saves wait on the phone and upload later.

## Changing the script later
Use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**, so the link stays the same.
