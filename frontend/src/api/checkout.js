// Which payment method the purchase screens ask the API for.
//   "manual" (default): the student pays the seller's / organizer's own account,
//                       uploads a screenshot, and the seller approves it.
//   "online":           the platform-wide provider (mock checkout in development).
// Set VITE_PAYMENT_METHOD=online in frontend/.env to switch the whole app back.
export const PAYMENT_METHOD = import.meta.env.VITE_PAYMENT_METHOD === "online" ? "online" : "manual";

// Sends the student to the right screen after a purchase call created a payment.
export function startCheckout(navigate, payment, { label, returnTo }) {
  if (payment.provider === "manual") {
    navigate(`/pay/manual/${payment.paymentId}`, { state: { label, returnTo } });
  } else {
    navigate(`/mock-checkout/${payment.paymentId}`, { state: { amount: payment.amount, returnTo, label } });
  }
}