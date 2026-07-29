/* Avrios Evidence Engine — theme classification
   ------------------------------------------------------------
   Shared by the opportunity map (which clusters the corpus) and the ingest page
   (which shows a new card's theme before it is committed, so a card that would
   land in "Other" is visible at review time rather than after the fact).

   First match wins — ported verbatim from the build spec. Heuristic keyword
   matching, not embeddings; that caveat is surfaced in the UI on purpose. */

const THEME_RULES = [
  ['Compliance & licence checks', /DLC|licen|UVV|Halterhaftung|TÜV|compliance|BKrFQG|Pickerl|inspection|Contrôle/i],
  ['Fines management',            /fine|penalt|authorit|bounce/i],
  ['Procurement & lifecycle',     /procure|replacement|Not Ordered|quote|offer amount|purchase agreement|order status|decommission|financing|depreciation/i],
  ['Reporting & analytics',       /report|dashboard|consumption|TCO|benchmark|export|utilization|anomal|analy/i],
  ['Automation & AI trust',       /\bAI\b|automat|auto-|revert|approv|trust|escalat|LLM|OCR|readout/i],
  ['Documents & mailroom',        /post office|mailroom|Poststelle|document|folder|smime|scan|attachment/i],
  ['Vehicle checks & checklists', /checklist|vehicle check|check item/i],
  ['Handover & pool vehicles',    /handover|return|pool|booking/i],
  ['Invoices & finance',          /invoice|leasing|lease|fringe benefit|tax|cost cent|budget|insurance|installment|premium/i],
  ['User rights & permissions',   /user right|permission|role|access|sub-org/i],
  ['Driver app & comms',          /driver app|WhatsApp|notification|reminder|email address|PIN-user|username|SMS|messag/i],
  ['Tasks & workflow',            /task|template|workshop|scheduled date|recurring/i],
  ['Data & master data',          /master data|odometer|mileage|custom field|column|filter|registration paper/i],
];
const OTHER = 'Other';

function classify(row) {
  const hay = `${row.Insight || ''} ${row.Description || ''}`;
  for (const [name, re] of THEME_RULES) if (re.test(hay)) return name;
  return OTHER;
}
