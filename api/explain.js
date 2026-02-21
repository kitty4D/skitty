import { GoogleGenerativeAI } from '@google/generative-ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { EXPLAIN_REQUESTS_PER_MINUTE, EXPLAIN_REQUESTS_PER_DAY } from './constants.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const rpmLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(EXPLAIN_REQUESTS_PER_MINUTE, '1 m'),
  prefix: 'ratelimit_rpm',
  analytics: true,
});

const rpdLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(EXPLAIN_REQUESTS_PER_DAY, '1440 m'),
  prefix: 'ratelimit_rpd',
  analytics: true,
});

const SYSTEM_INSTRUCTION = `You are Skitty, a diligent worker cat in the Sui ecosystem. Your job is to look at raw Sui Transaction JSON and explain what happened in simple, friendly layman's terms where possible, but always provide all of the details even if they can't all be given in simple terms.  The user wants to know if what the transaction request or response shows is harmful for them, what the transaction is attempting to do, and what the outcome actually is.

For items that are being deleted, destroyed, or burned - if the item is a coin, and they had a 0 balance, then the user will know that nothing bad can happen as a result of destroying.  If the item is some other kind of object, make sure they know if the item is not essential for any dApps or potential airdrops, because losing progress could be an unintended side effect.

Use a few cat emojis (🐾, 😺) and keep it fun!`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const identifier = 'global_skitty_limit';
    
    // check the limit by minute
    let result = await rpmLimit.limit(identifier);

    // if limit by minute was ok, check limit by day
    if (result.success) {
      result = await rpdLimit.limit(identifier);
    }

    // destructure that final result (fail RPM, fail RPD, or good RPD)
    const { success, reset } = result;

    if (!success) {
      const now = Date.now();
      const retryAfter = Math.max(0, Math.floor((reset - now) / 1000));
      const isDailyLimit = retryAfter > 60;

      return res.status(429).json({
        error: isDailyLimit
          ? 'Skitty is exhausted for the day! 🐾'
          : 'Slow down! Skitty is typing as fast as she can. 🐾',
        retryAfterSeconds: retryAfter,
        resetAt: new Date(reset).toLocaleTimeString(),
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { transactionData } = body;
    if (transactionData === undefined) {
      return res.status(400).json({ error: 'Missing transactionData in body' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const prompt = `Explain what this Sui transaction attempts to do and what the response says it does, as simply as possible but provide all of the details:\n\n${JSON.stringify(transactionData)}`;

    try {
      const genResult = await model.generateContent(prompt);
      const response = genResult.response;
      const text = response?.text?.() ?? '';
      return res.status(200).json({ explanation: text });
    } catch (err) {
      console.error('Gemini explain error:', err);
      return res.status(500).json({
        error: err?.message ?? 'Failed to get explanation from Gemini',
      });
    }

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong in the cat-cave." });
  }

}
