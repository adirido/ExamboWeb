import { getSupabaseClient, isSupabaseMode } from './lib/supabase';

export interface MonitoringRealtimeEvent {
  type?: string;
  packageId?: number;
  studentId?: number;
  sessionId?: number;
  payload?: {
    studentName?: string;
    nis?: string;
    violationType?: string;
    locked?: boolean;
    [key: string]: unknown;
  };
}

export function subscribeTeacherMonitoring(
  packageId: number,
  onEvent: (event: MonitoringRealtimeEvent) => void,
  onConnectionChange: (connected: boolean) => void
): () => void {
  const supabase = getSupabaseClient();
  if (isSupabaseMode && supabase) {
    const channel = supabase.channel(`examflow-package-${packageId}`);
    channel
      .on('broadcast', { event: '*' }, (msg) => {
        const eventData = (msg.payload || {}) as MonitoringRealtimeEvent;
        onEvent({
          ...eventData,
          type: eventData.type || msg.event,
        });
      })
      .subscribe((status) => {
        onConnectionChange(status === 'SUBSCRIBED');
      });

    return () => {
      onConnectionChange(false);
      supabase.removeChannel(channel);
    };
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/monitoring?role=teacher&packageId=${packageId}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => onConnectionChange(true);
  ws.onclose = () => onConnectionChange(false);
  ws.onerror = () => onConnectionChange(false);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as MonitoringRealtimeEvent;
      onEvent(msg);
    } catch {
      // ignore malformed messages
    }
  };

  return () => {
    onConnectionChange(false);
    ws.close();
  };
}

export function subscribeStudentUnlock(
  options: {
    sessionToken: string;
    packageId?: number;
    studentId?: number;
  },
  onUnlocked: () => void
): () => void {
  const { sessionToken, packageId, studentId } = options;
  const supabase = getSupabaseClient();

  if (isSupabaseMode && supabase) {
    if (!packageId) {
      return () => {};
    }
    const channel = supabase.channel(`examflow-package-${packageId}`);
    channel
      .on('broadcast', { event: 'session:unlocked' }, (msg) => {
        const eventData = (msg.payload || {}) as MonitoringRealtimeEvent;
        if (!studentId || eventData.studentId === studentId) {
          onUnlocked();
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/monitoring?role=student&sessionToken=${encodeURIComponent(
    sessionToken
  )}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as { type?: string };
      if (msg.type === 'session:unlocked') {
        onUnlocked();
      }
    } catch {
      // ignore malformed messages
    }
  };

  return () => {
    ws.close();
  };
}
