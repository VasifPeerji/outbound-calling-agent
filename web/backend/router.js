'use strict';
/**
 * ROW ROUTER — decides, for one row of a partner's own data, which call to place and what to say.
 *
 * WHY THIS EXISTS
 * The engine this replaces read a fixed list of column names (`amount_due`, `due_date`,
 * `days_overdue`, `appointment_date` …) which happen to be the exact headers of our own
 * sample_crm.csv. That is not an industry bias so much as a sample bias: it worked on the file we
 * wrote to match the code. Given a real export — `msisdn`, `consignee`, `appt_dt`, `bill_due_date`,
 * `guardian_phone` — nothing matched, every row lost its name and number, and every row fell through
 * to the bottom of an if-else chain and became a marketing call with empty variables.
 *
 * WHAT IT DOES INSTEAD
 * Three stages, none of which know anything about any particular industry:
 *
 *   1. RESOLVE  — map the partner's headers onto a canonical vocabulary, by exact name, alias,
 *                 token overlap, and finally by sniffing the values themselves. Done once for the
 *                 whole file, because sniffing needs the column, not the cell.
 *   2. ROUTE    — score every use case the profile actually has, using the catalogue's own `fields`
 *                 declaration as the evidence. A use case whose REQUIRED fields are present in the
 *                 data is what the data is asking for. No per-industry code, because the catalogue
 *                 already carries the per-industry knowledge.
 *   3. FILL     — populate exactly the variables that use case declares, with type-aware formatting,
 *                 deriving what can be derived and OMITTING what cannot rather than inventing it.
 *
 * ON MISSING VALUES
 * Three tiers, in order of preference: derive it (days overdue from a due date), omit it (the
 * prompts already instruct the agent to speak around an empty variable, so silence is safe and
 * true), or refuse to place that particular call — either by dropping to a use case whose
 * requirements the row DOES meet, or by naming the columns the partner needs to add. Inventing a
 * plausible value is never an option: a specific number spoken to a real customer has to be theirs.
 */

// ── canonical vocabulary ────────────────────────────────
// `type` drives both value sniffing and output formatting. `aliases` are whole-header synonyms;
// `tokens` are the words that, appearing together in a longer header, still mean this field.
const FIELD = {
  customer_name: { type: 'name', aliases: ['customer_name', 'name', 'full_name', 'customer', 'client_name', 'contact_name', 'patient_name', 'student_name', 'subscriber_name', 'member_name', 'guest_name', 'passenger_name', 'consignee', 'consignee_name', 'account_name', 'lead_name', 'first_name', 'given_name', 'borrower_name', 'policyholder', 'policy_holder', 'tenant_name', 'donor_name', 'employee_name', 'candidate_name', 'owner_name', 'debtor_name', 'recipient_name', 'payer_name', 'applicant_name', 'contact_person', 'account_holder', 'holder', 'holder_name', 'primary_contact', 'bill_to', 'insured_name', 'insured', 'party_name', 'end_customer', 'attendee', 'resident_name',
    'nombre', 'nombre_completo', 'cliente', 'nom', 'nom_complet', 'client', 'nome', 'kunde', 'naam', 'titular'], tokens: ['name', 'customer', 'client', 'patient', 'student', 'subscriber', 'consignee', 'guest', 'passenger', 'member', 'applicant', 'donor', 'candidate', 'holder', 'insured', 'attendee', 'resident'] },
  to_number: { type: 'phone', aliases: ['to_number', 'phone', 'phone_number', 'mobile', 'mobile_number', 'contact_no', 'contact_number', 'msisdn', 'cell', 'cellphone', 'telephone', 'tel', 'primary_phone', 'guardian_phone', 'whatsapp', 'whatsapp_number', 'contact', 'number', 'mob', 'mobile_no', 'phone_no', 'alternate_number', 'home_phone', 'work_phone',
    'telefono', 'telefone', 'telefon', 'movil', 'movil_number', 'celular', 'telemovel', 'numero', 'numero_telefono', 'portable'], tokens: ['phone', 'mobile', 'msisdn', 'contact', 'tel', 'number', 'cell', 'whatsapp'] },

  product_name: { type: 'text', aliases: ['product_name', 'product', 'service', 'service_name', 'plan', 'plan_name', 'account_type', 'loan_type', 'policy_type', 'item', 'subscription', 'programme', 'program', 'course', 'course_name', 'utility', 'connection_type', 'bill_type', 'invoice_type', 'scheme', 'package'], tokens: ['product', 'service', 'plan', 'policy', 'loan', 'course', 'programme', 'program', 'subscription', 'package', 'scheme'] },
  amount_due: { type: 'money', aliases: ['amount_due', 'amount', 'due_amount', 'bill_amount', 'invoice_amount', 'premium_amount', 'emi_amount', 'emi', 'fee_amount', 'fees', 'payable', 'amount_payable', 'total_due', 'installment', 'instalment', 'rent', 'rent_amount', 'charge', 'total_amount', 'bill_value', 'net_payable',
    'importe', 'monto', 'valor', 'montant', 'betrag', 'importo'], tokens: ['amount', 'due', 'bill', 'invoice', 'premium', 'emi', 'fee', 'payable', 'instalment', 'installment', 'rent'] },
  due_date: { type: 'date', aliases: ['due_date', 'payment_due_date', 'bill_due_date', 'invoice_due_date', 'due_on', 'due', 'payment_date', 'fee_due_date', 'premium_due_date', 'last_date', 'pay_by', 'payable_by', 'due_dt',
    'fecha_vencimiento', 'vencimiento', 'fecha_de_pago', 'date_echeance', 'echeance', 'faelligkeit', 'scadenza', 'data_vencimento'], tokens: ['due', 'date', 'pay', 'payable', 'last'] },
  days_overdue: { type: 'int', aliases: ['days_overdue', 'overdue_days', 'days_past_due', 'dpd', 'days_late', 'aging_days', 'ageing_days', 'delinquency_days', 'arrears_days'], tokens: ['overdue', 'days', 'past', 'dpd', 'late', 'aging', 'ageing', 'arrears'] },
  amount_overdue: { type: 'money', aliases: ['amount_overdue', 'overdue_amount', 'arrears', 'arrears_amount', 'past_due_amount', 'outstanding_due', 'unpaid_amount', 'balance_overdue', 'delinquent_amount'], tokens: ['overdue', 'arrears', 'unpaid', 'delinquent'] },
  outstanding_balance: { type: 'money', aliases: ['outstanding_balance', 'balance', 'outstanding', 'total_outstanding', 'principal_outstanding', 'loan_balance', 'account_balance', 'remaining_balance', 'ledger_balance'], tokens: ['outstanding', 'balance', 'principal', 'remaining'] },

  appointment_type: { type: 'text', aliases: ['appointment_type', 'appt_type', 'visit_type', 'booking_type', 'service_type', 'consultation_type', 'session_type', 'department', 'dept', 'speciality', 'specialty', 'clinic'], tokens: ['appointment', 'appt', 'visit', 'booking', 'consultation', 'session', 'department', 'speciality', 'specialty'] },
  appointment_date: { type: 'date', aliases: ['appointment_date', 'appt_date', 'appt_dt', 'visit_date', 'booking_date', 'scheduled_date', 'scheduled_on', 'session_date', 'consultation_date', 'service_date', 'pickup_date', 'delivery_date', 'install_date', 'installation_date', 'inspection_date', 'test_drive_date', 'viewing_date', 'interview_date', 'appointment_on'], tokens: ['appointment', 'appt', 'visit', 'booking', 'scheduled', 'delivery', 'pickup', 'install', 'inspection', 'viewing', 'interview', 'date'] },
  appointment_time: { type: 'time', aliases: ['appointment_time', 'appt_time', 'visit_time', 'booking_time', 'scheduled_time', 'time_slot', 'slot', 'delivery_slot', 'delivery_window', 'service_window', 'pickup_time', 'session_time', 'window'], tokens: ['appointment', 'appt', 'visit', 'booking', 'scheduled', 'slot', 'window', 'time'] },
  location: { type: 'text', aliases: ['location', 'branch', 'branch_name', 'store', 'store_name', 'centre', 'center', 'site', 'address', 'venue', 'clinic_location', 'city', 'facility', 'outlet', 'depot', 'warehouse', 'showroom', 'campus'], tokens: ['location', 'branch', 'store', 'centre', 'center', 'site', 'address', 'venue', 'city', 'facility', 'outlet', 'campus'] },
  prep_notes: { type: 'text', aliases: ['prep_notes', 'preparation', 'prep', 'prep_instructions', 'instructions', 'notes', 'special_instructions', 'remarks', 'advice', 'pre_visit_notes'], tokens: ['prep', 'preparation', 'instruction', 'note', 'remark', 'advice'] },
  reference: { type: 'id', aliases: ['reference', 'reference_no', 'ref', 'ref_no', 'booking_ref', 'booking_reference', 'order_id', 'order_no', 'order_number', 'shipment_ref', 'shipment_id', 'awb', 'tracking_id', 'tracking_number', 'case_id', 'ticket_id', 'ticket_no', 'policy_number', 'policy_no', 'account_number', 'account_no', 'invoice_no', 'invoice_number', 'consignment_no', 'application_no', 'claim_no', 'job_no', 'work_order'], tokens: ['reference', 'ref', 'order', 'shipment', 'awb', 'tracking', 'ticket', 'policy', 'account', 'invoice', 'consignment', 'claim', 'id', 'no', 'number'] },

  renewal_item: { type: 'text', aliases: ['renewal_item', 'renewal_product', 'policy_name', 'contract', 'contract_name', 'membership', 'membership_type', 'subscription_plan', 'licence', 'license', 'amc', 'warranty'], tokens: ['renewal', 'contract', 'membership', 'subscription', 'licence', 'license', 'warranty', 'amc'] },
  renewal_date: { type: 'date', aliases: ['renewal_date', 'renews_on', 'renewal_due', 'expiry_date', 'expires_on', 'contract_end', 'contract_end_date', 'valid_till', 'valid_until', 'end_date', 'maturity_date', 'lapse_date'], tokens: ['renewal', 'renew', 'expiry', 'expires', 'valid', 'maturity', 'lapse', 'end'] },
  renewal_amount: { type: 'money', aliases: ['renewal_amount', 'renewal_premium', 'renewal_price', 'contract_value', 'membership_fee', 'subscription_amount'], tokens: ['renewal', 'contract', 'membership', 'subscription'] },

  interaction_type: { type: 'text', aliases: ['interaction_type', 'last_interaction', 'touchpoint', 'experience', 'service_availed', 'visit_reason', 'transaction_type', 'purchase_type', 'stay_type', 'trip_type'], tokens: ['interaction', 'touchpoint', 'experience', 'availed', 'transaction', 'purchase', 'visit'] },
  interaction_date: { type: 'date', aliases: ['interaction_date', 'last_interaction_date', 'visit_date', 'last_visit', 'previous_visit', 'last_service', 'last_service_date', 'last_purchase', 'last_purchase_date', 'last_transaction', 'last_stay', 'served_on', 'purchase_date', 'transaction_date', 'checkout_date', 'service_completed', 'completed_on', 'closed_on', 'discharge_date', 'order_date', 'stay_date'], tokens: ['interaction', 'purchase', 'transaction', 'checkout', 'completed', 'closed', 'discharge', 'order', 'stay', 'previous'] },
  scale: { type: 'text', aliases: ['scale', 'rating_scale', 'survey_scale', 'nps_scale'], tokens: ['scale'] },

  event_type: { type: 'text', aliases: ['event_type', 'event', 'incident_type', 'alert_type', 'notification_type', 'issue_type', 'exception_type', 'disruption_type', 'status', 'outage_type', 'recall_type'], tokens: ['event', 'incident', 'alert', 'notification', 'issue', 'exception', 'disruption', 'outage', 'recall', 'status'] },
  event_detail: { type: 'text', aliases: ['event_detail', 'event_details', 'detail', 'details', 'description', 'exception_reason', 'reason', 'incident_detail', 'outage_area', 'affected_area', 'issue_description', 'delay_reason', 'cancellation_reason', 'fault', 'fault_description'], tokens: ['detail', 'description', 'reason', 'area', 'affected', 'fault', 'exception'] },
  event_time: { type: 'time', aliases: ['event_time', 'incident_time', 'outage_start', 'start_time', 'scheduled_start', 'downtime_start', 'departure_time'], tokens: ['event', 'incident', 'outage', 'start', 'downtime', 'departure'] },
  impact: { type: 'text', aliases: ['impact', 'affected_service', 'impact_description', 'severity', 'affected_services'], tokens: ['impact', 'affected', 'severity'] },
  options: { type: 'text', aliases: ['options', 'alternatives', 'choices', 'available_options', 'rebooking_options', 'workaround'], tokens: ['option', 'alternative', 'choice', 'workaround', 'rebooking'] },
  resolution_eta: { type: 'text', aliases: ['resolution_eta', 'eta', 'restoration_eta', 'expected_resolution', 'restore_by', 'estimated_resolution', 'fix_eta', 'fix_by', 'fixed_by', 'resolve_by', 'repair_by', 'expected_delivery', 'back_online_by'], tokens: ['resolution', 'eta', 'restoration', 'restore', 'estimated', 'expected', 'fix', 'repair', 'resolve'] },

  process_name: { type: 'text', aliases: ['process_name', 'process', 'application_type', 'application', 'case_type', 'onboarding_stage', 'stage', 'workflow', 'claim_type', 'filing_type'], tokens: ['process', 'application', 'case', 'onboarding', 'stage', 'workflow', 'filing'] },
  missing_items: { type: 'list', aliases: ['missing_items', 'missing_documents', 'pending_documents', 'documents_pending', 'pending_docs', 'required_documents', 'outstanding_documents', 'docs_required', 'kyc_pending', 'missing_docs', 'documents', 'admission_docs_pending', 'pending_items'], tokens: ['missing', 'pending', 'required', 'outstanding', 'document', 'docs', 'kyc', 'items'] },
  deadline: { type: 'date', aliases: ['deadline', 'submit_by', 'submission_deadline', 'cutoff', 'cut_off_date', 'closing_date', 'last_date_to_submit'], tokens: ['deadline', 'submit', 'submission', 'cutoff', 'closing'] },
  consequences: { type: 'text', aliases: ['consequences', 'consequence', 'if_not_submitted', 'penalty', 'implication'], tokens: ['consequence', 'penalty', 'implication'] },
  submission_channel: { type: 'text', aliases: ['submission_channel', 'submit_via', 'channel', 'portal', 'upload_link', 'submission_method'], tokens: ['submission', 'submit', 'channel', 'portal', 'upload'] },

  offer_type: { type: 'text', aliases: ['offer_type', 'offer', 'campaign', 'campaign_name', 'promotion', 'promo', 'deal', 'scheme_name', 'proposition'], tokens: ['offer', 'promotion', 'promo', 'deal', 'campaign', 'proposition'] },
  offer_detail: { type: 'text', aliases: ['offer_detail', 'offer_details', 'offer_description', 'benefit', 'benefits', 'discount', 'promo_detail', 'terms'], tokens: ['offer', 'benefit', 'discount', 'promo', 'terms'] },
  eligible_amount: { type: 'money', aliases: ['eligible_amount', 'eligibility', 'approved_amount', 'sanctioned_amount', 'limit', 'credit_limit', 'pre_approved_amount', 'offer_amount', 'cart_value', 'order_value'], tokens: ['eligible', 'eligibility', 'approved', 'sanctioned', 'limit', 'value'] },
  expiry_date: { type: 'date', aliases: ['expiry_date', 'offer_expiry', 'offer_valid_till', 'promo_end', 'valid_till_date', 'offer_end_date'], tokens: ['expiry', 'expires', 'valid', 'offer', 'promo', 'end'] },
  pre_approved: { type: 'bool', aliases: ['pre_approved', 'preapproved', 'is_pre_approved'], tokens: ['approved'] },

  lead_source: { type: 'text', aliases: ['lead_source', 'source', 'enquiry_source', 'inquiry_source', 'channel_source', 'origin', 'utm_source', 'referral', 'referred_by'], tokens: ['lead', 'source', 'enquiry', 'inquiry', 'origin', 'referral', 'utm'] },
  interest: { type: 'text', aliases: ['interest', 'interested_in', 'enquiry', 'inquiry', 'requirement', 'product_interest', 'enquiry_detail', 'looking_for', 'interest_area'], tokens: ['interest', 'interested', 'enquiry', 'inquiry', 'requirement', 'looking'] }
};

// Columns that steer the run rather than feed the conversation.
const CONTROL = {
  use_case: ['use_case', 'usecase', 'call_type', 'campaign_type', 'intent', 'purpose', 'call_reason', 'scenario', 'call_purpose', 'action'],
  do_not_call: ['do_not_call', 'dnc', 'opt_out', 'optout', 'opted_out', 'unsubscribed', 'unsubscribe', 'consent_withdrawn', 'no_call', 'do_not_contact', 'dnd', 'suppressed', 'suppression', 'blacklisted', 'marketing_consent_withdrawn'],
  language: ['language', 'preferred_language', 'lang', 'locale', 'spoken_language'],
  time: ['time', 'time_of_day', 'preferred_time', 'best_time_to_call']
};
/**
 * Consent, matched by meaning rather than by exact spelling, and deliberately generous.
 *
 * "Opted Out" was ignored because the list held `opt_out`, and that person was queued for a call.
 * Over-matching here costs one call we did not make; under-matching costs a call to somebody who
 * asked us not to ring them, so the asymmetry decides which way to lean.
 */
function isDoNotCallHeader(h) {
  const t = tokensOf(h);
  const j = t.join('_');
  if (/(^|_)(dnc|dnd)(_|$)/.test(j)) return true;
  if (t.includes('opt') && t.includes('out')) return true;
  if (t.some(x => /^opted?out$/.test(x)) || t.includes('optout') || t.includes('optedout')) return true;
  if (t.includes('do') && t.includes('not') && (t.includes('call') || t.includes('contact') || t.includes('disturb'))) return true;
  if (t.some(x => x.startsWith('unsubscrib'))) return true;
  if (t.includes('consent') && t.some(x => /^(withdraw|withdrawn|revoked|no)$/.test(x))) return true;
  if (t.includes('suppressed') || t.includes('suppression') || t.includes('blacklist') || t.includes('blacklisted')) return true;
  return false;
}

const ARCHETYPES = ['payment_reminder', 'overdue_followup', 'sales_offer', 'appointment_reminder', 'feedback_survey', 'lead_qualification', 'renewal_retention', 'service_notification', 'document_collection'];

// What a use case needs when the profile predates the catalogue and carries no `fields` at all.
// Keeps every legacy 7-key profile (including the live Banking demo) working unchanged.
const LEGACY_FIELDS = {
  payment_reminder: [{ var: 'product_name', required: true }, { var: 'amount_due', required: true }, { var: 'due_date', required: true }, { var: 'outstanding_balance' }],
  overdue_followup: [{ var: 'product_name', required: true }, { var: 'amount_overdue', required: true }, { var: 'days_overdue', required: true }, { var: 'outstanding_balance' }],
  sales_offer: [{ var: 'offer_type', required: true }, { var: 'offer_detail' }, { var: 'eligible_amount' }, { var: 'expiry_date' }, { var: 'pre_approved' }],
  appointment_reminder: [{ var: 'appointment_type', required: true }, { var: 'appointment_date', required: true }, { var: 'appointment_time' }, { var: 'location' }, { var: 'reference' }, { var: 'prep_notes' }],
  feedback_survey: [{ var: 'interaction_type', required: true }, { var: 'interaction_date' }, { var: 'scale' }],
  lead_qualification: [{ var: 'lead_source', required: true }, { var: 'interest' }],
  renewal_retention: [{ var: 'renewal_item', required: true }, { var: 'renewal_date', required: true }, { var: 'renewal_amount' }],
  service_notification: [{ var: 'event_type', required: true }, { var: 'event_detail' }, { var: 'event_time' }, { var: 'impact' }, { var: 'options' }, { var: 'resolution_eta' }, { var: 'reference' }],
  document_collection: [{ var: 'process_name', required: true }, { var: 'missing_items', required: true }, { var: 'deadline' }, { var: 'consequences' }, { var: 'submission_channel' }, { var: 'reference' }]
};

/**
 * The fields a call is actually MEANINGLESS without, as opposed to merely declared required.
 * Each entry is a list of alternatives: any one of them present in the DATA carries the call.
 *
 * The distinction matters because the catalogue marks a lot required that is only preferred. An
 * admission-documents call with no deadline is a perfectly good call that omits one sentence; the
 * same call with no idea which documents are missing is not a call at all. Anything required but
 * not essential is dropped from the script instead of cancelling the dial, and the console says so.
 */
const ESSENTIAL = {
  payment_reminder: [['amount_due', 'due_date']],
  overdue_followup: [['amount_overdue', 'amount_due', 'days_overdue']],
  appointment_reminder: [['appointment_date', 'appointment_time']],
  service_notification: [['event_detail', 'event_type', 'impact']],
  document_collection: [['missing_items']],
  renewal_retention: [['renewal_date', 'renewal_item', 'renewal_amount']],
  feedback_survey: [['interaction_type', 'interaction_date']],
  lead_qualification: [['lead_source', 'interest']],
  sales_offer: [['offer_type', 'offer_detail', 'eligible_amount']]
};

/**
 * Fields that name what the CALL is about rather than stating a fact about the customer. We chose
 * the use case, so its own label is a truthful source for these: a "Delivery Exception" call is
 * about a delivery exception whether or not the file has a column saying so. Never used for an
 * essential field, and never for anything with a number or a date in it.
 */
const SUBJECT = {
  product_name: { strip: /\b(due|overdue|reminder|payment|follow[- ]?up|missed|late|arrears|collection|notice)\b/gi, fallback: 'your account' },
  appointment_type: { strip: /\b(reminder|confirmation|confirm|booking|scheduling|schedule|window|slot)\b/gi, fallback: 'appointment' },
  interaction_type: { strip: /\b(feedback|survey|csat|nps|rating|review|follow[- ]?up)\b/gi, fallback: 'your recent experience' },
  event_type: { strip: /\b(notification|alert|notice)\b/gi, fallback: 'an update to your service' },
  process_name: { strip: /\b(documents?|collection|pending|outstanding|verification|request)\b/gi, fallback: 'your application' },
  renewal_item: { strip: /\b(renewal|renew|retention|reminder|expiry)\b/gi, fallback: 'your plan' },
  offer_type: { strip: /\b(offer|campaign)\b/gi, fallback: 'a tailored offer' },
  lead_source: { strip: /\b(enquiry|inquiry|lead|qualification|follow[- ]?up)\b/gi, fallback: 'your recent enquiry' },
  interest: { strip: /\b(enquiry|inquiry|lead|qualification)\b/gi, fallback: '' }
};
/** Read the category off the use case's label, e.g. "Bill Due" -> "bill", "Delivery Window" -> "delivery". */
function subjectFallback(field, uc, key) {
  const def = SUBJECT[field];
  if (!def) return '';
  const label = String((uc && uc.label) || key || '').replace(/_/g, ' ');
  const trimmed = label.replace(def.strip, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) return def.fallback;
  // Acronyms stay upper ("EMI"), ordinary words go lower so they sit inside a spoken sentence.
  return trimmed.split(' ').map(w => (w.length <= 4 && w === w.toUpperCase() ? w : w.toLowerCase())).join(' ');
}

// Urgency, used only to break ties and to order the queue. A disruption outranks a promotion.
const URGENCY = { service_notification: 1, overdue_followup: 2, payment_reminder: 3, appointment_reminder: 4, document_collection: 5, renewal_retention: 6, feedback_survey: 7, lead_qualification: 8, sales_offer: 9 };

// ── small helpers ───────────────────────────────────────
const norm = h => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tokensOf = h => norm(h).split('_').filter(Boolean);
const isBlank = v => v === null || v === undefined || String(v).trim() === '';
const digitsOf = s => String(s).replace(/\D/g, '');

/**
 * Excel writes a long number in scientific notation the moment it decides the column is numeric,
 * which is what happens to a phone number saved from a spreadsheet. Put the digits back.
 */
function expandExponential(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d(?:\.\d+)?[eE][+]?\d+$/.test(s)) return s;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) < 1e18 ? BigInt(Math.round(n)).toString() : s;
}
/**
 * A date column holding 46272 is Excel's serial count from the 1900 epoch, not a year and not a
 * reference number. Read as a date literal it became "the 1st of January", which is a confident
 * wrong answer rather than a visible failure. The window is deliberately narrow: 1990 to 2070.
 */
const EXCEL_EPOCH_OFFSET = 25569;   // days between 1899-12-30 and 1970-01-01
function excelSerialToDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{5}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (n < 32874 || n > 62092) return null;
  const d = new Date((n - EXCEL_EPOCH_OFFSET) * 86400000);
  return isNaN(d.getTime()) ? null : d;
}

function parseDate(str, order) {
  if (isBlank(str)) return null;
  const s = String(str).trim();
  const serial = excelSerialToDate(s);
  if (serial) return serial;
  // The slashed form is genuinely ambiguous, so `order` carries what the whole column said. Day
  // first is the fallback because it is the norm everywhere we sell except the United States.
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // The value can settle it on its own whatever the column decided: there is no 13th month.
    const monthFirst = a > 12 ? false : b > 12 ? true : order === 'mdy';
    const day = monthFirst ? b : a, mon = monthFirst ? a : b;
    const d = new Date(`${m[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { const d = new Date(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T00:00:00`); return isNaN(d.getTime()) ? null : d; }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
/**
 * Whole days between two CALENDAR dates, not elapsed milliseconds.
 *
 * A due date parses to midnight while "now" carries a time, so the elapsed-time arithmetic this
 * replaces returned 21 for a bill twenty days late once the working day was past about noon. The
 * agent then said "twenty-one days" to a customer whose account says twenty.
 */
function daysDiff(a, b) {
  const A = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const B = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((B - A) / 86400000);
}
function looksLikeDate(v) {
  if (isBlank(v)) return false;
  const s = String(v).trim();
  if (!/\d/.test(s)) return false;
  // A written-out date wins outright: its digits would otherwise satisfy the phone-shape guard below.
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(s)) return !!parseDate(s);
  if (/^\+?\d[\d\s\-()]{8,}$/.test(s)) return false;
  return !!parseDate(s);
}
function looksLikePhone(v) {
  if (isBlank(v)) return false;
  const s = expandExponential(v);
  if (!/^[+(]?[\d][\d\s\-().]*$/.test(s)) return false;
  const d = digitsOf(s);
  return d.length >= 8 && d.length <= 15;
}
function looksLikeMoney(v) {
  if (isBlank(v)) return false;
  const s = String(v).trim();
  return /^[^\d]{0,3}[\d,]+(\.\d{1,2})?$/.test(s) && digitsOf(s).length <= 12;
}
function looksLikeName(v) {
  if (isBlank(v)) return false;
  const s = String(v).trim();
  return /^[\p{L}][\p{L}\s'’.\-]{1,60}$/u.test(s) && !/\d/.test(s);
}
/**
 * Stricter than looksLikeName: is this value plausibly a PERSON, as opposed to any phrase made of
 * letters? Used where the answer decides whether to take a column away from the field its header
 * named, so a false positive costs a correctly routed row.
 */
const NAME_PARTICLES = ['van', 'von', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'bin', 'binte', 'ibn', 'al', 'el', 'ter', 'ten', 'op', 'af', 'av', 'san', 'dos', 'das', 'e', 'y'];
function looksLikePersonName(v) {
  if (isBlank(v)) return false;
  const s = String(v).trim();
  if (/[\d@_/|;:]/.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(w => {
    if (!/^[\p{L}][\p{L}'’.\-]*$/u.test(w)) return false;
    if (NAME_PARTICLES.includes(w.toLowerCase())) return true;
    const first = w[0];
    return first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase();
  });
}
function looksLikeTime(v) {
  if (isBlank(v)) return false;
  return /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i.test(String(v)) || /\b\d{1,2}\s*(am|pm)\b/i.test(String(v));
}
function isTruthy(v) { return /^(1|true|yes|y|t)$/i.test(String(v == null ? '' : v).trim()); }

// ── stage 1: resolve the partner's headers onto the vocabulary ──
/**
 * Match once per FILE, not once per row: deciding that `msisdn` is the phone number needs to look
 * down the column, and a single cell is not enough evidence.
 *
 * Returns { map: { canonicalField: {header, how, score} }, control: {...}, unmapped: [headers] }.
 * `how` is kept because the console shows the partner what we read their columns as, and a mapping
 * they can see is a mapping they can correct.
 */
function resolveColumns(rows) {
  rows = Array.isArray(rows) ? rows : [];
  const headers = [...new Set(rows.flatMap(r => Object.keys(r || {})))];
  const sample = rows.slice(0, 50);
  const valuesOf = h => sample.map(r => (r || {})[h]).filter(v => !isBlank(v));

  const control = {};
  const claimed = new Set();
  for (const [key, aliases] of Object.entries(CONTROL)) {
    const hit = headers.find(h => aliases.includes(norm(h)));
    if (hit) { control[key] = hit; claimed.add(hit); }
  }
  if (!control.do_not_call) {
    const hit = headers.find(h => !claimed.has(h) && isDoNotCallHeader(h));
    if (hit) { control.do_not_call = hit; claimed.add(hit); }
  }

  // Every (header, field) pair scored, then assigned best-first so two headers never fight over one
  // slot and the stronger claim always wins.
  const cands = [];
  for (const h of headers) {
    if (claimed.has(h)) continue;
    const n = norm(h), ht = tokensOf(h), vals = valuesOf(h);
    for (const [field, def] of Object.entries(FIELD)) {
      let score = 0, how = '';
      if (n === field) { score = 100; how = 'exact'; }
      else if (def.aliases.includes(n)) { score = 90; how = 'alias'; }
      else {
        const overlap = ht.filter(t => def.tokens.includes(t));
        if (overlap.length) {
          // Two matching words ("bill" + "due") is a real signal; one common word is not, unless
          // that word is the field's own distinctive term.
          score = overlap.length >= 2 ? 60 + overlap.length * 3 : (def.aliases.some(a => a === overlap[0]) ? 45 : 30);
          how = 'similar';
        }
      }
      if (!score) continue;
      // The values have the final say: a column called `contact` holding e-mail addresses is not a
      // phone number, and a `reference` of digits is not one either.
      if (vals.length) {
        const frac = fn => vals.filter(fn).length / vals.length;
        if (def.type === 'phone') { const f = frac(looksLikePhone); if (f < 0.5) continue; score += f * 25; }
        else if (def.type === 'date') { const f = frac(looksLikeDate); if (f < 0.4) score -= 35; else score += f * 20; }
        else if (def.type === 'money') { const f = frac(looksLikeMoney); if (f < 0.4) score -= 30; else score += f * 15; }
        else if (def.type === 'name') { const f = frac(looksLikeName); if (f < 0.5) score -= 40; else score += f * 20; }
        else if (def.type === 'time') { const f = frac(v => looksLikeTime(v) || looksLikeDate(v)); if (f < 0.3) score -= 20; }
        else if (def.type === 'int') { const f = frac(v => /^\d{1,4}$/.test(String(v).trim())); if (f < 0.5) score -= 30; }
        else {
          // `id` and free text have no shape of their own, so nothing above stops a column of
          // people's names being filed as a reference number on the strength of one shared word.
          if (frac(looksLikePersonName) >= 0.7) score -= 45;
          else if (frac(looksLikePhone) >= 0.7) score -= 45;
        }
      }
      if (score > 20) cands.push({ header: h, field, score, how });
    }
  }

  // Read the data for the two columns that decide whether a row can be called at all. This always
  // competes rather than only filling gaps: a header we half-recognise ("Account Holder" sharing the
  // word "account" with a reference number) must not outrank a column that visibly holds people.
  for (const h of headers) {
    if (claimed.has(h)) continue;
    const vals = valuesOf(h);
    if (!vals.length) continue;
    const frac = fn => vals.filter(fn).length / vals.length;
    const phone = frac(looksLikePhone);
    const person = frac(looksLikePersonName);
    if (phone >= 0.8) cands.push({ header: h, field: 'to_number', score: 55 + phone * 15, how: 'from the values' });
    else if (person >= 0.8) cands.push({ header: h, field: 'customer_name', score: 52 + person * 15, how: 'from the values' });
  }

  cands.sort((a, b) => b.score - a.score);
  const map = {}, usedHeader = new Set();
  for (const c of cands) {
    if (map[c.field] || usedHeader.has(c.header)) continue;
    map[c.field] = { header: c.header, how: c.how, score: Math.round(c.score) };
    if ((FIELD[c.field] || {}).type === 'date') {
      const order = detectDateOrder(valuesOf(c.header));
      if (order) map[c.field].dateOrder = order;
    }
    usedHeader.add(c.header);
  }
  const unmapped = headers.filter(h => !usedHeader.has(h) && !claimed.has(h));
  return { map, control, unmapped, headers };
}

/**
 * Which way round a column writes its slashed dates, decided by the column rather than the cell.
 *
 * One value cannot tell 09/11 apart, but a column usually can: a single day past the 12th settles
 * it for every other value in the same column. Only when no value in the whole column exceeds 12 is
 * it truly ambiguous, and then we say so rather than quietly picking.
 */
function detectDateOrder(values) {
  let dmy = 0, mdy = 0, slashed = 0;
  for (const v of values) {
    const m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}/);
    if (!m) continue;
    slashed++;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a > 12) dmy++; else if (b > 12) mdy++;
  }
  if (!slashed) return null;
  if (dmy && !mdy) return 'dmy';
  if (mdy && !dmy) return 'mdy';
  if (dmy && mdy) return 'dmy';        // contradictory; fall back to the norm
  return 'ambiguous';                  // nothing above the 12th either way
}

/** Pull one row through the map into canonical fields, plus the raw lowercased row as a fallback. */
function resolveRow(row, resolved) {
  const out = {}, meta = {};
  for (const [field, m] of Object.entries(resolved.map)) {
    const v = row[m.header];
    if (isBlank(v)) continue;
    // Normalise a date to ISO here, using what the whole column said about its order, so every
    // later reader of this row gets the same unambiguous answer.
    if ((FIELD[field] || {}).type === 'date') {
      const d = parseDate(v, m.dateOrder);
      out[field] = d ? isoOf(d) : String(v).trim();
    } else if ((FIELD[field] || {}).type === 'phone') {
      out[field] = expandExponential(v);
    } else out[field] = String(v).trim();
    if (m.dateOrder) meta[field] = m.dateOrder;
  }
  // A header that matched nothing is still worth honouring when it happens to be named exactly like
  // a canonical field we did not map (an empty column, say).
  for (const [k, v] of Object.entries(row || {})) {
    const n = norm(k);
    if (FIELD[n] && out[n] === undefined && !isBlank(v)) out[n] = String(v).trim();
  }
  const ctl = {};
  for (const [key, header] of Object.entries(resolved.control)) { const v = row[header]; if (!isBlank(v)) ctl[key] = String(v).trim(); }
  return { data: out, control: ctl, meta };
}

// ── stage 2: score every use case this profile actually has ──
function fieldsFor(uc, key) {
  const f = (uc && uc.fields) || [];
  if (f.length) return f;
  const arch = (uc && uc.archetype) || key;
  return LEGACY_FIELDS[ARCHETYPES.includes(arch) ? arch : 'sales_offer'] || [];
}
function archetypeOf(uc, key) { const a = (uc && uc.archetype) || key; return ARCHETYPES.includes(a) ? a : 'sales_offer'; }

/** The date-derived facts every archetype signal is judged against. */
function timeSignals(d, now) {
  const due = parseDate(d.due_date), appt = parseDate(d.appointment_date), ren = parseDate(d.renewal_date);
  let inter = parseDate(d.interaction_date);
  const dl = parseDate(d.deadline);
  // A visit that has already happened IS an interaction, whatever column it arrived in. The fill
  // step derives it that way, so the evidence has to be read that way too, or a row can be judged
  // to have no signal and then quietly satisfy the very call it was judged not to want.
  if (!inter) { const a = parseDate(d.appointment_date); if (a && a < now) inter = a; }
  let overdue = d.days_overdue != null && /^\d+$/.test(String(d.days_overdue)) ? parseInt(d.days_overdue, 10) : null;
  if (overdue === null && due && due < now) overdue = daysDiff(due, now);
  return {
    daysOverdue: overdue,
    daysToDue: due ? daysDiff(now, due) : null,
    daysToAppt: appt ? daysDiff(now, appt) : null,
    daysToRenewal: ren ? daysDiff(now, ren) : null,
    daysSinceInteraction: inter ? daysDiff(inter, now) : null,
    daysToDeadline: dl ? daysDiff(now, dl) : null
  };
}

/**
 * Evidence that the row is ASKING for a given archetype, independent of which fields it declares.
 * Positive numbers argue for, negative against. Kept separate from field coverage so a row can want
 * a call it is not yet complete enough to place, which is what makes the downgrade meaningful.
 */
function archetypeSignal(arch, d, t) {
  const has = k => !isBlank(d[k]);
  switch (arch) {
    case 'overdue_followup':
      if (t.daysOverdue > 0) return { score: 45, why: `${t.daysOverdue} day${t.daysOverdue === 1 ? '' : 's'} overdue` };
      if (has('amount_overdue')) return { score: 35, why: 'an overdue amount on file' };
      return { score: t.daysToDue >= 0 ? -30 : 0, why: '' };
    case 'payment_reminder':
      if (t.daysOverdue > 0) return { score: -35, why: '' };
      if (t.daysToDue !== null && t.daysToDue >= 0 && t.daysToDue <= 21) return { score: 40, why: `payment due in ${t.daysToDue} day${t.daysToDue === 1 ? '' : 's'}` };
      if (has('amount_due')) return { score: 22, why: 'an amount due on file' };
      return { score: 0, why: '' };
    case 'appointment_reminder':
      if (t.daysToAppt !== null && t.daysToAppt >= 0 && t.daysToAppt <= 30) return { score: 42, why: t.daysToAppt === 0 ? 'an appointment today' : `an appointment in ${t.daysToAppt} day${t.daysToAppt === 1 ? '' : 's'}` };
      if (t.daysToAppt !== null && t.daysToAppt < 0) return { score: -30, why: '' };
      if (has('appointment_time') || has('appointment_type')) return { score: 20, why: 'a booking on file' };
      return { score: 0, why: '' };
    case 'service_notification':
      if (has('event_detail') || has('event_type')) return { score: 44, why: 'a service event on file' };
      if (has('impact') || has('resolution_eta')) return { score: 30, why: 'a disruption logged' };
      return { score: 0, why: '' };
    case 'document_collection':
      if (has('missing_items')) return { score: 44, why: 'documents outstanding' };
      if (has('process_name') && has('deadline')) return { score: 26, why: 'an application with a deadline' };
      return { score: 0, why: '' };
    case 'renewal_retention':
      if (t.daysToRenewal !== null && t.daysToRenewal >= -7 && t.daysToRenewal <= 90) return { score: 38, why: t.daysToRenewal < 0 ? 'a lapsed renewal' : `renewal in ${t.daysToRenewal} day${t.daysToRenewal === 1 ? '' : 's'}` };
      if (has('renewal_item')) return { score: 20, why: 'a renewable item on file' };
      return { score: 0, why: '' };
    case 'feedback_survey':
      if (t.daysSinceInteraction !== null && t.daysSinceInteraction >= 0 && t.daysSinceInteraction <= 30) return { score: 34, why: `an interaction ${t.daysSinceInteraction} day${t.daysSinceInteraction === 1 ? '' : 's'} ago` };
      if (has('interaction_type')) return { score: 18, why: 'a recent interaction' };
      return { score: 0, why: '' };
    case 'lead_qualification':
      if (has('lead_source') || has('interest')) return { score: 36, why: 'a new enquiry' };
      return { score: 0, why: '' };
    case 'sales_offer':
      if (has('offer_type') || has('offer_detail')) return { score: 30, why: 'an offer on file' };
      if (has('eligible_amount')) return { score: 22, why: 'an eligibility on file' };
      return { score: 0, why: '' };
    default: return { score: 0, why: '' };
  }
}

/** A field only one use case in this profile asks for is strong evidence for that use case. */
function discriminators(useCases) {
  const count = {};
  for (const [key, uc] of Object.entries(useCases)) for (const f of fieldsFor(uc, key)) count[f.var] = (count[f.var] || 0) + 1;
  return new Set(Object.keys(count).filter(v => count[v] === 1));
}

function matchExplicit(raw, useCases) {
  if (isBlank(raw)) return null;
  const n = norm(raw);
  if (useCases[n]) return n;
  for (const [key, uc] of Object.entries(useCases)) {
    if (norm(uc.label || '') === n) return key;
    if (norm(uc.archetype || '') === n) return key;
  }
  // Free text ("collections call", "renewal") mapped to an archetype, then to this profile's own
  // use case for it, so a partner's vocabulary does not have to be ours.
  const arch = normaliseArchetype(n);
  if (arch) { const k = Object.keys(useCases).find(k2 => archetypeOf(useCases[k2], k2) === arch); if (k) return k; }
  return null;
}
function normaliseArchetype(s) {
  if (!s) return null;
  if (ARCHETYPES.includes(s)) return s;
  if (/overdue|collection|arrear|dunning|recovery|follow/.test(s)) return 'overdue_followup';
  if (/reminder|due|payment|emi|bill|invoice|premium/.test(s)) return 'payment_reminder';
  if (/sales|offer|market|promo|upsell|cross|winback|win_back|campaign/.test(s)) return 'sales_offer';
  if (/appoint|booking|delivery|visit|schedul|slot/.test(s)) return 'appointment_reminder';
  if (/feedback|survey|csat|nps|review/.test(s)) return 'feedback_survey';
  if (/notif|disrupt|outage|delay|recall|alert|advisory|cancel|incident|exception/.test(s)) return 'service_notification';
  if (/document|kyc|paperwork|verification|pending_doc/.test(s)) return 'document_collection';
  if (/lead|qualif|prospect|enquiry|inquiry/.test(s)) return 'lead_qualification';
  if (/renew|retention|subscription|expiry/.test(s)) return 'renewal_retention';
  return null;
}

/**
 * Rank every enabled use case for this row.
 *
 * The catalogue already states, per use case, which variables the call cannot be made without. That
 * declaration is the evidence: a row carrying those fields is a row asking for that call. It needs
 * no industry-specific code, which is the whole point — adding an industry stays a catalogue edit.
 */
function scoreUseCases(d, ctl, profile, now) {
  const useCases = enabledUseCases(profile);
  const keys = Object.keys(useCases);
  if (!keys.length) return [];
  const disc = discriminators(useCases);
  const t = timeSignals(d, now);
  const explicit = matchExplicit(ctl.use_case, useCases);

  return keys.map(key => {
    const uc = useCases[key];
    const arch = archetypeOf(uc, key);
    const fields = fieldsFor(uc, key);
    const required = fields.filter(f => f.required).map(f => f.var);
    const optional = fields.filter(f => !f.required).map(f => f.var);
    const have = v => !isBlank(d[v]) || derivable(v, d, t);
    const metReq = required.filter(have);
    const missingReq = required.filter(v => !have(v));
    const metOpt = optional.filter(have);
    const coverage = required.length ? metReq.length / required.length : 1;

    const sig = archetypeSignal(arch, d, t);
    let score = 0;
    const why = [];
    if (explicit === key) { score += 1000; why.push('the file names this call'); }
    score += sig.score;
    if (sig.why) why.push(sig.why);
    score += coverage * 40;
    if (missingReq.length === 0 && required.length) why.push('every detail it needs is present');
    score += metOpt.length * 4;
    const discHit = [...metReq, ...metOpt].filter(v => disc.has(v));
    if (discHit.length) { score += 12 * discHit.length; }
    if (missingReq.length) score -= 18 * missingReq.length;
    score -= (URGENCY[arch] || 9) * 0.4;   // tie-break only

    return { key, uc, archetype: arch, score, coverage, required, missingReq, metOpt, why, complete: missingReq.length === 0, explicit: explicit === key, urgency: URGENCY[arch] || 9 };
  }).sort((a, b) => b.score - a.score);
}
function enabledUseCases(profile) {
  const uc = (profile && profile.use_cases) || {};
  const out = {};
  for (const [k, v] of Object.entries(uc)) if (v && v.enabled) out[k] = v;
  return out;
}

// ── stage 3: fill the variables that use case declares ──
// var-as-written -> canonical field. Built once from the alias table.
const CANONICAL = (() => {
  const m = {};
  for (const [field, def] of Object.entries(FIELD)) { m[field] = field; for (const a of def.aliases) if (!m[a]) m[a] = field; }
  return m;
})();
/** The value for a declared variable, tolerating a catalogue that spells it differently. */
function valueOf(d, v) {
  if (!isBlank(d[v])) return d[v];
  const c = CANONICAL[v];
  return c && !isBlank(d[c]) ? d[c] : '';
}
/** Can we work this out from what we do have? Kept in step with `derive` below. */
function derivable(v, d, t) {
  switch (v) {
    case 'days_overdue': return t.daysOverdue !== null && t.daysOverdue > 0;
    case 'amount_overdue': return !isBlank(d.amount_due) && t.daysOverdue > 0;
    case 'amount_due': return !isBlank(d.amount_overdue);
    case 'due_date': return t.daysOverdue !== null || !isBlank(d.deadline);
    case 'deadline': return !isBlank(d.due_date);
    case 'appointment_date': return !isBlank(d.appointment_time) && looksLikeDate(d.appointment_time);
    case 'renewal_date': return !isBlank(d.expiry_date);
    case 'expiry_date': return !isBlank(d.renewal_date);
    case 'interaction_date': return t.daysToAppt !== null && t.daysToAppt < 0;
    default: return false;
  }
}
function derive(v, d, t, now) {
  switch (v) {
    case 'days_overdue': return t.daysOverdue > 0 ? String(t.daysOverdue) : '';
    case 'amount_overdue': return t.daysOverdue > 0 ? d.amount_due : '';
    case 'amount_due': return d.amount_overdue;
    case 'due_date': {
      if (!isBlank(d.deadline)) return d.deadline;
      if (t.daysOverdue !== null) { const x = new Date(now); x.setDate(x.getDate() - t.daysOverdue); return x.toISOString().slice(0, 10); }
      return '';
    }
    case 'deadline': return d.due_date;
    case 'appointment_date': return d.appointment_time;
    case 'renewal_date': return d.expiry_date;
    case 'expiry_date': return d.renewal_date;
    case 'interaction_date': return t.daysToAppt !== null && t.daysToAppt < 0 ? d.appointment_date : '';
    default: return '';
  }
}

function formatMoney(raw, scale) {
  if (isBlank(raw)) return '';
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!n || isNaN(n)) return '';
  return Math.round(n).toLocaleString(scale === 'indian' ? 'en-IN' : 'en-US');
}
function formatDateSpoken(date) {
  if (!date) return '';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = date.getDate();
  const suffix = ['th', 'st', 'nd', 'rd'][(day % 10 > 3 || Math.floor(day / 10) === 1) ? 0 : day % 10] || 'th';
  return `${days[date.getDay()]}, the ${day}${suffix} of ${months[date.getMonth()]}`;
}
/** A slot like "2026-09-08 10:00-13:00" is a date column and a time column wearing one hat. */
function formatTimeSpoken(raw) {
  if (isBlank(raw)) return '';
  const s = String(raw).trim();
  const clock = s.match(/\d{1,2}[:.]\d{2}\s*(?:am|pm)?(?:\s*(?:[-–—]|to)\s*\d{1,2}[:.]\d{2}\s*(?:am|pm)?)?/i)
    || s.match(/\d{1,2}\s*(?:am|pm)(?:\s*(?:[-–—]|to)\s*\d{1,2}\s*(?:am|pm)?)?/i);
  if (clock) return clock[0].replace(/\./g, ':').replace(/\s*[-–—]\s*/, ' to ');
  // A slot is as often a word as a clock face: "morning", "AM slot", "between 9 and 11".
  const worded = s.match(/\b(early morning|morning|midday|noon|afternoon|evening|night|anytime)\b/i);
  if (worded) return worded[0].toLowerCase();
  return looksLikeDate(s) ? '' : s;
}
/** Values that are a date in a text-typed slot ("restoration ETA: 2026-09-10") should still speak. */
function speakIfDate(raw) {
  if (isBlank(raw)) return String(raw == null ? '' : raw).trim();
  const s = String(raw).trim();
  const d = parseDate(s);
  if (!d || !/^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(s)) return s;
  const time = formatTimeSpoken(s);
  return formatDateSpoken(d) + (time ? ', ' + time : '');
}

function formatValue(field, raw, scale) {
  const def = FIELD[field];
  const type = def ? def.type : 'text';
  if (isBlank(raw)) return '';
  switch (type) {
    case 'money': return formatMoney(raw, scale);
    case 'date': { const d = parseDate(raw); return d ? formatDateSpoken(d) : String(raw).trim(); }
    case 'time': return formatTimeSpoken(raw);
    case 'phone': return String(raw).trim();
    case 'bool': return isTruthy(raw) ? 'TRUE' : 'FALSE';
    case 'list': return String(raw).trim().replace(/\s*[;|]\s*/g, ', ');
    case 'id': return String(raw).trim();
    case 'int': { const n = parseInt(String(raw).replace(/\D/g, ''), 10); return isNaN(n) ? '' : String(n); }
    default:
      // A few free-text slots routinely carry a date; speak it rather than reading the ISO string out.
      return ['resolution_eta', 'event_time', 'deadline'].includes(field) ? speakIfDate(raw) : String(raw).trim();
  }
}

/**
 * Build the variables for one chosen use case.
 *
 * Anything the use case declares but the row does not carry is DERIVED where the data allows it and
 * OMITTED where it does not. Omitted is safe: the prompts already tell the agent to speak around an
 * empty variable, so silence about an unknown is a sentence the agent can say. A plausible stand-in
 * is not — a specific amount or date spoken to a real customer has to be that customer's.
 */
function fillVariables(cand, d, t, profile, now) {
  const scale = (profile && profile.locale && profile.locale.money_scale) === 'indian' ? 'indian' : 'western';
  const fields = fieldsFor(cand.uc, cand.key);
  const vars = {}, derived = [], omitted = [], missing = [];
  for (const f of fields) {
    let raw = valueOf(d, f.var);
    let wasDerived = false;
    if (isBlank(raw) && derivable(f.var, d, t)) { raw = derive(f.var, d, t, now); wasDerived = !isBlank(raw); }
    let val = formatValue(f.var, raw, scale);
    if (isBlank(val) && SUBJECT[f.var]) {
      const sub2 = subjectFallback(f.var, cand.uc, cand.key);
      if (sub2) { val = sub2; wasDerived = true; }
    }
    if (isBlank(val)) {
      (f.required ? missing : omitted).push(f.var);
      continue;   // never emit an empty string: an unset variable is what the prompt knows to handle
    }
    vars[f.var] = val;
    if (wasDerived) derived.push(f.var);
  }
  // Whether the call can go ahead is decided on the DATA, never on a label fallback: a subject
  // fallback tells the agent what to call the thing, it does not supply a fact we do not have.
  const groups = ESSENTIAL[cand.archetype] || [];
  const blocking = groups.filter(g => !g.some(v => !isBlank(d[v]) || (derivable(v, d, t) && !isBlank(derive(v, d, t, now)))))
    .map(g => g.find(v => fields.some(f => f.var === v)) || g[0]);
  // Nouns the catalogue supplies for this use case when the data does not name the thing itself.
  // These describe the CALL, not the customer, so they carry no risk of asserting something untrue.
  const uc = cand.uc || {};
  if (!vars.appointment_type && uc.appointment_noun) vars.appointment_type = uc.appointment_noun;
  if (!vars.renewal_item && uc.renewal_noun) vars.renewal_item = uc.renewal_noun;
  if (!vars.event_type && uc.event_noun) vars.event_type = uc.event_noun;
  if (!vars.process_name && uc.process_noun) vars.process_name = uc.process_noun;
  if (!vars.scale && uc.scale) vars.scale = uc.scale;
  if (!vars.submission_channel && profile && profile.contact && profile.contact.portal) vars.submission_channel = profile.contact.portal;
  for (const k of ['appointment_type', 'renewal_item', 'event_type', 'process_name', 'scale', 'submission_channel']) {
    if (vars[k]) { const i = missing.indexOf(k); if (i >= 0) missing.splice(i, 1); const j = omitted.indexOf(k); if (j >= 0) omitted.splice(j, 1); }
  }
  // Required-but-not-essential is a sentence we drop, not a call we cancel.
  const soft = missing.filter(v => !blocking.includes(v));
  return { variables: vars, derived, omitted: omitted.concat(soft), missing: blocking, softMissing: soft };
}

// ── the decision ────────────────────────────────────────
const labelOf = (uc, key) => (uc && uc.label) || String(key || '').replace(/_/g, ' ');
function humanFields(vars, useCases, key) {
  const fields = fieldsFor(useCases[key], key);
  return vars.map(v => { const f = fields.find(x => x.var === v); return (f && f.label) || v.replace(/_/g, ' '); });
}

/**
 * Route one row: which call, with what variables, and if not this call then why not.
 * `resolved` comes from resolveColumns() over the whole file.
 */
function routeRow(row, resolved, profile, opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const { data: d, control: ctl } = resolveRow(row, resolved);
  const useCases = enabledUseCases(profile);
  const t = timeSignals(d, now);

  const out = {
    customer_name: d.customer_name || '',
    to_number: d.to_number || '',
    time: ctl.time || autoTimeOfDay(now),
    use_case: null, variables: {},
    intelligence_reason: '', intelligence_signals: [],
    confidence: 'none', alternatives: [], derived: [], omitted: [], needs: [],
    dnc: !!(ctl.do_not_call && isTruthy(ctl.do_not_call))
  };
  if (ctl.language) out.language = ctl.language;
  if (!Object.keys(useCases).length) { out.intelligence_reason = 'No use cases are switched on for this agent.'; return out; }

  const ranked = scoreUseCases(d, ctl, profile, now);
  const top = ranked[0];

  // The row wants this call but does not carry everything it needs. Rather than placing a call with
  // holes in it, look for one the row CAN support — a fee reminder with no amount but documents
  // outstanding is a documents call, and that is a better call than a hollow one.
  let chosen = top, downgradedFrom = null;
  if (!top.complete && !top.explicit) {
    const alt = ranked.find(c => c.complete && c.score > 0);
    // Only step down for a candidate with real evidence of its own, never merely to find something
    // complete: an empty row must not become a marketing call by process of elimination.
    if (alt && alt.score >= top.score - 45) { chosen = alt; downgradedFrom = top; }
  }

  const filled = fillVariables(chosen, d, t, profile, now);
  out.use_case = chosen.key;
  out.variables = filled.variables;
  out.derived = filled.derived;
  out.omitted = filled.omitted;
  out.needs = humanFields(filled.missing, useCases, chosen.key);
  out.softMissing = humanFields(filled.softMissing || [], useCases, chosen.key);

  const signals = [];
  if (chosen.explicit) signals.push('📌 named in the file');
  for (const w of chosen.why) if (w && !/^the file names/.test(w)) signals.push('• ' + w);
  if (filled.derived.length) signals.push('🧮 worked out: ' + humanFields(filled.derived, useCases, chosen.key).join(', '));
  if (downgradedFrom) signals.push('↩ not ' + labelOf(downgradedFrom.uc, downgradedFrom.key) + ': ' + humanFields(downgradedFrom.missingReq, useCases, downgradedFrom.key).join(', ') + ' missing');
  if (filled.omitted.length) signals.push('○ not mentioned: ' + humanFields(filled.omitted, useCases, chosen.key).join(', '));
  out.intelligence_signals = signals;

  const label = labelOf(chosen.uc, chosen.key);
  const because = chosen.why.filter(Boolean).slice(0, 2).join(' and ');
  // Below zero, nothing argued FOR any call and the ranking is only measuring which is least wrong.
  // Naming that as the intended call would misrepresent what the row says.
  const noMatch = chosen.score <= 0 && !chosen.explicit;
  out.matched = !noMatch;
  out.intelligence_reason = noMatch
    ? `Nothing on this row matches the calls this agent makes. The nearest, ${label}, would need ${out.needs.length ? out.needs.join(' and ') : 'more detail'}.`
    : (filled.missing.length
      ? `${label} is the closest fit, but ${out.needs.join(' and ')} ${out.needs.length === 1 ? 'is' : 'are'} missing from the row.`
      : (because ? `${label} — ${because}.` : `${label} — the details on this row fit this call.`));
  if (noMatch) out.intelligence_signals = ['∅ no matching call'];

  const second = ranked.find(c => c.key !== chosen.key);
  const gap = second ? chosen.score - second.score : 999;
  // Judged on the ESSENTIALS, not on every field the catalogue happened to mark required. A
  // network-outage call carrying the fault and the restoration time is a confident call even though
  // it says nothing about the start time, and labelling it "low" undermines the one screen whose
  // job is to earn trust in the routing.
  out.confidence = chosen.explicit ? 'certain'
    : noMatch ? 'none'
    : filled.missing.length ? 'low'
    : gap >= 25 ? 'high' : gap >= 10 ? 'medium' : 'low';
  out.alternatives = ranked.filter(c => c.key !== chosen.key).slice(0, 2).map(c => ({ key: c.key, label: labelOf(c.uc, c.key), score: Math.round(c.score), complete: c.complete }));
  out.urgency = chosen.urgency;
  out.archetype = chosen.archetype;
  out.callable = !!(out.to_number && out.customer_name && filled.missing.length === 0 && !noMatch);
  if (noMatch && !out.needs.length) out.needs = ['a detail this agent can act on'];
  return out;
}
function autoTimeOfDay(now) { const hr = (now || new Date()).getHours(); return hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'; }

module.exports = {
  FIELD, CONTROL, ARCHETYPES, LEGACY_FIELDS, URGENCY,
  resolveColumns, resolveRow, routeRow, scoreUseCases, fillVariables,
  parseDate, formatDateSpoken, formatMoney, formatTimeSpoken, formatValue,
  detectDateOrder, expandExponential, excelSerialToDate,
  isTruthy, norm, timeSignals, fieldsFor, archetypeOf, enabledUseCases, normaliseArchetype, autoTimeOfDay,
  looksLikePersonName, looksLikePhone, looksLikeDate
};
