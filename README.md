# Task Scheduler

Share a WhatsApp message to this app to turn it into a Google Calendar event. Understands English, Malay and Chinese dates.

Run parser tests: `node test-parser.js`

## Client list (CRM)
Clients and tasks are saved to a separate CRM Google Sheet. Contacts are copied (read only) from airnergy_crm_backend. Setup: [CRM-SETUP.md](CRM-SETUP.md). Backend: `crm-script.gs` (Google Apps Script). Tests: `node test-crm.js`.

## Reference (admin only)
Pick a WhatsApp chat; its links are opened, summarised and sorted into categories, in a private sheet. Setup: [REFERENCE-SETUP.md](REFERENCE-SETUP.md). PC helper: `reference-sync.py` (read only). Tests: `node test-ref.js`, `python3 test-reference-sync.py`.
