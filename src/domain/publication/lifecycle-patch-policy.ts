import { LIFECYCLE_STATUSES } from '@/domain/offer-lifecycle';

/** Returns a client-facing error when PATCH is used as a lifecycle API. */
export function directLifecyclePatchError(body: unknown): string {
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'db_status')) {
    return `Direct lifecycle status changes via PATCH are prohibited. Use POST /api/offers/:id/transition with an authorized action (allowed statuses: ${LIFECYCLE_STATUSES.join(', ')}) so transition rules and audit history are enforced.`;
  }
  return 'PATCH does not support mutable offer fields. Use the correction or transition endpoints.';
}
