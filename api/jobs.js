const QUEUES = {
  anton: 'scheduler_queue_anton',
  fano: 'scheduler_queue_fano',
  jonas: 'scheduler_queue_jonas',
  grisha: 'scheduler_queue_grisha'
};

const MAX_LOGS = 300;

function queueKeyForUser(user) {
  return QUEUES[String(user || '').toLowerCase()] || null;
}

function logKeyForQueue(queueKey) {
  return queueKey.replace('scheduler_queue_', 'scheduler_logs_');
}

function redisHeaders() {
  return {
    Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function disableCaching(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function readQueue(key) {
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: redisHeaders()
  });
  const data = await response.json();
  let queue = data.result || [];
  if (typeof queue === 'string') queue = JSON.parse(queue);
  if (typeof queue === 'string') queue = JSON.parse(queue);
  return Array.isArray(queue) ? queue : [];
}

async function readLogs(key) {
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: redisHeaders()
  });
  const data = await response.json();
  let logs = data.result || [];
  if (typeof logs === 'string') logs = JSON.parse(logs);
  if (typeof logs === 'string') logs = JSON.parse(logs);
  return Array.isArray(logs) ? logs : [];
}

async function writeQueue(key, queue) {
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${key}`, {
    method: 'POST',
    headers: redisHeaders(),
    body: JSON.stringify(JSON.stringify(queue))
  });

  if (!response.ok) {
    throw new Error(`Redis write failed with ${response.status}`);
  }
}

async function writeLogs(key, logs) {
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${key}`, {
    method: 'POST',
    headers: redisHeaders(),
    body: JSON.stringify(JSON.stringify(logs.slice(-MAX_LOGS)))
  });

  if (!response.ok) {
    throw new Error(`Redis log write failed with ${response.status}`);
  }
}

function newLog(type, message, item) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    type,
    message,
    itemId: item?.id,
    gameName: item?.gameName,
    eventName: item?.event?.name,
    eventTemplate: item?.event?.tmpl,
    af_id: item?.af_id,
    device_name: item?.device_name || ''
  };
}

function describeItem(item) {
  const device = item.device_name || item.af_id || 'unknown device';
  const event = item.event?.name || item.event?.tmpl || 'unknown event';
  return `[${item.gameName || 'unknown game'}] ${event} (${device})`;
}

function buildAuditLogs(before, after) {
  const oldById = new Map(before.map(item => [item.id, item]));
  const newById = new Map(after.map(item => [item.id, item]));
  const logs = [];

  for (const item of after) {
    const old = oldById.get(item.id);
    if (!old) {
      logs.push(newLog('info', `Scheduled ${describeItem(item)}`, item));
      continue;
    }

    if (old.status !== item.status) {
      const type = item.status === 'done' ? 'success' : item.status === 'failed' ? 'error' : 'warn';
      logs.push(newLog(type, `Status changed ${old.status} -> ${item.status}: ${describeItem(item)}`, item));
    }

    if (old.fireAt !== item.fireAt || old.af_id !== item.af_id || old.device_name !== item.device_name) {
      logs.push(newLog('info', `Updated ${describeItem(item)}`, item));
    }
  }

  for (const item of before) {
    if (!newById.has(item.id)) {
      logs.push(newLog('warn', `Removed ${describeItem(item)}`, item));
    }
  }

  return logs;
}

export default async function handler(req, res) {
  disableCaching(res);

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Redis environment is not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const user = req.method === 'GET' ? req.query.user : body.user;
    const key = queueKeyForUser(user);
    if (!key) return res.status(400).json({ error: 'Invalid user' });

    if (req.method === 'GET') {
      const queue = await readQueue(key);
      const logs = await readLogs(logKeyForQueue(key));
      return res.status(200).json({ queue, logs });
    }

    if (req.method === 'PUT') {
      const queue = Array.isArray(body.queue) ? body.queue : null;
      if (!queue) return res.status(400).json({ error: 'Queue must be an array' });
      const previousQueue = await readQueue(key);
      const logKey = logKeyForQueue(key);
      const previousLogs = await readLogs(logKey);
      const auditLogs = buildAuditLogs(previousQueue, queue);
      await writeQueue(key, queue);
      if (auditLogs.length) await writeLogs(logKey, [...previousLogs, ...auditLogs]);
      return res.status(200).json({ ok: true, logsAdded: auditLogs.length });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
