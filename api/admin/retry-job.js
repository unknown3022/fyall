import {
  appendLogsForUser,
  cancelQStashMessage,
  describeItem,
  disableCaching,
  hydrateQStashMetadata,
  newLog,
  normalizeUser,
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
    const user = normalizeUser(body.user);
    if (!user) return res.status(400).json({ error: 'Invalid user' });
    const queue = await readQueueForUser(user);
    const item = queue.find(candidate => String(candidate.id) === String(body.jobId));
    if (!item) return res.status(404).json({ error: 'Job not found' });
    const maxAttempts = Number(body.maxAttempts || item.maxAttempts || 3);
    if (!body.force && (item.attempts || 0) >= maxAttempts) {
      return res.status(400).json({ error: `Retry limit reached (${item.attempts || 0}/${maxAttempts})` });
    }

    if (item.qstashMessageId) await cancelQStashMessage(item.qstashMessageId);
    const delaySeconds = Math.max(0, Number(body.delaySeconds || 60));
    item.fireAt = Date.now() + delaySeconds * 1000;
    item.totalSecs = delaySeconds;
    item.status = 'pending';
    item.maxAttempts = maxAttempts;
    item.updatedAt = new Date().toISOString();
    delete item.lastError;
    delete item.error;
    const messageId = await publishDelayedJob(user, item);
    hydrateQStashMetadata(item, messageId, { maxAttempts });
    await writeQueueForUser(user, queue);
    await appendLogsForUser(user, [newLog('info', `Admin retry scheduled ${describeItem(item)}`, item)]);
    return res.status(200).json({ ok: true, item });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
