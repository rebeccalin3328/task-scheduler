# CRM setup (airnergy_crm_backend)

The app saves clients and tasks into your existing **airnergy_crm_backend** sheet, the same one AppSheet uses. No new tabs or columns.

```
 WhatsApp msg ─copy─▶ Task Scheduler ─▶ Google Calendar (as before)
                           │
                           ├─ finds the client by phone / email / company ─▶ Contact + ContactPerson
                           │      not found? ─▶ new Contact row, Source = "WhatsApp"
                           ├─ the task ──────▶ Task   (AssignedTo / CreatedBy from the User tab, by email)
                           ├─ a log line ────▶ Activity
                           └─ status, agent, notes ─▶ Contact.CRMTags / AssignedAgent / CRMNotes
```

What it never does: delete rows, add tabs or columns, change AutoCount details (name, phone, email, address, credit) on AutoCount contacts, or send User tab data (IC, EPF, bank) to phones.

**Safety net for new WhatsApp contacts:** each one is also saved in the Activity tab. If a sync ever removes it from Contact, the app puts it back (same ContactID) the next time anyone syncs.

## 1. Add the script (Rebecca, once, on a computer, about 5 minutes)
1. Signed in as admin@airnergy.my, go to **script.google.com** and click **New project**. Name it `Task Scheduler CRM`.
   (It's a separate project on purpose, so it can't clash with your AutoCount or WhatsApp scripts on the sheet.)
2. Delete what's in `Code.gs` and paste the whole of [`crm-script.gs`](crm-script.gs). The sheet's ID is already filled in.
3. On the line `var TEAM_KEY = 'change-me';`, replace `change-me` with a word only your team knows. Click 💾 Save.
4. Click **Deploy → New deployment**. Click ⚙︎ next to "Select type", then **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, then **Authorize access** and choose admin@airnergy.my. If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It's your own script.
6. Copy the **Web app URL** (it ends in `/exec`).

"Anyone" only means the link answers requests. Without the team key it refuses everything, and it only reads or writes the CRM tabs listed above.

## 2. Connect each phone
1. Open Task Scheduler and tap ⚙︎.
2. Paste the **CRM link**, type the **Team key**, and enter **your work email**, which must match your row in the User tab. Tap Save.
3. Open **Clients**. It should say "Synced … clients".

## Using it
- **New task:** paste a message. If the phone, email or company is already in the CRM, you'll see "✓ ALPHA SDN BHD · AutoCount 300-0001". Otherwise it says "New contact". Tap Add to team calendar, and the task goes into the Task tab too. Set **Next follow-up** to add a second "Follow up" task.
- **Clients tab:** **Tasks due** at the top (the red number), then recent clients. Search any of the clients by company, person, phone or AutoCount number.
- **Client page:** WhatsApp, call or email; set status (saved in CRMTags), agent and CRM notes; see contact persons; tick tasks done; add a follow-up (also opens Google Calendar).
- **No signal?** Saves wait on the phone and upload later.

## Changing the script later
Use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**, so the link stays the same.
