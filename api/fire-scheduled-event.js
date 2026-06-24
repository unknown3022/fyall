import { disableCaching, fireStoredJob, parseBody, verifyQStashSignature } from './_scheduler.js';

export default async function handler(req, res) {
  disableCaching(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  try {
    if (!verifyQStashSignature(req, rawBody)) {
      return res.status(401).json({ error: 'Invalid QStash signature' });
    }

    const body = parseBody(req);
    if (!body.user || body.jobId === undefined || !body.fireAt) {
      return res.status(400).json({ error: 'Missing user, jobId, or fireAt' });
    }

    const result = await fireStoredJob(body.user, body.jobId, {
      expectedFireAt: body.fireAt,
      source: 'QStash'
    });

    // Stale/cancelled/already handled deliveries are acknowledged so QStash does not retry them.
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
