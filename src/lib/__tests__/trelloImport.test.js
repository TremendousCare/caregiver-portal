import { describe, it, expect } from 'vitest';
import { parseName, parseDescription, mapChecklists, convertComments, normalizePhone, buildDescriptionNote } from '../trelloParser.js';

// ============================================================
// parseName
// ============================================================
describe('parseName', () => {
  it('parses simple two-part name', () => {
    const result = parseName('Elizabeth Nicasio');
    expect(result.firstName).toBe('Elizabeth');
    expect(result.lastName).toBe('Nicasio');
    expect(result.annotation).toBeNull();
  });

  it('parses three-part name (first + rest as last)', () => {
    const result = parseName('Bernadette Martinez Wallick');
    expect(result.firstName).toBe('Bernadette');
    expect(result.lastName).toBe('Martinez Wallick');
  });

  it('strips parenthetical annotation', () => {
    const result = parseName('Amanda Vega (On Medical Leave until April 2026)');
    expect(result.firstName).toBe('Amanda');
    expect(result.lastName).toBe('Vega');
    expect(result.annotation).toBe('On Medical Leave until April 2026');
  });

  it('preserves hyphenated last name without annotation', () => {
    const result = parseName('Folasade Famofo-Idowu');
    expect(result.firstName).toBe('Folasade');
    expect(result.lastName).toBe('Famofo-Idowu');
    expect(result.annotation).toBeNull();
  });

  it('handles dash-annotation like "On Call"', () => {
    const result = parseName('Aaliyah Navarro-On Call');
    expect(result.firstName).toBe('Aaliyah');
    expect(result.lastName).toBe('Navarro');
    expect(result.annotation).toBe('On Call');
  });

  it('handles dash-annotation like "Resigned"', () => {
    const result = parseName('Mia Lopez-Resigned');
    expect(result.firstName).toBe('Mia');
    expect(result.lastName).toBe('Lopez');
    expect(result.annotation).toBe('Resigned');
  });

  it('detects dash-annotation with spaces after dash', () => {
    const result = parseName('Naomi Escobar-Medical leave car accident');
    expect(result.firstName).toBe('Naomi');
    expect(result.lastName).toBe('Escobar');
    expect(result.annotation).toBe('Medical leave car accident');
  });

  it('handles (Web) annotation', () => {
    const result = parseName('Seada Muhammed (Web)');
    expect(result.firstName).toBe('Seada');
    expect(result.lastName).toBe('Muhammed');
    expect(result.annotation).toBe('Web');
  });

  it('handles parenthetical with client codes like (SL)', () => {
    const result = parseName('Lina Nguyen (SL)');
    expect(result.firstName).toBe('Lina');
    expect(result.lastName).toBe('Nguyen');
    expect(result.annotation).toBe('SL');
  });

  it('handles single-word name gracefully', () => {
    const result = parseName('Madonna');
    expect(result.firstName).toBe('Madonna');
    expect(result.lastName).toBe('');
  });
});

// ============================================================
// normalizePhone
// ============================================================
describe('normalizePhone', () => {
  it('strips non-digits', () => {
    expect(normalizePhone('+1 (323)245-9452')).toBe('3232459452');
  });

  it('removes leading 1 from 11-digit number', () => {
    expect(normalizePhone('+17145489690')).toBe('7145489690');
  });

  it('handles 10-digit number with no formatting', () => {
    expect(normalizePhone('6574234447')).toBe('6574234447');
  });

  it('handles number with leading + but no country code padding', () => {
    expect(normalizePhone('+9495209613')).toBe('9495209613');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

// ============================================================
// parseDescription
// ============================================================
describe('parseDescription', () => {
  const templateDesc = `### **APPLICANT INFORMATION**

**Name: Elizabeth Nicasio**
**Full Address:** 11609 Stamy Rd La Mirada CA, 90638
**Phone No.** +6574234447
**Email:** [Elizabeth.nicasio@gmail.com](mailto:Elizabeth.nicasio@gmail.com)
**Pay Rate: $21.00**`;

  it('extracts phone from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.phone).toBe('6574234447');
  });

  it('extracts email from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.email).toBe('elizabeth.nicasio@gmail.com');
  });

  it('extracts address from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.address).toContain('11609 Stamy Rd');
  });

  it('extracts city and state', () => {
    const result = parseDescription(templateDesc);
    expect(result.city).toBe('La Mirada');
    expect(result.state).toBe('CA');
  });

  it('extracts zip code', () => {
    const result = parseDescription(templateDesc);
    expect(result.zip).toBe('90638');
  });

  const simpleDesc = 'Phone: +15868720633';

  it('extracts phone from simple format', () => {
    const result = parseDescription(simpleDesc);
    expect(result.phone).toBe('5868720633');
  });

  it('returns empty object for empty description', () => {
    const result = parseDescription('');
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  const metaDesc = 'New Lead From META, Please Contact: First Name: Joy Last Name: Cuenca Email: joycue@outlook.com Phone: +17145489690 City: Beaumont Zip Code: 92840';

  it('extracts email from meta lead format', () => {
    const result = parseDescription(metaDesc);
    expect(result.email).toBe('joycue@outlook.com');
  });

  it('extracts phone from meta lead format', () => {
    const result = parseDescription(metaDesc);
    expect(result.phone).toBe('7145489690');
  });

  const hcaDesc = `**HCA PER ID:** 7517616665
**HCA Expiration:** 2027-08-07`;

  it('extracts HCA PER ID', () => {
    const result = parseDescription(hcaDesc);
    expect(result.per_id).toBe('7517616665');
  });

  it('extracts HCA expiration date', () => {
    const result = parseDescription(hcaDesc);
    expect(result.hca_expiration).toBe('2027-08-07');
  });
});

// ============================================================
// mapChecklists
// ============================================================
describe('mapChecklists', () => {
  const taskMap = {
    'HCA Registered': 'hca_linked',
    'IRS Form I9': 'i9_form',
    'Training': 'training_assigned',
  };

  it('maps completed checklist items to portal tasks', () => {
    const checklists = [{
      name: 'Onboarding',
      checkItems: [
        { name: 'HCA Registered', state: 'complete' },
        { name: 'IRS Form I9', state: 'complete' },
        { name: 'Training', state: 'incomplete' },
      ],
    }];
    const result = mapChecklists(checklists, taskMap);
    expect(result.tasks.hca_linked.completed).toBe(true);
    expect(result.tasks.i9_form.completed).toBe(true);
    expect(result.tasks.training_assigned.completed).toBe(false);
  });

  it('returns unmapped items', () => {
    const checklists = [{
      name: 'Onboarding',
      checkItems: [
        { name: 'HCA Registered', state: 'complete' },
        { name: 'Social Media Check', state: 'complete' },
      ],
    }];
    const result = mapChecklists(checklists, taskMap);
    expect(result.unmapped).toContain('Social Media Check');
  });

  it('handles empty checklists', () => {
    const result = mapChecklists([], taskMap);
    expect(result.tasks).toEqual({});
    expect(result.unmapped).toEqual([]);
  });

  it('handles multiple checklists (Onboarding + Orientation)', () => {
    const extendedMap = {
      ...taskMap,
      'Questionnaire': 'questionnaire_done',
    };
    const checklists = [
      {
        name: 'Onboarding',
        checkItems: [{ name: 'HCA Registered', state: 'complete' }],
      },
      {
        name: 'Orientation',
        checkItems: [{ name: 'Questionnaire', state: 'complete' }],
      },
    ];
    const result = mapChecklists(checklists, extendedMap);
    expect(result.tasks.hca_linked.completed).toBe(true);
    expect(result.tasks.questionnaire_done.completed).toBe(true);
  });
});

// ============================================================
// convertComments
// ============================================================
describe('convertComments', () => {
  it('converts Trello comments to portal notes format', () => {
    const comments = [{
      text: 'Offer Letter Sent',
      date: '2026-02-19T18:30:00.000Z',
      by: 'Janster Nieva',
    }];
    const notes = convertComments(comments);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('Offer Letter Sent');
    expect(notes[0].type).toBe('note');
    expect(notes[0].author).toBe('Janster Nieva (via Trello)');
    expect(notes[0].timestamp).toBe(new Date('2026-02-19T18:30:00.000Z').getTime());
  });

  it('handles empty comments array', () => {
    expect(convertComments([])).toEqual([]);
  });

  it('preserves comment ordering (newest first)', () => {
    const comments = [
      { text: 'Second', date: '2026-02-20T00:00:00Z', by: 'A' },
      { text: 'First', date: '2026-02-19T00:00:00Z', by: 'B' },
    ];
    const notes = convertComments(comments);
    expect(notes[0].text).toBe('Second');
    expect(notes[1].text).toBe('First');
  });
});

// ============================================================
// buildDescriptionNote
// ============================================================
describe('buildDescriptionNote', () => {
  const fullDesc = `### **📋 APPLICANT INFORMATION**

**Name: Ciara Hinojoza**
**Full Address:** 2225 S Laura Linda Lane Santa Ana, CA 92704
**Phone No.** +7148123217
**Email:** [ciarahinojoza@gmail.com](https://tremendouscare.clearcareonline.com/activity/send-email/ "‌")
**Pay Rate: $20**

---

### **🕒 ATTENDANCE RECORD**

(Notes on responsiveness, punctuality in answering, attitude during call)

8/27-Last min call off due to back pain (HZ) did partial shift then left. CL okayed it

---

### **📅 SCHEDULE AVAILABILITY**

**Monday: Unavailable after SL**
**Tuesday:**
**Wednesday: Unavailable after SL**
**Thursday:**
**Friday:**
**Saturday:**
**Sunday:**

---

### **👩‍⚕️ PROFESSIONAL BACKGROUND**

**Years of Experience:**
**Client Conditions Previously Handled:** Home-Hospice, Post-Stroke, Bed-Bound
**Transfer Experience:**
**Skills (e.g., ADLs, cooking, driving clients, etc.):**

---

### **✅ CERTIFICATIONS AND COMPLIANCE**

**HCA PER ID:** 7517425198
**HCA Exp Date:** 2027-04-21
**TB Test:** Yes
**Driver's License:** Yes
**Automobile Insurance:** Yes
**Reliable Transportation:** Yes`;

  it('captures pay rate from applicant information', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toContain('Pay Rate: $20');
  });

  it('captures attendance record entries', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toContain('8/27-Last min call off due to back pain');
  });

  it('captures schedule availability (non-empty days only)', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toContain('Monday: Unavailable after SL');
    expect(note).toContain('Wednesday: Unavailable after SL');
  });

  it('captures professional background conditions', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toContain('Home-Hospice, Post-Stroke, Bed-Bound');
  });

  it('captures certifications (TB, license, insurance)', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toContain('TB Test: Yes');
    expect(note).toContain("Driver's License: Yes");
    expect(note).toContain('Automobile Insurance: Yes');
    expect(note).toContain('Reliable Transportation: Yes');
  });

  it('skips fields already in structured data (name, address, phone, email, HCA)', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).not.toMatch(/Full Address:/i);
    expect(note).not.toMatch(/Phone No/i);
    expect(note).not.toMatch(/\bEmail:/i);
    expect(note).not.toMatch(/HCA PER ID:/i);
    expect(note).not.toMatch(/HCA Exp/i);
  });

  it('skips empty template lines (label with no value)', () => {
    const note = buildDescriptionNote(fullDesc);
    // "Tuesday:" with no value should be skipped
    expect(note).not.toMatch(/^.*Tuesday:\s*$/m);
    // "Years of Experience:" with no value should be skipped
    expect(note).not.toMatch(/Years of Experience:\s*$/m);
  });

  it('returns null for empty description', () => {
    expect(buildDescriptionNote('')).toBeNull();
    expect(buildDescriptionNote(null)).toBeNull();
  });

  it('returns null for description with only structured fields (no extra data)', () => {
    const minimalDesc = `### **📋 APPLICANT INFORMATION**

**Name: Test Person**
**Full Address:** 123 Main St City, CA 90001
**Phone No.** +15551234567
**Email:** test@example.com`;
    expect(buildDescriptionNote(minimalDesc)).toBeNull();
  });

  it('starts with "Trello Card Details" header', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).toMatch(/^Trello Card Details/);
  });

  it('strips markdown formatting (bold, headers, emojis)', () => {
    const note = buildDescriptionNote(fullDesc);
    expect(note).not.toContain('**');
    expect(note).not.toContain('###');
    expect(note).not.toContain('📋');
  });
});
