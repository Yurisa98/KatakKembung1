# KatakKembung1

Multi-project Gantt and project management suite. The demo uses synthetic records and saves changes in its own browser. Team mode uses a private Google Sheet as the shared source of truth.

## Open the demo

```powershell
npm ci
npm run dev
```

Open the local address printed by Vite. Select a task to edit dates, status and completion. Drag the blue Planned bar to move it and drag an edge to resize it. Use date fields for precise edits, keyboard input or touch. The teal Actual bar shows the elapsed actual range and the recorded progress. Choose Week, Month, Quarter or Year and set the visible range up to 10 years.

Use Settings for projects, team access, workbook import and JSON backup. The Excel import supports the `Project Manager Pro LightMode` layout. It reads the file locally and shows counts and validation before saving mapped rows. Re-importing tasks with existing codes in the same project raises a duplicate warning or validation error. JSON restore merges by ID and leaves team access intact.

## Deploy a private team workspace

1. Use a Google Cloud project approved for your team. Enable Cloud Run, Cloud Build, Artifact Registry, Sheets, Cloud Storage, and, for Notion, Secret Manager and Cloud Scheduler. Set up a Google OAuth **Web application** client in that project. Configure its consent screen for the intended team, and add `https://yurisa98.github.io` as an authorised JavaScript origin. Add `http://localhost:5173` only if testing the integration from Vite. Users sign in with verified Gmail or Google Workspace accounts.
2. In your Drive create a blank private Google Sheet. Share that spreadsheet specifically with a dedicated runtime service account as Editor. Create a private Cloud Storage bucket for write locks and give the runtime service account object create/delete access in that bucket. Keep the lock objects out of automated expiry policies. Use the service account as Cloud Run's attached runtime identity. No service account key file is needed in production.
3. Deploy the Dockerfile to Cloud Run with a 240-second or longer request timeout and the server values in `.env.example`. The endpoint is internet reachable so Google-authenticated users can call it. The app validates Google ID tokens and membership on the server. Set `APP_ORIGIN` to the website origin (no path) and `PLANNER_URL` to the full Pages path. Run a one-off Cloud Run Job using the same built image and runtime identity, with `initialise` as its argument. This creates the sheet tabs and header rows. The backend expects the tabs to be maintained through the app and treats the operation ledger as its change feed. Keep the initial owner email as an environment variable, then manage team membership in Settings.
4. In GitHub Settings > Pages choose **GitHub Actions**. For a live team build set the repository Actions variables `VITE_API_URL` and `VITE_GOOGLE_CLIENT_ID`. Run the Pages workflow again. With variables left blank, the published site is a demo. The public repository should contain only code and synthetic examples.
5. Sign in as the workspace owner and test with a second authorised Google account before importing live data. A Viewer cannot write, and only Owners can import, export and manage membership. The API stores the prior/new values, editor email, version and timestamp for each change. Sheet owners can inspect those records. Provision spreadsheet edit access only to the runtime account and the account that owns the sheet.

### Notion summaries

In the owner-approved Notion workspace, create a dedicated project summary database and share it with an internal connection. Use these properties:

| Property | Type |
| --- | --- |
| Name | Title |
| Project ID | Text |
| Status | Select (`Not Started`, `In Progress`, `On Hold`, `Completed`) |
| Planned, Actual, Last synced | Date |
| Progress percent, Overdue | Number |
| Planner | URL |
| Sync revision | Text |

Set `NOTION_DATA_SOURCE_ID` (the data source ID). Add `NOTION_TOKEN` and `SCHEDULER_SECRET` as secrets on Cloud Run. Have Cloud Scheduler send `POST /jobs/notion` every 10 minutes with the same random value in the `X-Scheduler-Secret` header. Sync uses Project ID for upserts and limits each run to 80 changed summaries; the next run continues any backlog. Review the job logs and job permissions in the Google Cloud project. Edits to a mirrored row in Notion are outside this one-way sync.

## Checks and limits

```powershell
npm test
npm run build
node tests/browser.mjs
```

The browser test uses Chrome installed on Windows or `BROWSER_BIN`. Set `PLANNER_TEST_WORKBOOK` to the local reference workbook to also exercise the browser import preview. `PLANNER_SCREENSHOT` optionally saves a synthetic demo screenshot.

The project caps a workspace at 500 active projects, 10,000 active tasks per project and 50,000 active tasks in total. The synthetic test verifies the schedule index and matching rows at these sizes. Before team release, benchmark real Sheets API latency, cold-cache load, long timeline scrolling, and repeated edits with multiple team accounts on a staging spreadsheet. Use smaller batches for large JSON restores or imports that exceed the atomic Sheets request size. The dashboard progress metric uses planned calendar-day duration as the task weight. A change to planned dates also changes this weight.

When a save times out, retry the same edit so the server can look up the operation ID. The server writes the operation and audit history atomically. A cross-instance lock in Cloud Storage holds the write queue safe. If a terminated instance leaves an orphan lock, an administrator should first verify no writer is active and whether the operation is already recorded, then clear that specific lock using Cloud Storage. Refer to Cloud Run logs for infrastructure errors. Never publish a workbook, real import, private backup or credential into this repository.
