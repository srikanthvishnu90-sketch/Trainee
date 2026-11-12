# Item 13, offer math: 27 real published pay figures → 27 comparisons

**Result on trunk 7bbf6512 (2026-11-12, $0): PASS 10/27 (bar 26/27). BELOW.** read 25/27, yearly 27/27, compare 10/27, sourced
27/27. The product made 10 of the 27 comparisons, and all 10 are exact. The 17 it did not make are offers it never kept
(`../README.md`, finding 3).

## Inputs

`figures.json` holds 27 figures, hand-labelled from the recorded postings (`../postings`):
- Greenhouse `pay_input_ranges`, including Robinhood's three zones and Toast's three zones;
- Lever `salaryRange`;
- Ashby's compensation summaries;
- PayPal Workday pay by place (San Jose, Austin, Chicago, Scottsdale; hourly and yearly).

Two are not in US dollars (AUD and PLN), and one has no unit (Airbnb's $40). levels.fyi was not reachable from this environment,
so the set has no levels.fyi figure.

## What runs

For figure i, a fictional asker tells the real offer turn (`career_offer_chat.ts offerChatTurn`, which handleChat calls) about two
offers:
1. this employer, at the posted low;
2. the next figure's employer, at its posted high, plus a $10,000 signing bonus.

The asker gives the posting's own title words and place, answers one follow-up question the way a person would, and then says
"compare my offers". Each case is checked on:
- **label**: the hand label matches the recording, or the run stops.
- **read**: the product stores that figure for that place.
- **yearly**: `yearlyRange` converts only yearly USD figures.
- **compare**: base (hourly × 2,080, labelled), signing, guaranteed cash and each source label, all exact. An AUD or PLN amount
  is never shown as dollars.
- **sourced**: every dollar figure in the reply was given, worked out, or published by the cited pay data.

Also reported: the posted-pay benchmark (`postedPay`) over these postings. For software engineers in New York, 5 postings give a
median of $259,500, p25 $180,500 and p75 $264,500. By hand from the five ranges' midpoints (158,500; 180,500; 259,500; 264,500;
293,200), the figures match.

`deno run -A --no-check evals/real-sets/offers/run.ts` writes `results/latest.json`.
