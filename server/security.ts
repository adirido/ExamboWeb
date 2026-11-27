import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// Runtime-generated fallback secret ensures no hardcoded credentials while keeping server statelessly signed per boot
const RUNTIME_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

function getMasterSecret(): Buffer {
  const raw = process.env.EXAMFLOW_QR_SECRET?.trim() || RUNTIME_FALLBACK_SECRET;
  return crypto.createHash('sha256').update(raw).digest();
}

export function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(plain: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export interface QrPackagePayload {
  packageId: number;
  classId: number;
  subjectCode: string;
  title: string;
  issuedAt: number;
  nonce: string;
}

export function encryptQrPayload(payload: Omit<QrPackagePayload, 'issuedAt' | 'nonce'>): string {
  const fullPayload: QrPackagePayload = {
    ...payload,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const key = getMasterSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(fullPayload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'ef1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptQrPayload(token: string): QrPackagePayload | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'ef1') return null;
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    const key = getMasterSecret();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as QrPackagePayload;
    if (!parsed || typeof parsed.packageId !== 'number' || typeof parsed.classId !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encryptTextWithKey(plain: string, keyMaterial: string): string {
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'p1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptTextWithKey(cipherText: string, keyMaterial: string): string | null {
  try {
    const parts = cipherText.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'p1') return null;
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const encrypted = Buffer.from(parts[3], 'base64url');
    const key = crypto.createHash('sha256').update(keyMaterial).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface TeacherTokenClaims {
  teacherId: number;
  email: string;
  name: string;
  role: 'TEACHER' | 'ADMIN';
  exp: number;
}

export function createTeacherToken(claims: Omit<TeacherTokenClaims, 'exp'>): string {
  const payload: TeacherTokenClaims = {
    ...claims,
    exp: Date.now() + 1000 * 60 * 60 * 12, // 12 hours
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getMasterSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyTeacherToken(token: string): TeacherTokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', getMasterSecret()).update(data).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as TeacherTokenClaims;
    if (!parsed || typeof parsed.teacherId !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function generateExamToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[crypto.randomInt(0, chars.length)];
  }
  return result;
}

export function generateSemesterPin(): string {
  return String(crypto.randomInt(100000, 999999));
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function constantTimeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface AuthenticatedTeacherRequest extends Request {
  teacher?: TeacherTokenClaims;
}

export function requireTeacherAuth(req: AuthenticatedTeacherRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Autentikasi guru diperlukan.' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const claims = verifyTeacherToken(token);
  if (!claims) {
    res.status(401).json({ error: 'Sesi guru tidak valid atau telah berakhir.' });
    return;
  }
  req.teacher = claims;
  next();
}

export function requireExambroClient(req: Request, res: Response, next: NextFunction): void {
  const clientHeader = String(req.headers['x-exambro-client'] || '').trim();
  const allowedPrefixes = ['ExamFlow-Exambro-Android/', 'ExambroPro-Android-', 'ExamFlow-Web-Portal/'];
  const hasValidClientHeader = allowedPrefixes.some((prefix) => clientHeader.startsWith(prefix));

  if (!hasValidClientHeader) {
    res.status(403).json({
      error: 'Akses ditolak. Endpoint ini hanya menerima permintaan dari klien APK Exambro atau Portal Ujian terverifikasi.',
      code: 'INVALID_EXAMBRO_CLIENT',
    });
    return;
  }

  const strictMode = process.env.EXAMBRO_STRICT_HEADER === 'true';
  const configuredKey = process.env.EXAMBRO_CLIENT_KEY?.trim();
  if (strictMode && configuredKey) {
    const providedKey = String(req.headers['x-exambro-key'] || '').trim();
    if (!providedKey || !constantTimeEqualText(providedKey, configuredKey)) {
      res.status(403).json({
        error: 'Kunci aplikasi Exambro (X-Exambro-Key) tidak valid.',
        code: 'INVALID_EXAMBRO_KEY',
      });
      return;
    }
  }

  next();
}
