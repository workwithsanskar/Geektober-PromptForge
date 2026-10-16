import { broadcastToUser } from '../utils/eventBus.js';
import Entitlement from '../models/entitlement.js';
import Order from '../models/order.js';
import Prompt from '../models/prompt.js';
import Users from '../models/user.js';

/**
 * Get authenticated user ID from request.
 * Only uses req.user.id, never req.body.userId.
 */
function getUserId(req) {
  return req.user?.id;
}

/**
 * Handle order fulfillment and notify buyer of prompt unlock.
 * Called after a payment is successfully verified (synchronously) or via webhook reconciliation.
 * Only emits PAYMENT_SUCCESS after the durable entitlement/settlement transaction commits.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 */
export async function notifyPaymentSuccess(req, res) {
  try {
    const buyerId = getUserId(req);
    const { orderId, promptId } = req.body;

    if (!buyerId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (!orderId || !promptId) {
      return res.status(400).json({ success: false, message: 'Order ID and Prompt ID are required' });
    }

    // Verify the order exists and belongs to this buyer
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.buyerId.toString() !== buyerId) {
      return res.status(403).json({ success: false, message: 'Order does not belong to this user' });
    }

    // Check if entitlement already exists (idempotency)
    const existingEntitlement = await Entitlement.findOne({ userId: buyerId, promptId });
    if (existingEntitlement && existingEntitlement.orderId.equals(orderId)) {
      // Already entitled; still return success but don't broadcast duplicate
      return res.status(200).json({ success: true, alreadyOwned: true });
    }

    // Create or update entitlement atomically
    const entitlement = await Entitlement.findOneAndUpdate(
      { userId: buyerId, promptId },
      { orderId, grantedAt: new Date() },
      { upsert: true, new: true }
    );

    // Notify the buyer via SSE
    const notificationSuccess = broadcastToUser(buyerId, {
      event: 'PAYMENT_SUCCESS',
      data: {
        orderId: order._id,
        promptId,
        promptTitle: order.promptId?.title || '',
        buyerUsername: order.buyerId?.username || '',
      },
    });

    return res.status(200).json({
      success: true,
      alreadyOwned: false,
      entitlementGranted: true,
      notificationSent: notificationSuccess,
    });
  } catch (err) {
    console.error('notifyPaymentSuccess error:', err);
    return res.status(500).json({ success: false, message: 'Error processing payment success notification' });
  }
}

/**
 * Get user's active entitlements (prompts they've unlocked via payment).
 * Used by the frontend to check if content is already unlocked.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 */
export async function getUserEntitlements(req, res) {
  try {
    const buyerId = getUserId(req);
    if (!buyerId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const entitlements = await Entitlement.find({ userId: buyerId })
      .populate('promptId', 'title pricePaise isPublished imageUrl')
      .sort({ grantedAt: -1 });

    return res.status(200).json({ success: true, entitlements });
  } catch (err) {
    console.error('getUserEntitlements error:', err);
    return res.status(500).json({ success: false, message: 'Error fetching entitlements' });
  }
}

/**
 * Webhook reconciliation: check for unfulfilled orders and notify buyers.
 * This runs periodically or on startup to ensure no entitlements were missed.
 * Only notifies for orders that have been paid but entitlements may not have been created.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 */
export async function reconcileWebhooks(req, res) {
  try {
    // Find orders that are PAID but may not have entitlements
    const paidOrders = await Order.find({ status: 'PAID' })
      .select('buyerId promptId')
      .lean();

    const notified = [];

    for (const order of paidOrders) {
      const buyerId = order.buyerId.toString();
      const promptId = order.promptId.toString();

      // Check if entitlement already exists
      const existingEntitlement = await Entitlement.findOne({ userId: buyerId, promptId });

      if (!existingEntitlement) {
        // Create entitlement and notify
        const entitlement = await Entitlement.create({
          userId: buyerId,
          promptId,
          orderId: order._id,
        });

        // Notify the buyer via SSE
        broadcastToUser(buyerId, {
          event: 'PAYMENT_SUCCESS',
          data: {
            orderId: order._id,
            promptId,
          },
        });

        notified.push({ orderId: order._id, promptId });
      }
    }

    return res.status(200).json({ success: true, notified });
  } catch (err) {
    console.error('reconcileWebhooks error:', err);
    return res.status(500).json({ success: false, message: 'Error reconciling webhooks' });
  }
}