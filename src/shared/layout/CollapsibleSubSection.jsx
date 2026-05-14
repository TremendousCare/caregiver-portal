import { useState, useEffect, useRef, useCallback } from 'react';
import layout from '../../styles/layout.module.css';

function loadExpanded(storageKey, defaultExpanded) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultExpanded;
    return raw === '1';
  } catch { return defaultExpanded; }
}

function saveExpanded(storageKey, expanded) {
  try { localStorage.setItem(storageKey, expanded ? '1' : '0'); } catch {}
}

// ─── Collapsible sub-section used inside the parent sidebar sections ───
// Mirrors the look-and-feel of SidebarSection (uppercase label + rotating chevron)
// but persists its own state under `storageKey`.
export function CollapsibleSubSection({ storageKey, label, defaultExpanded = false, children }) {
  const [expanded, setExpanded] = useState(() => loadExpanded(storageKey, defaultExpanded));
  const contentRef = useRef(null);
  const [contentHeight, setContentHeight] = useState(expanded ? 'auto' : 0);
  const isFirstRender = useRef(true);

  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      saveExpanded(storageKey, next);
      return next;
    });
  }, [storageKey]);

  useEffect(() => {
    if (isFirstRender.current) {
      setContentHeight(expanded ? 'auto' : 0);
      isFirstRender.current = false;
      return;
    }
    if (!contentRef.current) return;
    if (expanded) {
      const h = contentRef.current.scrollHeight;
      setContentHeight(h);
      const timer = setTimeout(() => setContentHeight('auto'), 250);
      return () => clearTimeout(timer);
    } else {
      const h = contentRef.current.scrollHeight;
      setContentHeight(h);
      requestAnimationFrame(() => { setContentHeight(0); });
    }
  }, [expanded]);

  return (
    <div className={layout.sidebarSection}>
      <button
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '0 14px 10px', border: 'none',
          background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{
          fontSize: 10, textTransform: 'uppercase', letterSpacing: '1.8px',
          color: expanded ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.25)',
          fontWeight: 700, transition: 'color 0.2s',
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 9, color: 'rgba(255,255,255,0.2)',
          transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          display: 'inline-block',
        }}>
          ▾
        </span>
      </button>
      <div
        ref={contentRef}
        style={{
          height: contentHeight,
          overflow: contentHeight === 'auto' ? 'visible' : 'hidden',
          transition: contentHeight === 'auto' ? 'none' : 'height 0.25s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
