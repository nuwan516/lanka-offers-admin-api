import * as fs from 'fs';
import * as path from 'path';

// Load existing holdout to ensure zero overlap
const existingHoldoutPath = path.resolve(__dirname, '../tests/fixtures/100-holdout-offers.json');
const existingHoldout: any[] = JSON.parse(fs.readFileSync(existingHoldoutPath, 'utf8'));
const existingTitles = new Set(existingHoldout.map((h) => (h.candidateOffer?.title || '').toLowerCase().trim()));
const existingMerchants = new Set(existingHoldout.map((h) => (h.candidateOffer?.merchant?.name || '').toLowerCase().trim()));

console.log(`Existing holdout has ${existingHoldout.length} offers.`);

// The 4 forbidden optimization cases
const forbidden = new Set(['hnb-3', 'seylan-2', 'ndb-1', 'peoples-4']);
console.log('Forbidden cases:', Array.from(forbidden));
