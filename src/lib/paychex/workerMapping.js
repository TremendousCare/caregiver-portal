// Pure mapping: caregivers row + organizations.settings + a reference
// date → a single Paychex Worker payload (one object).
//
// The Phase 2 sync edge function consumes the return value of this
// function and either POSTs it (wrapped as a single-element array,
// per the Paychex API) or PATCHes it. This file MUST stay free of
// I/O and side effects — every Paychex-shape decision is exercised
// by workerMapping.test.js.
//
// What this function deliberately does NOT include in the payload:
//   - legalId  (SSN). Filed via the Paychex-hosted onboarding flow
//                     (Phase 6). Never stored in our database.
//   - birthDate. Same reason as legalId.
//   - hireDate. The Phase 2 sync creates workers in IN_PROGRESS /
//                  PENDING_HIRE state with a placeholder
//                  effectiveDate. The actual hire date is set later
//                  by the Phase 3+ promotion automation when the
//                  caregiver's first non-cancelled shift completes.
//                  There is intentionally no caregivers.hire_date
//                  column to read from.
//
// Shape of the returned `currentStatus`:
//   { statusType: 'IN_PROGRESS', statusReason: 'PENDING_HIRE',
//     effectiveDate: <referenceDate + offsetDays> in 'YYYY-MM-DD' }
//
// See: docs/plans/2026-04-25-paychex-integration-plan.md
//      ("Phase 2 — Paychex client and worker sync"
//       and "Decisions locked").

/**
 * Returns true iff the value is a non-empty string after trimming.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Coerce a string-ish value to its trimmed form, or undefined when
 * it isn't a usable string. Names with internal whitespace (e.g.
 * "Mary Jo") keep that whitespace; only surrounding whitespace is
 * stripped.
 */
function trimOrUndefined(value) {
  if (!isNonEmptyString(value)) return undefined;
  return value.trim();
}

/**
 * Converts a reference date and a non-negative integer day offset to
 * an ISO date string (YYYY-MM-DD) in UTC. The Paychex Worker
 * `effectiveDate` field is a calendar date, not a timestamp, so we
 * deliberately drop the time component.
 *
 * Accepts a Date, an ISO string, or a YYYY-MM-DD string. Throws if
 * the input isn't parseable — mapping is preceded by an explicit
 * referenceDate from the edge function so a parse failure here is a
 * caller bug, not a runtime condition to swallow.
 */
function isoDatePlusDays(referenceDate, offsetDays) {
  if (!Number.isInteger(offsetDays) || offsetDays < 0) {
    throw new Error(
      `workerMapping: pending-hire offsetDays must be a non-negative integer (got ${String(offsetDays)})`,
    );
  }

  let base;
  if (referenceDate instanceof Date) {
    base = referenceDate;
  } else if (typeof referenceDate === 'string' && referenceDate.length > 0) {
    // Parse YYYY-MM-DD as a UTC date so day arithmetic doesn't shift
    // across timezone boundaries. Accept full ISO strings too.
    if (/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      base = new Date(`${referenceDate}T00:00:00.000Z`);
    } else {
      base = new Date(referenceDate);
    }
  } else {
    throw new Error(
      'workerMapping: referenceDate must be a Date or ISO date string',
    );
  }

  if (Number.isNaN(base.getTime())) {
    throw new Error(
      `workerMapping: referenceDate is not a valid date (${String(referenceDate)})`,
    );
  }

  const result = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + offsetDays,
  ));

  const yyyy = result.getUTCFullYear();
  const mm = String(result.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(result.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Builds the Paychex Worker `name` sub-object from a caregivers row.
 * Tolerates any combination of:
 *   - first_name / firstName / givenName
 *   - last_name  / lastName  / familyName
 *   - middle_name / middleName
 *   - preferred_name / preferredName / nickname
 * Caregivers in the production DB only have first_name + last_name;
 * the optional fields are accepted defensively so future schema
 * additions don't require a code change here.
 */
function buildName(caregiver) {
  const givenName = trimOrUndefined(
    caregiver.first_name ?? caregiver.firstName ?? caregiver.givenName,
  );
  const familyName = trimOrUndefined(
    caregiver.last_name ?? caregiver.lastName ?? caregiver.familyName,
  );

  if (!givenName || !familyName) {
    throw new Error(
      'workerMapping: caregiver is missing required first_name or last_name',
    );
  }

  const middleName = trimOrUndefined(
    caregiver.middle_name ?? caregiver.middleName,
  );
  const preferredName = trimOrUndefined(
    caregiver.preferred_name ?? caregiver.preferredName ?? caregiver.nickname,
  );

  const name = { givenName, familyName };
  if (middleName) name.middleName = middleName;
  if (preferredName) name.preferredName = preferredName;
  return name;
}

/**
 * Pulls the Paychex defaults from organizations.settings, with safe
 * fallbacks to the values TC ships with so a misconfigured-but-still-
 * functional org doesn't silently produce a malformed worker. The
 * sync edge function asserts companyId separately because that's a
 * fail-loud condition, not a default-able one.
 */
function readDefaults(orgSettings) {
  const settings = orgSettings || {};
  const paychex = settings.paychex || {};
  const payroll = settings.payroll || {};

  const employmentType = isNonEmptyString(paychex.default_employment_type)
    ? paychex.default_employment_type.trim()
    : 'FULL_TIME';

  const exemptionType = isNonEmptyString(paychex.default_exemption_type)
    ? paychex.default_exemption_type.trim()
    : 'NON_EXEMPT';

  // Non-negative integer; reject NaN/negative/non-integer.
  const rawOffset = payroll.default_pending_hire_date_offset_days;
  const offsetDays =
    Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 14;

  return { employmentType, exemptionType, offsetDays };
}

/**
 * Build the Paychex Worker payload for a single caregiver.
 *
 * @param {object} args
 * @param {object} args.caregiver       Row from `caregivers` (must have id,
 *                                      first_name, last_name).
 * @param {object} args.orgSettings     `organizations.settings` jsonb.
 * @param {Date|string} args.referenceDate  "Today" for the offset
 *                                      calculation. The caller (the
 *                                      sync edge function) supplies
 *                                      this so tests can pin it.
 * @returns {object} A single Paychex Worker object. The edge function
 *                   wraps it in `[...]` for POST, sends as-is for PATCH.
 */
export function buildPaychexWorker({ caregiver, orgSettings, referenceDate }) {
  if (!caregiver || typeof caregiver !== 'object') {
    throw new Error('workerMapping: caregiver is required');
  }
  if (!isNonEmptyString(caregiver.id)) {
    throw new Error('workerMapping: caregiver.id is required for workerCorrelationId');
  }
  if (referenceDate === undefined || referenceDate === null) {
    throw new Error('workerMapping: referenceDate is required');
  }

  const { employmentType, exemptionType, offsetDays } = readDefaults(orgSettings);
  const effectiveDate = isoDatePlusDays(referenceDate, offsetDays);

  return {
    workerCorrelationId: caregiver.id,
    workerType: 'EMPLOYEE',
    employmentType,
    exemptionType,
    name: buildName(caregiver),
    currentStatus: {
      statusType: 'IN_PROGRESS',
      statusReason: 'PENDING_HIRE',
      effectiveDate,
    },
  };
}

/**
 * Inspect a Paychex worker shape returned by GET /workers/{id} (or by
 * the array-shape POST response) and return a structured rehire
 * decision. The Phase 2 sync function calls this before issuing a
 * PATCH to avoid auto-reactivating a TERMINATED worker — TC wants
 * those handled manually in Paychex Flex.
 *
 * Returns { rehire: false } when the worker is in any state other
 * than TERMINATED (or when the input is missing). Returns
 * { rehire: true, lastTerminationDate, lastTerminationReason } when
 * a rehire block is required.
 *
 * Pure function — used by the edge function and exercised by the
 * mapping test suite.
 */
export function detectRehire(existingWorker) {
  const status = existingWorker && existingWorker.currentStatus;
  if (!status || typeof status !== 'object') return { rehire: false };
  if (status.statusType !== 'TERMINATED') return { rehire: false };

  return {
    rehire: true,
    lastTerminationDate: isNonEmptyString(status.effectiveDate)
      ? status.effectiveDate
      : null,
    lastTerminationReason: isNonEmptyString(status.statusReason)
      ? status.statusReason
      : null,
  };
}
