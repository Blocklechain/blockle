// Config from env with safe defaults. Secrets (SESSION_SECRET, PayPal, admin seed) come from
// the environment only — never the repo. Missing secrets fail closed at startup in prod.
import crypto from 'node:crypto';

const env = process.env;
const bool = (v, d) => (v == null ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: +(env.ACCOUNTS_PORT || 8930),
  host: env.ACCOUNTS_HOST || '127.0.0.1',
  dataDir: env.ACCOUNTS_DATA || '/opt/blockle/accounts-data',
  socialDataDir: env.ACCOUNTS_SOCIAL_DATA || '/opt/blockle/social-data',
  publicOrigin: env.ACCOUNTS_ORIGIN || 'https://blockle.org',
  prod: bool(env.ACCOUNTS_PROD, false),

  // Cookies: Secure in prod, SameSite=Lax, httpOnly always.
  cookieSecure: bool(env.ACCOUNTS_COOKIE_SECURE, bool(env.ACCOUNTS_PROD, false)),
  sessionIdleMs: +(env.ACCOUNTS_SESSION_IDLE_MS || 15 * 60 * 1000),
  sessionAbsoluteMs: +(env.ACCOUNTS_SESSION_ABS_MS || 7 * 24 * 60 * 60 * 1000),

  tokenTtlMs: +(env.ACCOUNTS_TOKEN_TTL_MS || 15 * 60 * 1000),
  backupMaxBytes: +(env.ACCOUNTS_BACKUP_MAX || 2 * 1024 * 1024),

  // Abuse controls.
  maxLoginPerIp: +(env.ACCOUNTS_MAX_LOGIN_IP || 30),
  maxLoginPerAccount: +(env.ACCOUNTS_MAX_LOGIN_ACCT || 8),
  lockoutBaseMs: +(env.ACCOUNTS_LOCKOUT_MS || 30 * 1000),
  rateWindowMs: +(env.ACCOUNTS_RATE_WINDOW_MS || 15 * 60 * 1000),

  // Admin seed — the hidden dashboard owner. Password is hashed at first run, never stored raw.
  adminEmail: (env.ACCOUNTS_ADMIN_EMAIL || '').toLowerCase().trim(),
  adminPassword: env.ACCOUNTS_ADMIN_PASSWORD || '',

  mailFrom: env.ACCOUNTS_MAIL_FROM || 'Blockle <support@blockle.org>',
  mailTransport: env.ACCOUNTS_MAIL_TRANSPORT || 'stub', // stub | sendmail | smtp
  smtpHost: env.ACCOUNTS_SMTP_HOST || '127.0.0.1',
  smtpPort: +(env.ACCOUNTS_SMTP_PORT || 25),

  paypalEnv: env.PAYPAL_ENV || 'sandbox',
  paypalClientId: env.PAYPAL_CLIENT_ID || '',
  paypalSecret: env.PAYPAL_SECRET || '',
  paypalPlanId: env.PAYPAL_PLAN_ID || '',
  paypalWebhookId: env.PAYPAL_WEBHOOK_ID || '',
  planName: env.ACCOUNTS_PLAN_NAME || 'Blockle Pro',
  planPrice: env.ACCOUNTS_PLAN_PRICE || '10.00',
  planCurrency: env.ACCOUNTS_PLAN_CCY || 'USD',

  sessionSecret: env.ACCOUNTS_SESSION_SECRET || '',

  killed: bool(env.ACCOUNTS_KILL, false),
};

export function resolveSecrets() {
  if (!config.sessionSecret) {
    if (config.prod) throw new Error('ACCOUNTS_SESSION_SECRET is required in prod');
    config.sessionSecret = crypto.randomBytes(32).toString('hex'); // dev only
  }
  // The forgeable PayPal test stub must never run in prod (it would grant free entitlement).
  if (config.prod && config.paypalEnv === 'stub') {
    throw new Error('PAYPAL_ENV=stub is not allowed in prod; set live/sandbox creds or leave billing disabled');
  }
  return config;
}
