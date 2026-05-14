import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatAnswerForDisplay } from '../../../lib/surveyUtils';

// Layout constants — Letter portrait at 72 DPI.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_HEIGHT = 14;

const COLOR_TITLE = rgb(0.10, 0.18, 0.36);
const COLOR_SECTION = rgb(0.18, 0.31, 0.55);
const COLOR_LABEL = rgb(0.30, 0.36, 0.46);
const COLOR_BODY = rgb(0.10, 0.10, 0.10);
const COLOR_MUTED = rgb(0.45, 0.50, 0.58);

// pdf-lib's Helvetica only supports WinAnsi. Strip anything outside that
// (em-dashes, smart quotes, emoji) so drawText doesn't throw.
function sanitize(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function wrapText(text, font, fontSize, maxWidth) {
  const safe = sanitize(text);
  if (!safe) return [''];
  const lines = [];
  for (const rawLine of safe.split(/\r?\n/)) {
    if (rawLine === '') { lines.push(''); continue; }
    const words = rawLine.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      const width = font.widthOfTextAtSize(candidate, fontSize);
      if (width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
      // Hard-break a single word that is wider than maxWidth.
      while (font.widthOfTextAtSize(current, fontSize) > maxWidth) {
        let cut = current.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(current.slice(0, cut), fontSize) > maxWidth) {
          cut -= 1;
        }
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function formatSubmittedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Group questions in array order by their `section` field, preserving
 * the original order. Mirrors the modal's grouping so the PDF reads in
 * the same sequence as the on-screen form.
 */
function groupQuestionsBySection(questions) {
  const groups = [];
  let current = null;
  for (const q of questions || []) {
    const section = q.section || '';
    if (!current || current.section !== section) {
      current = { section, questions: [] };
      groups.push(current);
    }
    current.questions.push(q);
  }
  return groups;
}

/**
 * Build the PDF. Returns a Uint8Array.
 *
 * @param {Object} args
 * @param {Object} args.caregiver - Caregiver app model (firstName, lastName)
 * @param {Object} args.template  - survey_templates row (name, questions[])
 * @param {Object} args.answers   - { [question_id]: answer }
 * @param {string} [args.submittedAt] - ISO timestamp
 * @param {string} [args.evaluator]   - Display name of the evaluator
 */
export async function buildInterviewEvaluationPdf({ caregiver, template, answers, submittedAt, evaluator }) {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const drawWrapped = (text, { font, size, color, indent = 0, leading = LINE_HEIGHT, italic = false }) => {
    const useFont = italic ? fontItalic : font;
    const lines = wrapText(text, useFont, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(leading);
      page.drawText(line, {
        x: MARGIN + indent,
        y: y - size,
        size,
        font: useFont,
        color,
      });
      y -= leading;
    }
  };

  // ── Header ─────────────────────────────────────────────────────
  const title = sanitize(template?.name || 'Interview Evaluation');
  drawWrapped(title, { font: fontBold, size: 18, color: COLOR_TITLE, leading: 22 });
  y -= 4;

  const candidateName = sanitize(`${caregiver?.firstName || ''} ${caregiver?.lastName || ''}`.trim()) || 'Caregiver';
  drawWrapped(`Candidate: ${candidateName}`, { font: fontBold, size: 11, color: COLOR_BODY });

  if (submittedAt) {
    drawWrapped(`Submitted: ${formatSubmittedAt(submittedAt)}`, { font: fontRegular, size: 10, color: COLOR_MUTED });
  }
  if (evaluator) {
    drawWrapped(`Evaluator: ${sanitize(evaluator)}`, { font: fontRegular, size: 10, color: COLOR_MUTED });
  }

  y -= 8;
  // Divider
  ensureSpace(2);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.75,
    color: rgb(0.85, 0.87, 0.91),
  });
  y -= 14;

  // ── Body ───────────────────────────────────────────────────────
  const groups = groupQuestionsBySection(template?.questions || []);
  let questionIndex = 0;

  for (const group of groups) {
    if (group.section) {
      ensureSpace(20);
      drawWrapped(group.section.toUpperCase(), {
        font: fontBold, size: 10, color: COLOR_SECTION, leading: 14,
      });
      // Underline
      ensureSpace(6);
      page.drawLine({
        start: { x: MARGIN, y: y + 4 },
        end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
        thickness: 0.5,
        color: rgb(0.85, 0.87, 0.91),
      });
      y -= 6;
    }

    for (const q of group.questions) {
      questionIndex += 1;
      ensureSpace(20);
      const prompt = `${questionIndex}. ${q.text || ''}`;
      drawWrapped(prompt, { font: fontBold, size: 11, color: COLOR_BODY, leading: 14 });

      const answerText = formatAnswerForDisplay(q, answers?.[q.id]);
      if (answerText) {
        y -= 2;
        drawWrapped(answerText, { font: fontRegular, size: 11, color: COLOR_BODY, indent: 14, leading: 14 });
      } else {
        y -= 2;
        drawWrapped('(no answer)', { font: fontRegular, size: 10, color: COLOR_MUTED, indent: 14, leading: 13, italic: true });
      }

      y -= 6;
    }
  }

  // ── Page numbers ───────────────────────────────────────────────
  const pages = pdfDoc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const width = fontRegular.widthOfTextAtSize(label, 9);
    p.drawText(label, {
      x: PAGE_WIDTH - MARGIN - width,
      y: MARGIN / 2,
      size: 9,
      font: fontRegular,
      color: COLOR_LABEL,
    });
  });

  return pdfDoc.save();
}

function safeFilenameSegment(value, fallback) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/**
 * Build the canonical download filename for an evaluation PDF.
 * Pure so it can be unit tested.
 */
export function buildEvaluationFilename({ caregiver, submittedAt }) {
  const name = safeFilenameSegment(`${caregiver?.firstName || ''}_${caregiver?.lastName || ''}`, 'Caregiver');
  const date = submittedAt ? new Date(submittedAt) : new Date();
  const datePart = Number.isNaN(date.getTime())
    ? ''
    : `_${date.toISOString().slice(0, 10)}`;
  return `Interview_Evaluation_${name}${datePart}.pdf`;
}

/**
 * Build the PDF and trigger a browser download. Resolves once the
 * download click has been dispatched.
 */
export async function downloadInterviewEvaluationPdf(args) {
  const bytes = await buildInterviewEvaluationPdf(args);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = buildEvaluationFilename(args);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
