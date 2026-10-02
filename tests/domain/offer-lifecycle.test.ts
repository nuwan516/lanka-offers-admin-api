import { isValidTransition, nextLifecycleStatus } from '@/domain/offer-lifecycle';

describe('offer lifecycle transitions', () => {
  it('allows APPROVE from REVIEW_REQUIRED', () => {
    expect(isValidTransition('REVIEW_REQUIRED', 'APPROVE')).toBe(true);
    expect(nextLifecycleStatus('APPROVE')).toBe('APPROVED');
  });

  it('allows PUBLISH only from APPROVED', () => {
    expect(isValidTransition('APPROVED', 'PUBLISH')).toBe(true);
    expect(isValidTransition('REVIEW_REQUIRED', 'PUBLISH')).toBe(false);
  });

  it('a rejected offer cannot be published', () => {
    expect(isValidTransition('REJECTED', 'PUBLISH')).toBe(false);
  });

  it('a review-required offer cannot be published directly', () => {
    expect(isValidTransition('REVIEW_REQUIRED', 'PUBLISH')).toBe(false);
  });

  it('allows UNPUBLISH only from PUBLISHED', () => {
    expect(isValidTransition('PUBLISHED', 'UNPUBLISH')).toBe(true);
    expect(isValidTransition('APPROVED', 'UNPUBLISH')).toBe(false);
  });

  it('DISABLE is allowed from any state', () => {
    expect(isValidTransition('DISCOVERED', 'DISABLE')).toBe(true);
    expect(isValidTransition('PUBLISHED', 'DISABLE')).toBe(true);
    expect(isValidTransition('REJECTED', 'DISABLE')).toBe(true);
  });

  it('SEND_BACK is only allowed from APPROVED or REJECTED', () => {
    expect(isValidTransition('APPROVED', 'SEND_BACK')).toBe(true);
    expect(isValidTransition('REJECTED', 'SEND_BACK')).toBe(true);
    expect(isValidTransition('DISCOVERED', 'SEND_BACK')).toBe(false);
  });
});
