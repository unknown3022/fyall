import crypto from 'crypto';

export const QUEUES = {
  anton: 'scheduler_queue_anton',
  fano: 'scheduler_queue_fano',
  jonas: 'scheduler_queue_jonas',
  grisha: 'scheduler_queue_grisha'
};

export const USERS = Object.keys(QUEUES);
export const MAX_LOGS = 300;

export function normalizeUser(user) {
  const normalized = String(user || '').toLowerCase();
  return QUEUES[normalized] ? normalized : null;
}

export function queueKeyForUser(user) {
  const normalized = normalizeUser(user);
  return normalized ? QUEUES[normalized] : null;
}

export function logKeyForQueue(queueKey) {
  return queueKey.replace('scheduler_queue_', 'scheduler_logs_');
}

export function disableCaching(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

export function requireRedisEnv() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Redis environment is not configured');
  }
}

function redisHeaders() {
  return {
    Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

export function parseStoredArray(value) {
  let result = value || [];
  if (typeof result === 'string') result = JSON.parse(result);
  if (typeof result === 'string') result = JSON.parse(result);
  return Array.isArray(result) ? result : [];
}

export async function readQueueByKey(queueKey) {
  requireRedisEnv();
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${queueKey}`, {
    headers: redisHeaders()
  });
  const data = await response.json();
  return parseStoredArray(data.result);
}

export async function writeQueueByKey(queueKey, queue) {
  requireRedisEnv();
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${queueKey}`, {
    method: 'POST',
    headers: redisHeaders(),
    body: JSON.stringify(JSON.stringify(queue))
  });
  if (!response.ok) throw new Error(`Redis queue write failed with ${response.status}`);
}

export async function readLogsByKey(logKey) {
  requireRedisEnv();
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${logKey}`, {
    headers: redisHeaders()
  });
  const data = await response.json();
  return parseStoredArray(data.result);
}

export async function writeLogsByKey(logKey, logs) {
  requireRedisEnv();
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${logKey}`, {
    method: 'POST',
    headers: redisHeaders(),
    body: JSON.stringify(JSON.stringify(logs.slice(-MAX_LOGS)))
  });
  if (!response.ok) throw new Error(`Redis log write failed with ${response.status}`);
}

export async function readQueueForUser(user) {
  const queueKey = queueKeyForUser(user);
  if (!queueKey) throw new Error('Invalid user');
  return readQueueByKey(queueKey);
}

export async function writeQueueForUser(user, queue) {
  const queueKey = queueKeyForUser(user);
  if (!queueKey) throw new Error('Invalid user');
  await writeQueueByKey(queueKey, queue);
}

export async function readLogsForUser(user) {
  const queueKey = queueKeyForUser(user);
  if (!queueKey) throw new Error('Invalid user');
  return readLogsByKey(logKeyForQueue(queueKey));
}

export async function appendLogsForUser(user, logs) {
  if (!logs.length) return;
  const queueKey = queueKeyForUser(user);
  if (!queueKey) throw new Error('Invalid user');
  const logKey = logKeyForQueue(queueKey);
  const previous = await readLogsByKey(logKey);
  await writeLogsByKey(logKey, [...previous, ...logs]);
}

export function newLog(type, message, item) {
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

export function describeItem(item) {
  const device = item.device_name || item.af_id || 'unknown device';
  const event = item.event?.name || item.event?.tmpl || 'unknown event';
  return `[${item.gameName || 'unknown game'}] ${event} (${device})`;
}

export function buildAuditLogs(before, after) {
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
    if (!newById.has(item.id)) logs.push(newLog('warn', `Removed ${describeItem(item)}`, item));
  }
  return logs;
}

export function requireAdmin(req) {
  if (!process.env.ADMIN_SECRET) throw new Error('ADMIN_SECRET is not configured');
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

function requireQStashEnv() {
  if (!process.env.QSTASH_TOKEN) throw new Error('QSTASH_TOKEN is not configured');
  if (!process.env.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is not configured');
}

function qstashDestination() {
  return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/fire-scheduled-event`;
}

export async function publishDelayedJob(user, item, options = {}) {
  requireQStashEnv();
  const now = Date.now();
  const delaySeconds = Math.max(0, Math.ceil(((options.fireAt ?? item.fireAt) - now) / 1000));
  const payload = {
    user: normalizeUser(user),
    jobId: item.id,
    fireAt: item.fireAt
  };

  const response = await fetch(`https://qstash.upstash.io/v2/publish/${qstashDestination()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': `${delaySeconds}s`,
      'Upstash-Retries': String(options.retries ?? 3)
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`QStash publish failed with ${response.status}: ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  return data.messageId || data.deduplicated?.messageId || data.raw || null;
}

export async function cancelQStashMessage(messageId) {
  if (!messageId) return { skipped: true };
  if (!process.env.QSTASH_TOKEN) throw new Error('QSTASH_TOKEN is not configured');
  const response = await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` }
  });
  const text = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new Error(`QStash cancel failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return { ok: response.ok, status: response.status };
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
  return Buffer.from(padded, 'base64');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verifyJwtWithKey(token, key, body) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSignature = base64UrlEncode(
    crypto.createHmac('sha256', key).update(`${encodedHeader}.${encodedPayload}`).digest()
  );
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return false;
  if (payload.nbf && now < payload.nbf) return false;

  if (payload.body) {
    const bodyHash = crypto.createHash('sha256').update(body || '').digest('base64url');
    if (payload.body !== bodyHash) return false;
  }
  return true;
}

export function verifyQStashSignature(req, rawBody) {
  const token = req.headers['upstash-signature'] || req.headers['Upstash-Signature'];
  if (!token) return false;
  const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter(Boolean);
  if (!keys.length) throw new Error('QStash signing keys are not configured');
  return keys.some(key => {
    try { return verifyJwtWithKey(token, key, rawBody); } catch (e) { return false; }
  });
}

export async function fireAppsFlyer(item) {
  const appId = item.appId || (item.platform === 'android' ? item.game?.pkg : item.game?.ios) || item.game?.pkg;
  if (!appId) throw new Error('Missing app ID for scheduled event');
  if (!item.game?.key) throw new Error('Missing AppsFlyer authentication key');
  if (!item.event?.tmpl) throw new Error('Missing event template');

  const eventValue = item.event?.value && Object.keys(item.event.value).length
    ? JSON.stringify(item.event.value)
    : '';
  const eventTime = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  const payload = {
    appsflyer_id: item.af_id,
    customer_user_id: item.device_name || '',
    eventName: item.event.tmpl,
    eventCurrency: 'USD',
    eventValue,
    eventTime
  };

  const response = await fetch(`https://api2.appsflyer.com/inappevent/${appId}`, {
    method: 'POST',
    headers: {
      authentication: item.game.key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body: body.slice(0, 1000), payload };
}

export async function fireStoredJob(user, jobId, options = {}) {
  const normalizedUser = normalizeUser(user);
  if (!normalizedUser) throw new Error('Invalid user');
  const queue = await readQueueForUser(normalizedUser);
  const item = queue.find(candidate => String(candidate.id) === String(jobId));
  const logs = [];

  if (!item) return { ignored: true, reason: 'not_found', queue };
  if (!options.ignoreStatus && item.status !== 'pending' && item.status !== 'failed') {
    return { ignored: true, reason: `status_${item.status}`, item, queue };
  }
  if (options.expectedFireAt && item.fireAt !== options.expectedFireAt) {
    return { ignored: true, reason: 'stale_fireAt', item, queue };
  }

  item.status = 'firing';
  item.attempts = (item.attempts || 0) + 1;
  item.lastAttemptAt = new Date().toISOString();
  item.updatedAt = item.lastAttemptAt;
  delete item.lastError;
  logs.push(newLog('warn', `${options.source || 'Scheduler'} firing ${describeItem(item)}`, item));
  await writeQueueForUser(normalizedUser, queue);

  try {
    const result = await fireAppsFlyer(item);
    item.status = result.ok ? 'done' : 'failed';
    item.firedAt = new Date().toISOString();
    item.result = { status: result.status, body: result.body };
    if (!result.ok) item.lastError = `AppsFlyer ${result.status}: ${result.body}`;
    logs.push(newLog(result.ok ? 'success' : 'error', `${options.source || 'Scheduler'} ${item.status}: ${describeItem(item)} [${result.status}]`, item));
    await writeQueueForUser(normalizedUser, queue);
    await appendLogsForUser(normalizedUser, logs);
    return { ok: result.ok, item, result, queue };
  } catch (error) {
    item.status = 'failed';
    item.firedAt = new Date().toISOString();
    item.lastError = error.message;
    item.error = error.message;
    logs.push(newLog('error', `${options.source || 'Scheduler'} failed: ${describeItem(item)} - ${error.message}`, item));
    await writeQueueForUser(normalizedUser, queue);
    await appendLogsForUser(normalizedUser, logs);
    return { ok: false, item, error: error.message, queue };
  }
}

export function hydrateQStashMetadata(item, messageId, extra = {}) {
  item.deliveryMode = 'qstash';
  item.qstashMessageId = messageId;
  item.qstashScheduledAt = new Date().toISOString();
  item.attempts = item.attempts || 0;
  item.maxAttempts = Number(extra.maxAttempts || item.maxAttempts || 3);
  item.manualFireAllowed = true;
  if (extra.transferBatchId) item.qstashTransferBatchId = extra.transferBatchId;
  return item;
}
