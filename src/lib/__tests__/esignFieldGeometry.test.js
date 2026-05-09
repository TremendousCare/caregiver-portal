import { describe, it, expect } from 'vitest';
import {
  clampFieldRect,
  computeDraggedPosition,
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
    // 612 - 200 = 412 — the rightmost x that keeps the field in-page
    expect(r.x).toBe(412);
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

describe('computeDraggedPosition', () => {
  // A field at PDF (200, 300), 200x50, scale 0.8.
  // Display position: (160, 240). Field display size: 160x40.
  // User clicks at page-relative display (220, 260) — 60px right, 20px below
  // the field's top-left. So offsetX=60, offsetY=20.
  const base = {
    offsetX: 60,
    offsetY: 20,
    scale: 0.8,
    fieldW: 200,
    fieldH: 50,
    ...PAGE,
  };

  it('returns the original position when the mouse has not moved', () => {
    // Mouse still at (220, 260) → expect ~(200, 300) PDF
    const r = computeDraggedPosition({ ...base, mouseX: 220, mouseY: 260 });
    expect(r).toEqual({ x: 200, y: 300 });
  });

  it('moves the field to follow the mouse', () => {
    // Mouse at (320, 340) — moved 100/80 display px → 125/100 PDF px
    const r = computeDraggedPosition({ ...base, mouseX: 320, mouseY: 340 });
    expect(r.x).toBe(325);
    expect(r.y).toBe(400);
  });

  it('clamps to the right page edge instead of disappearing off-page', () => {
    // Mouse way off to the right
    const r = computeDraggedPosition({ ...base, mouseX: 5000, mouseY: 260 });
    expect(r.x).toBe(412); // 612 - 200
  });

  it('clamps to the bottom page edge', () => {
    const r = computeDraggedPosition({ ...base, mouseX: 220, mouseY: 5000 });
    expect(r.y).toBe(742); // 792 - 50
  });

  it('clamps negatives to 0 (mouse dragged above-left of page)', () => {
    const r = computeDraggedPosition({ ...base, mouseX: -1000, mouseY: -1000 });
    expect(r).toEqual({ x: 0, y: 0 });
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
