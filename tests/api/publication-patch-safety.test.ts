import { directLifecyclePatchError } from '@/domain/publication/lifecycle-patch-policy';

describe('publication lifecycle PATCH safety', () => {
  it.each(['APPROVED', 'REJECTED', 'PUBLISHED', 'DISABLED'])(
    'rejects direct %s status mutation',
    (status) => {
      expect(directLifecyclePatchError({ db_status: status })).toContain(
        'Direct lifecycle status changes via PATCH are prohibited',
      );
    },
  );

  it('does not offer a generic PATCH mutation escape hatch', () => {
    expect(directLifecyclePatchError({ title: 'unreviewed edit' })).toContain(
      'PATCH does not support mutable offer fields',
    );
  });
});
