import {
  appendLogsForUser,
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
    if (!body.item || body.item.fireAt === undefined) return res.status(400).json({ error: 'Missing scheduled item' });

    const queue = await readQueueForUser(user);
    const item = {
      ...body.item,
      status: 'pending',
      attempts: body.item.attempts || 0,
      maxAttempts: Number(body.item.maxAttempts || body.maxAttempts || 3),
      manualFireAllowed: true
    };

    const messageId = await publishDelayedJob(user, item);
    hydrateQStashMetadata(item, messageId, { maxAttempts: item.maxAttempts });
    queue.push(item);
    await writeQueueForUser(user, queue);
    await appendLogsForUser(user, [newLog('info', `Scheduled via QStash ${describeItem(item)}`, item)]);

    return res.status(200).json({ ok: true, item });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
