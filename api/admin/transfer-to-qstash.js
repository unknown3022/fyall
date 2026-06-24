import {
  USERS,
  appendLogsForUser,
  cancelQStashMessage,
  describeItem,
  disableCaching,
  fireStoredJob,
  hydrateQStashMetadata,
  newLog,
  parseBody,
  publishDelayedJob,
  readQueueForUser,
  requireAdmin,
  writeQueueForUser
} from '../_scheduler.js';

export default async function handler(req, res) {
  disableCaching(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    requireAdmin(req);
    const body = parseBody(req);
    const dryRun = body.dryRun !== false;
    const force = body.force === true;
    const pastDue = body.pastDue || 'skip';
    const defaultMaxAttempts = Number(body.defaultMaxAttempts || 3);
    const batchId = `transfer-${new Date().toISOString()}`;
    const report = {
      ok: true,
      dryRun,
      force,
      pastDue,
      batchId,
      summary: { checked: 0, scheduled: 0, pastDue: 0, alreadyTransferred: 0, nonPending: 0, errors: 0, firedNow: 0, markedFailed: 0 },
      queues: {}
    };

    for (const user of USERS) {
      const queueReport = { scheduled: [], pastDue: [], alreadyTransferred: [], nonPending: [], firedNow: [], markedFailed: [], errors: [] };
      report.queues[user] = queueReport;
      const queue = await readQueueForUser(user);
      let changed = false;

      for (const item of queue) {
        report.summary.checked++;
        try {
          if (item.status !== 'pending') {
            report.summary.nonPending++;
            queueReport.nonPending.push(item.id);
            continue;
          }

          if (item.qstashMessageId && item.deliveryMode === 'qstash' && !force) {
            report.summary.alreadyTransferred++;
            queueReport.alreadyTransferred.push(item.id);
            continue;
          }

          const isPastDue = Date.now() >= item.fireAt;
          if (isPastDue) {
            report.summary.pastDue++;
            queueReport.pastDue.push(item.id);
            if (pastDue === 'skip') continue;
            if (pastDue === 'markFailed') {
              if (!dryRun) {
                item.status = 'failed';
                item.lastError = `Marked failed during QStash transfer batch ${batchId}: job was past due`;
                item.updatedAt = new Date().toISOString();
                changed = true;
              }
              report.summary.markedFailed++;
              queueReport.markedFailed.push(item.id);
              continue;
            }
            if (pastDue === 'fireNow') {
              if (!dryRun) {
                const fireResult = await fireStoredJob(user, item.id, { source: 'Admin transfer', ignoreStatus: true });
                if (fireResult.item) {
                  Object.assign(item, fireResult.item);
                  changed = true;
                }
              }
              report.summary.firedNow++;
              queueReport.firedNow.push(item.id);
              continue;
            }
            if (pastDue === 'scheduleNow') {
              item.fireAt = Date.now() + 5000;
              item.totalSecs = 5;
            } else {
              throw new Error(`Unsupported pastDue mode: ${pastDue}`);
            }
          }

          if (!dryRun) {
            if (force && item.qstashMessageId) await cancelQStashMessage(item.qstashMessageId);
            item.maxAttempts = Number(item.maxAttempts || defaultMaxAttempts);
            const messageId = await publishDelayedJob(user, item);
            hydrateQStashMetadata(item, messageId, { maxAttempts: item.maxAttempts, transferBatchId: batchId });
            changed = true;
          }
          report.summary.scheduled++;
          queueReport.scheduled.push(item.id);
        } catch (error) {
          report.summary.errors++;
          queueReport.errors.push({ id: item.id, error: error.message });
        }
      }

      if (!dryRun && changed) {
        await writeQueueForUser(user, queue);
        await appendLogsForUser(user, [newLog('info', `QStash transfer batch ${batchId} updated ${queueReport.scheduled.length} job(s)`, null)]);
      }
    }

    return res.status(200).json(report);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
