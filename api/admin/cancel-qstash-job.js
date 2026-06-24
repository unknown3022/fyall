import {
  appendLogsForUser,
  cancelQStashMessage,
  describeItem,
  disableCaching,
  newLog,
  normalizeUser,
  parseBody,
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
    const cancelResult = item.qstashMessageId ? await cancelQStashMessage(item.qstashMessageId) : { skipped: true };
    delete item.qstashMessageId;
    if (body.markCancelled !== false) item.status = 'cancelled';
    item.updatedAt = new Date().toISOString();
    await writeQueueForUser(user, queue);
    await appendLogsForUser(user, [newLog('warn', `Admin cancelled QStash job ${describeItem(item)}`, item)]);
    return res.status(200).json({ ok: true, cancelResult, item });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
