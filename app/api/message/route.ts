// app/api/message/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PAYLOAD_CHARS = 900_000; // Upstash REST requests are capped at ~1MB
const MESSAGE_TTL_SECONDS = 300;
const INDEX_TTL_SECONDS = 600;

interface StoredMessage {
  payload: string;
  sender?: string;
  type?: string;
}

function serverError(error: unknown) {
  console.error('[api/message]', error);
  return NextResponse.json({ error: 'Server failure' }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { roomId, messageId, encryptedPayload, senderId, type } = body ?? {};

    if (!roomId || !messageId || !encryptedPayload) {
      return NextResponse.json({ error: 'Missing cryptographic payload' }, { status: 400 });
    }
    if (!ID_PATTERN.test(String(roomId)) || !ID_PATTERN.test(String(messageId))) {
      return NextResponse.json({ error: 'Invalid identifiers' }, { status: 400 });
    }
    if (typeof encryptedPayload !== 'string' || encryptedPayload.length > MAX_PAYLOAD_CHARS) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const redis = getRedis();
    const pipeline = redis.pipeline();
    pipeline.set(
      `msg:${roomId}:${messageId}`,
      JSON.stringify({ payload: encryptedPayload, sender: senderId, type: type || 'text' }),
      { ex: MESSAGE_TTL_SECONDS }
    );
    pipeline.sadd(`room:${roomId}:index`, messageId);
    pipeline.expire(`room:${roomId}:index`, INDEX_TTL_SECONDS);
    await pipeline.exec();

    return NextResponse.json({ success: true, messageId }, { status: 201 });
  } catch (error) {
    return serverError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const roomId = new URL(request.url).searchParams.get('roomId');
    if (!roomId || !ID_PATTERN.test(roomId)) {
      return NextResponse.json({ error: 'Missing Room ID' }, { status: 400 });
    }

    const redis = getRedis();
    const messageIds = await redis.smembers(`room:${roomId}:index`);
    if (messageIds.length === 0) {
      return NextResponse.json({ success: true, messages: [] }, { status: 200 });
    }

    // One round-trip for every message instead of one per message
    const values = await redis.mget<(StoredMessage | null)[]>(
      ...messageIds.map((id) => `msg:${roomId}:${id}`)
    );

    const messages: { id: string; payload: string; sender?: string; type?: string }[] = [];
    const expired: string[] = [];
    messageIds.forEach((id, i) => {
      const data = values[i];
      if (data) messages.push({ id, ...data });
      else expired.push(id);
    });
    if (expired.length > 0) await redis.srem(`room:${roomId}:index`, ...expired);

    return NextResponse.json({ success: true, messages }, { status: 200 });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    const messageId = searchParams.get('messageId');

    if (!roomId || !messageId || !ID_PATTERN.test(roomId) || !ID_PATTERN.test(messageId)) {
      return NextResponse.json({ error: 'Missing roomId or messageId' }, { status: 400 });
    }

    const redis = getRedis();
    await redis.srem(`room:${roomId}:index`, messageId);
    await redis.del(`msg:${roomId}:${messageId}`);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return serverError(error);
  }
}