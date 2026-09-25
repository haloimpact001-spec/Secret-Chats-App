// app/api/message/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { roomId, messageId, encryptedPayload, senderId, type } = body;

    if (!roomId || !messageId || !encryptedPayload) {
      return NextResponse.json({ error: 'Missing cryptographic payload' }, { status: 400 });
    }

    await redis.set(
      `msg:${roomId}:${messageId}`, 
      JSON.stringify({ payload: encryptedPayload, sender: senderId, type: type || 'text' }), 
      { ex: 300 } 
    );

    await redis.sadd(`room:${roomId}:index`, messageId);
    await redis.expire(`room:${roomId}:index`, 600);

    return NextResponse.json({ success: true, messageId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    if (!roomId) return NextResponse.json({ error: 'Missing Room ID' }, { status: 400 });

    const messageIds = await redis.smembers(`room:${roomId}:index`);
    const messages = [];

    for (const msgId of messageIds) {
      const data = await redis.get(`msg:${roomId}:${msgId}`);
      if (data) {
        messages.push({ id: msgId, ...(data as any) });
      } else {
        await redis.srem(`room:${roomId}:index`, msgId);
      }
    }
    return NextResponse.json({ success: true, messages }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}

// --- NEW DELETE ROUTE ---
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    const messageId = searchParams.get('messageId');

    if (!roomId || !messageId) {
      return NextResponse.json({ error: 'Missing roomId or messageId' }, { status: 400 });
    }

    // Remove from index and delete the actual message
    await redis.srem(`room:${roomId}:index`, messageId);
    await redis.del(`msg:${roomId}:${messageId}`);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}