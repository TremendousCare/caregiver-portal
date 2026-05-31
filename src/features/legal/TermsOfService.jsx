import s from './LegalPage.module.css';
import { LEGAL_NAME, BRAND_NAME, CONTACT_EMAIL, LAST_UPDATED } from './legalInfo';

// Public, no-auth Terms of Service / End-User License Agreement.
// Linked from the QuickBooks / Intuit production app listing and
// reachable at /terms.
export function TermsOfService() {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.logo}>
          Tremendous<span className={s.logoAccent}>Care</span>
        </div>
        <div className={s.tagline}>Caregiver Portal</div>
      </header>

      <main className={s.doc}>
        <h1 className={s.title}>Terms of Service</h1>
        <p className={s.updated}>Last updated: {LAST_UPDATED}</p>

        <p className={s.intro}>
          These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of the
          Caregiver Portal (the &ldquo;Service&rdquo;) operated by {LEGAL_NAME}
          (&ldquo;{BRAND_NAME},&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;). By accessing or using the Service, you agree to these
          Terms. If you do not agree, do not use the Service.
        </p>

        <h2>1. The Service</h2>
        <p>
          The Service is a private, internal operations platform used by {BRAND_NAME} to
          manage caregiver recruiting, scheduling, client care, and back-office
          accounting. It is provided for authorized users only and is not offered to the
          general public.
        </p>

        <h2>2. Accounts and eligibility</h2>
        <p>
          Access requires an account that we provision. You are responsible for
          maintaining the confidentiality of your credentials and for all activity that
          occurs under your account. You must promptly notify us of any unauthorized
          use.
        </p>

        <h2>3. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for any unlawful or unauthorized purpose.</li>
          <li>
            Access data you are not authorized to access, or attempt to circumvent
            access controls or security measures.
          </li>
          <li>
            Interfere with or disrupt the integrity or performance of the Service.
          </li>
          <li>
            Reverse engineer, copy, or resell the Service except as permitted by law.
          </li>
        </ul>

        <h2>4. QuickBooks Online integration</h2>
        <p>
          The Service can connect to QuickBooks Online through Intuit&rsquo;s authorized
          OAuth 2.0 flow. Only an account owner may establish this connection, and it is
          limited to {BRAND_NAME}&rsquo;s own QuickBooks company file. Your use of
          QuickBooks Online remains subject to Intuit&rsquo;s own terms. We access
          accounting data solely to support our internal billing, reconciliation, and
          financial reporting, as described in our{' '}
          <a href="/privacy">Privacy Policy</a>. An owner may disconnect the integration
          at any time from the Settings page.
        </p>

        <h2>5. Intellectual property</h2>
        <p>
          The Service, including its software, design, and content, is owned by
          {' '}{BRAND_NAME} and its licensors and is protected by applicable laws. These
          Terms do not grant you any ownership rights in the Service.
        </p>

        <h2>6. Third-party services</h2>
        <p>
          The Service relies on third-party providers (including Intuit, Vercel, and
          Supabase). We are not responsible for the availability, accuracy, or practices
          of third-party services, which are governed by their own terms.
        </p>

        <h2>7. Disclaimer of warranties</h2>
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;
          without warranties of any kind, whether express or implied, including
          warranties of merchantability, fitness for a particular purpose, and
          non-infringement, to the maximum extent permitted by law.
        </p>

        <h2>8. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, {BRAND_NAME} will not be liable for
          any indirect, incidental, special, consequential, or punitive damages, or for
          any loss of profits or data, arising out of or related to your use of the
          Service.
        </p>

        <h2>9. Termination</h2>
        <p>
          We may suspend or terminate access to the Service at any time, with or without
          notice, including for violation of these Terms.
        </p>

        <h2>10. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. Material changes will be reflected
          by updating the &ldquo;Last updated&rdquo; date above. Continued use of the
          Service after changes take effect constitutes acceptance of the revised Terms.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about these Terms can be directed to {LEGAL_NAME} at{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>

        <div className={s.footer}>
          <a href="/privacy">Privacy Policy</a>
        </div>
      </main>
    </div>
  );
}
