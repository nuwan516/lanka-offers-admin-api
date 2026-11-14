import * as fs from 'fs';
import * as path from 'path';
import { determineLocationScope, LocationScope, isMerchantOnlyAddress } from '../src/domain/location-scope';
import { AddressEngine } from '../src/parsing/address/address-engine';

interface BankStats {
  bank: string;
  totalOffers: number;
  onlineOffers: number;
  onlineWithZeroAddresses: number;
  onlineWithFalseAddresses: number;
  singleVenueOffers: number;
  multiBranchOffers: number;
  selectedOutletsOffers: number;
  nationwideOffers: number;
  unresolvedOffers: number;
  offersWithAddresses: number;
  totalAddressesExtracted: number;
  noiseLeakedAddresses: number;
  multiBranchSplitProperly: number;
  sampleSingle: any[];
  sampleMulti: any[];
  sampleOnline: any[];
  sampleSelectedOutlets: any[];
}

const NOISE_CHECK_PATTERNS = [
  /\b\d+\s*%\s*off\b/i,
  /\bterms\s*(?:and|&)\s*conditions\b/i,
  /\bvalid\s+(?:on|until|till)\b/i,
  /\bcardholders?\b/i,
  /\bminimum\s+spend\b/i,
  /^[+\d][\d\s/+-]{6,}$/, // standalone phone number
];

async function main() {
  const outputDir = path.join(__dirname, '..', 'output');
  const files = [
    { bank: 'hnb', file: 'hnb_all.json' },
    { bank: 'boc', file: 'boc_all.json' },
    { bank: 'peoples', file: 'peoples_all.json' },
    { bank: 'nsb', file: 'nsb_all.json' },
    { bank: 'seylan', file: 'seylan_all.json' },
    { bank: 'combank', file: 'combank_all.json' },
    { bank: 'pabc', file: 'pabc_all.json' },
    { bank: 'sampath', file: 'sampath_all.json' },
    { bank: 'ndb', file: 'ndb_all.json' },
    { bank: 'dfcc', file: 'dfcc_all.json' },
  ];

  const overallResults: BankStats[] = [];

  for (const { bank, file } of files) {
    const filePath = path.join(outputDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`[SKIP] ${file} does not exist`);
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const offers = data.offers || [];

    const stats: BankStats = {
      bank,
      totalOffers: offers.length,
      onlineOffers: 0,
      onlineWithZeroAddresses: 0,
      onlineWithFalseAddresses: 0,
      singleVenueOffers: 0,
      multiBranchOffers: 0,
      selectedOutletsOffers: 0,
      nationwideOffers: 0,
      unresolvedOffers: 0,
      offersWithAddresses: 0,
      totalAddressesExtracted: 0,
      noiseLeakedAddresses: 0,
      multiBranchSplitProperly: 0,
      sampleSingle: [],
      sampleMulti: [],
      sampleOnline: [],
      sampleSelectedOutlets: [],
    };

    for (const o of offers) {
      const merchantName = o.merchant?.name || o.title || '';
      const location = o.merchant?.location || o.location || '';
      const addresses: string[] = o.merchant?.addresses || [];
      const description = o.offer?.description || o.description || '';
      const title = o.title || '';
      const terms: string[] = o.offer?.generalTerms || o.terms || [];

      // Determine scope purely from raw offer evidence (no google geocoding)
      const scopeResult = determineLocationScope({
        location,
        title,
        description,
        merchantName,
        addresses,
        terms,
      });

      // Genuine physical addresses (filter out merchant-only fallback placeholders)
      const physicalAddresses = addresses.filter(
        (a) => a && a !== '.' && !isMerchantOnlyAddress(a, merchantName)
      );

      if (physicalAddresses.length > 0) {
        stats.offersWithAddresses++;
        stats.totalAddressesExtracted += physicalAddresses.length;

        // Check if any noise leaked into address strings
        for (const addr of physicalAddresses) {
          if (NOISE_CHECK_PATTERNS.some((p) => p.test(addr))) {
            stats.noiseLeakedAddresses++;
          }
        }
      }

      // Check classification
      switch (scopeResult.scope) {
        case LocationScope.ONLINE:
          stats.onlineOffers++;
          if (physicalAddresses.length === 0) {
            stats.onlineWithZeroAddresses++;
          } else {
            stats.onlineWithFalseAddresses++;
          }
          if (stats.sampleOnline.length < 3) {
            stats.sampleOnline.push({
              id: o.uniqueId,
              title: o.title,
              merchant: merchantName,
              scope: scopeResult.scope,
              explanation: scopeResult.explanation,
              addresses: physicalAddresses,
            });
          }
          break;

        case LocationScope.EXPLICIT_BRANCH:
          stats.singleVenueOffers++;
          if (stats.sampleSingle.length < 3) {
            stats.sampleSingle.push({
              id: o.uniqueId,
              title: o.title,
              merchant: merchantName,
              scope: scopeResult.scope,
              extractedAddresses: physicalAddresses.length > 0 ? physicalAddresses : [location || merchantName],
              rawLocation: location,
            });
          }
          break;

        case LocationScope.MULTIPLE_BRANCHES:
          stats.multiBranchOffers++;
          const branches = scopeResult.participatingBranches || [];
          if (branches.length > 1 || physicalAddresses.length > 1) {
            stats.multiBranchSplitProperly++;
          }
          if (stats.sampleMulti.length < 3) {
            stats.sampleMulti.push({
              id: o.uniqueId,
              title: o.title,
              merchant: merchantName,
              scope: scopeResult.scope,
              branchCount: scopeResult.participatingBranchesCount || physicalAddresses.length,
              branches: (scopeResult.participatingBranches || physicalAddresses).slice(0, 5),
            });
          }
          break;

        case LocationScope.SELECTED_OUTLETS:
          stats.selectedOutletsOffers++;
          if (stats.sampleSelectedOutlets.length < 2) {
            stats.sampleSelectedOutlets.push({
              id: o.uniqueId,
              title: o.title,
              merchant: merchantName,
              scope: scopeResult.scope,
              explanation: scopeResult.explanation,
            });
          }
          break;

        case LocationScope.NATIONWIDE:
          stats.nationwideOffers++;
          break;

        case LocationScope.UNRESOLVED:
        default:
          stats.unresolvedOffers++;
          break;
      }
    }

    overallResults.push(stats);
  }

  // Print summary report
  console.log('\n========================================================================');
  console.log('         10-BANK ADDRESS EXTRACTION & LOCATION SCOPE AUDIT');
  console.log('========================================================================\n');

  let totalAllOffers = 0;
  let totalOnline = 0;
  let totalOnlineClean = 0;
  let totalSingle = 0;
  let totalMulti = 0;
  let totalMultiClean = 0;
  let totalSelected = 0;
  let totalNationwide = 0;
  let totalUnresolved = 0;
  let totalPhysicalAddrs = 0;
  let totalNoiseLeaks = 0;

  for (const s of overallResults) {
    totalAllOffers += s.totalOffers;
    totalOnline += s.onlineOffers;
    totalOnlineClean += s.onlineWithZeroAddresses;
    totalSingle += s.singleVenueOffers;
    totalMulti += s.multiBranchOffers;
    totalMultiClean += s.multiBranchSplitProperly;
    totalSelected += s.selectedOutletsOffers;
    totalNationwide += s.nationwideOffers;
    totalUnresolved += s.unresolvedOffers;
    totalPhysicalAddrs += s.totalAddressesExtracted;
    totalNoiseLeaks += s.noiseLeakedAddresses;

    console.log(`BANK: ${s.bank.toUpperCase()} (${s.totalOffers} offers)`);
    console.log(`  - Online Offers: ${s.onlineOffers} (Zero-address accuracy: ${s.onlineOffers ? ((s.onlineWithZeroAddresses / s.onlineOffers) * 100).toFixed(1) : 100}%)`);
    console.log(`  - Single Venue / Explicit: ${s.singleVenueOffers}`);
    console.log(`  - Multi-Branch / Chains: ${s.multiBranchOffers} (Split properly: ${s.multiBranchSplitProperly})`);
    console.log(`  - Selected Outlets (Restricted): ${s.selectedOutletsOffers}`);
    console.log(`  - Nationwide / Islandwide: ${s.nationwideOffers}`);
    console.log(`  - Unresolved: ${s.unresolvedOffers}`);
    console.log(`  - Physical Addresses Extracted: ${s.totalAddressesExtracted} across ${s.offersWithAddresses} offers (Noise leaked: ${s.noiseLeakedAddresses})`);
    console.log('');
  }

  console.log('========================================================================');
  console.log('TOTAL CONSOLIDATED METRICS:');
  console.log(`  Total Offers Audited: ${totalAllOffers}`);
  console.log(`  Online Offers: ${totalOnline} (Clean 0-address rate: ${((totalOnlineClean / (totalOnline || 1)) * 100).toFixed(2)}%)`);
  console.log(`  Single Venue (Explicit): ${totalSingle}`);
  console.log(`  Multi-Branch Chains: ${totalMulti} (Properly split rate: ${((totalMultiClean / (totalMulti || 1)) * 100).toFixed(2)}%)`);
  console.log(`  Selected Outlets (Uncertainty preserved): ${totalSelected}`);
  console.log(`  Nationwide / All Outlets: ${totalNationwide}`);
  console.log(`  Unresolved Scope: ${totalUnresolved}`);
  console.log(`  Total Extracted Physical Addresses: ${totalPhysicalAddrs}`);
  console.log(`  Noise Leakage Count: ${totalNoiseLeaks} (${((totalNoiseLeaks / (totalPhysicalAddrs || 1)) * 100).toFixed(2)}%)`);
  console.log('========================================================================\n');

  const reportPayload = {
    generatedAt: new Date().toISOString(),
    auditScope: 'Raw offer address extraction and location scope (offline/local, zero Google Geocoding calls)',
    totalOffersAudited: totalAllOffers,
    summary: {
      totalOnlineOffers: totalOnline,
      onlineZeroAddressAccuracyPct: Number(((totalOnlineClean / (totalOnline || 1)) * 100).toFixed(2)),
      totalSingleVenueExplicit: totalSingle,
      totalMultiBranchChains: totalMulti,
      multiBranchSplitAccuracyPct: Number(((totalMultiClean / (totalMulti || 1)) * 100).toFixed(2)),
      totalSelectedOutletsUncertaintyPreserved: totalSelected,
      totalNationwideAllOutlets: totalNationwide,
      totalUnresolvedScope: totalUnresolved,
      totalPhysicalAddressesExtracted: totalPhysicalAddrs,
      noiseLeakageRatePct: Number(((totalNoiseLeaks / (totalPhysicalAddrs || 1)) * 100).toFixed(2)),
    },
    bankBreakdown: overallResults.map((b) => ({
      bank: b.bank,
      totalOffers: b.totalOffers,
      online: {
        total: b.onlineOffers,
        zeroAddressClean: b.onlineWithZeroAddresses,
        falseAddresses: b.onlineWithFalseAddresses,
      },
      singleVenue: b.singleVenueOffers,
      multiBranchChains: {
        total: b.multiBranchOffers,
        splitProperly: b.multiBranchSplitProperly,
      },
      selectedOutlets: b.selectedOutletsOffers,
      nationwide: b.nationwideOffers,
      unresolved: b.unresolvedOffers,
      physicalAddressesExtracted: b.totalAddressesExtracted,
      offersWithAddresses: b.offersWithAddresses,
      noiseLeaks: b.noiseLeakedAddresses,
      sampleSingle: b.sampleSingle[0] || null,
      sampleMulti: b.sampleMulti[0] || null,
      sampleOnline: b.sampleOnline[0] || null,
      sampleSelected: b.sampleSelectedOutlets[0] || null,
    })),
  };

  const reportDir = path.join(__dirname, '..', 'reports', 'data-quality');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'address-extraction-audit.json'), JSON.stringify(reportPayload, null, 2));
  console.log(`Saved detailed audit report to reports/data-quality/address-extraction-audit.json`);

  // Print sample inspections
  console.log('--- SAMPLE INSPECTIONS ---');
  for (const s of overallResults) {
    if (s.sampleSingle.length > 0) {
      console.log(`\n[${s.bank.toUpperCase()}] Sample Single Venue:`, JSON.stringify(s.sampleSingle[0], null, 2));
    }
    if (s.sampleMulti.length > 0) {
      console.log(`\n[${s.bank.toUpperCase()}] Sample Multi-Branch Chain:`, JSON.stringify(s.sampleMulti[0], null, 2));
    }
    if (s.sampleOnline.length > 0) {
      console.log(`\n[${s.bank.toUpperCase()}] Sample Online (No Address):`, JSON.stringify(s.sampleOnline[0], null, 2));
    }
  }
}

main().catch(console.error);
