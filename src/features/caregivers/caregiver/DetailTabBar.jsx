import styles from './messaging.module.css';

const LEGACY_CAREGIVER_TABS = [
  { key: 'tasks', label: 'Activity & Tasks' },
  { key: 'messages', label: 'Messages', badgeKey: 'needsResponse' },
  { key: 'availability', label: 'Availability' },
  { key: 'schedule', label: 'Schedule' },
];

/**
 * Tab bar used by both the caregiver and client detail views.
 *
 * Two ways to use it:
 *   1. Pass a `tabs` prop (array of { key, label, badge? }) — used by
 *      ClientDetail to render its 3-tab layout.
 *   2. Omit `tabs` — falls back to the original 4-tab caregiver layout.
 *      `needsResponse` controls the Messages-tab badge in this mode.
 *
 * The fallback path keeps existing CaregiverDetail call sites byte-identical.
 */
export function DetailTabBar({ activeTab, onChange, needsResponse, tabs }) {
  const resolved = tabs || LEGACY_CAREGIVER_TABS.map((t) =>
    t.badgeKey === 'needsResponse' ? { ...t, badge: !!needsResponse } : t,
  );

  return (
    <div className={styles.detailTabBar}>
      {resolved.map((tab) => (
        <button
          key={tab.key}
          className={`${styles.detailTab} ${activeTab === tab.key ? styles.detailTabActive : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.badge && <span className={styles.tabBadge}>!</span>}
        </button>
      ))}
    </div>
  );
}
