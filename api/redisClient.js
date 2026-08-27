import { Redis } from '@upstash/redis';

// Two naming conventions reach the same database:
//   - KV_REST_API_URL / KV_REST_API_TOKEN — what the Vercel Marketplace injects when
//     Upstash is provisioned through an integration.
//   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — what Upstash's own SDK
//     (`Redis.fromEnv()`) expects, and what a hand-configured instance uses.
//
// The marketplace names win, because a project that once had a hand-configured instance
// keeps its old UPSTASH_* variables after that database is deleted. Reading those first
// would point every request at a database that no longer exists — which is exactly how
// a deleted Upstash instance turned into an opaque 500 on the signing path.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** null when no Redis is configured; callers decide whether that is fatal */
export const redis = url && token ? new Redis({ url, token }) : null;
