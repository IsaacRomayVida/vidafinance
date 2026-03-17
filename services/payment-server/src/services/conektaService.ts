import { Configuration, OrdersApi, OrderRequest, OrderResponse } from 'conekta';
import { db, admin } from '../lib/firebase';

export interface CreateOxxoLinkParams {
  loanId: string;
  amount: number;
  borrowerName: string;
  borrowerEmail: string;
  borrowerPhone: string;
  expiresAt: number; // Unix ms
}

export interface OxxoLinkResult {
  orderId: string;
  paymentReference: string;
  expiresAt: number; // Unix seconds
}

let ordersApi: OrdersApi | null = null;

function getOrdersApi(): OrdersApi {
  if (ordersApi) return ordersApi;

  const apiKey = process.env.CONEKTA_API_KEY;
  if (!apiKey) {
    throw new Error('CONEKTA_API_KEY not configured');
  }

  const config = new Configuration({ accessToken: apiKey });
  ordersApi = new OrdersApi(config);
  return ordersApi;
}

/**
 * Create a Conekta OXXO cash payment order for a loan repayment.
 * Uses the Conekta Node SDK (v6) OrdersApi.
 */
export async function createOxxoPaymentLink(
  params: CreateOxxoLinkParams,
): Promise<OxxoLinkResult> {
  const { loanId, amount, borrowerName, borrowerEmail, borrowerPhone, expiresAt } = params;
  const api = getOrdersApi();

  const orderRequest: OrderRequest = {
    currency: 'MXN',
    customer_info: {
      name: borrowerName,
      email: borrowerEmail,
      phone: borrowerPhone,
    },
    line_items: [
      {
        name: 'Préstamo VIDA Finance',
        unit_price: Math.round(amount * 100),
        quantity: 1,
      },
    ],
    charges: [
      {
        payment_method: {
          type: 'oxxo_cash',
          expires_at: Math.floor(expiresAt / 1000),
        },
      },
    ],
    metadata: { loan_id: loanId },
  };

  const { data: order } = await api.createOrder(orderRequest, 'es');

  const charges = (order as OrderResponse & { charges?: { data?: Array<{ id?: string; payment_method?: { reference?: string; expires_at?: number } }> } }).charges;
  const oxxoCharge = charges?.data?.[0];
  const paymentReference = oxxoCharge?.payment_method?.reference ?? '';
  const chargeExpiresAt = oxxoCharge?.payment_method?.expires_at ?? Math.floor(expiresAt / 1000);

  await db.collection('oxxo_links').doc(loanId).set({
    conektaOrderId: order.id,
    loanId,
    amount,
    borrowerName,
    borrowerEmail,
    paymentReference,
    expiresAt: admin.firestore.Timestamp.fromMillis(chargeExpiresAt * 1000),
    status: 'pending',
    createdAt: admin.firestore.Timestamp.now(),
  });

  return {
    orderId: order.id!,
    paymentReference,
    expiresAt: chargeExpiresAt,
  };
}

/**
 * Reset the cached OrdersApi instance (useful for testing).
 */
export function __resetOrdersApi(): void {
  ordersApi = null;
}
