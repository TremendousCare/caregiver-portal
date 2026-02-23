import { useState, useCallback } from 'react';
import s from './ApplyPage.module.css';

const APPLY_API_KEY = 'wh_e8881c4759b6de2f6455cf53c001ebd4';
const WEBHOOK_URL = 'https://zocrnurvazyxdpyqimgj.supabase.co/functions/v1/client-intake-webhook';

const INITIAL_FORM = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  zip: '',
  message: '',
};

function validateForm(form) {
  const errors = {};
  if (!form.firstName.trim()) errors.firstName = 'First name is required';
  if (!form.lastName.trim()) errors.lastName = 'Last name is required';
  if (!form.phone.trim()) {
    errors.phone = 'Phone number is required';
  } else if (!/^[\d\s()+-]{7,20}$/.test(form.phone.trim())) {
    errors.phone = 'Please enter a valid phone number';
  }
  if (!form.email.trim()) {
    errors.email = 'Email is required';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'Please enter a valid email address';
  }
  return errors;
}

export function ApplyPage() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const handleChange = useCallback((field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    // Clear field error on change
    setErrors((e) => {
      if (!e[field]) return e;
      const next = { ...e };
      delete next[field];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setSubmitError(null);

    const validationErrors = validateForm(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        source: 'website',
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
      };
      if (form.address.trim()) payload.address = form.address.trim();
      if (form.city.trim()) payload.city = form.city.trim();
      if (form.state.trim()) payload.state = form.state.trim();
      if (form.zip.trim()) payload.zip = form.zip.trim();
      if (form.message.trim()) payload.message = form.message.trim();

      const res = await fetch(`${WEBHOOK_URL}?api_key=${APPLY_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submission failed (${res.status})`);
      }

      setSubmitted(true);
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [form]);

  const handleReset = useCallback(() => {
    setForm(INITIAL_FORM);
    setErrors({});
    setSubmitError(null);
    setSubmitted(false);
  }, []);

  // ── Success State ──
  if (submitted) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>
            Tremendous <span className={s.logoAccent}>Care</span>
          </div>
        </div>
        <div className={s.card}>
          <div className={s.success}>
            <div className={s.successIcon}>&#10003;</div>
            <h2 className={s.successTitle}>Thank You!</h2>
            <p className={s.successText}>
              Your application has been received. Our team will review your
              information and reach out to you shortly.
            </p>
            <button className={s.anotherBtn} onClick={handleReset}>
              Submit Another Application
            </button>
          </div>
        </div>
        <div className={s.footer}>
          Tremendous Care &middot; Home Care Staffing
        </div>
      </div>
    );
  }

  // ── Form State ──
  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.logo}>
          Tremendous <span className={s.logoAccent}>Care</span>
        </div>
        <p className={s.tagline}>Home Care Staffing</p>
        <h1 className={s.title}>Caregiver Application</h1>
        <p className={s.subtitle}>
          Interested in joining our team? Fill out the form below and we will
          be in touch.
        </p>
      </div>

      <form className={s.card} onSubmit={handleSubmit} noValidate>
        {/* ── Contact Information ── */}
        <h3 className={s.section}>Contact Information</h3>
        <div className={s.grid}>
          <Field
            label="First Name"
            required
            placeholder="Jane"
            value={form.firstName}
            error={errors.firstName}
            onChange={(v) => handleChange('firstName', v)}
          />
          <Field
            label="Last Name"
            required
            placeholder="Doe"
            value={form.lastName}
            error={errors.lastName}
            onChange={(v) => handleChange('lastName', v)}
          />
          <Field
            label="Phone"
            type="tel"
            required
            placeholder="(949) 555-1234"
            value={form.phone}
            error={errors.phone}
            onChange={(v) => handleChange('phone', v)}
          />
          <Field
            label="Email"
            type="email"
            required
            placeholder="jane@email.com"
            value={form.email}
            error={errors.email}
            onChange={(v) => handleChange('email', v)}
          />
        </div>

        {/* ── Address (optional) ── */}
        <h3 className={s.section}>Address</h3>
        <div className={s.grid}>
          <div className={s.fullWidth}>
            <Field
              label="Street Address"
              placeholder="123 Main St, Apt 4"
              value={form.address}
              onChange={(v) => handleChange('address', v)}
            />
          </div>
          <Field
            label="City"
            placeholder="Costa Mesa"
            value={form.city}
            onChange={(v) => handleChange('city', v)}
          />
          <Field
            label="State"
            placeholder="CA"
            value={form.state}
            onChange={(v) => handleChange('state', v)}
          />
          <Field
            label="Zip Code"
            placeholder="92627"
            value={form.zip}
            onChange={(v) => handleChange('zip', v)}
          />
        </div>

        {/* ── Message ── */}
        <h3 className={s.section}>About You</h3>
        <div className={s.field}>
          <label className={s.label}>Tell us about yourself</label>
          <textarea
            className={s.textarea}
            placeholder="Share your caregiving experience, availability, certifications, or anything else you'd like us to know..."
            value={form.message}
            onChange={(e) => handleChange('message', e.target.value)}
            rows={4}
          />
        </div>

        {/* ── Submit ── */}
        <button
          type="submit"
          className={s.submitBtn}
          disabled={submitting}
        >
          {submitting ? 'Submitting...' : 'Submit Application'}
        </button>

        {/* ── Error ── */}
        {submitError && (
          <div className={s.error}>
            <span className={s.errorIcon}>!</span>
            <div className={s.errorBody}>
              <p className={s.errorText}>{submitError}</p>
              <button
                type="button"
                className={s.retryBtn}
                onClick={handleSubmit}
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </form>

      <div className={s.footer}>
        Tremendous Care &middot; Home Care Staffing
      </div>
    </div>
  );
}

/* ── Reusable Field Component ── */

function Field({ label, type = 'text', required, placeholder, value, error, onChange }) {
  return (
    <div className={s.field}>
      <label className={s.label}>
        {label}
        {required && <span className={s.required}>*</span>}
      </label>
      <input
        className={`${s.input}${error ? ` ${s.inputError}` : ''}`}
        type={type}
        placeholder={placeholder}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className={s.fieldError}>{error}</span>}
    </div>
  );
}
