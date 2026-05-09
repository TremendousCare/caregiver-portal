import { useNavigate, useParams } from 'react-router-dom';
import s from './BdPortal.module.css';

// Stub for navigation. The full account profile (header, contacts,
// timeline, AI summary) ships in PR #2.
export function AccountProfile() {
  const { accountId } = useParams();
  const navigate = useNavigate();

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
      </div>
      <div className={s.card}>
        <div className={s.sectionTitle}>Account profile</div>
        <p className={s.briefingText}>
          The full profile screen — header, contacts, timeline, AI summary — ships next.
        </p>
        <p className={s.muted}>Account id: <code>{accountId}</code></p>
      </div>
    </div>
  );
}
