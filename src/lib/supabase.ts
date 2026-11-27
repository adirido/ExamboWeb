import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const rawSupabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const rawSupabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const supabaseUrl = rawSupabaseUrl;
export const supabaseAnonKey = rawSupabaseAnonKey;
export const apiBaseUrl =
  rawApiBaseUrl || (rawSupabaseUrl ? `${rawSupabaseUrl}/functions/v1/api` : '');
export const isSupabaseMode = Boolean(supabaseUrl && supabaseAnonKey);

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseMode) return null;
  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedClient;
}

export function resolveApiUrl(apiPath: string): string {
  if (!apiBaseUrl) {
    return apiPath;
  }
  const normalized = apiPath.replace(/^\/api(?=\/|$)/, '');
  return `${apiBaseUrl}${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
}

export function buildApiHeaders(
  appToken?: string | null,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };

  if (apiBaseUrl && supabaseAnonKey) {
    headers.apikey = supabaseAnonKey;
    const isJwtAnonKey = supabaseAnonKey.split('.').length === 3;
    if (isJwtAnonKey) {
      headers.Authorization = `Bearer ${supabaseAnonKey}`;
    } else if (appToken) {
      headers.Authorization = `Bearer ${appToken}`;
    }
    if (appToken) {
      headers['X-ExamFlow-Token'] = appToken;
    }
  } else if (appToken) {
    headers.Authorization = `Bearer ${appToken}`;
  }

  return headers;
}
