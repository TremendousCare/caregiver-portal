import { describe, it, expect } from 'vitest';
import { haversineMeters, evaluateGeofence, formatDistanceUs } from '../geofence';

// Two well-known points for a sanity check on the math.
// Apple Park <-> One Infinite Loop is ~1.1 km.
const APPLE_PARK = { lat: 37.33467, lng: -122.00888 };
const INFINITE_LOOP = { lat: 37.33182, lng: -122.03118 };

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(APPLE_PARK, APPLE_PARK)).toBeCloseTo(0, 5);
  });

  it('matches the known Apple Park → Infinite Loop distance within 50m', () => {
    const d = haversineMeters(APPLE_PARK, INFINITE_LOOP);
    expect(d).toBeGreaterThan(1950);
    expect(d).toBeLessThan(2050);
  });

  it('is symmetric', () => {
    const ab = haversineMeters(APPLE_PARK, INFINITE_LOOP);
    const ba = haversineMeters(INFINITE_LOOP, APPLE_PARK);
    expect(ab).toBeCloseTo(ba, 5);
  });

  it('returns null for missing coordinates', () => {
    expect(haversineMeters(null, APPLE_PARK)).toBeNull();
    expect(haversineMeters(APPLE_PARK, { lat: 'x', lng: 0 })).toBeNull();
  });

  it('handles large distances (NY → LA)', () => {
    const ny = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };
    const d = haversineMeters(ny, la);
    // ~3,940 km — check within ±50 km
    expect(d).toBeGreaterThan(3_890_000);
    expect(d).toBeLessThan(3_990_000);
  });
});

describe('evaluateGeofence', () => {
  const client = { lat: 37.33467, lng: -122.00888 };

  it('passes when caregiver is at the client address', () => {
    const r = evaluateGeofence({ caregiver: client, client, radiusM: 150 });
    expect(r.passed).toBe(true);
    expect(r.distanceM).toBeCloseTo(0, 2);
  });

  it('passes when caregiver is within the radius', () => {
    // ~20m north
    const caregiver = { lat: client.lat + 0.00018, lng: client.lng };
    const r = evaluateGeofence({ caregiver, client, radiusM: 150 });
    expect(r.passed).toBe(true);
    expect(r.distanceM).toBeGreaterThan(15);
    expect(r.distanceM).toBeLessThan(25);
  });

  it('fails when caregiver is clearly outside the radius', () => {
    const caregiver = INFINITE_LOOP; // ~2km away
    const r = evaluateGeofence({ caregiver, client, radiusM: 150 });
    expect(r.passed).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });

  it('forgives the GPS accuracy radius', () => {
    // ~200m away with ±100m accuracy → effective 100m, passes a 150m fence
    const caregiver = { lat: client.lat + 0.0018, lng: client.lng };
    const strict = evaluateGeofence({ caregiver, client, radiusM: 150, accuracyM: 0 });
    const lenient = evaluateGeofence({ caregiver, client, radiusM: 150, accuracyM: 100 });
    expect(strict.passed).toBe(false);
    expect(lenient.passed).toBe(true);
  });

  it('reports client_not_geocoded when client has no coordinates', () => {
    const r = evaluateGeofence({ caregiver: client, client: { lat: null, lng: null }, radiusM: 150 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('client_not_geocoded');
  });

  it('reports no_caregiver_fix when the caregiver position is missing', () => {
    const r = evaluateGeofence({ caregiver: null, client, radiusM: 150 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('no_caregiver_fix');
  });

  it('treats negative accuracy as zero', () => {
    const caregiver = { lat: client.lat + 0.0002, lng: client.lng }; // ~22m
    const r = evaluateGeofence({ caregiver, client, radiusM: 150, accuracyM: -50 });
    expect(r.passed).toBe(true);
  });
});

describe('formatDistanceUs', () => {
  it('formats short distances in feet', () => {
    expect(formatDistanceUs(30)).toMatch(/ft$/);
    expect(formatDistanceUs(30)).toBe('98 ft');
  });

  it('formats long distances in miles with one decimal under 10mi', () => {
    expect(formatDistanceUs(1609)).toMatch(/mi$/);
    expect(formatDistanceUs(1609)).toBe('1.0 mi');
  });

  it('formats very long distances without a decimal', () => {
    expect(formatDistanceUs(50_000)).toBe('31 mi');
  });

  it('returns a placeholder for non-finite inputs', () => {
    expect(formatDistanceUs(NaN)).toBe('—');
    expect(formatDistanceUs(null)).toBe('—');
  });
});
