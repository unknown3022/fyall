export default async function handler(req, res) {
  // Verify it's called by Vercel Cron
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const MAX_LOGS = 300;

  const parseQueue = (value) => {
    let queue = value || [];
    if (typeof queue === 'string') queue = JSON.parse(queue);
    if (typeof queue === 'string') queue = JSON.parse(queue);
    return Array.isArray(queue) ? queue : [];
  };

  const saveQueue = (queueKey, queue) => fetch(`${url}/set/${queueKey}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(JSON.stringify(queue))
  });

  const logKeyForQueue = (queueKey) => queueKey.replace('scheduler_queue_', 'scheduler_logs_');

  const readLogs = async (logKey) => {
    const response = await fetch(`${url}/get/${logKey}`, { headers });
    const data = await response.json();
    let logs = data.result || [];
    if (typeof logs === 'string') logs = JSON.parse(logs);
    if (typeof logs === 'string') logs = JSON.parse(logs);
    return Array.isArray(logs) ? logs : [];
  };

  const saveLogs = (logKey, logs) => fetch(`${url}/set/${logKey}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(JSON.stringify(logs.slice(-MAX_LOGS)))
  });

  const describeItem = (item) => {
    const device = item.device_name || item.af_id || 'unknown device';
    const event = item.event?.name || item.event?.tmpl || 'unknown event';
    return `[${item.gameName || 'unknown game'}] ${event} (${device})`;
  };

  const newLog = (type, message, item) => ({
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
  });

  const queues = [
    'scheduler_queue_anton',
    'scheduler_queue_fano',
    'scheduler_queue_jonas',
    'scheduler_queue_grisha'   // ← added
  ];

  let totalFired = 0;
  const now = Date.now();

  for (const queueKey of queues) {
    try {
      // Load queue
      const r = await fetch(`${url}/get/${queueKey}`, { headers });
      const data = await r.json();
      if (!data.result) continue;

      let queue = parseQueue(data.result);
      if (!Array.isArray(queue) || !queue.length) continue;

      let changed = false;
      const cronLogs = [];

      for (const item of queue) {
        if (item.deliveryMode === 'qstash' && item.qstashMessageId) continue;
        if (item.status !== 'pending') continue;
        if (now < item.fireAt) continue;

        item.status = 'firing';
        item.updatedAt = new Date().toISOString();
        cronLogs.push(newLog('warn', `Cron firing ${describeItem(item)}`, item));
        await saveQueue(queueKey, queue);

        try {
          const appId = item.appId || (item.platform === 'android' ? item.game?.pkg : item.game?.ios) || item.game?.pkg;
          if (!appId) throw new Error('Missing app ID for scheduled event');

          const eventValue = item.event?.value && Object.keys(item.event.value).length
            ? JSON.stringify(item.event.value)
            : "";

          const eventTime = new Date().toISOString()
            .replace('T', ' ').replace('Z', '').slice(0, 23);

          const payload = {
            appsflyer_id:      item.af_id,
            customer_user_id:  item.device_name || '',
            eventName:         item.event.tmpl,
            eventCurrency:     "USD",
            eventValue,
            eventTime
          };

          const fireRes = await fetch(`https://api2.appsflyer.com/inappevent/${appId}`, {
            method: 'POST',
            headers: {
              'authentication':  item.game.key,
              'Content-Type':    'application/json'
            },
            body: JSON.stringify(payload)
          });

          const responseText = await fireRes.text();
          item.status = fireRes.ok ? 'done' : 'failed';
          item.firedAt = new Date().toISOString();
          item.result = {
            status: fireRes.status,
            body: responseText.slice(0, 1000)
          };
          delete item.error;
          cronLogs.push(newLog(item.status === 'done' ? 'success' : 'error', `Cron ${item.status}: ${describeItem(item)} [${fireRes.status}]`, item));
          totalFired++;
        } catch (e) {
          item.status = 'failed';
          item.firedAt = new Date().toISOString();
          item.error = e.message;
          cronLogs.push(newLog('error', `Cron failed: ${describeItem(item)} - ${e.message}`, item));
          console.error(`Fire error for ${queueKey} item ${item.id}:`, e.message);
        }
        changed = true;
      }

      // Save back if anything changed
      if (changed) {
        await saveQueue(queueKey, queue);
        if (cronLogs.length) {
          const logKey = logKeyForQueue(queueKey);
          const existingLogs = await readLogs(logKey);
          await saveLogs(logKey, [...existingLogs, ...cronLogs]);
        }
      }
    } catch (e) {
      console.error(`Error processing ${queueKey}:`, e.message);
    }
  }

  res.status(200).json({ ok: true, fired: totalFired, timestamp: new Date().toISOString() });
}
