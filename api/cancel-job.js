import {
  appendLogsForUser,
  cancelQStashMessage,
  describeItem,
  disableCaching,
  newLog,
  normalizeUser,
  parseBody,
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

    let queue = await readQueueForUser(user);
    const item = queue.find(candidate => String(candidate.id) === String(body.jobId));
    if (!item) return res.status(404).json({ error: 'Job not found' });

    let cancelResult = null;
    if (item.qstashMessageId) cancelResult = await cancelQStashMessage(item.qstashMessageId);
    if (body.markCancelled) {
      item.status = 'cancelled';
      item.updatedAt = new Date().toISOString();
      delete item.qstashMessageId;
    } else {
      queue = queue.filter(candidate => String(candidate.id) !== String(body.jobId));
    }
    await writeQueueForUser(user, queue);
    await appendLogsForUser(user, [newLog('warn', `Cancelled ${describeItem(item)}`, item)]);

    return res.status(200).json({ ok: true, cancelResult, queue });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
