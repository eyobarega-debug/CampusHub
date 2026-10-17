// CampusHub Manual Payment System
// All new transactions use the secure manual payment and confirmation workflow.
export const PAYMENT_METHOD = "manual";

// Sends the student to the right screen after a purchase call created a payment.
export function startCheckout(navigate, payment, { label, returnTo } = {}) {
  if (!payment || payment.isFree) {
    navigate(returnTo || "/tickets");
    return;
  }

  // Always route to manual payment with proof upload and recipient instructions
  navigate(`/pay/manual/${payment.paymentId}`, { state: { label, returnTo } });
}