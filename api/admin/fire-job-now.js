import { cancelQStashMessage, disableCaching, fireStoredJob, normalizeUser, parseBody, readQueueForUser, requireAdmin } from '../_scheduler.js';

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
    if (item.qstashMessageId) await cancelQStashMessage(item.qstashMessageId);
    const result = await fireStoredJob(user, body.jobId, {
      source: 'Admin manual fire',
      ignoreStatus: body.ignoreStatus === true
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
