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
5. Click **Deploy**, then **Authorize access** and choose admin@airnergy.my. If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It's your own script. Google will ask for access to your spreadsheets (to read airnergy_crm_backend), your calendars (for linked Google Calendars) and your Drive (to save uploaded files).
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

### Phone reminders
App calendars live only in the CRM sheet, so your phone can't remind you about them. Google Calendars can:
1. **⚙︎ Manage calendars (admin)** → tap the calendar (for example Rebecca) → tick **🔔 Turn into a Google Calendar** → **Save calendar**. A Google Calendar with the same name is made in your account and its events are copied over.
2. On your phone, open the **Google Calendar** app signed in as admin@airnergy.my, and make sure that calendar is ticked in the ☰ menu.
3. From then on every event gets a pop-up reminder: **30 minutes before**, or **8 pm the evening before** for all-day tasks. You can change `REMINDER_MINUTES` and `ALL_DAY_REMINDER_MINUTES` at the top of the script.

Someone else who wants reminders from a shared Google Calendar adds it in their own Google Calendar app, and sets its notifications under Settings → that calendar.

```
            Team        Service      Sales (Google)
 Rebecca     ✓            ✓              ✓        (admin sees all)
 Siti        ✓                           ✓
 Ahmad       ✓            ✓
```

## Quick picks
After pasting a message, tap **Who is this task for?** (Customer, Supplier, Staff, Your child, Husband…), then **What is it about?** (for Your child: SRI KL International School, Tuition Center, ECA, Piano Lesson, Swimming Lessons, Homework, Project, English Subject…), then a **quick phrase** (Pay fees, Pick up, Bring…). The task title becomes "Piano Lesson: Pay fees".

- Tap **＋ New role** or **＋ Add** to add your own. Additions are saved in the CRM sheet's **Picklist** tab and shared with the team. You can also edit that tab directly.
- Only roles marked as clients (Customer, Supplier, and any new role you tick) are saved to the client list. Family and staff tasks are saved as tasks only.

## Files
Tap **📎 Attach files** on a task, or **📎 Add files** on a client page. Any format works (photos, PDF, Word, Excel…), up to 20 MB each.

- Files go to a new Google Drive folder, **Task Scheduler Files**, made the first time someone uploads. It's shared only with the work emails in the User tab. If you add people later, run `shareFilesFolderAgain` once from the Apps Script editor.
- Each file gets a readable name: `date_who_topic_task_file_client`, for example `2026-11-27_Your-child_Piano-Lesson_Pay-fees_exam-form.pdf` or `2026-11-30_Customer_Site-survey_site-photos_ALPHA-SDN-BHD.jpg`. Camera names like IMG_2031 are left out.
- Each file is listed in the CRM sheet's **File** tab, with its task and client, and appears on the client page and the calendar event.

## Look and feel
Each person picks a style in ⚙︎ → **Look and feel**: Classic, Rainbow (kids), Big & Clear (larger text), Professional, Night or Pastel. The choice is saved on their own phone.

## Using it
- **Calendar tab:** month, week or day view. Tap the coloured chips to show or hide calendars, tap ＋ to add an event, and tap an event to edit or delete it or to open its client.
- **New task:** paste a message. If the phone, email or company is already a contact, you'll see "✓ ALPHA SDN BHD · AutoCount 300-0001". Otherwise it says "New contact". Pick a calendar and tap **Add to … calendar**. It's saved to the calendar and to the client's record in one step. **Also add a reminder on my phone** opens your phone's calendar if you want a personal alert. Set **Next follow-up** to add a second "Follow up" task.
- **Clients tab:** **Tasks due** is at the top (the red number), then recent clients. You can search every contact by company, person, phone or AutoCount number.
- **Tasks (top of Clients tab):** set each task's priority (🔴 Urgent, 🟠 High, ⚪ Normal, 🔵 Low; the list puts Urgent first, then by due date) and status (New, In progress, Waiting, Done, Cancelled). Done and Cancelled count as closed. Choose **Open**, **Due and overdue** or **All, with closed** to hide or show closed tasks (saved on your phone). 🗑 then **Delete?** removes a task and its calendar entry; the row stays in the sheet marked Deleted, for the record.
- **Client page:** WhatsApp, call or email the client; set status, agent and CRM notes; see contact persons; tick tasks done; add a follow-up (this also opens Google Calendar).
- **No signal?** Saves wait on the phone and upload later.

## Changing the script later
Paste the new `crm-script.gs` over the old one, **put your two secret words back** in `TEAM_KEY` and `ADMIN_KEY`, click 💾 Save, then use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**, so the link stays the same.
