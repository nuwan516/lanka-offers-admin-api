import { AddressEngine } from '@/parsing/address/address-engine';
import { parseConcatenatedBranches } from '@/parsing/geo/branch-parser';

describe('Bank Address Extraction Regressions (Engine & Concatenated Parser)', () => {
  const engine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

  // ─── Bug 1: stripContactInfo eats venue names ──────────────────────────────
  describe('Bug 1: stripContactInfo preserves venue names containing tel/web/hotline', () => {
    it('preserves Galle Face Hotel from "Location: Galle Face Hotel, Colombo 03"', () => {
      const result = engine.extract('Location: Galle Face Hotel, Colombo 03');
      expect(result).toEqual(['Galle Face Hotel, Colombo 03, Sri Lanka']);
    });

    it('preserves Webb Place from "Venue: Webb Place, Colombo 07"', () => {
      const result = engine.extract('Venue: Webb Place, Colombo 07');
      expect(result).toEqual(['Webb Place, Colombo 07, Sri Lanka']);
    });

    it('preserves Hotline Cafe from "Location: Hotline Cafe, Kandy"', () => {
      const result = engine.extract('Location: Hotline Cafe, Kandy');
      expect(result).toEqual(['Hotline Cafe, Kandy, Sri Lanka']);
    });

    it('preserves Hotel Janaki from "Hotel Janaki, Matale"', () => {
      const result = engine.extract('Hotel Janaki, Matale');
      expect(result).toEqual(['Hotel Janaki, Matale, Sri Lanka']);
    });

    it('still strips labeled contacts like "- Contact No : 077 371 0139"', () => {
      const result = engine.extract('Location: No 5, Galle Road, Colombo 03 - Contact No : 077 371 0139');
      expect(result).toEqual(['No 5, Galle Road, Colombo 03, Sri Lanka']);
    });

    it('strips phone numbers written with spaces like "Colombo 07 011 269 8161"', () => {
      const result = engine.extract('Location: Colombo 07 011 269 8161');
      expect(result).toEqual(['Colombo 07, Sri Lanka']);
    });
  });

  // ─── Bug 2: splitMulti over-splitting ──────────────────────────────────────
  describe('Bug 2: splitMulti single venue preservation vs genuine lists', () => {
    it('keeps "Cinnamon Grand, Galle Road, Colombo 03" as ONE address', () => {
      const result = engine.extract('Location: Cinnamon Grand, Galle Road, Colombo 03');
      expect(result).toEqual(['Cinnamon Grand, Galle Road, Colombo 03, Sri Lanka']);
    });

    it('keeps "Barefoot & Co, Colombo 03" as ONE address', () => {
      const result = engine.extract('Location: Barefoot & Co, Colombo 03');
      expect(result).toEqual(['Barefoot & Co, Colombo 03, Sri Lanka']);
    });

    it('keeps "Dolphin Hotel and Spa, Wadduwa" as ONE address', () => {
      const result = engine.extract('Location: Dolphin Hotel and Spa, Wadduwa');
      expect(result).toEqual(['Dolphin Hotel and Spa, Wadduwa, Sri Lanka']);
    });

    it('keeps "1st Floor, Majestic City, Colombo 04" as ONE address', () => {
      const result = engine.extract('Location: 1st Floor, Majestic City, Colombo 04');
      expect(result).toEqual(['1st Floor, Majestic City, Colombo 04, Sri Lanka']);
    });

    it('keeps "Level 3, One Galle Face Mall, Colombo 02" as ONE address', () => {
      const result = engine.extract('Location: Level 3, One Galle Face Mall, Colombo 02');
      expect(result).toEqual(['Level 3, One Galle Face Mall, Colombo 02, Sri Lanka']);
    });

    it('still splits genuine lists: "Branches: Nugegoda, Maharagama and Kottawa" into 3', () => {
      const result = engine.extract('Branches: Nugegoda, Maharagama and Kottawa');
      expect(result).toHaveLength(3);
      expect(result).toEqual([
        'Nugegoda, Sri Lanka',
        'Maharagama, Sri Lanka',
        'Kottawa, Sri Lanka',
      ]);
    });

    it('still splits genuine lists: "Outlets: Keells Super Nugegoda, Keells Super Rajagiriya" into 2', () => {
      const result = engine.extract('Outlets: Keells Super Nugegoda, Keells Super Rajagiriya');
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        'Keells Super Nugegoda, Sri Lanka',
        'Keells Super Rajagiriya, Sri Lanka',
      ]);
    });

    it('still splits genuine lists: "Available at: Galle Face Hotel, Cinnamon Lakeside Hotel" into 2', () => {
      const result = engine.extract('Available at: Galle Face Hotel, Cinnamon Lakeside Hotel');
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        'Galle Face Hotel, Sri Lanka',
        'Cinnamon Lakeside Hotel, Sri Lanka',
      ]);
    });
  });

  // ─── Bug 3: NOISE pattern /\boff\b/i ──────────────────────────────────────
  describe('Bug 3: NOISE pattern keeps "Off <Road>" and rejects discount wording', () => {
    it('keeps "Off Galle Road, Colombo 03"', () => {
      const result = engine.extract('Location: Off Galle Road, Colombo 03');
      expect(result).toEqual(['Off Galle Road, Colombo 03, Sri Lanka']);
    });

    it('keeps "No 5, Off High Level Road, Nugegoda"', () => {
      const result = engine.extract('Location: No 5, Off High Level Road, Nugegoda');
      expect(result).toEqual(['No 5, Off High Level Road, Nugegoda, Sri Lanka']);
    });

    it('rejects "Flat 20 off on all items"', () => {
      const result = engine.extract('Flat 20 off on all items');
      expect(result).toEqual([]);
    });

    it('rejects "Up to 30 off the total bill"', () => {
      const result = engine.extract('Up to 30 off the total bill');
      expect(result).toEqual([]);
    });
  });

  // ─── Bug 4: Terms sentence on same line ────────────────────────────────────
  describe('Bug 4: Terms sentence cuts at sentence boundary, not abbreviation dots', () => {
    it('extracts "Colombo 03" from "Location: Colombo 03. Valid on weekends only"', () => {
      const result = engine.extract('Location: Colombo 03. Valid on weekends only');
      expect(result).toEqual(['Colombo 03, Sri Lanka']);
    });

    it('preserves abbreviation dots in "Location: No. 5, Mt. Lavinia. Valid on weekends only"', () => {
      const result = engine.extract('Location: No. 5, Mt. Lavinia. Valid on weekends only');
      expect(result).toEqual(['No. 5, Mt. Lavinia, Sri Lanka']);
    });
  });

  // ─── Bug 5: Prose patterns stop at first "." ──────────────────────────────
  describe('Bug 5: Prose patterns do not stop at abbreviation dots', () => {
    it('extracts full address from "Visit us at No. 5, Galle Rd. Colombo 03"', () => {
      const result = engine.extract('Visit us at No. 5, Galle Rd. Colombo 03');
      expect(result).toEqual(['No. 5, Galle Rd. Colombo 03, Sri Lanka']);
    });
  });

  // ─── Bug 6: Promo text returned as address ────────────────────────────────
  describe('Bug 6: Promo text rejected and real addresses preserved', () => {
    it('rejects "Draw takes place in December"', () => {
      expect(engine.extract('Draw takes place in December')).toEqual([]);
    });

    it('rejects "Enjoy Street food all week"', () => {
      expect(engine.extract('Enjoy Street food all week')).toEqual([]);
    });

    it('rejects "Free delivery above Rs. 15000"', () => {
      expect(engine.extract('Free delivery above Rs. 15000')).toEqual([]);
    });

    it('rejects "Valid until 31/Dec"', () => {
      expect(engine.extract('Valid until 31/Dec')).toEqual([]);
    });

    it('rejects "In-store: Buy one get one free on all desserts"', () => {
      expect(engine.extract('In-store: Buy one get one free on all desserts')).toEqual([]);
    });

    it('rejects "Shop: Buy 2 get 1 free on shoes"', () => {
      expect(engine.extract('Shop: Buy 2 get 1 free on shoes')).toEqual([]);
    });

    it('still extracts real store: "Store: No 12, Main Street, Negombo"', () => {
      expect(engine.extract('Store: No 12, Main Street, Negombo')).toEqual([
        'No 12, Main Street, Negombo, Sri Lanka',
      ]);
    });

    it('still extracts real visit: "Visit Galle Road, Colombo 03 today"', () => {
      expect(engine.extract('Visit Galle Road, Colombo 03 today')).toEqual([
        'Visit Galle Road, Colombo 03 today, Sri Lanka',
      ]);
    });
  });

  // ─── Bug 10 (Part 1): parseConcatenatedBranches ────────────────────────────
  describe('Bug 10: parseConcatenatedBranches preserves Mc/Mac and City Mall', () => {
    it('keeps McDonald\'s whole without splitting into Donald\'s', () => {
      const result = parseConcatenatedBranches("McDonald's, No 123, High Level Road, Nugegoda");
      expect(result).toEqual(["McDonald's, No 123, High Level Road, Nugegoda"]);
    });

    it('keeps HavelockCity Mall whole', () => {
      const result = parseConcatenatedBranches("Level 2, HavelockCity Mall, Colombo 05");
      expect(result).toEqual(["Level 2, HavelockCity Mall, Colombo 05"]);
    });

    it('still splits concatenated branches like "Solar Crab, PamunugamaThe Walden, Nuwara Eliya"', () => {
      const result = parseConcatenatedBranches("Solar Crab, PamunugamaThe Walden, Nuwara Eliya");
      expect(result).toEqual([
        'Solar Crab, Pamunugama',
        'The Walden, Nuwara Eliya',
      ]);
    });
  });
});
