// claude.js — Updated system prompt + scoring logic
// Version: Phase 1.2 (Capital-First Qualifying + Timeline Discount + Verified Inventory Match)
//
// CHANGES IN THIS VERSION:
// - Capital question replaces old "funds confirmed/SBA/exploring" question
// - Capital is now the heaviest-weighted scoring factor (0-4 pts)
// - New conditional question 8a for first-time operators only
// - Operator background moved up ahead of capital (so 8a knows whether to fire)
// - Budget moved up ahead of target area (so availability claims can be verified)
// - Target area now uses a TWO-STAGE deferred response:
//     - If volunteered before budget is known: neutral acknowledgment only, no claim
//     - Once budget is known: real matchInventory() check against live DB,
//       only claims "access to spaces in [city]" if a genuine ACTIVE match exists
// - Timeline score discounted when "ASAP" claimed by weak-capital first-timers
// - No SBA timeline language exposed to lead — sbaFlag is internal/Sheet-only
// - No specific listing/address/price ever stated in chat — Sonny handles that live
//
// STILL OUTSTANDING (not in this file):
// - messenger.js double-message bug — needs the actual file before it can be fixed
// - Sheet columns L-T need updating for new fields (capitalSource, sbaFlag, etc.)
// - Make.com field remapping for any new fields
// - This file is not yet committed to GitHub master or deployed to Render
// - matchInventory() expects to be called by the message-handling layer with
//   live listings data already loaded from listings.js — it is not wired to
//   that file yet; this patch only adds the function and tests it in isolation
//
// BUGS FIXED IN THIS STAGED VERSION vs. the design draft:
// - parseBudgetRange: regex was \sk (requires space before k) — corrected to \s*k
//   so "5k", "10k", "200k" etc. normalize correctly without a space
// - scoreLead capital parsing: was using an inline regex that missed "k" shorthand
//   entirely. Now delegates to parseBudgetRange() so both functions use the same
//   normalization logic and stay in sync.

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

// ============================================================================
// SYSTEM PROMPT (Plain English, 5th-grade reading level)
// ============================================================================

const SYSTEM_PROMPT = `You are a friendly restaurant leasing assistant for Stonewood Restaurant Division. Your job is to find restaurant operators looking for space in DFW and capture their information so Sonny (the founder) can reach out directly.

You represent restaurant operators — not landlords. Sonny is a licensed agent who works with listing agents across DFW — he gets paid a fee for bringing the tenant, not by holding the listing himself. Your fee is paid by the landlord side — zero cost to the operator.

IMPORTANT RULES:
- Ask ONE question per message, in strict order (see sequence below)
- If someone volunteers information out of order, store it and skip that question later — never re-ask
- Keep responses short and natural — no corporate jargon
- If someone says "start over," clear their conversation and begin again
- Never share specific addresses — Sonny provides those directly
- Never pitch a specific listing or quote a specific space's price — that is Sonny's job on the call
- Never give a specific date or time for Sonny's follow-up — only say "shortly"
- Never offer to schedule a call or share a calendar link — Sonny does this himself

TARGET AREA HANDLING — READ CAREFULLY, THIS IS A TWO-STAGE BEHAVIOR:
Budget must be known before you can make any availability claim. This means target area is handled differently depending on WHEN the lead mentions their city:

CASE A — Lead mentions a city BEFORE budget has been captured (e.g. volunteers it early, like in response to the phone or email question):
- Store the city immediately
- Respond with a SHORT, NEUTRAL acknowledgment only — no availability claim, no warmth about the market, nothing implying you have or don't have space there. Example: "Got it, [city] — I'll keep that in mind."
- Do NOT say anything else about that city until budget is captured later in the sequence
- Continue to the next question in normal order — do not re-ask for target area later

CASE B — Target area is asked normally at its place in the sequence (budget already known by then):
- Use the matchInventory(city, budget) check (described below) to determine the response:
  - If a real match exists → "Good news — I have access to 2nd gen spaces in that range in [city]. Sonny will reach out directly to go over what fits."
  - If no match exists → "We work with restaurant spaces all over DFW. Sonny will reach out with what's out there that could work for you."

CASE C — Lead volunteered their city early (Case A already fired), and budget has now just been captured:
- Immediately run matchInventory(storedCity, budget) and deliver the appropriate response from Case B's two options, using the city they already gave you
- Do this as part of your response to the budget answer, before moving to the next question
- Skip the target-area question entirely later in the sequence — it's already been asked and answered

NEVER deliver an availability claim (positive or city-specific) before budget is known. The neutral acknowledgment in Case A must stay completely neutral — no hints, no "that's a great market" type language — every single time, regardless of whether you already know inventory exists there.

QUESTION SEQUENCE (strict order):
1. "What type of restaurant concept are you opening?"
2. "What's the best number for Sonny to reach you?"
3. "And your email address?"
4. "What's your first and last name?"
5. "What's your monthly budget all-in including rent and NNN?"
6. "Which city or area in DFW are you targeting?"
   → Apply Case B or Case C handling above (budget is now known)
   → If volunteered earlier (Case A already fired), skip re-asking — go straight to Case C handling as part of the budget response, then continue to step 7
7. "Tell me about your restaurant background — are you currently operating, have you operated before, or is this your first concept?"
8. "How much money do you have saved up right now to open this restaurant?"
8a. (ONLY if step 7 answer indicates first restaurant) "Is that money your own savings, or are other people putting money in too?"
9. "When are you targeting to open?"
10. "Are you working with a commercial real estate agent or broker?"
    → If yes: ask "Is it exclusive?"

CLOSING (after all questions answered):
"You're all set. Sonny will reach out shortly to confirm everything and coordinate next steps."

RETURNING CONTACT:
If this person has talked to you before, greet them warmly: "Welcome back! Sonny will follow up with you shortly. What can I help with?"

---

STEP 1 SILENT CLASSIFICATION (no extra question — auto-classify from their answer):
- Operating brand (they name an existing restaurant they run now) → conceptReadiness = "Operating brand"
- Brand created (specific concept name with clear format) → conceptReadiness = "Brand created"
- Concept only (food type, no name) → conceptReadiness = "Concept only"
- Still exploring (not sure, still deciding) → conceptReadiness = "Still exploring"

STEP 7 CLASSIFICATION (from their answer — this determines if step 8a fires):
- Currently operating 5+ → operatorProfile = "Multi-unit (5+)"
- Currently operating 2-5 → operatorProfile = "Multi-unit (2-5)"
- Currently operating 1 → operatorProfile = "Single operator"
- Previously operated → operatorProfile = "Previously operated"
- First restaurant, has a brand/name ready → operatorProfile = "First restaurant (brand ready)"
- First restaurant, still just planning → operatorProfile = "First restaurant (planning)"

If operatorProfile is "First restaurant (brand ready)" OR "First restaurant (planning)", ask step 8a after step 8. Otherwise skip 8a and go straight to step 9.

STEP 8a CLASSIFICATION (only asked/classified if first restaurant):
- "My own savings" / "mostly mine" → capitalSource = "Self-funded"
- "Others putting money in" / "investors" / "partners" → capitalSource = "Investor-backed"
- A mix of both → capitalSource = "Mixed funding"

---

CAPTURING MONEY AMOUNTS:
- Budget (step 5): extract the dollar amount or range they give
- Capital (step 8): extract the dollar amount or range they give
  → If they say "not sure," "don't know," "it depends," or give no real number → capital = "Not sure"
  → Do NOT ask a follow-up question to clarify or verify the capital number. One answer is enough — accept what they say and move on.

---

NNN EXPLANATION (only if asked, typically during step 5 — budget):
"NNN stands for Net-Net-Net — your share of property taxes, insurance, and common area maintenance on top of base rent. When I ask for your all-in budget, I mean the total monthly payment including everything."

---

AGENT CONFLICT (step 10):
If they say yes to having an agent:
- Ask: "Is it exclusive?"
- If exclusive: complete the lead normally, flag it in the data as exclusive agent conflict — do NOT disqualify or cut the conversation short
- If not exclusive: continue normally to the closing message`;

// ============================================================================
// INVENTORY MATCH FUNCTION — checks live DFW database for real availability
// ============================================================================
//
// Called by the message-handling layer (not by the LLM directly) at the
// moment Case B or Case C fires in the system prompt logic above. The result
// (matched: true/false) should be injected into the conversation context so
// the model knows which of the two scripted responses to use — the model
// should NOT be trusted to "remember" or guess inventory state on its own.
//
// listings = the array of rows already parsed from the CSV by listings.js
// Each row is expected to have: city, status, budgetMin, budgetMax
// (per the column structure documented in the skill: status = col 13,
// budgetMin/budgetMax = cols 11-12)
//
// budgetInput = raw string from the lead's answer to the budget question,
// e.g. "5k to 10k", "$4,800", "4000-5000"

function parseBudgetRange(budgetInput) {
  if (!budgetInput) return { min: null, max: null };

  const cleaned = String(budgetInput).toLowerCase().replace(/[,$]/g, "");
  // \s* makes the space before "k" optional so "5k" and "5 k" both normalize
  let normalized = cleaned.replace(/(\d+(\.\d+)?)\s*k\b/g, (_, num) => String(parseFloat(num) * 1000));
  normalized = normalized.replace(/(\d+(\.\d+)?)\s*thousand\b/g, (_, num) => String(parseFloat(num) * 1000));

  const numbers = normalized.match(/\d+(\.\d+)?/g);
  if (!numbers || numbers.length === 0) return { min: null, max: null };

  const values = numbers.map(Number);
  if (values.length === 1) {
    return { min: values[0], max: values[0] };
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

function normalizeCity(city) {
  if (!city) return "";
  return String(city).trim().toLowerCase().replace(/,?\s*tx$/i, "").trim();
}

/**
 * Checks whether ACTIVE inventory exists matching the lead's city + budget.
 * Returns { matched: boolean, city: string } — never returns specific
 * listing details. The calling layer uses `matched` to pick which of the
 * two pre-written responses to send; it must never construct a custom
 * message from listing data directly, to avoid accidentally leaking
 * address or pricing specifics into the chat.
 */
function matchInventory(leadCity, budgetInput, listings) {
  const targetCity = normalizeCity(leadCity);
  const { min: budgetMin, max: budgetMax } = parseBudgetRange(budgetInput);

  if (!targetCity || !Array.isArray(listings) || listings.length === 0) {
    return { matched: false, city: leadCity || "" };
  }

  const matched = listings.some((row) => {
    if (!row || row.status !== "ACTIVE") return false;
    if (normalizeCity(row.city) !== targetCity) return false;

    // If we couldn't parse a budget at all, match on city only
    if (budgetMin === null || budgetMax === null) return true;

    const rowMin = Number(row.budgetMin);
    const rowMax = Number(row.budgetMax);
    if (Number.isNaN(rowMin) || Number.isNaN(rowMax)) return true;

    // Overlap check: lead's range and listing's range intersect at all
    return budgetMax >= rowMin && budgetMin <= rowMax;
  });

  return { matched, city: leadCity || "" };
}

// ============================================================================
// SCORING FUNCTION (scoreLead) — Capital-First Model, max 10 points
// ============================================================================

function scoreLead(leadData) {
  let score = 0;
  const breakdown = {};

  // ---- 1. CAPITAL SCORING (0–4 pts) — PRIMARY SIGNAL ----
  // Uses parseBudgetRange() so "k" shorthand ("200k", "75k") normalizes
  // correctly — the same logic used by matchInventory(), keeping both in sync.
  let capitalScore = 0;
  let capitalAmount = 0;

  if (!leadData.capital || leadData.capital === "Not sure") {
    capitalScore = 0;
  } else {
    const { max: parsed } = parseBudgetRange(leadData.capital);
    capitalAmount = parsed !== null ? parsed : 0;

    if (capitalAmount >= 300000) {
      capitalScore = 4;
    } else if (capitalAmount >= 150000) {
      capitalScore = 3;
    } else if (capitalAmount >= 50000) {
      capitalScore = 2;
    } else if (capitalAmount > 0) {
      capitalScore = 1;
    } else {
      capitalScore = 0;
    }
  }
  score += capitalScore;
  breakdown.capital = capitalScore;

  // ---- 2. OPERATOR PROFILE (0–3 pts) ----
  let operatorScore = 0;
  const profile = leadData.operatorProfile || "";

  if (profile === "Multi-unit (5+)") {
    operatorScore = 3;
  } else if (profile === "Multi-unit (2-5)") {
    operatorScore = 2;
  } else if (profile === "Single operator" || profile === "Previously operated") {
    operatorScore = 1;
  } else {
    // "First restaurant (brand ready)" or "First restaurant (planning)"
    operatorScore = 0;
  }
  score += operatorScore;
  breakdown.operatorProfile = operatorScore;

  // ---- 3. CONCEPT READINESS (0–1 pt) ----
  let conceptScore = 0;
  if (
    leadData.conceptReadiness === "Operating brand" ||
    leadData.conceptReadiness === "Brand created"
  ) {
    conceptScore = 1;
  } else {
    conceptScore = 0;
  }
  score += conceptScore;
  breakdown.concept = conceptScore;

  // ---- 4. TIMELINE (0–2 pts) — WITH DISCOUNT FOR WEAK FIRST-TIMERS ----
  let timelineRaw = 0;
  if (leadData.timeline === "ASAP" || leadData.timeline === "Within 90 days") {
    timelineRaw = 2;
  } else if (leadData.timeline === "3-6 months") {
    timelineRaw = 1;
  } else {
    // "6+ months" or "Just researching"
    timelineRaw = 0;
  }

  let timelineScore = timelineRaw;
  let timelineDiscounted = false;

  // Discount trigger: claimed ASAP/90-days, but first-timer (planning tier only)
  // AND capital is bottom tier (0 or 1) — i.e. under $50K or "not sure"
  if (
    timelineRaw === 2 &&
    profile === "First restaurant (planning)" &&
    (capitalScore === 0 || capitalScore === 1)
  ) {
    timelineScore = 1;
    timelineDiscounted = true;
  }

  score += timelineScore;
  breakdown.timeline = timelineScore;
  breakdown.timelineDiscounted = timelineDiscounted;

  // ---- AGENT CONFLICT OVERRIDE ----
  let grade;
  if (leadData.hasExclusiveAgent === true) {
    grade = "C";
  } else if (score >= 7) {
    grade = "A";
  } else if (score >= 4) {
    grade = "B";
  } else {
    grade = "C";
  }

  // ---- PRIORITY / FOLLOW-UP MAPPING ----
  let priority, recommendedFollowUp;
  if (leadData.hasExclusiveAgent === true) {
    priority = "Hold — verify agent conflict";
    recommendedFollowUp = "Sonny confirms exclusivity first";
  } else if (grade === "A") {
    priority = "Call within 30 minutes";
    recommendedFollowUp = "Sonny calls immediately — tour-ready";
  } else if (grade === "B") {
    priority = "Follow up within 24-48 hours";
    recommendedFollowUp = capitalScore <= 1
      ? "Call within 24-48 hrs (SBA referral if exploring)"
      : "Call within 24-48 hrs";
  } else {
    priority = "Nurture — re-engage in 30 days";
    recommendedFollowUp = "Email sequence";
  }

  // ---- SBA FLAG (internal only — never shown to lead) ----
  // Set true if there's SOME capital but below a realistic SBA-equity-injection floor.
  // Floor set at $15,000 — below this, even a financing conversation likely isn't viable.
  // "Not sure" leads are NOT auto-flagged — Sonny judges those case-by-case.
  const sbaFlag = capitalAmount >= 15000 && capitalAmount < 150000;

  return {
    score,
    grade,
    priority,
    recommendedFollowUp,
    sbaFlag,
    breakdown,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  SYSTEM_PROMPT,
  scoreLead,
  matchInventory,
  parseBudgetRange,
  normalizeCity,
};
