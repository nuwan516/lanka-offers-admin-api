import { GeoToolExecutor } from '@/llm/tools/geo-tool-executor';
import { GeoOfferContext } from '@/geo/geo-evidence';

describe('Geo Tool Executor', () => {
  let executor: GeoToolExecutor;
  const mockContext: GeoOfferContext = {
    offerId: 'test-offer-1',
    bank: 'hnb',
    merchant: {
      name: 'Opal Fashion',
      addresses: ['No. 45, Galle Road, Colombo 03'],
      location: 'Colombo',
    },
    offer: {
      title: '20% off at Opal Fashion',
      description: 'Visit our flagship outlet at No. 45, Galle Road, Colombo 03',
      category: 'fashion',
      terms: ['Offer valid at Galle Road outlet only'],
      locationScope: 'EXPLICIT_BRANCH',
    },
    extractedGeo: {
      candidateAddresses: ['No. 45, Galle Road, Colombo 03'],
      confidence: 'HIGH',
      addressQuality: 'EXACT_ADDRESS',
      qualityReasons: [],
    },
    sourceEvidence: {
      sourceUrl: 'https://hnb.lk/promotions/opal',
      contentType: 'text/html',
      evidenceHash: 'abc123hash',
      relevantSnippets: [
        { id: 'ev-1', text: 'Visit our flagship outlet at No. 45, Galle Road, Colombo 03', sourceLocation: 'offer-description' },
      ],
    },
  };

  beforeEach(() => {
    executor = new GeoToolExecutor({
      maxCallsPerAttempt: 3,
      maxCallsPerOffer: 6,
      toolTimeoutMs: 500,
    });
    executor.registerOfferContext(mockContext, 'Full source text containing No. 45, Galle Road, Colombo 03 and other details.');
  });

  it('executes extract_address_candidates correctly', async () => {
    const res = await executor.executeTool('extract_address_candidates', {
      snippet: 'Valid at Address: No. 12, Main Street, Kandy',
    });

    expect(res.success).toBe(true);
    const data = res.result as { count: number; candidateAddresses: string[] };
    expect(data.candidateAddresses.length).toBeGreaterThanOrEqual(1);
    expect(data.candidateAddresses[0]).toContain('Main Street, Kandy');
  });

  it('executes normalize_sri_lankan_address correctly', async () => {
    const res = await executor.executeTool('normalize_sri_lankan_address', {
      address: 'no 10 galle rd, colombo 03',
    });

    expect(res.success).toBe(true);
    const data = res.result as { normalizedAddress: string; postalZone: string | null };
    expect(data.normalizedAddress).toContain('Road');
    expect(data.postalZone).toBe('Colombo 03');
  });

  it('executes compare_offer_to_raw_evidence correctly', async () => {
    const res = await executor.executeTool('compare_offer_to_raw_evidence', {
      offerId: 'test-offer-1',
      addressesToVerify: ['No. 45, Galle Road, Colombo 03'],
    });

    expect(res.success).toBe(true);
    const data = res.result as { allSupported: boolean };
    expect(data.allSupported).toBe(true);
  });

  it('enforces maximum tool calls per attempt limit (quota control)', async () => {
    // Attempt limit is 3
    await executor.executeTool('extract_address_candidates', { snippet: 'Address: No. 1, Street' });
    await executor.executeTool('extract_address_candidates', { snippet: 'Address: No. 2, Street' });
    await executor.executeTool('extract_address_candidates', { snippet: 'Address: No. 3, Street' });

    // 4th call in same attempt should be rejected
    const blockedRes = await executor.executeTool('extract_address_candidates', { snippet: 'Address: No. 4, Street' });
    expect(blockedRes.success).toBe(false);
    expect(blockedRes.error).toContain('Exceeded maximum tool calls for current attempt');

    // Starting new attempt resets attempt counter
    executor.startNewAttempt();
    const allowedRes = await executor.executeTool('extract_address_candidates', { snippet: 'Address: No. 5, Street' });
    expect(allowedRes.success).toBe(true);
  });

  it('rejects unknown or unauthorized tool names', async () => {
    const res = await executor.executeTool('execute_arbitrary_shell_command', { cmd: 'dir' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown or unauthorized tool');
  });
});
