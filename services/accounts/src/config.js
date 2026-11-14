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
  chainApiBase: env.ACCOUNTS_CHAIN_API || env.ACCOUNTS_ORIGIN || 'https://blockle.org',
  botStepMs: +(env.ACCOUNTS_BOT_STEP_MS || 60 * 1000),
  prod: bool(env.ACCOUNTS_PROD, false),

  // Cookies: Secure in prod, SameSite=Lax, httpOnly always.
  cookieSecure: bool(env.ACCOUNTS_COOKIE_SECURE, bool(env.ACCOUNTS_PROD, false)),
  // Optional cookie Domain for cross-subdomain SSO (e.g. ".blockle.org" so the
  // session cookie reaches world.blockle.org). Empty = host-only (current behavior).
  cookieDomain: env.ACCOUNTS_COOKIE_DOMAIN || '',
  // A signed-in wallet stays signed in: 30 days idle / 180 days absolute (logout,
  // password change and device revoke still kill a session instantly).
  sessionIdleMs: +(env.ACCOUNTS_SESSION_IDLE_MS || 30 * 24 * 60 * 60 * 1000),
  sessionAbsoluteMs: +(env.ACCOUNTS_SESSION_ABS_MS || 180 * 24 * 60 * 60 * 1000),

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
  // Blockle Copilot subscription tiers (the flagship AI trading-agent product). Each tier is
  // offered only when its PayPal plan id is configured, so this is safe to ship before the
  // live plans exist. Prices are display-only; the real amount lives in the PayPal plan.
  copilotPlanId: env.PAYPAL_COPILOT_PLAN_ID || '',
  copilotPrice: env.PAYPAL_COPILOT_PRICE || '19.00',
  copilotProPlanId: env.PAYPAL_COPILOT_PRO_PLAN_ID || '',
  copilotProPrice: env.PAYPAL_COPILOT_PRO_PRICE || '49.00',

  // MoonPay Commerce server-owned USD prices for FIXED-price products. SINGLE SOURCE OF
  // TRUTH: these default to the SAME canonical USD the PayPal/IAP path charges — the
  // Copilot tier prices above (copilotPrice / copilotProPrice) and the launchpad promo
  // launch fee ($5, matching services/launchpad LAUNCHPAD_FEE_PROMO_USD). The client's
  // amountUsd is IGNORED for these products: the server sets the price at /commerce create
  // and re-asserts paid >= price at grant time. Env-overridable but never client-settable.
  moonpayPriceCopilot: env.MOONPAY_PRICE_COPILOT || env.PAYPAL_COPILOT_PRICE || '19.00',
  moonpayPriceCopilotPro: env.MOONPAY_PRICE_COPILOT_PRO || env.PAYPAL_COPILOT_PRO_PRICE || '49.00',
  moonpayPriceLaunchFee: env.MOONPAY_PRICE_LAUNCH_FEE || '5',

  // Free trial for the Copilot tier: first live-bot activation grants this many days of
  // Copilot entitlement, once per account, with no payment method required. 0 disables trials.
  trialDays: +(env.ACCOUNTS_TRIAL_DAYS || 7),
  trialTier: env.ACCOUNTS_TRIAL_TIER || 'copilot',

  // In-app purchase (Apple StoreKit / Google Play). Same two tiers as PayPal; a store purchase
  // lands in the same shared user.sub. iapEnv: live | stub (stub is dev/tests only, blocked in
  // prod like the PayPal stub). Creds absent -> that platform's verification is DISABLED.
  iapEnv: env.IAP_ENV || (bool(env.ACCOUNTS_PROD, false) ? 'live' : 'stub'),
  // Apple: the app's bundle id + the App Store shared secret (symmetric; for verifyReceipt of
  // auto-renewable subscriptions). Verification is remote (Apple's verifyReceipt), no local crypto.
  appleBundleId: env.APPLE_BUNDLE_ID || '',
  appleSharedSecret: env.APPLE_SHARED_SECRET || '',
  appleCopilotProduct: env.APPLE_COPILOT_PRODUCT || 'org.blockle.copilot.monthly',
  appleCopilotProProduct: env.APPLE_COPILOT_PRO_PRODUCT || 'org.blockle.copilotpro.monthly',
  // Google: the app package + a Play Developer API service-account JSON (verbatim) + the RTDN
  // shared token guarding the Pub/Sub push endpoint.
  googlePackageName: env.GOOGLE_PACKAGE_NAME || '',
  googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleRtdnToken: env.GOOGLE_RTDN_TOKEN || '',
  googleCopilotProduct: env.GOOGLE_COPILOT_PRODUCT || 'copilot_monthly',
  googleCopilotProProduct: env.GOOGLE_COPILOT_PRO_PRODUCT || 'copilotpro_monthly',

  // Blocklings GOLD consumable IAP (game premium currency; IAP-only, never earned, never
  // cashed out). Crediting is HARD-GATED behind this flag: the operator must only set
  // APPLE_IAP_ENABLED once App Store Server API receipt verification is wired (see the
  // TODO at the /account/api/game/gold/iap route). Off -> the route answers 503 and no
  // GOLD is ever credited.
  appleIapEnabled: bool(env.APPLE_IAP_ENABLED, false),

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
