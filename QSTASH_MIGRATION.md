# QStash Scheduler Migration Guide

This project now uses Upstash Redis as the source of truth and Upstash QStash as the delayed-message scheduler.

## What Changed

Old flow:

```text
Frontend saves pending jobs to Redis
Vercel Cron calls /api/cron every minute
/api/cron scans Redis and fires due AppsFlyer events
```

New flow:

```text
Frontend calls /api/schedule-job
Backend saves the job in Redis and publishes a delayed QStash message
QStash calls /api/fire-scheduled-event when the job is due
Backend reloads the Redis job, verifies it is still valid, fires AppsFlyer, and updates Redis
```

Redis is still the durable storage for queues, logs, statuses, attempts, and dashboard display. QStash is only the delayed wake-up signal.

## Required Environment Variables

Keep the existing Redis variables:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Add these QStash/admin variables:

```text
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
PUBLIC_BASE_URL
ADMIN_SECRET
```

`PUBLIC_BASE_URL` must be the deployed site origin that QStash can call, for example:

```text
https://your-domain.com
```

Keep `CRON_SECRET` only while the old Vercel Cron fallback is still deployed.

## Admin Panel Access

The admin panel is available at:

```text
/admin
```

The panel is intentionally not linked from the main app. It provides:

```text
QStash status/audit
Transfer existing Redis schedules to QStash
Failed job retry
Manual fire now
QStash job cancellation
Raw API reports
```

Enter the `ADMIN_SECRET` value in the Admin Secret field and click `Save Secret`. The value is stored only in this browser's `sessionStorage`.

Admin API operations are protected by:

```text
Authorization: Bearer ADMIN_SECRET
```

The main scheduler dashboard also asks for the admin secret when you click retry/fire controls on failed jobs.

## Change The Admin Password

The admin password is the `ADMIN_SECRET` environment variable.

To change it:

1. Generate a new long random value.
2. Update `ADMIN_SECRET` in the deployment provider environment variables.
3. Redeploy or restart the app so serverless functions see the new value.
4. Open `/admin` and click `Clear Secret`, or clear browser session storage, so the old value is not reused.

Example local shell value format:

```text
ADMIN_SECRET=replace-with-a-long-random-secret
```

Anyone with the old secret loses access after the redeploy/restart.

The admin panel cannot directly change `ADMIN_SECRET` because it is a server environment variable. Rotation must happen in the deployment provider.

## Hidden Admin Endpoints

Status/audit:

```bash
curl "https://your-domain.com/api/admin/qstash-status" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Dry-run transfer existing Redis schedules to QStash:

```bash
curl -X POST "https://your-domain.com/api/admin/transfer-to-qstash" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"pastDue":"skip"}'
```

Run the real transfer:

```bash
curl -X POST "https://your-domain.com/api/admin/transfer-to-qstash" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"pastDue":"skip"}'
```

Retry a failed job through QStash:

```bash
curl -X POST "https://your-domain.com/api/admin/retry-job" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user":"anton","jobId":30,"delaySeconds":60,"maxAttempts":3}'
```

Manually fire a failed or pending job now:

```bash
curl -X POST "https://your-domain.com/api/admin/fire-job-now" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user":"anton","jobId":30}'
```

Cancel a QStash-backed job:

```bash
curl -X POST "https://your-domain.com/api/admin/cancel-qstash-job" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user":"anton","jobId":30,"markCancelled":true}'
```

## Transfer Options

`/api/admin/transfer-to-qstash` accepts:

```json
{
  "dryRun": true,
  "force": false,
  "pastDue": "skip",
  "defaultMaxAttempts": 3
}
```

`dryRun=true` reports what would happen without publishing QStash messages.

`force=true` replaces existing QStash messages when a job already has `qstashMessageId`.

`pastDue` controls old schedules whose `fireAt` is already in the past:

```text
skip        leave them unchanged and report them
scheduleNow publish them to QStash with a short delay
fireNow     fire them immediately through the same AppsFlyer path
markFailed  mark them failed with a migration note
```

Recommended first run:

```json
{"dryRun":true,"pastDue":"skip"}
```

Recommended safe real run after reviewing the report:

```json
{"dryRun":false,"pastDue":"skip"}
```

## Complete Transition Checklist

1. Add the QStash/admin environment variables.
2. Deploy the new code.
3. Open `/admin`, enter `ADMIN_SECRET`, save it, and click `Refresh Status`.
4. Schedule one test event from the dashboard and confirm it gets `deliveryMode: "qstash"` and a `qstashMessageId` in the admin panel.
5. In `/admin`, run Transfer Existing Schedules with `Dry run` enabled.
6. Review `pendingWithoutQStash`, `pastDue`, and `errors` from the transfer report.
7. Run the real transfer with the chosen `pastDue` mode by disabling `Dry run`.
8. Click `Refresh Status` and confirm `Cron-only` is `0`.
9. Keep Vercel Cron enabled briefly as a fallback. The cron code now skips jobs that have `deliveryMode: "qstash"` and `qstashMessageId`.
10. After confidence, remove the cron entry from `vercel.json` or stop configuring Vercel Cron.

## Failure Handling

QStash calls `/api/fire-scheduled-event`. That endpoint verifies the QStash signature, reloads the job from Redis, and ignores stale/cancelled/already-handled messages.

AppsFlyer failures are stored on the job as:

```text
status: failed
attempts
maxAttempts
lastAttemptAt
lastError
result
```

The admin panel displays failed jobs with retry, fire, and cancel actions. The main scheduler dashboard also shows retry/fire controls on failed timer cards. Retry schedules a new QStash delayed message. Fire sends the event immediately through the admin endpoint.

## Important Safety Behavior

QStash messages carry only:

```json
{"user":"anton","jobId":123,"fireAt":1780658829200}
```

The event body is loaded from Redis at firing time. If a timer was edited, cancelled, or already fired, stale QStash deliveries are acknowledged and ignored.
