import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

export interface RealtimeEvent {
  type:
    | 'session:updated'
    | 'violation:alert'
    | 'session:unlocked'
    | 'package:token_rotated'
    | 'package:status_changed';
  packageId: number;
  studentId?: number;
  sessionId?: number;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface ClientSubscription {
  ws: WebSocket;
  packageId: number | null;
  sessionToken: string | null;
  role: 'teacher' | 'student';
}

const clients = new Set<ClientSubscription>();

export function setupWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/monitoring' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const packageIdParam = url.searchParams.get('packageId');
    const sessionTokenParam = url.searchParams.get('sessionToken');
    const roleParam = url.searchParams.get('role') === 'student' ? 'student' : 'teacher';

    const sub: ClientSubscription = {
      ws,
      packageId: packageIdParam ? Number(packageIdParam) : null,
      sessionToken: sessionTokenParam || null,
      role: roleParam,
    };
    clients.add(sub);

    ws.send(
      JSON.stringify({
        type: 'connection:ready',
        role: sub.role,
        packageId: sub.packageId,
        timestamp: Date.now(),
      })
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; packageId?: number; sessionToken?: string };
        if (msg.type === 'subscribe' && typeof msg.packageId === 'number') {
          sub.packageId = msg.packageId;
        }
        if (msg.type === 'subscribe_student' && typeof msg.sessionToken === 'string') {
          sub.sessionToken = msg.sessionToken;
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    ws.on('close', () => {
      clients.delete(sub);
    });
  });
}

export function broadcastPackageEvent(event: RealtimeEvent): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.role === 'teacher') {
      if (client.packageId === null || client.packageId === event.packageId) {
        client.ws.send(message);
      }
    } else if (client.role === 'student' && event.payload.sessionToken) {
      if (client.sessionToken === event.payload.sessionToken) {
        client.ws.send(message);
      }
    }
  }
}
