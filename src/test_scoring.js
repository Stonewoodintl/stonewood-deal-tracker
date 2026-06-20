// test_scoring.js — Phase 1.2 scoring unit tests
// Run with: node src/test_scoring.js

const { scoreLead, parseBudgetRange, matchInventory } = require('./claude.js');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ============================================================================
// SCORING TESTS
// ============================================================================

console.log("\n=== TEST 1: Suraj-pattern (first-timer, no capital, claims ASAP) ===");
const t1 = scoreLead({
  capital: "Not sure",
  operatorProfile: "First restaurant (planning)",
  conceptReadiness: "Concept only",
  timeline: "ASAP",
  hasExclusiveAgent: false,
});
console.log(JSON.stringify(t1, null, 2));
assert("score = 1",             t1.score, 1);
assert("grade = C",             t1.grade, "C");
assert("timeline discounted",   t1.breakdown.timelineDiscounted, true);
assert("timeline score = 1",    t1.breakdown.timeline, 1);
assert("sbaFlag = false",       t1.sbaFlag, false);

console.log("\n=== TEST 2: Bernardo-pattern (multi-unit, $350K, ASAP) ===");
const t2 = scoreLead({
  capital: "$350,000",
  operatorProfile: "Multi-unit (2-5)",
  conceptReadiness: "Operating brand",
  timeline: "ASAP",
  hasExclusiveAgent: false,
});
console.log(JSON.stringify(t2, null, 2));
assert("score = 9",             t2.score, 9);
assert("grade = A",             t2.grade, "A");
assert("capital = 4",           t2.breakdown.capital, 4);
assert("no discount",           t2.breakdown.timelineDiscounted, false);
assert("sbaFlag = false",       t2.sbaFlag, false);

console.log("\n=== TEST 3: Well-funded first-timer ($300K, ASAP — no discount) ===");
const t3 = scoreLead({
  capital: "$300,000",
  operatorProfile: "First restaurant (planning)",
  conceptReadiness: "Concept only",
  timeline: "ASAP",
  hasExclusiveAgent: false,
});
console.log(JSON.stringify(t3, null, 2));
assert("score = 6",             t3.score, 6);
assert("grade = B",             t3.grade, "B");
assert("no discount (cap=4)",   t3.breakdown.timelineDiscounted, false);
assert("timeline = 2",          t3.breakdown.timeline, 2);

console.log("\n=== TEST 4: Brand-ready first-timer ($20K, ASAP — no discount by design) ===");
const t4 = scoreLead({
  capital: "$20,000",
  operatorProfile: "First restaurant (brand ready)",
  conceptReadiness: "Brand created",
  timeline: "ASAP",
  hasExclusiveAgent: false,
});
console.log(JSON.stringify(t4, null, 2));
assert("score = 4",             t4.score, 4);
assert("grade = B",             t4.grade, "B");
assert("no discount (wrong tier)", t4.breakdown.timelineDiscounted, false);
assert("timeline = 2",          t4.breakdown.timeline, 2);
assert("sbaFlag = true",        t4.sbaFlag, true);

console.log("\n=== TEST 5: Exclusive agent override (score 10 → grade C) ===");
const t5 = scoreLead({
  capital: "$500,000",
  operatorProfile: "Multi-unit (5+)",
  conceptReadiness: "Operating brand",
  timeline: "ASAP",
  hasExclusiveAgent: true,
});
console.log(JSON.stringify(t5, null, 2));
assert("score = 10",            t5.score, 10);
assert("grade = C (override)",  t5.grade, "C");
assert("priority = Hold",       t5.priority, "Hold — verify agent conflict");

console.log("\n=== TEST 6: SBA flag boundaries ===");
assert("$10K → false",  scoreLead({capital: "$10,000",  operatorProfile: "First restaurant (planning)", conceptReadiness: "Concept only", timeline: "6+ months", hasExclusiveAgent: false}).sbaFlag, false);
assert("$15K → true",   scoreLead({capital: "$15,000",  operatorProfile: "First restaurant (planning)", conceptReadiness: "Concept only", timeline: "6+ months", hasExclusiveAgent: false}).sbaFlag, true);
assert("$149K → true",  scoreLead({capital: "$149,000", operatorProfile: "First restaurant (planning)", conceptReadiness: "Concept only", timeline: "6+ months", hasExclusiveAgent: false}).sbaFlag, true);
assert("$150K → false", scoreLead({capital: "$150,000", operatorProfile: "First restaurant (planning)", conceptReadiness: "Concept only", timeline: "6+ months", hasExclusiveAgent: false}).sbaFlag, false);
assert("unsure → false", scoreLead({capital: "Not sure", operatorProfile: "First restaurant (planning)", conceptReadiness: "Concept only", timeline: "6+ months", hasExclusiveAgent: false}).sbaFlag, false);

console.log("\n=== TEST 7: 'k' shorthand capital parsing (the bug fix) ===");
assert("'200k' → capitalScore 3",  scoreLead({capital: "200k",  operatorProfile: "Single operator", conceptReadiness: "Concept only", timeline: "ASAP", hasExclusiveAgent: false}).breakdown.capital, 3);
assert("'75k' → capitalScore 2",   scoreLead({capital: "75k",   operatorProfile: "Single operator", conceptReadiness: "Concept only", timeline: "ASAP", hasExclusiveAgent: false}).breakdown.capital, 2);
assert("'20k' → capitalScore 1",   scoreLead({capital: "20k",   operatorProfile: "Single operator", conceptReadiness: "Concept only", timeline: "ASAP", hasExclusiveAgent: false}).breakdown.capital, 1);
assert("'about 350k' → capitalScore 4", scoreLead({capital: "about 350k", operatorProfile: "Single operator", conceptReadiness: "Concept only", timeline: "ASAP", hasExclusiveAgent: false}).breakdown.capital, 4);

console.log("\n=== TEST 8: parseBudgetRange ===");
assert("'5k'",           parseBudgetRange("5k"),           { min: 5000,  max: 5000  });
assert("'5 k'",          parseBudgetRange("5 k"),          { min: 5000,  max: 5000  });
assert("'5k to 10k'",    parseBudgetRange("5k to 10k"),    { min: 5000,  max: 10000 });
assert("'$4,800'",       parseBudgetRange("$4,800"),       { min: 4800,  max: 4800  });
assert("'4000-5000'",    parseBudgetRange("4000-5000"),    { min: 4000,  max: 5000  });
assert("'2 thousand'",   parseBudgetRange("2 thousand"),   { min: 2000,  max: 2000  });
assert("empty string",   parseBudgetRange(""),             { min: null,  max: null  });
assert("null",           parseBudgetRange(null),           { min: null,  max: null  });

console.log("\n=== TEST 9: matchInventory ===");
const listings = [
  { city: "Plano",        status: "ACTIVE",   budgetMin: 4000,  budgetMax: 6000  },
  { city: "Plano",        status: "INACTIVE", budgetMin: 3000,  budgetMax: 5000  },
  { city: "Frisco",       status: "ACTIVE",   budgetMin: 7000,  budgetMax: 10000 },
  { city: "Dallas, TX",   status: "ACTIVE",   budgetMin: 5000,  budgetMax: 8000  },
];
assert("Plano $5k match",         matchInventory("Plano",       "5k",          listings), { matched: true,  city: "Plano"       });
assert("Plano INACTIVE skipped",  matchInventory("Plano",       "4k",          listings), { matched: true,  city: "Plano"       });
assert("Plano $10k no overlap",   matchInventory("Plano",       "$10,000",     listings), { matched: false, city: "Plano"       });
assert("Dallas TX normalized",    matchInventory("Dallas, TX",  "6k",          listings), { matched: true,  city: "Dallas, TX"  });
assert("Frisco match",            matchInventory("Frisco",      "8k to 10k",   listings), { matched: true,  city: "Frisco"      });
assert("Allen no listing",        matchInventory("Allen",       "5k",          listings), { matched: false, city: "Allen"       });
assert("empty listings → false",  matchInventory("Plano",       "5k",          []),       { matched: false, city: "Plano"       });
assert("no city → false",         matchInventory("",            "5k",          listings), { matched: false, city: ""            });

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
