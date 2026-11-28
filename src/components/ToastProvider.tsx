import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, durationMs?: number) => void;
  success: (message: string, durationMs?: number) => void;
  error: (message: string, durationMs?: number) => void;
  info: (message: string, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismissToast = useCallback((id: number) => {
    const timerId = timersRef.current.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success', durationMs?: number) => {
      const cleanMessage = message.trim();
      if (!cleanMessage) return;

      const id = nextIdRef.current++;
      const timeout = durationMs ?? (type === 'error' ? 6000 : 4200);

      setToasts((prev) => {
        const next = [...prev, { id, type, message: cleanMessage }];
        return next.slice(-4);
      });

      const timerId = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, timeout);
      timersRef.current.set(id, timerId);
    },
    []
  );

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      timersRef.current.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      showToast,
      success: (message, durationMs) => showToast(message, 'success', durationMs),
      error: (message, durationMs) => showToast(message, 'error', durationMs),
      info: (message, durationMs) => showToast(message, 'info', durationMs),
    }),
    [showToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Floating Top-Right Semi-Transparent Notification Stack */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed top-4 right-4 z-[90] flex flex-col gap-2.5 w-[calc(100vw-2rem)] max-w-sm pointer-events-none print:hidden"
      >
        {toasts.map((toast) => {
          const isSuccess = toast.type === 'success';
          const isError = toast.type === 'error';

          return (
            <div
              key={toast.id}
              role={isError ? 'alert' : 'status'}
              className={`pointer-events-auto rounded-xl border px-4 py-3 text-xs font-medium flex items-start gap-2.5 backdrop-blur-md shadow-lg shadow-slate-900/10 transition-all duration-200 ${
                isSuccess
                  ? 'bg-emerald-50/80 border-emerald-200/85 text-emerald-950'
                  : isError
                    ? 'bg-red-50/80 border-red-200/85 text-red-950'
                    : 'bg-white/80 border-slate-200/85 text-slate-900'
              }`}
            >
              {isSuccess ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              ) : isError ? (
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
              )}

              <span className="flex-1 leading-relaxed">{toast.message}</span>

              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className={`p-0.5 rounded transition-colors shrink-0 cursor-pointer ${
                  isSuccess
                    ? 'text-emerald-700/70 hover:text-emerald-950'
                    : isError
                      ? 'text-red-700/70 hover:text-red-950'
                      : 'text-slate-400 hover:text-slate-800'
                }`}
                aria-label="Tutup notifikasi"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};
