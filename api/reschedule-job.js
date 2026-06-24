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
  writeQueueForUser
} from './_scheduler.js';

export default async function handler(req, res) {
  disableCaching(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = parseBody(req);
    const user = normalizeUser(body.user);
    if (!user) return res.status(400).json({ error: 'Invalid user' });

    const queue = await readQueueForUser(user);
    const item = queue.find(candidate => String(candidate.id) === String(body.jobId));
    if (!item) return res.status(404).json({ error: 'Job not found' });
    if (item.status !== 'pending' && item.status !== 'failed') return res.status(400).json({ error: `Cannot reschedule status ${item.status}` });

    if (item.qstashMessageId) await cancelQStashMessage(item.qstashMessageId);
    Object.assign(item, body.updates || {});
    item.status = 'pending';
    item.updatedAt = new Date().toISOString();
    item.lastError = null;
    delete item.error;
    const messageId = await publishDelayedJob(user, item);
    hydrateQStashMetadata(item, messageId, { maxAttempts: item.maxAttempts || body.maxAttempts || 3 });
    await writeQueueForUser(user, queue);
    await appendLogsForUser(user, [newLog('info', `Rescheduled via QStash ${describeItem(item)}`, item)]);

    return res.status(200).json({ ok: true, item });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
