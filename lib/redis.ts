// lib/redis.ts
import { Redis } from '@upstash/redis';

let client: Redis | null = null;

// Created lazily, on the first request, so `next build` never fails just because
// env vars are missing at build time. Supports both the manual Upstash variable
// names and the KV_* names Vercel's Upstash integration injects.
export function getRedis(): Redis {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Missing Redis credentials: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project environment variables.'
    );
  }
  client = new Redis({ url, token });
  return client;
}