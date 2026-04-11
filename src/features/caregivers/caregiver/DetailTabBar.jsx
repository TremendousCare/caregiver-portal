import styles from './messaging.module.css';

/**
 * Tab bar for switching between "Activity & Tasks" and "Messages" views
 * on the caregiver detail page.
 */
export function DetailTabBar({ activeTab, onChange, needsResponse }) {
  return (
    <div className={styles.detailTabBar}>
      <button
        className={`${styles.detailTab} ${activeTab === 'tasks' ? styles.detailTabActive : ''}`}
        onClick={() => onChange('tasks')}
      >
        Activity &amp; Tasks
      </button>
      <button
        className={`${styles.detailTab} ${activeTab === 'messages' ? styles.detailTabActive : ''}`}
        onClick={() => onChange('messages')}
      >
        Messages
        {needsResponse && <span className={styles.tabBadge}>!</span>}
      </button>
    </div>
  );
}
