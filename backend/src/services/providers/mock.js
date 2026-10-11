// The Phase 1 mock provider, now expressed as one driver behind the
// provider registry (src/services/payments.js). Every driver implements:
//   isConfigured()                        -> boolean
//   initiate(payment)                     -> { checkoutPath | checkoutUrl, providerRef? }
//   name
// "Initiation" for the mock provider just means: nothing to call out to —
// the frontend renders a fake checkout screen and later calls
// POST /api/payments/mock/:id/complete to simulate the provider's webhook.
module.exports = {
  name: "mock",
  isConfigured: () => true, // always available — the guaranteed fallback
  async initiate(payment) {
    return { checkoutPath: `/mock-checkout/${payment.id}` };
  },
};
