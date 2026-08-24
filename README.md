# CareFlow — Healthcare Appointment & Follow-up Manager

A complete Node.js 24 project for the Healthcare Appointment & Follow-up Manager brief. The UI is intentionally light, baby-pink and white, with responsive cards, dashboards, booking flows, modals, urgency badges and role-specific portals.

## Requirements covered
- Separate patient, doctor and admin portals with JWT role-based authentication.
- Patient registration/login, doctor search and appointment booking.
- Specialisation, working hours, slot duration and leave management.
- Double-booking prevention using a database UNIQUE constraint plus a transaction/re-check immediately before insert.
- Doctor leave conflict handling: existing bookings are cancelled and patients are notified.
- AI/LLM pre-visit summary with Low/Medium/High urgency, chief complaint and three questions. If the LLM is unavailable, a deterministic safe fallback keeps the application running.
- Doctor post-visit notes + prescription and patient-friendly summary. LLM failure also falls back safely.
- Medication reminder background worker with prescription-frequency parsing and email delivery.
- Email notifications with Nodemailer; without SMTP configuration, messages are logged to the backend console so local development still works.
- Google Calendar OAuth 2.0 integration and event creation/deletion. Without Google credentials, booking continues safely and logs a calendar fallback.
- Notification attempts/status are persisted in the database.
- API, database schema, LLM prompts and system design documentation included.

## Why Node.js 24 works
This version uses Node 24's built-in `node:sqlite` API instead of `better-sqlite3`. Therefore you do **not** need Visual Studio C++ Build Tools or a downgrade to Node 20/22. Your installed Node `v24.18.0` is the intended runtime.

Node may display an experimental warning for `node:sqlite`; that warning is not an application failure.

## Run in VS Code
1. Extract the project folder.
2. Open `CareFlow_Node24` in VS Code.
3. Open Terminal → New Terminal.
4. Run:
   ```powershell
   cd backend
   npm install
   copy .env.example .env
   npm run dev
   ```
5. Open **http://localhost:5000**.

The frontend is served by the same Express server, so you do **not** need a second terminal or Vite.

## Demo accounts
All demo accounts use `password123`:
- Patient: `patient@careflow.local`
- Doctor: `doctor@careflow.local`
- Admin: `admin@careflow.local`

## Optional LLM
Copy `.env.example` to `.env` and set `LLM_API_KEY`. The project uses the configured OpenAI-compatible chat-completions URL/model. If no key is supplied, CareFlow automatically uses the safe local fallback logic.

## Optional email
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optionally `SMTP_FROM`. Without these values, emails are logged to the terminal and their notification records remain in the database.

## Google Calendar OAuth 2.0
1. Create/select a Google Cloud project.
2. Enable Google Calendar API.
3. Configure an OAuth consent screen.
4. Create an OAuth client for a web application.
5. Add this redirect URI:
   `http://localhost:5000/api/calendar/oauth/callback`
6. Put the client ID and secret in `.env`.
7. Start CareFlow and call `/api/calendar/connect` while logged in, or add a small connect action in the UI if desired.
8. After consent, copy the displayed refresh token to `GOOGLE_REFRESH_TOKEN` in `.env`.

## Database
The SQLite database file `careflow.db` is generated automatically inside `backend/` on first start.

Main tables:
- `users`
- `doctor_profiles`
- `leaves`
- `appointments`
- `notifications`
- `medication_reminders`

## System design — conflict and reliability
The appointment slot is generated from a doctor's working hours and slot duration. Before a booking is inserted, the API checks that the slot is still available and then performs a transactional insert. The `appointments` table also has a database-level UNIQUE constraint on `(doctor_id, appointment_date, start_time)`. This means two simultaneous requests cannot successfully create the same doctor/date/time record even if both requests pass the first availability check. The failed request receives a conflict response and the UI asks the patient to select another slot.

There is no unsafe long-lived slot lock in this lightweight implementation: the authoritative reservation point is the transactional database insert. This avoids stale client-side holds while still protecting the critical section. A production deployment can extend this with a short-lived `slot_holds` table and expiry timestamp if the product requires a multi-step checkout experience.

When an admin marks a doctor on leave, the leave row is inserted with a unique `(doctor_id, leave_date)` constraint. Existing booked appointments on that date are changed to `cancelled`, a cancellation reason is stored, and patient notifications are queued/sent. Future slot generation returns no slots for the leave date, preventing new bookings.

Notification reliability is intentionally separated from the appointment transaction. The appointment is committed first; notification records are persisted with status/attempt fields. Email delivery is attempted after booking/cancellation/visit completion. Missing SMTP configuration does not break the appointment flow: CareFlow falls back to console logging. The reminder worker runs periodically and updates reminder schedules after delivery.

LLM calls are never the sole source of truth for appointment creation. Pre-visit and post-visit generation has deterministic fallbacks. If the LLM is unavailable, malformed, or returns an unexpected response, the appointment and visit can still complete. The generated output is stored with the appointment for later doctor/patient access.

Google Calendar is similarly non-blocking. When valid OAuth credentials are available, CareFlow creates an event and stores its event ID. If Calendar is unavailable or not configured, the appointment remains valid and the integration logs a safe fallback. Cancellation attempts to delete the stored event ID when present.

## Important healthcare note
The AI feature is an administrative/summarisation aid, not a diagnostic system. The UI explicitly tells patients that the pre-visit output is a screening summary and not a diagnosis.

## Submission hygiene
Do not submit `node_modules/`, `.env`, the generated `careflow.db`, editor folders or build artifacts. The assignment guidelines request minimal dependencies and exclude secrets and temporary files.
