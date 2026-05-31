import { useMemo } from 'react';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import {
  shiftStatusColors,
  shiftStatusLabel,
  formatLocalTimeShort,
} from './shiftHelpers';
import {
  buildResourceRows,
  computeDisplayBand,
  computeDayWindowMs,
  computeBarGeometry,
  assignLanes,
  buildHourTicks,
} from './resourceLaneHelpers';
import s from './ResourceLaneView.module.css';

// ═══════════════════════════════════════════════════════════════
// ResourceLaneView — PR 1 (Day board)
//
// A custom, dependency-free "lane" calendar: one row per resource
// (caregiver or client) with shifts laid out as horizontal bars along a
// single day's time axis. Designed to stay readable as the client roster
// grows — each resource gets its own lane instead of every shift piling
// into one day column.
//
// All layout math lives in resourceLaneHelpers.js (unit-tested); this
// component is a thin presentational shell that wires that math to the
// DOM and reuses the shared shift colors / time formatting so it matches
// the rest of the calendar exactly.
// ═══════════════════════════════════════════════════════════════

const BAR_HEIGHT = 26; // px — height of a single shift bar
const BAR_GAP = 4; // px — vertical gap between stacked (overlapping) bars
const ROW_PADDING = 6; // px — top+bottom breathing room inside a lane

function hourLabel(hour) {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${suffix}`;
}

/**
 * The text shown inside a shift bar depends on which entity owns the row:
 * a caregiver lane shows who they're caring for; a client lane shows who's
 * assigned (or that it's still open).
 */
function barPrimaryLabel(shift, { mode, rowType, clientsById, caregiversById }) {
  if (mode === 'client') {
    const cg = shift.assignedCaregiverId ? caregiversById[shift.assignedCaregiverId] : null;
    const name = cg ? `${cg.firstName || ''} ${cg.lastName || ''}`.trim() : '';
    return name || 'Open';
  }
  // caregiver / unassigned lane → show the client
  const client = clientsById[shift.clientId];
  const name = client ? `${client.firstName || ''} ${client.lastName || ''}`.trim() : '';
  const base = name || 'Client';
  return rowType === 'unassigned' ? `${base} (open)` : base;
}

export function ResourceLaneView({
  date,
  mode = 'caregiver',
  shifts = [],
  caregivers = [],
  clients = [],
  clientsById = {},
  caregiversById = {},
  includeEmptyRows = false,
  timezone = DEFAULT_APP_TIMEZONE,
  onShiftClick,
}) {
  const band = useMemo(
    () => computeDisplayBand(shifts, { date, timezone }),
    [shifts, date, timezone],
  );

  const dayWindow = useMemo(
    () =>
      computeDayWindowMs({
        date,
        startHour: band.startHour,
        endHour: band.endHour,
        timezone,
      }),
    [date, band.startHour, band.endHour, timezone],
  );

  const ticks = useMemo(
    () => buildHourTicks(band.startHour, band.endHour),
    [band.startHour, band.endHour],
  );

  const rows = useMemo(
    () => buildResourceRows({ mode, shifts, caregivers, clients, includeEmptyRows }),
    [mode, shifts, caregivers, clients, includeEmptyRows],
  );

  // Lay out each row's bars into stacked sub-lanes and compute geometry.
  const laidOutRows = useMemo(() => {
    return rows.map((row) => {
      const intervals = row.shifts.map((shift) => ({
        startMs: Date.parse(shift.startTime),
        endMs: Date.parse(shift.endTime),
        shift,
      }));
      const { intervals: placed, laneCount } = assignLanes(intervals);
      const bars = [];
      for (const iv of placed) {
        const geom = computeBarGeometry(iv.startMs, iv.endMs, dayWindow.startMs, dayWindow.endMs);
        if (!geom) continue;
        bars.push({ ...iv, geom });
      }
      const height = Math.max(1, laneCount) * BAR_HEIGHT + (laneCount - 1) * BAR_GAP + ROW_PADDING * 2;
      return { row, bars, height };
    });
  }, [rows, dayWindow.startMs, dayWindow.endMs]);

  // "Now" indicator — only when the board is showing today.
  const nowLeftPct = useMemo(() => {
    const now = Date.now();
    if (now < dayWindow.startMs || now > dayWindow.endMs) return null;
    return ((now - dayWindow.startMs) / (dayWindow.endMs - dayWindow.startMs)) * 100;
  }, [dayWindow.startMs, dayWindow.endMs]);

  const span = band.endHour - band.startHour;
  const hourWidthPct = span > 0 ? 100 / span : 100;

  const isEmpty = laidOutRows.length === 0;

  return (
    <div className={s.board} style={{ '--hour-w': `${hourWidthPct}%` }}>
      {/* Time axis header */}
      <div className={s.headerRow}>
        <div className={s.corner}>{mode === 'client' ? 'Client' : 'Caregiver'}</div>
        <div className={s.axis}>
          {ticks.map((t, i) => (
            <span
              key={`${t.hour}-${i}`}
              className={s.tick}
              style={{ left: `${t.leftPct}%` }}
            >
              {hourLabel(t.hour)}
            </span>
          ))}
        </div>
      </div>

      {/* Scrollable rows */}
      <div className={s.rows}>
        {isEmpty && (
          <div className={s.empty}>
            No shifts to show for this day.
          </div>
        )}

        {laidOutRows.map(({ row, bars, height }) => (
          <div key={row.id} className={s.row}>
            <div
              className={`${s.rowLabel} ${row.type === 'unassigned' ? s.rowLabelUnassigned : ''}`}
            >
              <span className={s.rowLabelText} title={row.label}>
                {row.label}
              </span>
              <span className={s.rowCount}>{row.shifts.length}</span>
            </div>
            <div className={s.track} style={{ height: `${height}px` }}>
              {/* hourly gridlines */}
              <div className={s.gridlines} aria-hidden="true" />
              {nowLeftPct != null && (
                <div className={s.nowLine} style={{ left: `${nowLeftPct}%` }} aria-hidden="true" />
              )}
              {bars.map(({ shift, geom, lane }) => {
                const colors = shiftStatusColors(shift.status);
                const start = new Date(shift.startTime);
                const end = new Date(shift.endTime);
                const primary = barPrimaryLabel(shift, {
                  mode,
                  rowType: row.type,
                  clientsById,
                  caregiversById,
                });
                const timeText = `${formatLocalTimeShort(start, timezone)}–${formatLocalTimeShort(end, timezone)}`;
                return (
                  <button
                    key={shift.id}
                    type="button"
                    className={s.bar}
                    style={{
                      left: `${geom.leftPct}%`,
                      width: `${geom.widthPct}%`,
                      top: `${ROW_PADDING + lane * (BAR_HEIGHT + BAR_GAP)}px`,
                      height: `${BAR_HEIGHT}px`,
                      background: colors.bg,
                      borderColor: colors.border,
                      color: colors.fg,
                    }}
                    title={`${primary} · ${timeText} · ${shiftStatusLabel(shift.status)}`}
                    onClick={() => onShiftClick?.(shift)}
                  >
                    <span className={s.barTime}>{timeText}</span>
                    <span className={s.barName}>{primary}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
