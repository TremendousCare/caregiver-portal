import s from './LegalPage.module.css';
import { LEGAL_NAME, BRAND_NAME, CONTACT_EMAIL, LAST_UPDATED } from './legalInfo';

// Public, no-auth privacy policy. Linked from the QuickBooks / Intuit
// production app listing and reachable at /privacy.
export function PrivacyPolicy() {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.logo}>
          Tremendous<span className={s.logoAccent}>Care</span>
        </div>
        <div className={s.tagline}>Caregiver Portal</div>
      </header>

      <main className={s.doc}>
        <h1 className={s.title}>Privacy Policy</h1>
        <p className={s.updated}>Last updated: {LAST_UPDATED}</p>

        <p className={s.intro}>
          This Privacy Policy describes how {LEGAL_NAME} (&ldquo;{BRAND_NAME},&rdquo;
          &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, and
          protects information in connection with the Caregiver Portal (the
          &ldquo;Service&rdquo;), an internal operations platform used by our staff to
          manage caregiver recruiting, scheduling, client care, and back-office
          accounting.
        </p>

        <h2>Who this policy is for</h2>
        <p>
          The Service is a private business application operated by {BRAND_NAME} for its
          own employees, contractors, caregivers, and clients. It is not a consumer
          product offered to the general public. Access requires an account that we
          provision.
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Account information</strong> — names, email addresses, phone
            numbers, and roles for staff, caregivers, and clients we work with.
          </li>
          <li>
            <strong>Operational records</strong> — recruiting notes, scheduling and
            shift data, care documentation, and communications generated in the normal
            course of running our home-care agency.
          </li>
          <li>
            <strong>Accounting data from QuickBooks Online</strong> — when an authorized
            owner connects our QuickBooks Online company, the Service accesses
            accounting records (such as customers, invoices, and related financial
            data) through Intuit&rsquo;s API. See &ldquo;QuickBooks Online
            integration&rdquo; below.
          </li>
        </ul>

        <h2>QuickBooks Online integration</h2>
        <p>
          We integrate with QuickBooks Online via Intuit&rsquo;s authorized OAuth 2.0
          flow. Only an account owner can establish this connection, and the connection
          is limited to our own QuickBooks company file.
        </p>
        <ul>
          <li>
            <strong>Scope of access.</strong> We request the accounting scope
            (<code>com.intuit.quickbooks.accounting</code>) together with basic
            OpenID profile and email scopes used to identify the authorizing user.
          </li>
          <li>
            <strong>How it is used.</strong> Accounting data is used solely to support
            internal billing, reconciliation, and financial reporting within the
            Service for our own agency. We do not use QuickBooks data for advertising,
            and we never sell it.
          </li>
          <li>
            <strong>Tokens and security.</strong> OAuth access and refresh tokens are
            stored encrypted in our managed secrets vault (Supabase Vault) and are never
            exposed to the browser or written to application tables. Access is
            restricted to the owner role and server-side processes.
          </li>
          <li>
            <strong>Disconnecting.</strong> An owner can disconnect QuickBooks at any
            time from the Service&rsquo;s Settings page, which deletes the stored tokens.
            Access can also be revoked from within your Intuit account.
          </li>
        </ul>

        <h2>How we use information</h2>
        <ul>
          <li>To operate, maintain, and improve the Service.</li>
          <li>To coordinate caregiver recruiting, scheduling, and client care.</li>
          <li>To perform billing, accounting, and financial reporting.</li>
          <li>To communicate with staff, caregivers, and clients.</li>
          <li>To comply with legal, regulatory, and contractual obligations.</li>
        </ul>

        <h2>How we share information</h2>
        <p>
          We do not sell personal information. We share information only with service
          providers that help us operate the Service (for example, our cloud hosting,
          database, and integration providers such as Vercel, Supabase, and Intuit),
          and only as needed for them to perform those services, or when required by
          law.
        </p>

        <h2>Data retention</h2>
        <p>
          We retain information for as long as needed to operate the Service and to meet
          legal, tax, and recordkeeping obligations. QuickBooks tokens are retained only
          while the connection is active and are deleted on disconnect.
        </p>

        <h2>Security</h2>
        <p>
          We use industry-standard safeguards including encryption in transit,
          row-level access controls, role-based permissions, and encrypted storage of
          credentials. No method of transmission or storage is completely secure, but we
          work to protect information using reasonable administrative and technical
          measures.
        </p>

        <h2>Your choices</h2>
        <p>
          If you are a staff member, caregiver, or client and wish to access, correct,
          or delete information we hold about you, contact us using the details below
          and we will respond consistent with applicable law.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. Material changes will be
          reflected by updating the &ldquo;Last updated&rdquo; date above.
        </p>

        <h2>Contact us</h2>
        <p>
          Questions about this Privacy Policy can be directed to {LEGAL_NAME} at{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>

        <div className={s.footer}>
          <a href="/terms">Terms of Service</a>
        </div>
      </main>
    </div>
  );
}
