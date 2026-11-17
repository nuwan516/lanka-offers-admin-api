/**
 * Confirms Google Places text-search hits before they can become branch pins.
 *
 * A hit is confirmed only when it is inside Sri Lanka, is not the country
 * centroid, is not a duplicate, and the name/address agree with the query
 * (including a named town). Everything else stays unconfirmed and must not
 * be written as a branch coordinate.
 */

import { SRI_LANKAN_CITIES } from '@/core/constants/cities';

export interface PlacesMatchInput {
  placeId?: string;
  name?: string;
  formattedAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  types?: string[];
  businessStatus?: string;
}

export interface PlacesMatchDecision {
  placeId: string;
  name: string;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
  confidence: number;
  confirmed: boolean;
  reason: string;
}

export interface PlacesApiPlace {
  id?: string;
  displayName?: { text?: string } | string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  businessStatus?: string;
}

const SRI_LANKA_BOUNDS = { minLat: 5.9, maxLat: 10.0, minLng: 79.5, maxLng: 82.0 };

const STOPWORDS = new Set([
  'sri', 'lanka', 'the', 'and', 'hotel', 'hotels', 'restaurant', 'branch',
  'outlet', 'outlets', 'supermarket', 'store', 'stores', 'of', 'at', 'for',
]);

const CITIES_BY_LENGTH = [...SRI_LANKAN_CITIES].sort((a, b) => b.length - a.length);

function inSriLanka(lat: number, lng: number): boolean {
  return (
    lat >= SRI_LANKA_BOUNDS.minLat &&
    lat <= SRI_LANKA_BOUNDS.maxLat &&
    lng >= SRI_LANKA_BOUNDS.minLng &&
    lng <= SRI_LANKA_BOUNDS.maxLng
  );
}

function isCountryCentroid(lat: number, lng: number, types: string[]): boolean {
  if (types.includes('country')) return true;
  return Math.abs(lat - 7.8731) < 0.05 && Math.abs(lng - 80.7718) < 0.05;
}

function citiesIn(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const city of CITIES_BY_LENGTH) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) found.push(city);
  }
  return found;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/sri\s+lanka/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/**
 * Score a saved Places response (or an equivalent in-memory hit list).
 * Confirmed decisions are the only ones allowed to keep coordinates.
 */
export function confirmPlacesMatches(query: string, places: PlacesMatchInput[]): PlacesMatchDecision[] {
  const decisions: PlacesMatchDecision[] = [];
  const seenIds = new Set<string>();
  const seenCoords = new Set<string>();
  const queryCities = citiesIn(query);
  const queryTokens = tokens(query).filter((t) => !queryCities.includes(t));

  places.forEach((place, index) => {
    const placeId = (place.placeId ?? '').trim();
    const name = (place.name ?? '').trim();
    const formattedAddress = (place.formattedAddress ?? '').trim();
    const types = place.types ?? [];
    const lat = place.latitude;
    const lng = place.longitude;
    const base = { placeId: placeId || `missing-${index}`, name, formattedAddress };

    const reject = (reason: string, confidence = 0): PlacesMatchDecision => ({
      ...base,
      latitude: null,
      longitude: null,
      confidence,
      confirmed: false,
      reason,
    });

    if (!placeId) {
      decisions.push(reject('Missing place id'));
      return;
    }
    if (seenIds.has(placeId)) {
      decisions.push(reject('Duplicate place id'));
      return;
    }
    seenIds.add(placeId);

    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      decisions.push(reject('Missing coordinates'));
      return;
    }
    if (!inSriLanka(lat, lng)) {
      decisions.push(reject('Coordinates outside Sri Lanka'));
      return;
    }
    if (isCountryCentroid(lat, lng, types)) {
      decisions.push(reject('Country centroid'));
      return;
    }
    if ((place.businessStatus ?? '').toUpperCase() === 'CLOSED_PERMANENTLY') {
      decisions.push(reject('Permanently closed'));
      return;
    }

    const resultText = `${name} ${formattedAddress}`;
    const resultCities = citiesIn(resultText);
    if (queryCities.length > 0 && queryCities.some((city) => !resultCities.includes(city))) {
      decisions.push(reject(`Wrong place: query town not in result (${queryCities.join(', ')})`, 0.2));
      return;
    }

    const resultTokens = new Set(tokens(resultText));
    const matched = queryTokens.filter((t) => resultTokens.has(t));
    const confidence = queryTokens.length === 0 ? 0 : Math.round((matched.length / queryTokens.length) * 100) / 100;
    if (queryTokens.length === 0 || confidence < 0.6) {
      decisions.push(reject('Wrong place: name does not match the query', confidence));
      return;
    }

    const coordKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seenCoords.has(coordKey)) {
      decisions.push(reject('Duplicate coordinates', confidence));
      return;
    }
    seenCoords.add(coordKey);

    decisions.push({
      ...base,
      latitude: lat,
      longitude: lng,
      confidence,
      confirmed: true,
      reason: 'Name, town, and coordinates agree',
    });
  });

  return decisions;
}

/** Adapt a saved Places API (New) searchText body. No network. */
export function confirmPlacesApiResponse(
  query: string,
  response: { places?: PlacesApiPlace[] },
): PlacesMatchDecision[] {
  const places = (response.places ?? []).map((p) => ({
    placeId: p.id,
    name: typeof p.displayName === 'string' ? p.displayName : p.displayName?.text ?? '',
    formattedAddress: p.formattedAddress ?? '',
    latitude: p.location?.latitude,
    longitude: p.location?.longitude,
    types: p.types,
    businessStatus: p.businessStatus,
  }));
  return confirmPlacesMatches(query, places);
}
