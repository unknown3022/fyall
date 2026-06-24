import { USERS, disableCaching, readQueueForUser, requireAdmin } from '../_scheduler.js';

function summarizeItem(user, item) {
  return {
    user,
    id: item.id,
    status: item.status,
    gameName: item.gameName,
    eventName: item.event?.name,
    eventTemplate: item.event?.tmpl,
    af_id: item.af_id,
    device_name: item.device_name || '',
    fireAt: item.fireAt,
    qstashMessageId: item.qstashMessageId || null,
    deliveryMode: item.deliveryMode || null,
    attempts: item.attempts || 0,
    maxAttempts: item.maxAttempts || 3,
    lastAttemptAt: item.lastAttemptAt || null,
    lastError: item.lastError || item.error || null
  };
}

export default async function handler(req, res) {
  disableCaching(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    requireAdmin(req);
    const result = {
      ok: true,
      summary: { pendingWithQStash: 0, pendingWithoutQStash: 0, failed: 0, done: 0, cancelled: 0, firing: 0, total: 0 },
      pendingWithoutQStash: [],
      failedJobs: [],
      queues: {}
    };

    for (const user of USERS) {
      const queue = await readQueueForUser(user);
      result.queues[user] = queue.map(item => summarizeItem(user, item));
      for (const item of queue) {
        result.summary.total++;
        if (item.status === 'pending') {
          if (item.qstashMessageId && item.deliveryMode === 'qstash') result.summary.pendingWithQStash++;
          else {
            result.summary.pendingWithoutQStash++;
            result.pendingWithoutQStash.push(summarizeItem(user, item));
          }
        } else if (item.status === 'failed') {
          result.summary.failed++;
          result.failedJobs.push(summarizeItem(user, item));
        } else if (item.status === 'done') result.summary.done++;
        else if (item.status === 'cancelled') result.summary.cancelled++;
        else if (item.status === 'firing') result.summary.firing++;
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
