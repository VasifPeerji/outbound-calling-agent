/**
 * OmniReach — call simulator (dry-run, no telephony).
 *
 * Produces a realistic transcript + a plausible outcome for a use case, using the active profile's
 * variables (agent, company, currency, honorific, amounts). Lets the WHOLE console be demoed end to
 * end — history, recordings-less transcripts, outcomes, write-back, analytics — with no ElevenLabs
 * credentials or phone numbers. Every simulated call is flagged `simulated:true` so it is never
 * mistaken for a real one.
 */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(p) { return Math.random() < p; }
function addr(name, style) {
  const first = (name || 'there').split(' ')[0];
  const last = (name || '').split(' ').slice(-1)[0];
  if (style === 'first_name_ji') return first + ' ji';
  if (style === 'mr_ms_surname') return last ? 'Mr. ' + last : first;
  if (style === 'sir_maam') return 'sir';
  return first;
}

// Build a simulated call. Returns fields ready to merge onto a history entry.
function simulateCall(vars, profile) {
  vars = vars || {}; profile = profile || {};
  // `uc` is the profile's use-case key (industry-named, e.g. "flight_disruption") — history and
  // analytics keep that. The simulated CONVERSATION is driven by its archetype.
  const uc = vars.use_case || 'sales_offer';
  const ucCfg = (profile.use_cases && profile.use_cases[uc]) || {};
  const arch = ucCfg.archetype || uc;
  const v = vars.variables || vars; // accept either flat or nested
  const agent = (profile.agent && profile.agent.name) || 'Alex';
  const company = (profile.company && profile.company.name) || 'our company';
  const short = (profile.company && profile.company.short_name) || company;
  const cust = vars.customer_name || 'the customer';
  const who = addr(cust, (profile.agent && profile.agent.honorific_style) || 'first_name');
  const cur = (profile.locale && profile.locale.currency_spoken) || 'the amount';
  const time = vars.time || 'day';
  const turns = [];
  const A = m => turns.push({ role: 'agent', message: m });
  const U = m => turns.push({ role: 'user', message: m });
  let disposition = 'reached_customer', sentiment = 'neutral', successful = true;
  const apply = {}; // structured outcome fields (mirror the action tools)
  const timeline = []; // pseudo tool-call log
  const logTool = (tool, params) => timeline.push({ tool, params, at: null, simulated: true });

  // ~8% no-answer / voicemail, ~4% wrong person — short calls, before the flow
  const roll = Math.random();
  if (roll < 0.08) {
    A(`Hello, this is ${agent} from ${company} with a message for ${cust}. Please call us back on ${(profile.contact && profile.contact.support_number_spoken) || 'our support line'} when convenient. Thank you.`);
    disposition = 'no_answer_voicemail'; successful = false;
    return finish(turns, disposition, sentiment, successful, apply, timeline, 'Voicemail — left a brief callback message.', uc);
  }
  if (roll < 0.12) {
    A(`Good ${time}! Am I speaking with ${cust}?`);
    U(`No, they're not available right now.`);
    A(`Apologies for the interruption. Could you ask ${cust} to call ${short} back? Thank you, have a good ${time}.`);
    disposition = 'wrong_person'; successful = false;
    return finish(turns, disposition, sentiment, successful, apply, timeline, 'Reached someone else — left a neutral callback request.', uc);
  }

  A(`Good ${time}! Am I speaking with ${cust}?`);
  U(`Yes, that's me.`);

  if (arch === 'payment_reminder') {
    const amt = v.amount_due ? `${v.amount_due} ${cur}` : `your upcoming payment`;
    const due = v.due_date || 'in a few days';
    A(`Lovely, ${who}. It's ${agent} from ${company} — just a quick, friendly reminder that ${v.product_name || 'your payment'} of ${amt} is coming up ${due}. Nothing to worry about. Is everything looking fine for that date?`);
    const b = pick(['pay', 'pay', 'paid', 'busy', 'difficulty']);
    if (b === 'pay') {
      const date = pick(['by Friday', 'on the due date', 'tomorrow', 'this weekend']); const method = pick(['the portal', 'auto-pay', 'UPI', 'my card']);
      U(`Yes, all good — I'll pay ${date} through ${method}.`);
      A(`Perfect, ${who}. So that's ${amt} ${date} — I've noted that. Thank you for staying on top of it!`);
      disposition = 'promised_payment'; sentiment = 'positive';
      apply.promiseToPay = { amount: v.amount_due || '', date, method }; logTool('log_promise_to_pay', apply.promiseToPay);
    } else if (b === 'paid') {
      U(`Oh, I actually paid that yesterday.`);
      A(`Thank you for letting me know, ${who}! It can take a short while to reflect — do keep the reference handy just in case.`);
      disposition = 'already_paid'; sentiment = 'positive';
    } else if (b === 'busy') {
      const t2 = pick(['this evening', 'tomorrow morning', 'after six']);
      U(`I'm a little busy right now.`);
      A(`Of course, ${who}, I won't keep you. Shall I arrange a quick reminder call ${t2}?`); U(`Yes, that works.`);
      disposition = 'callback_requested'; apply.callback = { time: t2, reason: 'was busy' }; logTool('schedule_callback', apply.callback);
    } else {
      U(`Honestly, money's a bit tight this month.`);
      A(`I completely understand, ${who}, and thank you for being open. Please reach our team before ${due} and we'll look at the options together — you won't be on your own with this.`);
      disposition = 'callback_requested'; sentiment = 'neutral'; apply.callback = { time: 'before the due date', reason: 'payment difficulty' }; logTool('schedule_callback', apply.callback);
    }
  } else if (arch === 'overdue_followup') {
    const amt = v.amount_overdue ? `${v.amount_overdue} ${cur}` : `the overdue amount`;
    A(`Thank you, ${who}. It's ${agent} from ${company}. I'm calling because ${v.product_name || 'your account'} of ${amt}, due on ${v.original_due_date || 'its date'}, is now ${v.days_overdue || 'a few'} days overdue. I'd like to help sort it out — what's happened there?`);
    const b = pick(['promise', 'promise', 'partial', 'dispute', 'hardship']);
    if (b === 'promise') {
      const date = pick(['this Friday', 'on the 5th', 'by month-end']);
      U(`Sorry, it slipped my mind — I'll clear it ${date}.`);
      A(`I appreciate that, ${who}. So the full ${amt} ${date} — I've recorded that. Please do call us if anything changes before then.`);
      disposition = 'promised_payment'; sentiment = 'neutral'; apply.promiseToPay = { amount: v.amount_overdue || '', date, method: '' }; logTool('log_promise_to_pay', apply.promiseToPay);
    } else if (b === 'partial') {
      U(`I can only manage half right now.`);
      A(`That's a fair start, ${who} — let's get the part-payment in this week, and we'll plan the rest. I've noted it.`);
      disposition = 'promised_payment'; apply.promiseToPay = { amount: 'a part-payment', date: 'this week', method: '' }; logTool('log_promise_to_pay', apply.promiseToPay);
    } else if (b === 'dispute') {
      U(`That can't be right — I already paid this!`);
      A(`Thank you for flagging it, ${who}, I won't argue the point — I've logged it for the team to check against your records. Please keep the reference handy.`);
      disposition = 'dispute_raised'; sentiment = 'negative'; apply.dispute = { about: 'says already paid', details: '' }; logTool('flag_dispute', apply.dispute);
    } else {
      U(`I lost my job last month, it's been hard.`);
      A(`I'm really sorry to hear that, ${who}. Let me connect you with our support team who can look at a proper plan — you have options here.`);
      disposition = 'escalated_to_human'; sentiment = 'negative'; apply.transferred = { department: 'collections', reason: 'hardship' }; logTool('transfer_to_human', apply.transferred);
    }
  } else if (arch === 'sales_offer') {
    A(`Thanks, ${who}. It's ${agent} from ${company} — something came up against your profile I thought could genuinely help: ${v.offer_type || 'a new offer'}${v.offer_detail ? ', ' + v.offer_detail : ''}. Do you have a quick minute?`);
    const b = pick(['interested', 'interested', 'callback', 'no', 'dnc']);
    if (b === 'interested') {
      U(`Actually, that does sound useful.`);
      A(`Wonderful, ${who}! I'll have a specialist walk you through it — I've captured your interest.`);
      disposition = 'lead_qualified'; sentiment = 'positive'; apply.lead = { qualified: 'yes', interest: v.offer_type || '', budget: '', timeline: 'soon', notes: '' }; logTool('capture_lead', apply.lead);
    } else if (b === 'callback') {
      const t2 = pick(['tomorrow', 'next week', 'this weekend']);
      U(`Can you call me ${t2}?`); A(`Absolutely, ${who} — I'll set that up. Talk ${t2}!`);
      disposition = 'callback_requested'; apply.callback = { time: t2, reason: 'wants to consider' }; logTool('schedule_callback', apply.callback);
    } else if (b === 'no') {
      U(`No thanks, not for me.`); A(`No problem at all, ${who} — I appreciate your time. Do keep ${short} in mind down the line.`);
      disposition = 'not_interested';
    } else {
      U(`Please stop calling me with offers.`); A(`Understood, ${who}, and apologies for the disturbance — I've recorded that and you won't get these calls again.`);
      disposition = 'do_not_call'; apply.dnc = true; apply.dncReason = 'opted out of offers'; logTool('mark_do_not_call', { reason: 'opted out of offers', scope: 'marketing_only' });
    }
  } else if (arch === 'appointment_reminder') {
    A(`Hihi ${who}, it's ${agent} from ${company} — a quick reminder about your ${v.appointment_type || 'appointment'} on ${v.appointment_date || 'the scheduled date'}${v.appointment_time ? ' at ' + v.appointment_time : ''}. Does that still work for you?`);
    const b = pick(['confirm', 'confirm', 'reschedule', 'cancel']);
    if (b === 'confirm') {
      U(`Yes, that's fine.`); A(`Lovely — you're all confirmed, ${who}. See you then!`);
      disposition = 'appointment_set'; sentiment = 'positive'; apply.appointment = { status: 'confirmed', date: v.appointment_date || '', time: v.appointment_time || '', type: v.appointment_type || '', location: v.location || '' }; logTool('book_appointment', apply.appointment);
    } else if (b === 'reschedule') {
      const nd = pick(['next Tuesday', 'Thursday afternoon', 'the following week']);
      U(`Could we move it to ${nd}?`); A(`Of course, ${who} — I've moved it to ${nd}. All set.`);
      disposition = 'appointment_set'; apply.appointment = { status: 'rescheduled', date: nd, time: '' }; logTool('reschedule_appointment', { new_date: nd, new_time: '' });
    } else {
      U(`I need to cancel, sorry.`); A(`No problem at all, ${who} — that's cancelled. You're welcome to rebook any time.`);
      disposition = 'resolved'; apply.appointment = { status: 'cancelled', reason: '' }; logTool('cancel_appointment', { reason: '' });
    }
  } else if (arch === 'feedback_survey') {
    const scale = v.scale || '1 to 5';
    A(`Thanks ${who}! It's ${agent} from ${company} — could I grab a quick moment about ${v.interaction_type || 'your recent experience'}? On a scale of ${scale}, how would you rate it?`);
    if (chance(0.68)) {
      const hi = /10/.test(scale) ? pick(['9', '10', '8']) : pick(['5', '4']);
      U(`I'd say ${hi} — really smooth, honestly.`); A(`That's lovely to hear, ${who} — thank you so much for sharing that.`);
      disposition = 'resolved'; sentiment = 'positive'; apply.survey = { score: hi, scale, sentiment: 'positive', verbatim: 'smooth experience', would_recommend: 'yes' }; logTool('capture_survey_response', apply.survey);
    } else {
      const lo = /10/.test(scale) ? pick(['4', '5', '3']) : pick(['2', '3']);
      U(`Maybe a ${lo} — the wait was too long.`); A(`I'm sorry it wasn't the experience we'd want, ${who}, and thank you for being honest. I'll pass this to the team and have someone follow up.`);
      disposition = 'escalated_to_human'; sentiment = 'negative'; apply.survey = { score: lo, scale, sentiment: 'negative', verbatim: 'wait was too long', would_recommend: 'unsure' }; logTool('capture_survey_response', apply.survey);
      apply.callback = { time: 'soon', reason: 'low CSAT follow-up' };
    }
  } else if (arch === 'lead_qualification') {
    A(`Hi ${who}, it's ${agent} from ${company} — following up on your interest in ${v.interest || 'our products'} from ${v.lead_source || 'your enquiry'}. Is that still something you're looking into?`);
    const b = pick(['qualified', 'qualified', 'exploring', 'no']);
    if (b === 'qualified') {
      const t2 = pick(['this week', 'next week']);
      U(`Yes, I'm hoping to move on it fairly soon.`); A(`Great to hear, ${who}! Let's get a specialist to walk you through it — I'll book something for ${t2}.`);
      disposition = 'appointment_set'; sentiment = 'positive'; apply.lead = { qualified: 'yes', interest: v.interest || '', budget: '', timeline: 'soon', notes: '' }; apply.appointment = { status: 'booked', date: t2, time: '', type: 'specialist call' }; logTool('capture_lead', apply.lead); logTool('book_appointment', apply.appointment);
    } else if (b === 'exploring') {
      U(`Just exploring for now.`); A(`Totally fine, ${who} — I'll send over some info and check back when the time's right.`);
      disposition = 'callback_requested'; apply.lead = { qualified: 'maybe', interest: v.interest || '', timeline: 'exploring' }; apply.callback = { time: 'in a couple of weeks', reason: 'still exploring' }; logTool('capture_lead', apply.lead);
    } else {
      U(`I've actually gone with someone else.`); A(`Understood, ${who} — thanks for letting me know, and all the best. We're here if that ever changes.`);
      disposition = 'not_interested'; apply.lead = { qualified: 'no', interest: v.interest || '' };
    }
  } else if (arch === 'renewal_retention') {
    A(`Hello ${who}, it's ${agent} from ${company} — your ${v.renewal_item || 'plan'} is coming up for renewal on ${v.renewal_date || 'its date'}, and I wanted to make keeping it effortless. Shall I help you get it renewed?`);
    const b = pick(['renew', 'renew', 'considering', 'leaving']);
    if (b === 'renew') {
      U(`Yes, let's keep it going.`); A(`Wonderful, ${who} — I've noted the renewal so there's no break in your benefits.`);
      disposition = 'renewed'; sentiment = 'positive'; apply.renewal = { decision: 'renewed', reason: '', offer_accepted: 'none_offered' }; logTool('log_renewal_decision', apply.renewal);
    } else if (b === 'considering') {
      U(`Let me think about it.`); A(`Of course, ${who} — no rush. I'll follow up before ${v.renewal_date || 'the date'} so you don't lose anything.`);
      disposition = 'callback_requested'; apply.renewal = { decision: 'considering', reason: 'wants to think' }; apply.callback = { time: 'before renewal', reason: 'considering renewal' }; logTool('log_renewal_decision', apply.renewal);
    } else {
      U(`Actually, I'd like to cancel it.`); A(`I understand, ${who}. May I ask what's prompting it? ... Thank you for sharing — I've noted your decision and we'd love to have you back any time.`);
      disposition = 'refused'; sentiment = 'negative'; apply.renewal = { decision: 'declined', reason: pick(['price', 'not using it', 'switching']), offer_accepted: 'no' }; logTool('log_renewal_decision', apply.renewal);
    }
  } else if (arch === 'service_notification') {
    const what = v.event_type || 'a change to your booking';
    A(`Thank you, ${who}. It's ${agent} from ${company}, and I'm calling about ${what}. ${v.event_detail || 'There has been a change on our side.'}${v.impact ? ' What that means for you is ' + v.impact + '.' : ''} I'm sorry about this — let me tell you what we can do.`);
    const b = pick(['accepts', 'accepts', 'annoyed', 'refund', 'callback']);
    if (b === 'accepts') {
      const opt = v.options || pick(['the next available slot', 'the alternative we have held for you']);
      U(`That's frustrating, but okay — what are the options?`);
      A(`We can move you to ${opt}. ${v.resolution_eta ? 'Everything should be back to normal ' + v.resolution_eta + '.' : ''} Shall I confirm that for you?`);
      U(`Yes, please do that.`);
      A(`Done, ${who} — you're confirmed. You'll get it in writing shortly. Thank you for being so understanding.`);
      disposition = 'appointment_set'; sentiment = 'neutral';
      apply.appointment = { status: 'rescheduled', date: v.resolution_eta || '', time: '', type: what, location: '' }; logTool('reschedule_appointment', { new_date: v.resolution_eta || '', new_time: '' });
    } else if (b === 'annoyed') {
      U(`This is the second time this has happened. It's really not good enough.`);
      A(`You're right to be annoyed, ${who}, and I'm not going to defend it. I've logged this formally so it's looked at properly, and someone will come back to you. In the meantime, here's what we can do right now.`);
      disposition = 'dispute_raised'; sentiment = 'negative';
      apply.dispute = { about: what, details: 'repeat disruption, customer dissatisfied' }; logTool('flag_dispute', apply.dispute);
    } else if (b === 'refund') {
      U(`I don't want an alternative, I'd just like my money back.`);
      A(`That's absolutely your choice, ${who} — I've started the refund and you'll see it back on your original payment method. I'm sorry we couldn't do better this time.`);
      disposition = 'resolved'; sentiment = 'negative';
      apply.appointment = { status: 'cancelled', reason: 'customer chose a refund' }; logTool('cancel_appointment', { reason: 'refund requested' });
    } else {
      const t2 = pick(['this evening', 'tomorrow morning']);
      U(`I can't deal with this now, I'm driving.`);
      A(`Understood, ${who} — I won't keep you. In short: ${what}. I'll call you back ${t2} to sort the options. Drive safely.`);
      disposition = 'callback_requested'; apply.callback = { time: t2, reason: 'was driving' }; logTool('schedule_callback', apply.callback);
    }
  } else if (arch === 'document_collection') {
    const proc = v.process_name || 'your application';
    const items = v.missing_items || 'a couple of documents';
    A(`Thanks, ${who}. It's ${agent} from ${company} — good news, ${proc} is nearly through. There's just one step left: we still need ${items}. Shall I talk you through the quickest way to send that across?`);
    const b = pick(['will_send', 'will_send', 'no_document', 'already_sent', 'more_time']);
    if (b === 'will_send') {
      U(`Oh, I didn't realise. Yes, how do I send it?`);
      A(`Easiest is ${v.submission_channel || 'the secure link we\'ll send you'} — it takes a minute. I'll text you the link now so you have it to hand.`);
      U(`Perfect, I'll do it today.`);
      A(`Brilliant, ${who}. So that's ${items} via the link${v.deadline ? ', ideally before ' + v.deadline : ''}. Thank you for sorting it so quickly!`);
      disposition = 'resolved'; sentiment = 'positive';
      apply.followups = [{ channel: 'sms', content: 'document upload link' }]; logTool('send_followup', { channel: 'sms', content_type: 'upload link' });
    } else if (b === 'no_document') {
      U(`I don't actually have that document.`);
      A(`Not a problem at all, ${who} — there are usually alternatives we can accept. Let me check exactly what would work for your case and have someone confirm it, so you're not sending something that gets rejected.`);
      disposition = 'escalated_to_human'; apply.transferred = { department: 'verification', reason: 'alternative document check' }; logTool('transfer_to_human', apply.transferred);
    } else if (b === 'already_sent') {
      U(`I sent all of that last week already.`);
      A(`Thank you for telling me, ${who}, and apologies for the crossed wires — I'm not going to ask you to do it twice. I've logged it to be traced and you'll hear back once it's matched to your file.`);
      disposition = 'dispute_raised'; sentiment = 'negative';
      apply.dispute = { about: 'documents already submitted', details: 'customer says sent last week' }; logTool('flag_dispute', apply.dispute);
    } else {
      const t2 = pick(['next week', 'in a couple of days', 'after the weekend']);
      U(`I'll need to dig it out — can you give me a few days?`);
      A(`Of course, ${who}. I'll check back ${t2}.${v.deadline ? ' Just so you know, the date we\'re working to is ' + v.deadline + '.' : ''} I'll send the list across so it's all in one place.`);
      disposition = 'callback_requested'; apply.callback = { time: t2, reason: 'gathering documents' }; logTool('schedule_callback', apply.callback);
    }
  } else {
    A(`Hello ${who}, it's ${agent} from ${company}. Thanks for your time today.`);
    U(`Sure, thanks.`);
  }

  const summary = summarise(disposition, apply, cust);
  logTool('record_call_outcome', { disposition, summary, sentiment });
  return finish(turns, disposition, sentiment, successful, apply, timeline, summary, uc);
}

function summarise(disposition, apply, cust) {
  const first = (cust || 'Customer').split(' ')[0];
  if (apply.promiseToPay) return `${first} promised to pay ${apply.promiseToPay.amount || 'the amount'} ${apply.promiseToPay.date || ''}.`.replace(/\s+\./, '.');
  if (apply.callback) return `${first} asked for a callback (${apply.callback.time}).`;
  if (apply.appointment) return `Appointment ${apply.appointment.status} with ${first}.`;
  if (apply.survey) return `${first} rated ${apply.survey.score} (${apply.survey.sentiment}).`;
  if (apply.lead) return `${first} lead: ${apply.lead.qualified}.`;
  if (apply.renewal) return `${first} renewal: ${apply.renewal.decision}.`;
  if (apply.dispute) return `${first} raised a dispute.`;
  if (apply.dnc) return `${first} opted out of calls.`;
  return `Spoke with ${first} — ${String(disposition).replace(/_/g, ' ')}.`;
}

function finish(turns, disposition, sentiment, successful, apply, timeline, summary, uc) {
  const durationMs = (turns.length * 8 + Math.floor(Math.random() * 25) + 10) * 1000;
  const transcript = turns.map(t => `${t.role === 'agent' ? 'Agent' : 'User'}: ${t.message}`).join('\n');
  return { simulated: true, callStatus: 'ended', hasAudio: false, transcript, durationMs, userSentiment: sentiment, callSuccessful: successful, disposition, outcomeSummary: summary, summary, useCase: uc, apply, outcomesTimeline: timeline };
}

module.exports = { simulateCall };
