# Event Email Ops Checklist

Use this checklist when deploying or operating programme/cohort event email flows.

## Environment

- [ ] `OBI_EMAIL_APP_SCRIPT_URL` is set to the campaign/batch Apps Script deployment
- [ ] Optional: `OBI_EMAIL_PLACEHOLDER_MODE=true` for local dev without a real send (events will not complete as sent)
- [ ] `OBI_AUTH_EMAIL_APP_SCRIPT_URL` is set for auth/portal emails (optional; falls back to console logging)
- [ ] `OBI_FORMS_APP_ORIGIN` points to the public forms app used for `hasForm` links
- [ ] `OBI_JWT_SECRET` is configured for CRM auth
- [ ] Redis is reachable for admin notifications and deduplication

## Apps Script

- [ ] Deploy `api/src/lib/email/appscript.gs` to the campaign Apps Script project
- [ ] Confirm `email_batch` requests with `htmlBody` send successfully
- [ ] Confirm attachment base64 payloads are accepted within size limits

## Database

- [ ] Run pending Prisma migrations before restarting the API
- [ ] Restart the API after migration so boot reconciliation reschedules deployed pending events

## Pre-deploy validation

- [ ] Email events have either a saved template or inline subject/body
- [ ] Recipient selection resolves to at least one participant
- [ ] Invoice events have a positive amount or line items
- [ ] Attachment URLs are reachable if templates/events include attachments

## Post-deploy checks

- [ ] Deployment summary shows expected scheduled/immediate/skipped counts
- [ ] Send a template test email from the Templates page
- [ ] Send an event test email from a saved programme event
- [ ] Confirm admin notifications appear once per failure/completion (deduped)

## Observability

Watch the **API process terminal** (where `npm run dev` / the API server runs). Scheduled event logs use these prefixes:

| Prefix | When |
|--------|------|
| `[scheduler:register]` | One-off job queued with `runAt` and ms until fire |
| `[scheduler:fire]` | node-schedule job actually fired |
| `[scheduler:immediate]` | Event ran right away (within 1s of schedule time) |
| `[scheduler:cancel]` | Pending job cancelled (save/reschedule) |
| `[event:execution]` | Claim, send, complete, fail, schedule, trigger phases (JSON) |
| `[email:batch:prepare]` | Batch about to send — recipients and subjects |
| `[email:batch:placeholder]` | No `OBI_EMAIL_APP_SCRIPT_URL` and `OBI_EMAIL_PLACEHOLDER_MODE=true` — payload logged, not sent |
| `[email:batch:error]` | No `OBI_EMAIL_APP_SCRIPT_URL` — send fails; event stays failed, not completed |
| `[email:batch:sent]` | Apps Script response after real send |
| `[scheduler:error]` | Uncaught error in scheduled task |

- [ ] API logs include `[event:execution]` JSON lines for claim/send/complete/fail phases
- [ ] Failed events show `executionMetadata` with error, duration, and dependency info
- [ ] Overdue events older than 2 hours are marked failed with `overdue_grace_expired`

## Size limits

- `OBI_EMAIL_MAX_ATTACHMENT_BYTES` default: 8MB per attachment
- `OBI_EMAIL_MAX_BATCH_ATTACHMENT_BYTES` default: 20MB combined per batch
