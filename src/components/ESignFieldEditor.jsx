import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import btn from '../styles/buttons.module.css';
import { isRadioGroupMember, groupCheckboxFields } from '../lib/esignCheckboxGroups.js';

// Use the bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

const FIELD_COLORS = {
  signature: { bg: 'rgba(46, 78, 141, 0.15)', border: '#2E4E8D', label: 'Signature' },
  initials: { bg: 'rgba(41, 190, 228, 0.15)', border: '#29BEE4', label: 'Initials' },
  date: { bg: 'rgba(234, 88, 12, 0.15)', border: '#EA580C', label: 'Date' },
  text: { bg: 'rgba(21, 128, 61, 0.15)', border: '#15803D', label: 'Text' },
  checkbox: { bg: 'rgba(124, 58, 237, 0.22)', border: '#7C3AED', label: 'Check' },
};

const DEFAULT_SIZES = {
  signature: { w: 200, h: 50 },
  initials: { w: 80, h: 30 },
  date: { w: 120, h: 20 },
  text: { w: 200, h: 20 },
  checkbox: { w: 14, h: 14 },
};

/**
 * Visual PDF field placement editor.
 * Renders PDF pages and lets users click to place fields, drag to reposition.
 *
 * Props:
 * - pdfUrl: string (signed URL or blob URL of the template PDF)
 * - fields: array of field objects
 * - onFieldsChange: (fields) => void
 * - readOnly: boolean
 */
export function ESignFieldEditor({ pdfUrl, fields = [], onFieldsChange, readOnly = false }) {
  const [pages, setPages] = useState([]); // Array of { canvas, width, height, pageNum }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedField, setSelectedField] = useState(null);
  const [dragging, setDragging] = useState(null); // { fieldId, offsetX, offsetY }
  const [resizing, setResizing] = useState(null); // { fieldId, handle, startX, startY, startW, startH, startFieldX, startFieldY }
  const [activePage, setActivePage] = useState(1);
  const [placingType, setPlacingType] = useState(null); // field type being placed
  const [scale, setScale] = useState(1);
  const containerRef = useRef(null);
  const canvasRefs = useRef({});

  // Render PDF pages
  useEffect(() => {
    if (!pdfUrl) return;
    let cancelled = false;

    const loadPdf = async () => {
      setLoading(true);
      setError(null);
      try {
        const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
        const rendered = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1 });

          // Scale to fit container width (max ~600px)
          const containerWidth = containerRef.current?.clientWidth || 600;
          const pageScale = Math.min((containerWidth - 32) / viewport.width, 1.5);
          const scaledViewport = page.getViewport({ scale: pageScale });

          const dpr = window.devicePixelRatio || 1;
          const renderViewport = page.getViewport({ scale: pageScale * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;
          const ctx = canvas.getContext('2d');

          await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

          rendered.push({
            dataUrl: canvas.toDataURL(),
            width: viewport.width,
            height: viewport.height,
            displayWidth: scaledViewport.width,
            displayHeight: scaledViewport.height,
            pageNum: i,
            scale: pageScale,
          });
        }

        if (!cancelled) {
          setPages(rendered);
          setScale(rendered[0]?.scale || 1);
          setLoading(false);
          // Report page count up
          if (onFieldsChange && rendered.length > 0) {
            // Don't modify fields, just let parent know page count
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error('PDF load error:', err);
          setError('Failed to load PDF. Make sure it\'s a valid PDF file.');
          setLoading(false);
        }
      }
    };

    loadPdf();
    return () => { cancelled = true; };
  }, [pdfUrl]);

  // Handle click on page to place a new field
  const handlePageClick = useCallback((e, pageNum) => {
    if (readOnly || !placingType) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const pageData = pages.find((p) => p.pageNum === pageNum);
    if (!pageData) return;

    // Get click position relative to the page image, then convert to PDF coordinates
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Convert display coordinates to PDF coordinates
    const pdfX = Math.round(clickX / pageData.scale);
    const pdfY = Math.round(clickY / pageData.scale);

    const size = DEFAULT_SIZES[placingType];
    const newField = {
      id: `${placingType}_${Date.now().toString(36)}`,
      type: placingType,
      page: pageNum,
      x: pdfX,
      y: pdfY,
      w: size.w,
      h: size.h,
      required: placingType !== 'checkbox',
      label: '',
      ...(placingType === 'checkbox' ? { group: '' } : {}),
    };

    const updated = [...fields, newField];
    onFieldsChange?.(updated);
    setSelectedField(newField.id);
    setPlacingType(null); // Stop placing after one click
  }, [placingType, fields, onFieldsChange, pages, readOnly]);

  // Handle mouse down on a field (start drag)
  const handleFieldMouseDown = useCallback((e, fieldId) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();

    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;

    const pageData = pages.find((p) => p.pageNum === field.page);
    if (!pageData) return;

    const rect = e.currentTarget.closest('[data-page]').getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Field position in display coordinates
    const fieldDisplayX = field.x * pageData.scale;
    const fieldDisplayY = field.y * pageData.scale;

    setDragging({
      fieldId,
      offsetX: mouseX - fieldDisplayX,
      offsetY: mouseY - fieldDisplayY,
      pageData,
    });
    setSelectedField(fieldId);
  }, [fields, pages, readOnly]);

  // Handle mouse move (drag)
  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e) => {
      const pageEl = document.querySelector(`[data-page="${fields.find((f) => f.id === dragging.fieldId)?.page}"]`);
      if (!pageEl) return;

      const rect = pageEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newX = Math.max(0, Math.round((mouseX - dragging.offsetX) / dragging.pageData.scale));
      const newY = Math.max(0, Math.round((mouseY - dragging.offsetY) / dragging.pageData.scale));

      const updated = fields.map((f) =>
        f.id === dragging.fieldId ? { ...f, x: newX, y: newY } : f
      );
      onFieldsChange?.(updated);
    };

    const handleUp = () => {
      setDragging(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, fields, onFieldsChange]);

  // Handle resize handle mouse down
  const handleResizeMouseDown = useCallback((e, fieldId, handle) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();

    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;

    const pageData = pages.find((p) => p.pageNum === field.page);
    if (!pageData) return;

    setResizing({
      fieldId,
      handle, // 'se', 'sw', 'ne', 'nw', 'e', 'w', 'n', 's'
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startW: field.w || 100,
      startH: field.h || 20,
      startX: field.x,
      startY: field.y,
      pageData,
    });
    setSelectedField(fieldId);
  }, [fields, pages, readOnly]);

  // Handle resize mouse move
  useEffect(() => {
    if (!resizing) return;

    const handleMove = (e) => {
      const { handle, startMouseX, startMouseY, startW, startH, startX, startY, pageData } = resizing;
      const dx = Math.round((e.clientX - startMouseX) / pageData.scale);
      const dy = Math.round((e.clientY - startMouseY) / pageData.scale);

      let newW = startW;
      let newH = startH;
      let newX = startX;
      let newY = startY;

      // Adjust based on which handle is being dragged
      if (handle.includes('e')) newW = Math.max(16, startW + dx);
      if (handle.includes('w')) { newW = Math.max(16, startW - dx); newX = startX + (startW - newW); }
      if (handle.includes('s')) newH = Math.max(12, startH + dy);
      if (handle.includes('n')) { newH = Math.max(12, startH - dy); newY = startY + (startH - newH); }

      const updated = fields.map((f) =>
        f.id === resizing.fieldId ? { ...f, w: newW, h: newH, x: newX, y: newY } : f
      );
      onFieldsChange?.(updated);
    };

    const handleUp = () => setResizing(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizing, fields, onFieldsChange]);

  // Delete selected field
  const deleteSelected = useCallback(() => {
    if (!selectedField) return;
    const updated = fields.filter((f) => f.id !== selectedField);
    onFieldsChange?.(updated);
    setSelectedField(null);
  }, [selectedField, fields, onFieldsChange]);

  // Update selected field property
  const updateSelectedField = useCallback((key, value) => {
    if (!selectedField) return;
    const updated = fields.map((f) =>
      f.id === selectedField ? { ...f, [key]: value } : f
    );
    onFieldsChange?.(updated);
  }, [selectedField, fields, onFieldsChange]);

  const selectedFieldData = fields.find((f) => f.id === selectedField);
  const currentPageFields = fields.filter((f) => f.page === activePage);

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#7A8BA0', fontSize: 13 }}>
        <div style={{
          display: 'inline-block', width: 20, height: 20, border: '2px solid #D1D5DB',
          borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        <div style={{ marginTop: 8 }}>Loading PDF...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: '#DC2626', fontSize: 13, background: '#FEF2F2', borderRadius: 8 }}>
        {error}
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div style={{ padding: 16, color: '#7A8BA0', fontSize: 13, textAlign: 'center' }}>
        No PDF loaded. Upload a PDF first.
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ userSelect: 'none' }}>
      {/* Toolbar */}
      {!readOnly && (
        <div style={{
          display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10,
          padding: '8px 10px', background: '#F8F9FB', borderRadius: 8, border: '1px solid #E0E4EA',
          alignItems: 'center',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#7A8BA0', marginRight: 4 }}>Place:</span>
          {Object.entries(FIELD_COLORS).map(([type, config]) => (
            <button
              key={type}
              onClick={() => setPlacingType(placingType === type ? null : type)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit', border: '1px solid',
                borderColor: placingType === type ? config.border : '#D5DCE6',
                background: placingType === type ? config.bg : '#fff',
                color: placingType === type ? config.border : '#4B5563',
                transition: 'all 0.15s',
              }}
            >
              {config.label}
            </button>
          ))}
          {selectedField && (
            <>
              <div style={{ width: 1, height: 20, background: '#D5DCE6', margin: '0 4px' }} />
              <button
                onClick={deleteSelected}
                style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit', border: '1px solid #FECACA',
                  background: '#FEF2F2', color: '#DC2626',
                }}
              >
                Delete Field
              </button>
            </>
          )}
        </div>
      )}

      {placingType && (
        <div style={{
          padding: '6px 12px', marginBottom: 8, background: '#FFFBEB', border: '1px solid #FDE68A',
          borderRadius: 8, fontSize: 12, color: '#854D0E', fontWeight: 500,
        }}>
          Click on the document where you want to place the {FIELD_COLORS[placingType]?.label || placingType} field.
          <button
            onClick={() => setPlacingType(null)}
            style={{
              marginLeft: 8, background: 'none', border: 'none', color: '#854D0E',
              textDecoration: 'underline', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Page tabs */}
      {pages.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          {pages.map((p) => {
            const pageFieldCount = fields.filter((f) => f.page === p.pageNum).length;
            return (
              <button
                key={p.pageNum}
                onClick={() => setActivePage(p.pageNum)}
                style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: activePage === p.pageNum ? '1px solid #2E4E8D' : '1px solid #D5DCE6',
                  background: activePage === p.pageNum ? '#2E4E8D' : '#fff',
                  color: activePage === p.pageNum ? '#fff' : '#4B5563',
                }}
              >
                Page {p.pageNum} {pageFieldCount > 0 ? `(${pageFieldCount})` : ''}
              </button>
            );
          })}
        </div>
      )}

      {/* PDF page with field overlays */}
      {pages.filter((p) => p.pageNum === activePage).map((pageData) => (
        <div
          key={pageData.pageNum}
          data-page={pageData.pageNum}
          style={{
            position: 'relative',
            width: pageData.displayWidth,
            height: pageData.displayHeight,
            border: '1px solid #D5DCE6',
            borderRadius: 8,
            overflow: 'hidden',
            cursor: placingType ? 'crosshair' : 'default',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}
          onClick={(e) => handlePageClick(e, pageData.pageNum)}
        >
          {/* Rendered PDF page */}
          <img
            src={pageData.dataUrl}
            alt={`Page ${pageData.pageNum}`}
            style={{ width: pageData.displayWidth, height: pageData.displayHeight, display: 'block' }}
            draggable={false}
          />

          {/* Field overlays */}
          {currentPageFields.map((field) => {
            const colors = FIELD_COLORS[field.type] || FIELD_COLORS.text;
            const isSelected = selectedField === field.id;
            const displayX = field.x * pageData.scale;
            const displayY = field.y * pageData.scale;
            const displayW = (field.w || 100) * pageData.scale;
            const displayH = (field.h || 20) * pageData.scale;
            const isRadio = isRadioGroupMember(field, fields);
            const diameter = Math.min(displayW, displayH);

            const handleStyle = (cursor) => ({
              position: 'absolute', width: 8, height: 8,
              background: '#fff', border: `2px solid ${colors.border}`,
              borderRadius: 2, cursor, zIndex: 20,
            });

            return (
              <div
                key={field.id}
                onMouseDown={(e) => handleFieldMouseDown(e, field.id)}
                onClick={(e) => { e.stopPropagation(); setSelectedField(field.id); }}
                style={{
                  position: 'absolute',
                  left: displayX,
                  top: displayY,
                  width: displayW,
                  height: displayH,
                  background: isRadio ? 'transparent' : colors.bg,
                  border: isRadio ? 'none' : `2px ${isSelected ? 'solid' : 'dashed'} ${colors.border}`,
                  borderRadius: 3,
                  cursor: readOnly ? 'default' : 'move',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: field.type === 'checkbox' ? Math.max(12, displayH * 0.9) : Math.max(9, 10 * pageData.scale),
                  fontWeight: 600,
                  color: colors.border,
                  lineHeight: 1,
                  boxShadow: isSelected && !isRadio ? `0 0 0 2px ${colors.border}40` : 'none',
                  zIndex: isSelected ? 10 : 1,
                  transition: 'box-shadow 0.1s',
                  overflow: 'visible',
                }}
                title={`${colors.label} — ${field.w}x${field.h}${isRadio ? ` · group "${field.group}"` : ''}`}
              >
                {isRadio ? (
                  <div style={{
                    width: diameter, height: diameter, borderRadius: '50%',
                    border: `2px ${isSelected ? 'solid' : 'dashed'} ${colors.border}`,
                    background: colors.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: isSelected ? `0 0 0 2px ${colors.border}40` : 'none',
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                  }}>
                    <div style={{
                      width: '45%', height: '45%', borderRadius: '50%', background: colors.border,
                    }} />
                  </div>
                ) : (field.type === 'checkbox' ? '\u2610' : colors.label)}
                {field.required && field.type !== 'checkbox' && <span style={{ color: '#DC2626', marginLeft: 2 }}>*</span>}
                {isRadio && (
                  <div style={{
                    position: 'absolute', top: '100%', left: '50%', transform: 'translate(-50%, 2px)',
                    padding: '1px 6px', borderRadius: 10, fontSize: 9, fontWeight: 600,
                    background: colors.border, color: '#fff', whiteSpace: 'nowrap',
                    pointerEvents: 'none', letterSpacing: 0.2,
                  }}>
                    {field.group}
                  </div>
                )}

                {/* Resize handles — only on selected field */}
                {isSelected && !readOnly && (
                  <>
                    {/* Corners */}
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'nw')}
                      style={{ ...handleStyle('nw-resize'), top: -5, left: -5 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'ne')}
                      style={{ ...handleStyle('ne-resize'), top: -5, right: -5 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'sw')}
                      style={{ ...handleStyle('sw-resize'), bottom: -5, left: -5 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'se')}
                      style={{ ...handleStyle('se-resize'), bottom: -5, right: -5 }} />
                    {/* Edge midpoints */}
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'n')}
                      style={{ ...handleStyle('n-resize'), top: -5, left: '50%', marginLeft: -4 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 's')}
                      style={{ ...handleStyle('s-resize'), bottom: -5, left: '50%', marginLeft: -4 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'w')}
                      style={{ ...handleStyle('w-resize'), top: '50%', left: -5, marginTop: -4 }} />
                    <div onMouseDown={(e) => handleResizeMouseDown(e, field.id, 'e')}
                      style={{ ...handleStyle('e-resize'), top: '50%', right: -5, marginTop: -4 }} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Selected field properties */}
      {selectedFieldData && !readOnly && (
        <div style={{
          marginTop: 10, padding: '10px 12px', background: '#F8F9FB', borderRadius: 8,
          border: '1px solid #E0E4EA', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: FIELD_COLORS[selectedFieldData.type]?.border || '#333', textTransform: 'capitalize' }}>
            {selectedFieldData.type}
          </span>
          <label style={{ fontSize: 10, color: '#7A8BA0' }}>X:</label>
          <input
            type="number" value={selectedFieldData.x}
            onChange={(e) => updateSelectedField('x', parseInt(e.target.value) || 0)}
            style={{ width: 50, fontSize: 11, padding: '2px 4px', border: '1px solid #D5DCE6', borderRadius: 4 }}
          />
          <label style={{ fontSize: 10, color: '#7A8BA0' }}>Y:</label>
          <input
            type="number" value={selectedFieldData.y}
            onChange={(e) => updateSelectedField('y', parseInt(e.target.value) || 0)}
            style={{ width: 50, fontSize: 11, padding: '2px 4px', border: '1px solid #D5DCE6', borderRadius: 4 }}
          />
          <label style={{ fontSize: 10, color: '#7A8BA0' }}>W:</label>
          <input
            type="number" value={selectedFieldData.w}
            onChange={(e) => updateSelectedField('w', parseInt(e.target.value) || 50)}
            style={{ width: 50, fontSize: 11, padding: '2px 4px', border: '1px solid #D5DCE6', borderRadius: 4 }}
          />
          <label style={{ fontSize: 10, color: '#7A8BA0' }}>H:</label>
          <input
            type="number" value={selectedFieldData.h}
            onChange={(e) => updateSelectedField('h', parseInt(e.target.value) || 20)}
            style={{ width: 50, fontSize: 11, padding: '2px 4px', border: '1px solid #D5DCE6', borderRadius: 4 }}
          />
          <label style={{ fontSize: 10, color: '#7A8BA0', display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
            <input
              type="checkbox" checked={selectedFieldData.required}
              onChange={(e) => updateSelectedField('required', e.target.checked)}
            />
            Required
          </label>
          {selectedFieldData.type === 'text' && (
            <>
              <label style={{ fontSize: 10, color: '#7A8BA0' }}>Label:</label>
              <input
                type="text" value={selectedFieldData.label || ''}
                onChange={(e) => updateSelectedField('label', e.target.value)}
                placeholder="Field label"
                style={{ width: 120, fontSize: 11, padding: '2px 6px', border: '1px solid #D5DCE6', borderRadius: 4 }}
              />
            </>
          )}
          {selectedFieldData.type === 'checkbox' && (() => {
            const groupName = (selectedFieldData.group || '').trim();
            const groupMembers = groupName
              ? (groupCheckboxFields(fields).get(groupName) || [])
              : [];
            const groupRequired = groupMembers.some((m) => m.required === true);
            const isGrouped = groupMembers.length >= 2;
            return (
              <>
                <label style={{ fontSize: 10, color: '#7A8BA0' }}>Group:</label>
                <input
                  type="text" value={selectedFieldData.group || ''}
                  onChange={(e) => updateSelectedField('group', e.target.value)}
                  placeholder="e.g. filing_status"
                  title="Checkboxes in the same group act as radio buttons — selecting one deselects the others"
                  style={{ width: 110, fontSize: 11, padding: '2px 6px', border: '1px solid #D5DCE6', borderRadius: 4 }}
                />
                {groupName && (
                  <span style={{ fontSize: 10, color: isGrouped ? '#7C3AED' : '#7A8BA0', fontWeight: 600 }}>
                    {isGrouped
                      ? `${groupMembers.length} fields · ${groupRequired ? 'required' : 'optional'}`
                      : 'only field in this group'}
                  </span>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Summary */}
      <div style={{ marginTop: 8, fontSize: 11, color: '#7A8BA0' }}>
        {pages.length} page{pages.length !== 1 ? 's' : ''} &middot; {fields.length} field{fields.length !== 1 ? 's' : ''} placed
      </div>
    </div>
  );
}
