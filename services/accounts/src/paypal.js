// PayPal Subscriptions behind an injectable interface. Entitlement is driven by VERIFIED
// webhooks only (never the browser return URL). In dev/tests use the 'stub' gateway; in prod
// the 'live'/'sandbox' gateway talks to PayPal with the REST app creds from env.
export function makePaypal(config, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  // The forgeable test stub is used ONLY when explicitly requested (tests/dev). It must never be
  // reachable in prod — otherwise a missing-creds deploy would grant free entitlement.
  if (config.paypalEnv === 'stub') return stubGateway();
  // Creds absent → billing is DISABLED (not stubbed): subscribe errors, webhooks are rejected.
  if (!config.paypalClientId || !config.paypalSecret) return disabledGateway();
  const base = config.paypalEnv === 'live'
    ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  async function token() {
    const auth = Buffer.from(`${config.paypalClientId}:${config.paypalSecret}`).toString('base64');
    const r = await fetchFn(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error(`paypal token ${r.status}`);
    return (await r.json()).access_token;
  }

  return {
    stub: false,
    async createSubscription(userId, returnUrl, cancelUrl, planId) {
      const t = await token();
      const r = await fetchFn(`${base}/v1/billing/subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: planId || config.paypalPlanId,
          custom_id: userId,
          application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'SUBSCRIBE_NOW' },
        }),
      });
      if (!r.ok) throw new Error(`paypal sub ${r.status}`);
      const j = await r.json();
      const approve = (j.links || []).find((l) => l.rel === 'approve');
      return { id: j.id, approveUrl: approve?.href };
    },
    // Verify webhook signature server-side via PayPal's verify API (defense: never trust the body alone).
    async verifyWebhook(headers, rawBody) {
      const t = await token();
      const r = await fetchFn(`${base}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: config.paypalWebhookId,
          webhook_event: JSON.parse(rawBody),
        }),
      });
      if (!r.ok) return false;
      return (await r.json()).verification_status === 'SUCCESS';
    },
  };
}

// Billing not configured: no subscriptions can be created and NO webhook is ever trusted.
// This is the safe prod default when PayPal creds are absent — it fails closed, never open.
function disabledGateway() {
  return {
    stub: false, disabled: true,
    async createSubscription() { throw new Error('billing not configured'); },
    async verifyWebhook() { return false; },
  };
}

// Deterministic stub: createSubscription returns a fake approve URL; verifyWebhook trusts a
// shared test marker. Lets the full entitlement flow be tested without network/creds.
function stubGateway() {
  return {
    stub: true,
    async createSubscription(userId) {
      return { id: `SUB-STUB-${userId}`, approveUrl: `https://sandbox.example/approve/${userId}` };
    },
    async verifyWebhook(headers) { return headers['x-stub-verified'] === 'yes'; },
  };
}

// Map a (verified) webhook event to an entitlement decision. Idempotent by event id upstream.
export function entitlementFromEvent(event) {
  const type = event?.event_type || '';
  const custom = event?.resource?.custom_id || event?.resource?.subscriber?.custom_id || null;
  const subId = event?.resource?.id || event?.resource?.billing_agreement_id || null;
  // plan_id lets the host map the subscription to a tier (Copilot vs Copilot Pro vs Pro).
  const planId = event?.resource?.plan_id || null;
  if (/BILLING\.SUBSCRIPTION\.(ACTIVATED|RE-?ACTIVATED)/i.test(type) || /PAYMENT\.SALE\.COMPLETED/i.test(type))
    return { userId: custom, subId, planId, active: true };
  if (/BILLING\.SUBSCRIPTION\.(CANCELLED|SUSPENDED|EXPIRED)/i.test(type))
    return { userId: custom, subId, planId, active: false };
  return null;
}
