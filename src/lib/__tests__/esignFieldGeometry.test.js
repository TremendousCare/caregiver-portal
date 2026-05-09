import { describe, it, expect } from 'vitest';
import {
  clampFieldRect,
  computeDraggedRect,
  computeResizedField,
} from '../esignFieldGeometry.js';

const PAGE = { pageWidth: 612, pageHeight: 792 }; // US Letter @ 72dpi

describe('clampFieldRect', () => {
  it('passes through a fully in-bounds rect unchanged', () => {
    const r = clampFieldRect({ x: 100, y: 200, w: 200, h: 50, ...PAGE });
    expect(r).toEqual({ x: 100, y: 200, w: 200, h: 50 });
  });

  it('clamps a field that overflows the right edge', () => {
    const r = clampFieldRect({ x: 500, y: 100, w: 200, h: 50, ...PAGE });
    expect(r.x).toBe(412); // 612 - 200
    expect(r.y).toBe(100);
  });

  it('clamps a field that overflows the bottom edge', () => {
    const r = clampFieldRect({ x: 100, y: 800, w: 200, h: 50, ...PAGE });
    expect(r.y).toBe(742); // 792 - 50
    expect(r.x).toBe(100);
  });

  it('clamps negative coords to 0', () => {
    const r = clampFieldRect({ x: -50, y: -10, w: 100, h: 20, ...PAGE });
    expect(r).toEqual({ x: 0, y: 0, w: 100, h: 20 });
  });

  it('caps a field wider than the page to page width and pins to 0', () => {
    const r = clampFieldRect({ x: 100, y: 100, w: 1000, h: 50, ...PAGE });
    expect(r.w).toBe(612);
    expect(r.x).toBe(0);
  });

  it('caps a field taller than the page to page height and pins to 0', () => {
    const r = clampFieldRect({ x: 100, y: 100, w: 50, h: 2000, ...PAGE });
    expect(r.h).toBe(792);
    expect(r.y).toBe(0);
  });
});

describe('computeDraggedRect', () => {
  // A field at PDF (200, 300), 200x50, displayed at scale 0.8.
  // Delta-based: starting pointer at clientX=400, clientY=500.
  const base = {
    startClientX: 400,
    startClientY: 500,
    startFieldX: 200,
    startFieldY: 300,
    scale: 0.8,
    fieldW: 200,
    fieldH: 50,
    ...PAGE,
  };

  it('returns the start position when the pointer has not moved', () => {
    const r = computeDraggedRect({ ...base, clientX: 400, clientY: 500 });
    expect(r.x).toBe(200);
    expect(r.y).toBe(300);
  });

  it('moves the field by the pointer delta, scaled to PDF units', () => {
    // Pointer moved 80 right, 40 down → 100 PDF right, 50 PDF down at scale 0.8
    const r = computeDraggedRect({ ...base, clientX: 480, clientY: 540 });
    expect(r.x).toBe(300);
    expect(r.y).toBe(350);
  });

  it('clamps to the right page edge instead of disappearing off-page', () => {
    const r = computeDraggedRect({ ...base, clientX: 100_000, clientY: 500 });
    expect(r.x).toBe(412); // 612 - 200
  });

  it('clamps to the bottom page edge', () => {
    const r = computeDraggedRect({ ...base, clientX: 400, clientY: 100_000 });
    expect(r.y).toBe(742); // 792 - 50
  });

  it('clamps to (0,0) when dragged far above-left', () => {
    const r = computeDraggedRect({ ...base, clientX: -100_000, clientY: -100_000 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('is layout-shift safe: result depends only on the delta, not page rect', () => {
    // Same delta → same result, regardless of any "page rect" we never touched.
    const a = computeDraggedRect({ ...base, clientX: 450, clientY: 520 });
    const b = computeDraggedRect({
      ...base,
      startClientX: 1000, // page could have shifted; only delta matters
      startClientY: 2000,
      clientX: 1050,
      clientY: 2020,
    });
    expect(a).toEqual(b);
  });
});

describe('computeResizedField', () => {
  const baseField = { startW: 200, startH: 50, startX: 100, startY: 100 };
  const env = { scale: 1, ...PAGE };

  it('grows width when dragging the east handle right', () => {
    const r = computeResizedField({
      ...baseField,
      ...env,
      handle: 'e',
      startMouseX: 0,
      startMouseY: 0,
      mouseX: 50,
      mouseY: 0,
    });
    expect(r).toEqual({ x: 100, y: 100, w: 250, h: 50 });
  });

  it('shrinks width and shifts x when dragging the west handle right', () => {
    const r = computeResizedField({
      ...baseField,
      ...env,
      handle: 'w',
      startMouseX: 0,
      startMouseY: 0,
      mouseX: 30,
      mouseY: 0,
    });
    expect(r.w).toBe(170);
    expect(r.x).toBe(130);
  });

  it('enforces the minimum width', () => {
    const r = computeResizedField({
      ...baseField,
      ...env,
      handle: 'e',
      startMouseX: 0,
      startMouseY: 0,
      mouseX: -1000,
      mouseY: 0,
    });
    expect(r.w).toBe(16);
  });

  it('caps width to page width when dragging far past the right edge', () => {
    const r = computeResizedField({
      ...baseField,
      ...env,
      handle: 'e',
      startMouseX: 0,
      startMouseY: 0,
      mouseX: 10_000,
      mouseY: 0,
    });
    expect(r.w).toBeLessThanOrEqual(PAGE.pageWidth);
    expect(r.x + r.w).toBeLessThanOrEqual(PAGE.pageWidth);
  });

  it('handles corner handles (se grows both dimensions)', () => {
    const r = computeResizedField({
      ...baseField,
      ...env,
      handle: 'se',
      startMouseX: 0,
      startMouseY: 0,
      mouseX: 30,
      mouseY: 20,
    });
    expect(r).toEqual({ x: 100, y: 100, w: 230, h: 70 });
  });
});
