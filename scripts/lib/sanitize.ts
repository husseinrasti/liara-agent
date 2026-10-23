/**
 * Sanitizes recorded Liara responses before they are committed as fixtures.
 * Keeps structure, app names and app/release ids; removes personal data,
 * credentials, env values and anything that looks like a token.
 */

const SAFE_ENV_KEYS = new Set(['PROBE_KEY', 'PROBE_A', 'PROBE_B', 'CHAOS_MODE', 'NODE_ENV', 'PORT', 'TZ']);

const PLACEHOLDER_BY_KEY: Record<string, string> = {
  email: 'user@example.com',
  phone: '09000000000',
  mobile: '09000000000',
  fullname: 'Sample User',
  fullName: 'Sample User',
  firstName: 'Sample',
  lastName: 'User',
  nationalCode: '0000000000',
  nationalID: '0000000000',
  postalCode: '0000000000',
  address: '<address>',
  accessKey: '<access-key>',
  secretKey: '<secret-key>',
  password: '<password>',
  token: '<token>',
  apiKey: '<api-key>',
  api_key: '<api-key>',
  avatar: '<avatar-url>',
  verificationCode: '<verification-code>',
  userID: '<user-id>',
  userId: '<user-id>',
  user_id: '<user-id>',
};

/** Money amounts are personal: numbers under these keys become a fixed sample value. */
const SAMPLE_NUMBER_BY_KEY: Record<string, number> = { balance: 1_000_000, remainingFreeCredit: 0 };

/** Keys whose whole value (any type) is replaced. */
const DROP_KEYS = new Set(['contactInfo', 'utm']);

/** Parent keys whose `_id` is a user/team id. */
const USER_CONTAINERS = new Set(['user', 'team', 'owner', 'author', 'creator', 'member']);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PHONE_RE = /(?:\+98|0098|\b0)9\d{9}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function sanitizeString(s: string): string {
  return s
    .replace(JWT_RE, '<jwt>')
    .replace(BEARER_RE, 'Bearer <token>')
    .replace(EMAIL_RE, 'user@example.com')
    .replace(PHONE_RE, '09000000000')
    .replace(IPV4_RE, '203.0.113.10');
}

export function sanitize(value: unknown, parentKey = ''): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) {
    if (parentKey === 'envs' || parentKey === 'variables') return value.map(sanitizeEnvEntry);
    return value.map((v) => sanitize(v, parentKey));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) {
        out[k] = v === null ? null : '<removed>';
      } else if (k in SAMPLE_NUMBER_BY_KEY && typeof v === 'number') {
        out[k] = SAMPLE_NUMBER_BY_KEY[k];
      } else if (parentKey === 'balance' && k === 'value' && typeof v === 'number') {
        out[k] = SAMPLE_NUMBER_BY_KEY.balance;
      } else if (k in PLACEHOLDER_BY_KEY && v !== null && v !== undefined && v !== '') {
        out[k] = typeof v === 'string' ? PLACEHOLDER_BY_KEY[k] : '<redacted>';
      } else if (k === '_id' && USER_CONTAINERS.has(parentKey)) {
        out[k] = '<user-id>';
      } else if (k === 'user' && typeof v === 'string') {
        out[k] = '<user-id>';
      } else if (k === 'name' && USER_CONTAINERS.has(parentKey) && typeof v === 'string') {
        out[k] = 'Sample User';
      } else {
        out[k] = sanitize(v, k);
      }
    }
    return out;
  }
  return value;
}

function sanitizeEnvEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return sanitize(entry);
  const e = { ...(entry as Record<string, unknown>) };
  const key = typeof e.key === 'string' ? e.key : '';
  if ('value' in e && !SAFE_ENV_KEYS.has(key)) e.value = '<redacted>';
  return sanitize(e);
}
