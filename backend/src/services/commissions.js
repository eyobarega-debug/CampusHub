// Platform commission ledger. One row per approved sale, tied to the seller
// (merchant / event organizer / student renting out an item), so each seller
// has their own account and the admin can see every seller separately.
//
// Exact default commission rates per business rules:
// Material sales: 5% (0.05), Event tickets: 2.5% (0.025), Rentals: 0% (0.00).
const RATES = {
  order: Number(process.env.COMMISSION_RATE_ORDER ?? 0.05),
  ticket: Number(process.env.COMMISSION_RATE_TICKET ?? 0.025),
  booking: Number(process.env.COMMISSION_RATE_BOOKING ?? 0.00),
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function rateFor(transactionType, fallbackRate) {
  return RATES[transactionType] ?? fallbackRate;
}

// Records the commission for a just-confirmed payment, inside the confirming transaction.
// Skipped when there is no seller to bill (e.g. promotion payments) or nothing to charge.
async function record(client, { payment, finalizer, base, rate, commission }) {
  if (!finalizer.getRecipient || commission <= 0) return null;
  const recipient = await finalizer.getRecipient(payment.transaction_id);
  const sellerId = recipient?.organizerId || recipient?.userId;
  if (!sellerId) return null;
  const { rows: u } = await client.query("SELECT role FROM users WHERE id = $1", [sellerId]);
  const { rows } = await client.query(
    `INSERT INTO commissions
       (university_id, payment_id, transaction_type, transaction_id, description,
        payee_id, payee_role, gross_amount, base_amount, rate, commission_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING *`,
    [
      payment.university_id, payment.id, payment.transaction_type, payment.transaction_id,
      recipient.description || null, sellerId, u[0]?.role || null,
      payment.amount, base, rate, commission,
    ]
  );
  return rows[0] || null;
}

// A refund before settlement cancels the commission. Already-settled ones are left for the admin to handle.
async function voidForPayment(client, paymentId) {
  await client.query("UPDATE commissions SET status = 'void' WHERE payment_id = $1 AND status = 'due'", [paymentId]);
}

module.exports = { RATES, rateFor, record, voidForPayment, round2 };