# Improvement Roadmap — v10 (2026-08-06) — from the first real performance evaluation

v10 does not come from a forensics pass over the *plumbing*. v9 fixed the
plumbing. v10 comes from finally asking the question the app was built to
answer: **has any of this actually worked?** The `/performance` backtest,
re-run 2026-08-06 against 1,545 score events over 55 tickers spanning
2026-06-13 → 2026-08-06, plus 16 closed trades and 83 matured setups, says:
**risk control works, selection has not yet demonstrated forward edge, and the
score is mostly a restatement of trailing momentum.**

The single most important measurement, score calibration by band
(SPY-adjusted abnormal return):

| band | pre [-5,0] | post [0,+5] | post [0,+20] |
|---|---|---|---|
| Buy (7–9) | **+3.00%** · t=**8.68** | −0.58% · t=−1.48 | +2.48% · t=1.49 *(n=25)* |
| Watch/Hold (5–7) | +0.13% · t=0.68 | −0.37% · t=−1.71 | −2.18% · t=−3.05 |
| Avoid (3–5) | **−5.16%** · t=**−11.81** | −0.90% · t=−1.79 | **−9.49%** · t=**−6.16** |

Read the t-statistics, not the percentages. **Backward, the score is
overwhelmingly significant (|t| up to 11.8). Forward at 5 days, nothing is
significant and the ordering is inverted — "Buy" (−0.58%) does worse than
"Hold" (−0.37%).** At 20 days the ordering is correct and monotonic, but only
the *downside* is statistically solid: Avoid at t=−6.16 on n=102 is a real
finding, while Buy at t=1.49 on n=25 is not yet distinguishable from noise.

**The honest one-line summary: today this is a reliable "what to avoid"
detector and an unproven "what to buy" detector.** That is genuinely useful —
it just is not what the recommendation ladder claims.

Everything below follows from that, and each item names the measurement it
came from. **Caveats that apply to all of it:** the sample is eight weeks in a
single mild-uptrend regime (SPY +1.84% over the window), post20 windows only
mature for events before ~2026-07-09, and 16 closed trades is a small sample.
None of this is a verdict on the strategy; it is a verdict on what has been
*demonstrated* so far.

## v10 — Tier 1: the score cannot say what it claims

- [x] **66. Two of the five recommendation bands are unreachable** *(DONE
  2026-08-14 — Colby chose option (b), widen the compressed components)*
  **Confirmed the arithmetic before changing anything:** `riskScore` started at
  7 and was almost purely subtractive (hard max **7.5**); `valuationScore` was a
  flat lookup returning only {4.5, 6, 7} (hard max **7.0**). Blending every
  component's observed maximum gave **7.46** — so "Strong Buy Candidate" (≥9)
  was not rare, it was *arithmetically impossible*. It has never fired because
  it could not.
  **Fix:** both components are now two-sided. `riskScore` keeps its base of 7
  and all existing penalties, and *adds* +0.5 / +1.5 tiers for genuinely low
  ATR%, +0.5 for holding near the 52-week high; `valuationScore` adds +1.5 when
  a 15–50% discount is already recovering (the value sweet spot). Ceiling is now
  9.5 / 8.5 respectively.
  **A first attempt was measured and reverted:** re-basing `riskScore` to a
  neutral 5.5 (the textbook "two-sided" shape) pushed the *median* stock down,
  because real holdings cluster at 2.5–4% ATR — Buy Candidate 17 → 7 and
  Watch/Hold 29 → 40 across the live watchlist, with the spread *tightening*
  (sd 1.05 → 0.96). It made the compression worse. Keeping the base at 7 and
  adding only upside is what actually worked; a comment in `riskScore` records
  this so it is not "simplified" back.
  **Measured (A/B on identical inputs — the first comparison against stored
  scores was confounded by live quotes and earnings nudges):** 36 of 54 tracked
  tickers scored higher, **0 lower**, spread widened (sd 0.77 → 0.86), ceiling
  7.0 → 7.7, Buy Candidate 2 → 8, Watch/Hold 46 → 40.
  **Strong Buy is still empty — and that is now the correct answer:** nothing on
  the current watchlist is excellent on every axis. A unit test
  (`blending each component's attainable maximum clears the 9.0 threshold`)
  pins the band as reachable so this cannot silently regress.
  **Known remaining limiter, see #67:** with catalysts present, `catalyst` (0.25)
  and `sentiment` (0.10) still sit near 5.6–6.6 in real data and cap the blend
  around 8.3. The no-catalyst path (weights redistributed) reaches 9.19. Until
  #67 lands, a 9 is realistically only attainable for a ticker with no tracked
  catalysts — which is backwards, and is the strongest argument for doing #67.

<details><summary>Original #66 entry (pre-fix, kept for the record)</summary>

- [ ] **66. Two of the five recommendation bands are unreachable** *(medium —
  needs a decision from Colby before any code moves, because it changes every
  number he looks at)*
  **Why:** in **26,667 score rows the app has never once produced a score of
  8, let alone 9.** All-time min 2.8, max **7.7**, mean 6.10. So
  "Strong Buy Candidate" (9–10) has **zero events, ever**, and "Strong Avoid"
  (1–3) has 44 rows out of 26,667. A five-band ladder is doing the work of
  three.
  This is structural, not a data accident. The components have wildly
  different achievable ranges, and the two carrying the most weight are the
  most compressed:

  | component | weight | observed min–max | max swing it can contribute |
  |---|---|---|---|
  | momentum | 0.20 | 1.5 – **9.5** | 1.60 |
  | risk | 0.25 | 1.5 – 7.5 | 1.50 |
  | catalyst | **0.25** | 3.79 – **6.66** | 0.72 |
  | valuation | 0.20 | 4.5 – 7.0 | 0.50 |
  | sentiment | 0.10 | 4.36 – **6.22** | **0.19** |

  Best case ≈ 7×0.2 + 9.5×0.2 + 6.66×0.25 + 7.5×0.25 + 6.22×0.1 ≈ **7.46**,
  which is exactly where the observed 7.7 ceiling sits (the small excess comes
  from the no-catalyst weight redistribution and the earnings nudge).
  **Two consequences worth separating:**
  1. The ladder is miscalibrated — bands should map onto the distribution the
     scorer actually produces.
  2. **`momentum` is the only component with real dynamic range**, so it
     dominates the variance — which is precisely *why* the score reads as a
     momentum mirror (pre5 t=8.68). Fixing the bands without addressing this
     would relabel the symptom.
  **What (Colby picks one):** (a) rescale/re-band so the five labels map to
  observed quantiles — smallest change, honest immediately, but purely
  cosmetic; (b) widen the compressed components so the 1–10 scale means what
  it says — bigger change, touches `catalystScore`/`sentimentScore`/
  `riskScore`; (c) drop to three bands and stop implying precision the data
  does not support. **Do not ship any of these unasked** — every score on
  every page moves.
  **Accept:** whichever is chosen, `/performance` re-run shows events
  distributed across the bands that exist, and the README's description of the
  ladder matches reality.
</details>

- [x] **67. `sentiment` earns 10% of the weight and contributes 0.19 points**
  *(DONE 2026-08-14 — but the diagnosis in the original entry was wrong)*
  **The real root cause is the INPUT, not the output range.** `catalystScore`
  already spans 1–10 mathematically. What crushed it: **6,616 of 8,991 stored
  catalysts (74%) have `impact_score = 0`**, and 6,501 of those are `yahoo-news`
  / `industry_news`. Mega-caps carry 300+ rows each (NVDA 408, MSFT 356) — a news
  feed, not a catalyst set. Because the score is a **mean**, a few real signals
  were averaged into a wall of neutral headlines: NVDA's mean impact over
  everything is **0.31** versus **1.09** over directional items alone. Widening
  the formula's range would not have touched this.
  **Two candidate aggregations were measured and rejected on evidence:**
  - *Net pressure* (`tanh` of the confidence-weighted sum): span 4.50 but
    **median 9.97, max 10.00** — with 300+ inputs any slight skew saturates it.
    Not discrimination, just a pinned needle.
  - *Strongest signal*: span 5.04 but NVDA/MSFT/META/AAPL all land on **3.61**,
    i.e. a single medium-confidence −3 headline defines the score. Too fragile.
  **What shipped:** `directionalCatalysts()` — the SCORING feed drops impact-0
  items and keeps only the most recent 30. The display timeline is unchanged, so
  nothing disappears from the stock page. Catalyst gain 0.9 → 1.6 to express the
  now-undiluted average. `sentiment` weight → **0** (folded into catalyst, which
  goes 0.25 → **0.35**); it is still computed and displayed, labelled as not
  blended, since it is derived from the same inputs and was ~collinear. Also:
  `hasCatalysts` now means *has directional catalysts*, so a ticker with 300
  neutral headlines redistributes the catalyst weight instead of being dragged to
  a false neutral.
  **Measured — catalyst component influence 0.27 → 1.25 points** (span 1.09 →
  3.58 across the tracked universe), which was the point of the item.
  **A/B on identical inputs (54 tracked tickers):** max 7.2 → **8.1**, sd 0.84 →
  **0.95**, Buy Candidate 8 → 23, Watch/Hold 40 → 27, raised 51 / lowered 1.
  **Reported honestly: this both decompresses AND shifts the level up.** 51 of 54
  rising is the removal of a systematic downward bias (neutral news pinning every
  catalyst score near 5.5), not evidence of better discrimination. See #67b.
  **The original acceptance criterion was arithmetically impossible** — "every
  component can move a score across a band boundary" needs span ≥ 2/weight = 8.0
  at weight 0.25. No component in a weighted blend of five can do that. Replaced
  with the influence-in-points measure used above.

- [ ] **67b. The Buy band now holds 43% of the watchlist — recalibrate on forward
  returns, not on shape** *(medium; the natural successor to #66 and #67)*
  **Why:** #66 and #67 both widened the score, and both were validated on
  *distribution* (spread, ceiling, band occupancy) rather than on whether the new
  scores predict anything. After #67, 23 of 54 tracked tickers sit in "Buy
  Candidate" versus 8 before. That may be correct — the old scores were
  artificially neutral — or the bands may simply need to move. Distribution shape
  cannot answer it.
  **What:** re-run the score-calibration event study once the post-#66/#67 scores
  have 20 trading days of forward data, and set the band thresholds so each band
  actually separates forward abnormal returns. This is the change that would make
  the ladder mean something empirically rather than by construction.
  **Accept:** band boundaries chosen from measured forward returns, with the
  supporting table recorded here — and an explicit note if the data does not
  support five bands.

<details><summary>Original #67 entry (the diagnosis that turned out to be wrong)</summary>

- [ ] **67. `sentiment` earns 10% of the weight and contributes 0.19 points**
  *(small — measure, then probably cut or merge)*
  **Why:** across all 26,667 rows `sentiment_score` spans **4.36 → 6.22**. At
  weight 0.10 that is a maximum swing of **0.19 points** on a 1–10 scale — it
  cannot change a recommendation band under any circumstance. It is
  effectively a constant that costs a fetch and a slot in the reasoning.
  `catalyst` is nearly as bad: span 2.87 at weight 0.25 = 0.72 points, the
  largest weight in the blend buying the third-smallest influence.
  **What:** confirm the spans hold when computed per-ticker rather than
  pooled, then either widen the component's output range or fold sentiment
  into catalyst and redistribute its weight. Coordinate with #66 — same root
  cause, and doing them separately would move every score twice.
  **Accept:** every component in the blend can move a score across at least
  one band boundary, or it is not in the blend.
</details>

## v10 — Tier 2: the setup detector has one bad type

- [x] **68. `breakout` setups lose money; two other types carry the whole
  result** *(DONE 2026-08-14 — root-caused and fixed; it was not a tuning
  problem, the detector could never fire on an actual breakout)*
  **Root cause:** `supportResistance` defines `resistance` as the nearest swing
  high **strictly above** price (`highs.filter(h => h > price)`), so the moment
  price clears a level the next level up becomes "resistance". `detectBreakout`
  keyed off it, so its `price >= resistance * 0.99` test only ever meant
  "price has climbed to within 1% below a ceiling" — an *approaching*-resistance
  detector wearing a breakout's name. Its `price <= resistance * 1.03` clause
  was dead code (price can never exceed resistance). Verified against all 616
  stored breakout rows: `entry_range_low > entry_range_high` never occurs, i.e.
  price was below resistance at every single detection. Most approaches to
  resistance get rejected — that is what makes it resistance — so a ~10% win
  rate is the expected outcome, not an anomaly.
  **Fix:** added `clearedHigh` (highest swing high price has *cleared*) to
  `IndicatorSnapshot`; `detectBreakout` now requires a fresh crossing (a close
  at or below the level within the prior 5 bars), price still within 5% of it
  (not chasing an extended move), and volume ≥1.3× average as a hard gate
  rather than a quality nudge. Stop anchors below the broken level; targets are
  measured from the entry **mid** rather than `entryHigh`, so the advertised
  R/R matches what the resolver actually fills at.
  **Measured (replay over 288 tickers of real bars, same resolver, old logic
  run as a control on identical data):**

  | | matured | win rate | avg R |
  |---|---|---|---|
  | breakout, old detector | 2,634 | 23.2% | +0.04 |
  | **breakout, new detector** | **2,568** | **38.3%** | **+0.10** |

  (The 9.5% in the live report was the same defect on a 40-setup sample; over
  full history the old detector ran 23.2%.) Volume confirmation alone was tested
  first and **disproven** as the fix — the volume-confirmed subset of the live
  sample went 0-for-4. `setupDetection.ts` had no unit tests at all, which is how
  this survived; there is now a `setupDetection.test.ts` pinning both directions
  (fires on a real break, does *not* fire on an approach).
  **Also tried and rejected on evidence:** `ma_reclaim` (20% win rate) looked
  like it was catching bull traps — reclaims of a *falling* 50-SMA. Filtering
  those halved the sample (1,922 → 1,067 matured) for an **unchanged 35.5% win
  rate**, so the filter was not shipped; a comment in `detectMaReclaim` records
  the measurement so it is not re-added. The genuine bug there — comparing
  4–6-bar-old closes against *today's* 50-SMA instead of the average as of those
  bars — was fixed, but it is outcome-neutral (35.2% vs 35.5%, inside noise).

- [ ] **68b. Re-measure `breakout` once the new detector has a matured sample**
  *(small — 2026-09 at the earliest)*
  **Why:** the 38.3% above is a historical replay. The live `/performance`
  breakout row still shows the old detector's 40 matured setups and will pool
  both definitions until those age out; a dated note now says so on the page
  (`BREAKOUT_DETECTOR_CHANGED_ON` in `signalPerformance.ts`). Colby chose to keep
  the 616 old rows rather than purge them — real data, real history.
  **Accept:** a breakout row built only from detections after 2026-08-14, held
  against the 38.3% / +0.10R the replay predicts.

- [x] **68c. `expired` is the largest single setup outcome** *(MEASURED
  2026-08-14 — the premise was backwards; expiry is not a defect)*
  **The question:** 44 of 111 triggered setups expire without touching target or
  stop inside 20 days. Is the target too far, or the horizon too short?
  **Method:** replayed the current detectors over 288 tickers (11,266 episodes),
  then re-resolved the *same* setups under different target multiples and
  horizons. **Expectancy (avg R over triggered) is the decider** — a nearer
  target wins more often but wins less, so win rate alone would mislead.

  | target | horizon | win rate | expired | **avg R** |
  |---|---|---|---|---|
  | 1R | 20d | 54.2% | 13.1% | 0.014 |
  | 1.5R | 20d | 43.0% | 21.0% | 0.032 |
  | **2R (current)** | **20d** | **34.4%** | **28.2%** | **0.059** |
  | 2.5R | 20d | 27.4% | 33.9% | 0.086 |
  | 3R | 20d | 22.1% | 37.7% | 0.108 |
  | 2R | 40d | 37.4% | 11.8% | 0.076 |
  | 3R | 40d | 27.4% | 19.2% | **0.143** |

  **Expectancy rises monotonically with target distance.** Pulling targets in to
  "fix" expiry would raise the win rate and *lower* the return — the exact trap of
  optimising the comfortable metric. Every setup type measured worse at 1.5R than
  at 2R, and `pullback_to_support` went **negative** (+0.014 → −0.011). n=9,968
  triggered, so this is not a small-sample artifact.
  **The real constraint is the horizon, not the target.** The same setups at 40
  days expire 11.8% instead of 28.2% and return 0.076R instead of 0.059R (+29%).
  **What shipped:** a `/performance` note stating this whenever expiry exceeds
  20% of triggered setups, so neither Colby nor a future session "fixes" expiry by
  shortening targets. `SETUP_HORIZON_DAYS` was **deliberately left at 20** —
  changing it would silently reshape every historical comparison, and 20 days
  matches the ~15-day average hold actually observed in the closed trades.
  Widening it is a strategy decision (would he really hold 40 days?), not a
  measurement tweak. See #68d.

- [ ] **68d. Decide whether the setup horizon should be 20 or 40 days** *(small,
  needs Colby — a strategy question, not a code question)*
  **Why:** #68c shows 40 days is materially better on paper (+29% expectancy at
  2R, expiry 28% → 12%). But the horizon is only a *measurement* parameter — the
  app does not enforce a time stop, so the real question is how long he is
  actually willing to hold a swing position. Realized trades average ~15 days.
  **What:** either keep 20 and accept expiry as the cost of a 2R target, or move
  to 40 and re-baseline every setup statistic (and say so on `/performance`, the
  way the breakout detector change is labelled). Reporting BOTH horizons is a
  third option and probably the most honest.

<details><summary>Original #68 entry (pre-fix, kept for the record)</summary>
  **Why:** over 83 matured setups (20-day horizon), by type:

  | type | matured | win rate | avg R |
  |---|---|---|---|
  | pullback_to_support | 16 | **55.6%** | **+0.26** |
  | momentum_continuation | 26 | 37.5% | +0.24 |
  | ma_reclaim | 11 | 20.0% | +0.05 |
  | **breakout** | **27** | **7.7%** | **−0.24** |
  | oversold_bounce | 2 | 0% | −0.17 |

  Overall 27.8% win rate, avg R **+0.07** — i.e. the whole detector is roughly
  breakeven, and it is breakeven *because* `breakout` (the joint-largest
  sample, 27 matured) drags down two types that are genuinely positive.
  `breakout` won 1 of 13 triggered trades. Separately, **31 of 67 triggered
  setups expired** without touching target or stop inside 20 days, which is a
  target/stop-distance question, not a direction question.
  **What:** with n=27 this is suggestive, not conclusive — so first re-measure
  `breakout` with the date slider across sub-periods to check it is not one
  bad fortnight. If it holds, either retune its entry (it may be buying
  extension — note its 7 no-fills, the highest of any type) or stop surfacing
  it above a quality threshold.
  **Accept:** a recorded per-period breakdown for `breakout`, and a decision
  backed by it rather than by the pooled number.
</details>

## v10 — Tier 2b: the realized-trade stats were measuring the wrong thing

- [x] **72. `thesisPlayedOut` could never be recorded, and "no" would have been
  stored as "yes"** *(DONE 2026-08-14)*
  **Why:** `/performance` showed `thesisPlayedOutRate` as null forever. The
  whole path existed — `closeTrade` accepts it, the PATCH route validated it,
  the swing page renders it — but the **close-trade form never collected it**,
  so nothing in the app could ever set the field. Worse, the route parsed it
  with `z.coerce.boolean()`, which is `Boolean(v)`: the form posts strings, so
  `"no"` and `"false"` would both have coerced to **true**. Adding the control
  naively would have silently inverted every negative answer and produced a
  thesis-played-out rate that could only ever go up.
  **Fix:** a `thesisPlayedOut` select (not recorded / yes / no) on the close
  form, and an explicit `formBoolean` parser mapping yes|y|true|1 → true,
  no|n|false|0 → false, blank → null. Five parametrised route tests pin every
  case.
  **Accept:** met — closing a trade with "no" stores `false`, and the rate
  starts accumulating from the next real close.

- [x] **73. A third of the closed-trade sample was development cleanup**
  *(DONE 2026-08-14 — Colby confirmed these were not real exits)*
  **Why:** 5 of 16 closed trades closed within ~2 minutes of each other on
  2026-06-25 (four within 12 seconds; UPS at exactly break-even with no stop
  ever set). They were a batch close during development, not exit decisions,
  and they carried the ORCL −27.3% that dominated every realized statistic.
  **Fix:** new `excluded_from_stats` / `excluded_reason` columns on
  `active_trades` (migration `0009`), honoured by `getTradePerformance`. **The
  rows are kept** — real data, real history — they are flagged, not deleted.
  **Effect on the realized numbers (11 genuine exits, was 16):**

  | | before | after |
  |---|---|---|
  | avg return | −1.86% | **+0.71%** |
  | avg R | −0.22 | **+0.00** |
  | profit factor | 1.17 | 1.42 |
  | worst | −27.3% | −8.1% |

  The honest read is now "roughly break-even on a risk-adjusted basis over 11
  trades", not "losing". Note this also changes #69/#71's inputs — **ORCL is an
  excluded trade**, so the "one −2.67R gap event" those items are built on is no
  longer part of the live sample. Re-check them before acting.

## v10 — Tier 2c: seeing and exiting your open positions

- [x] **74. Open trades on the stock page, and a one-click broker exit**
  *(DONE 2026-08-14 — Colby's request, design approved before build)*
  **Why:** landing on a ticker you actually hold showed only a score, a
  recommendation badge and a P/L percentage — not entry, stop, target or share
  count. Worse, the page used `openTrades().find(t => t.ticker === ticker)`, so
  a ticker with **more than one open trade silently displayed only the first**
  (TSLA has carried three at once). And there was no way to exit a position from
  the app at all: `CloseTradeButton` records a close in the *app* and leaves the
  broker holding the shares.
  **The non-obvious part — an exit is not just a sell.** 7 of 8 open trades were
  placed as **bracket** orders, so their stop and take-profit legs rest at Alpaca
  as live orders against the same shares. Selling underneath them either gets
  rejected for insufficient quantity or fills and leaves an **orphaned stop that
  can later execute and flip the account short**. `AlpacaService` could read legs
  but had **no cancel method at all**.
  **What shipped:**
  - `AlpacaService.cancelOrder` (DELETE `/v2/orders/{id}`, **404 counts as
    success** — an already-filled leg is the desired end state, and erroring
    there would abort an exit halfway) and `openOrdersFor(symbol)`.
  - `src/services/tradeExit.ts` — `exitOrderRequest` (a long closes by selling, a
    short by buying back, and **never** carries protective legs, which would open
    a fresh position instead of flattening this one), `planExit` /
    `planHoldingExit` pre-flight checks, and `exitTradeAtBroker`, which sequences
    cancel legs → market close → **poll for a real fill** → `closeTrade` at the
    actual fill price. It will not close a trade on an unfilled order, because
    that would record a fictional exit price into the realized stats.
  - **Market-closed guard:** a market order placed out of hours queues until the
    open, so the fill price is unknown and the position would sit unprotected
    overnight with its legs already cancelled. The exit refuses instead.
  - **Failure recovery:** if the legs are cancelled and the sell then fails, the
    position is briefly unprotected — strictly worse than before the click. The
    protective stop is re-placed and a **critical** alert is raised (and the
    alert says explicitly when the stop could *not* be restored).
  - `POST /api/trades/[id]/exit` and `POST /api/portfolio/[id]/exit`, both
    honouring the existing `confirmLive` gate. Holdings are a different set from
    trades — **10 of 18 holdings have no trade record** — so the portfolio route
    closes a matching open trade only when one exists and otherwise leaves the
    next portfolio sync to reconcile.
  - UI: a "Your swing trades" panel on the stock page (entry / now / shares /
    stop / target / P&L / score / action, one row per trade) and an Exit column
    on `/portfolio`. `ExitTradeButton` is **two-step** — the first click only
    arms a confirmation naming exactly what will be sold, because this sends a
    real order.
  **Verified:** 537 tests (26 new), typecheck clean, panel renders on a held
  ticker with real entry/stop/target values and is correctly absent on one with
  no position. **NOT verified end-to-end against the broker** — doing so would
  sell a real paper position, and the market was closed. See #74b.

- [x] **74c. `openOrdersFor` missed `held` bracket legs — the exact bug the exit
  design exists to prevent** *(FOUND + FIXED 2026-08-14, during the "why were my
  limits cancelled?" investigation, before any exit had run)*
  **Why:** the first cut used `/v2/orders?status=open&nested=true`. Verified
  against the live paper account, **both** query parameters drop legs:
  `nested=true` nests bracket children inside their parent so they never appear
  as top-level rows (31 orders returned nested vs **77 flat**), and — the real
  trap — **`status=open` does not return orders in `held`**, which is where a
  bracket's protective stop sits. On the live account that hid **5 stop legs**
  (AVGO, V, CVX, SCHW, MA). An exit would have cancelled only the visible target,
  sold the position, and left a live stop behind — an orphaned sell order that
  can later execute and flip the account short, which is precisely what #74's
  cancel-first sequencing was built to avoid.
  **Fix:** fetch `status=all&nested=false` and filter on an explicit
  `LIVE_ORDER_STATUSES` set that includes `held`. Verified live: AVGO and CVX now
  return 2 working orders each (limit/new + stop/held) where they returned 1.
  **Lesson:** a broker's "open" is not your definition of open. Enumerate the
  statuses you care about rather than trusting a vendor filter name.

- [ ] **74b. Confirm one real exit round-trip when the market is open** *(small
  — needs Colby, cannot be done unattended)*
  **Why:** every layer of #74 is unit- and route-tested and the market-closed
  guard was confirmed against Alpaca's live clock (`isOpen: false`, next open
  2026-08-17 09:30 ET), but no order has actually been sent through the new
  path. The untested-in-anger parts are the real leg cancellation and the fill
  poll.
  **What:** during market hours, exit **one small paper position** from the
  stock page and confirm: the resting legs disappear at Alpaca, the trade closes
  at the actual fill (not the reference price), the journal entry is created, and
  no orphan orders remain for that symbol.
  **Accept:** one clean round-trip observed, or a bug filed with the response.

- [x] **75. Stop-coverage reconciliation — detect positions with no live stop**
  *(DONE 2026-08-14)*
  **What shipped:** `src/services/stopCoverage.ts`. Pure `findStopGaps(trades,
  liveOrdersByTicker)` compares each open broker-linked trade's *recorded* stop
  against the orders actually working at the broker, classifying each gap as
  `missing_at_broker` (a stop is recorded but absent — restorable) or
  `no_stop_defined` (nothing to restore). `checkStopCoverage` does the IO in
  **one** account-wide request (`workingOrders()`, added so this does not cost a
  call per ticker on every 2-minute refresh) and emits a `stop_missing` alert per
  gap — **critical** when restorable, warning otherwise. Wired into the scheduler
  refresh path.
  **Two correctness details that matter:**
  - A stop resting in **`held`** counts as live protection. Missing that would
    cry wolf on the majority of healthy positions (5 of 8 here).
  - If the broker read **fails**, nothing is reported as unprotected. A network
    blip must never raise a critical "your position is naked" false alarm.
  - Side-aware: a short is stopped by *buying*, so a sell stop does not protect it.
  **Restoring is user-initiated**, per the app's never-trades-on-its-own rule:
  `POST /api/trades/[id]/restore-stop` places a standalone **GTC** stop (GTC
  deliberately — the legs lost on 2026-06-25 were `day` orders that expired at
  that close) and no-ops if a stop is already working. The stock page shows a ⚠
  on the stop column and a two-step **Restore stop** button, driven off the
  unacked alerts (`tickersMissingStops`) so rendering costs no API call.
  **Verified against the live account:** 8 positions checked, **3 gaps found** —
  QBTS (97 sh, recorded 15.13), LLY (1 sh, recorded 1039.45), UPS (8 sh, none
  recorded) — and correctly *not* flagged for AVGO/CVX/MA/SCHW/V whose stops rest
  in `held`. Alerts written at the right severities; the button renders on
  /stock/QBTS and not on /stock/AVGO. 546 tests.

- [ ] **75b. The restorable stops are now far from price — review before placing**
  *(small, needs Colby's judgement, not code)*
  **Why:** restoring the *recorded* stop re-places it where it was set at entry,
  which after a large move may be nowhere near a sensible level:

  | | entry | recorded stop | current | stop vs current | since entry |
  |---|---|---|---|---|---|
  | QBTS | 16.71 | 15.13 | 21.17 | **−28.5%** | +26.7% |
  | LLY | 1130.22 | 1039.45 | 1180.33 | −11.9% | +4.4% |
  | UPS | 108.53 | *none* | 104.50 | — | −3.7% |

  QBTS is the live case: it has run +26.7%, so its original stop now sits 28.5%
  below price and would give back the entire gain before triggering. That is a
  *sizing/trailing* decision, not a bug — but restoring blindly is not obviously
  right. UPS has no stop recorded at all, so it needs one chosen before anything
  can be restored.
  **What:** decide per position — restore as recorded, raise the stop first
  (edit the trade, then restore), or accept it unprotected deliberately. Relates
  to #71 (stop distance vs ATR), which is the natural place to compute a sensible
  level rather than reusing the entry-time one.

<details><summary>Original #75 entry (the audit that prompted it)</summary>

- [ ] **75. 5 of 11 positions carry no protective stop — $5,965 exposed**
  *(small–medium; found 2026-08-14 answering "why were my limits cancelled?")*
  **Why:** an audit of the live paper account against its order book:

  | position | value | live stop | live target |
  |---|---|---|---|
  | QBTS 97 sh | $2,045 | **NONE** | none |
  | BAC 20 sh | $1,290 | **NONE** | none |
  | LLY 1 sh | $1,180 | **NONE** | 1329.86 |
  | UPS 8 sh | $838 | **NONE** | none |
  | AAPL 2 sh | $612 | **NONE** | none |

  Three distinct causes, only one of which is a defect:
  1. **Normal OCO** — a bracket is one-cancels-other, so when a stop filled its
     target was cancelled and vice versa. Confirmed pair-by-pair for MSFT, AMGN,
     EIX, EXC, V, RTX, BABA, MA, AMZN, TSLA. Not a bug.
  2. **`time_in_force=day` on the 2026-06-25 orders** — their protective legs
     expired at that day's close (20:00 UTC) and were never replaced. LLY has had
     no stop since. Orders from 2026-07-06 onward use `gtc`, so this is historical.
  3. **QBTS is unexplained** — both legs cancelled 2026-07-27 at 07:03 and 08:00
     UTC (outside market hours), **neither filled**, position still held. No
     corporate action appears in account activities (only FEE rows). This is the
     one genuine anomaly and the largest unprotected position.
  **What:** the app already knows each trade's intended stop (`active_trades.
  stopLoss`) and can now both read working orders and place a standalone stop
  (`type: "stop"`, added for #74's recovery path). A reconciliation check — "open
  trade has a stop recorded but no live stop order at the broker" — could surface
  this as an alert, which is the natural home for it alongside the existing
  order-fill sync. **Detection first; do not auto-place orders.**
  **Accept:** /status or the alerts feed names every open position whose recorded
  stop has no matching live broker order, and QBTS's cause is either identified
  or explicitly recorded as unknown.
</details>

- [x] **76. Bulk "Exit all" — close the whole book in one reviewed action**
  *(DONE 2026-08-14 — Colby is closing this round out to redeploy)*
  **Why:** exiting 11 positions meant 11 separate Exit buttons and 11 separate
  confirmations. Worth one reviewed action — but it sends a real order per
  position, so the ceremony had to go *up*, not down.
  **What shipped:** `src/services/exitAll.ts` — `exitAllPositions` runs
  **sequentially** (overlapping cancel/sell cycles against one account invite
  rejections and make partial failure impossible to reason about), refuses
  entirely up front when the market is closed, and **never lets one failure abort
  the batch** — that is the whole point, since a mid-batch abort would strand the
  remaining positions half-exited. Every position gets an individual result row;
  any failures raise ONE critical summary alert naming them, because their
  bracket legs may already be cancelled.
  `POST /api/trades/exit-all` requires the literal typed phrase **"EXIT ALL"**,
  honours `confirmLive`, records an exit reason + thesis-played-out on every
  journal entry it creates (so the batch seeds the stat that was null forever —
  see #72), and re-runs the Signal Performance backtest afterwards so realized
  stats include the exits immediately. A failure to re-run the report never fails
  the exit that already happened.
  `ExitAllPanel` on `/swing` shows the full review table (ticker, shares, entry,
  now, P/L) plus the reason/thesis inputs, gates the button behind the typed
  phrase, and renders a per-position result table afterwards with failures called
  out in red.
  **Verified:** 555 tests (9 new), typecheck clean, panel renders on /swing.
  **Not exercised against the broker** — the market was closed (next open
  2026-08-17 09:30 ET) and the guard correctly refuses; #74b still covers the
  first real round-trip.

## v10 — Tier 3: exits, and the one real risk hole

- [ ] **69. Stops hold at −1R except when price gaps through them** *(small)*
  **Why:** the good news from 16 closed trades — the losses cluster
  extraordinarily tightly at exactly −1R (V −1.00, EIX −1.00, MA −1.01, EXC
  −1.01, RTX −1.02, AMZN −0.98). **Risk control is working mechanically.** The
  exceptions are the whole story: **ORCL −2.67R** (entry 209.76 → exit 152.50,
  −27.3%) and TSLA −1.26R. A stop does not protect against a gap, and one
  −2.67R event erases two and a half clean winners.
  **What:** surface gap risk where position size is chosen — the trade dialog
  already computes R/R and suggested size (#47), so it can also flag "this
  name has gapped >X% overnight N times in the last 90 days" from `price_bars`
  the app already stores. Sizing stays the user's call; this is information,
  not automation.
  **Accept:** the dialog shows a historical overnight-gap stat per ticker; no
  change to the server-side risk gate.

- [x] **70. Is the app exiting winners early?** *(MEASURED 2026-08-06 — answer:
  no, roughly a wash; but the measurement found one real thing, split out as
  #71)*
  **Measured:** for each closed trade with a stop, actual exit R vs. the R from
  holding to +20 trading days (12 of 15 comparable; 3 lack 20 forward bars).

  | | avg R |
  |---|---|
  | as actually exited | **−0.379** |
  | if held to +20 days | **−0.212** |
  | difference | **+0.168 R/trade in favour of holding** |

  **Do not act on that headline.** It is a small net of large opposing effects
  on n=12, nowhere near significant. Exiting *saved* 1.5–2.4R on the disasters
  (TSLA ×3, ORCL) and *cost* 2.9R and 4.8R on RTX and V, which were stopped out
  then reversed hard. The stop is doing its job on the left tail; it is also
  getting clipped by ordinary volatility on names that recover. Those cancel.
  **Conclusion: exit timing is not the problem, and no exit-logic change is
  justified by this data.** Re-run after another 8–12 weeks. The one concrete
  finding is #71.

- [x] **71. Flag a stop set inside the noise band** *(DONE 2026-08-14)*
  **Premise re-verified on the CURRENT sample** (after #73 excluded the
  dev-cleanup trades): across all 15 closed trades with a stop, **14 sit at
  1.49–2.12× ATR(14)** at entry. The sole outlier is still **V at 0.61×** (a
  1.43% stop against a 2.36% ATR), and V is **not** an excluded trade, so the
  finding survives. It realized −1.00R and the position then ran to +3.82R.
  **Honest limit unchanged: n=1 does not establish "tight stops lose."** What it
  establishes is that this stop sat inside a single average day's range.
  **What shipped:** pure `stopAtrMultiple(entry, stop, atr14, direction)` and
  `stopNoiseWarning(multiple)` in `riskManagement.ts` (direction-aware — a
  short's stop sits above entry; null when ATR is unknown or there is no stop
  distance). The order dialog now shows **`stop N.NN× ATR(14)`** beside the live
  R/R, amber below 1×, with a one-line explanation underneath. `atrByTicker()` in
  `lib/queries.ts` supplies it, reading only the last 30 bars per ticker.
  **`pretradeRiskProblems` is deliberately unchanged** — advisory, not a block,
  consistent with every other speed bump in the app.
  **Verified:** 564 tests (4 new), typecheck clean, and the `atr14` values reach
  the client payload on /swing and /watchlist.
  **Timing note:** this lands before Colby redeploys at Monday's open, so the
  fresh entries get the context the V trade never had.

<details><summary>Original #71 entry</summary>

- [ ] **71. Flag a stop set inside the noise band** *(small — the one
  actionable output of #70)*
  **Why:** checking every closed trade's stop distance against its 14-day ATR
  at entry, most are sized sanely at **1.6–2.5× ATR**. One was not: **V had a
  1.43% stop against a 2.36% ATR — 0.61× ATR, a stop tighter than a single
  average day's range.** It was hit almost immediately and the position then
  ran to +3.82R. That single sizing choice forgave **4.83R**, the largest
  swing of any decision in the book. (The honest limit: only 2 trades sit
  below 1.5× ATR, so "tight stops lose" is *not* established — 0/2 proves
  nothing. What is established is that this specific stop was inside the noise
  and that it was costly.)
  **What:** the trade dialog already computes live R/R and suggested size
  (#47). Add the ATR context it is missing — show stop distance as a multiple
  of 14-day ATR and warn below ~1×. `computeIndicators` already produces ATR
  and the dialog already has the bars, so this is display-layer only.
  Advisory, not a block: sizing stays the user's call, consistent with the
  server gate remaining authoritative.
  **Accept:** the dialog shows `stop = N.N× ATR(14)` and warns under 1×; no
  change to `pretradeRiskProblems`.
</details>
  **Why:** two independent hints. (1) Of 67 triggered setups, **31 expired**
  — more than won and lost combined. (2) Right now 6 of 8 open positions are
  flagged Trim or Exit, including **AVGO +11.4%** and **QBTS +16.1%**, the two
  biggest winners in the book. Meanwhile the three best closed trades ran to
  +3.18R, +3.00R and +2.05R — so when trades *are* left alone they pay for the
  −1R losers. With avg R at −0.22 realized, exit timing is where the leverage
  is.
  **Why it is only a measurement for now:** "flagged Exit while up 11%" is not
  evidence of a mistake — it may be correct de-risking. The honest test is
  whether those exits beat holding.
  **Accept:** a comparison of realized exit vs. the same position held to the
  20-day horizon, over the closed-trade history. If holding wins materially,
  open a follow-up; if not, close this and stop wondering.

**Not a code item — the standing caveat for all of v10:** every figure above
comes from **eight weeks in one market regime**. The negative findings (Avoid
band at t=−6.16, breakout at 1-for-13) rest on the larger samples and are the
more trustworthy half. The positive findings (Buy band at post20, n=25) do
not yet clear the bar. Re-run this evaluation after the next 8–12 weeks before
treating any of it as settled, and prefer the date slider (#v9 /performance)
to check whether a result is one fortnight or a pattern.

---

# Improvement Roadmap — v9 (2026-08-06)

v9 came from the post-v8 forensics pass (2026-08-06). v8 shipped 2026-07-20;
since then the runner has been up continuously and the machine stayed awake
through several full market days — the first time the system has run at its
real duty cycle. That exposed a cost nobody had measured: **the database more
than doubled in twelve days, 41 MB (07-25 backup) → 88 MB, now +13 MB per
awake market day.** `dbstat` puts **50.4 MB of the 88 MB (57%) in
`stock_scores` alone**, and the daily `VACUUM INTO` backup copies the whole
thing seven times over (`data/backups/` is already 367 MB).

Retention is not broken — it is doing exactly what it says (0 drawdown rows
past 30d, 0 snapshots past 7d, only 282 score rows past the 30d thin window).
The write path is the problem: at the market-open cadence the refresh loop
appends a **full** score row per ticker every ~2 minutes.

Measured on 2026-08-05/06 (the two full awake market days):

| table | rows/day | at steady state (retention window) |
|---|---|---|
| `stock_scores` | ~12,400 | ~372,000 (30d thin window) |
| `drawdown_metrics` | ~12,400 | ~372,000 (30d) |
| `market_price_snapshots` | ~12,400 | ~87,000 (7d) |
| `score_history` (material moves) | **9–34** | 90d |

That last row is the whole story: ~12,400 score rows a day are written to
record 9–34 actual score changes, and **every consumer reads at most one row
per ticker per day** — `latestScore()` (newest per ticker), `scoreSeries()`
(sparkline, last-per-day), `buildScoreEvents()` (Signal Performance,
last-per-day). Nothing reads intraday score resolution.

Separately, GDELT was believed dead for this use — twelve scheduled runs across
2026-07-21 → 2026-08-06 fetched **0 items every time**, the "clean window" #57
was left open to observe. **That conclusion was wrong, and #63 records why:** the
zeros came from our own connector abandoning each run on its first 429, not from
GDELT withholding data. Fixed 2026-08-06 — a live run of the exact production
shape now returns real articles.

## v9 — Tier 1: write amplification

- [x] **61. Stop appending a full `stock_scores` row every 2 minutes**
  *(small–medium — done 2026-08-06. `canUpdateLiveScoreRow` (pure, in
  `scoring.ts`) + an UPDATE branch in `recomputeStockAnalysis`. The hardcoded
  `0.5` that gated `score_history` is now the shared `MATERIAL_SCORE_DELTA`,
  so the two "did the score move?" tests cannot drift apart.
  **Live-verified with a control:** the runner was restarted onto the new
  build and ran a full 53-ticker refresh at 20:35:08Z — `stock_scores` for
  the day stayed at **12,402 → 12,402** (0 appended, 53 rows re-stamped in
  place), while `drawdown_metrics`, not yet fixed at that point, went
  **12,402 → 12,455 (+53)** in the same cycle. Same tickers, same refresh, so
  the difference is the change and not an idle loop. UI re-checked: /stock/NVDA
  header reads "Watch / Hold" and the sparkline's 2026-08-06 point reads 6.7,
  both matching the updated row; /, /watchlist, /portfolio, /status,
  /performance all 200.)*
  **Why:** `recomputeStockAnalysis` (`src/services/marketData.ts`) runs an
  unconditional `INSERT` into `stock_scores` on every refresh — including
  ~640 bytes of `reasoning_json` per row — while the comment directly above
  it says "Persist stock score + history when it changed". Only the
  *history* row is conditional; the score row is not. At 53 tickers × a
  ~2-minute market-open cadence that is ~12,400 rows/day, ~50 MB today and
  ~290 MB at the 30-day steady state, plus 7× that across backups. The
  information content is 9–34 material moves per day.
  **What:** keep the newest row per ticker *live* instead of appending a new
  one. In `recomputeStockAnalysis`, when the previous row for the ticker is
  from the **same UTC day** and the overall score moved by **less than the
  0.5 threshold `score_history` already uses**, `UPDATE` that row in place
  (all score columns + `reasoning_json` + `calculated_at`) rather than
  inserting. Insert a new row when the day rolls over or the move is
  material — so every material intraday move keeps its own row, and each
  ticker always has at least one row per day.
  Why in-place rather than the alternatives considered: shortening the
  retention window alone still writes 12,400 rows/day of WAL churn and only
  defers the cost; skipping the write entirely would freeze
  `latest_score.calculated_at` and make the score look stale. In-place
  update is the only option that preserves every value any consumer reads
  while writing ~60–90 rows/day instead of ~12,400.
  **Safe because:** staleness/`data_stale` reads
  `market_price_snapshots.captured_at`, not `stock_scores` — verified in
  `generateAlerts` — so freshness alerting is untouched. `score_history`
  semantics are unchanged: `prev` is still the most recent value, so the
  ≥0.5 comparison compares the same two numbers it does today.
  **Accept:** unit tests over a real test DB — two refreshes with an
  unchanged score leave ONE row with an advanced `calculated_at`; a ≥0.5
  move inserts a second row; a new UTC day inserts a fresh row;
  `latestScore`, `scoreSeries` and `buildScoreEvents` return the same values
  they did under append-only. Live: a market-open refresh cycle adds ~53
  rows/day instead of ~12,400.

- [x] **62. Same append-per-refresh cost in `drawdown_metrics`** *(small —
  done 2026-08-06, immediately after #61 proved the shape. One live row per
  ticker per UTC day, updated in place; no material-change threshold, because
  unlike scores there is no `score_history` analogue to preserve and every
  reader (`latestDrawdown()`, the buy-zone alert scan in `generateAlerts`)
  takes only the newest row. The UTC-day comparison both items need is now
  the shared `isSameUtcDay` in `lib/util.ts` — UTC deliberately, since every
  daily reader buckets on `substr(ts,1,10)` and local time would disagree by
  a day for a UTC-10 user. **Live-verified:** runner restarted, the 20:38:58Z
  53-ticker refresh appended **0** rows to either table (53 re-stamped in
  each); /watchlist still renders buy-zone status for all 87 rows
  (48 Above / 21 In / 18 Below).)*
  **Why:** `drawdown_metrics` takes the identical unconditional insert in
  the same function — ~12,400 rows/day, 7.8 MB today, ~372,000 rows at its
  30-day window. Only `latestDrawdown()` reads it. It is 6× smaller than
  `stock_scores`, so it is not the emergency, but it is the same bug.
  **What:** apply #61's pattern, or (simpler, since there is no
  history-table analogue and no material-change threshold) keep one row per
  ticker per day updated in place. Decide once #61 is live and its shape is
  proven.
  **Accept:** `latestDrawdown()` unchanged for every reader; row growth
  drops to ~53/day.

## v9 — Tier 2: data-source truth (closing #57)

- [x] **63. GDELT: not rate-limited to death — our connector was throwing the
  data away** *(done 2026-08-06, uncommitted)*
  **The retire-vs-pivot decision was never needed: the premise was wrong.**
  This item originally read "twelve consecutive scheduled runs fetched 0 items,
  therefore GDELT is too rate-limited for per-company polling — pivot or drop."
  Both halves of that inference were tested directly on 2026-08-06 and the
  conclusion does not hold.
  **What the evidence actually showed:**
  - A connector-identical request from this machine returned **200 OK with 10
    articles**. The endpoint works and the IP is not penalised.
  - Replaying the exact production shape (4 queries, 20s spacing,
    `maxrecords=10`) gave `429, 429, 429, 200 with 10 articles`. **The budget
    recovers inside a single run.**
  - `fetchGdeltNews` did a hard `break` on the first 429. Its only escape was a
    `Retry-After` retry — and GDELT **never sends that header** (`retry-after:
    null` on every observed 429), making the retry branch unreachable. So one
    throttle ended every run before it could reach a query that would succeed.
    That, not GDELT, is the source of all 24 zero-item runs.
  - The `http error` runs were a second bug: Node/undici's **connect** timeout
    is 10s, is not governed by `AbortSignal.timeout(30000)`, and throws a bare
    `TypeError`. Matching only on `TimeoutError`/`AbortError` filed those under
    `httpError`, which is why the class looked opaque.
  **Fixed:** a 429 now backs off and continues to the next query, bounded by
  `maxConsecutiveThrottled` (default 3, reset by any non-429 outcome) so a real
  wall of throttling still stops politely and the day-rotation resumes the tail.
  Undici `UND_ERR_*_TIMEOUT` is counted as a timeout, and `httpError` now
  records `httpErrorSample` ("HTTP 503", or error name + undici code) which
  `describeGdeltFailures` surfaces into `ingestion_runs.errors_json`.
  **Verified:** 5 new unit tests (500 total, typecheck clean) plus a live
  end-to-end run of the production shape — **10 real articles ingested where the
  old code returned 0**, reported as "3 throttled (429)".
  **Note for a future session:** GDELT's 429 body does suggest heavy users move
  to the ngrams dataset, so a *pivot* remains a legitimate future option for
  higher volume. It is no longer a rescue mission — the DOC API demonstrably
  works at this project's volume. #57 can move off `[~]` once a scheduled run
  lands a nonzero `gdelt` count in `ingestion_runs`.

## v9 — Tier 3: knock-on effects (revisit after #61)

- [x] **64. Backup + backtest cost, once #61 lands** *(measured 2026-08-06 —
  closed as "no new machinery needed, but see #65")*
  **Why:** two costs were downstream of the write amplification and might
  simply evaporate. `data/backups/` holds 7 full copies (367 MB), and
  `buildScoreEvents()` loads **every** `stock_scores` row into memory with an
  unfiltered `.all()` purely to collapse them to last-per-day.
  **Measured:** #61/#62 stop the *growth* (from ~24,800 rows/day across the
  two tables to ~106), but they do not shrink what is already there — the
  50.4 MB of historical intraday rows ages out only as the 30-day thin
  window reaches it. So both costs are now bounded and shrinking rather than
  unbounded, and neither justifies new machinery: `buildScoreEvents`'s scan
  falls to ~5k rows on its own once the backlog ages out, and the backup
  copies shrink with the database. **Reclaiming the existing 50 MB now is a
  data-deletion decision, split out as #65.**

- [x] **65. Reclaim the 50 MB of pre-#61 intraday rows** *(done 2026-08-06 —
  Colby chose "shorten the window to ~2 days" permanently.
  `SCORE_THIN_AFTER_DAYS` 30 → **2**, plus a new `DRAWDOWN_THIN_AFTER_DAYS`
  = 2 and a shared `thinToLastPerDay()` helper (the score thin's SQL, which
  `drawdown_metrics` had no equivalent of — its only rule deleted outright at
  30 days, so the intraday backlog would have sat for a month).
  **Result, live:** thinned **38,106 score rows + 38,106 drawdown rows**,
  deleted 2,915 snapshots, auto-acked 3 stale alerts; then a one-off
  `VACUUM` (runner stopped for the exclusive lock, restarted after) took the
  file from **88.5 MB → 45.2 MB**. `stock_scores` 50.4 MB → 20.8 MB, and
  still falling: 25,069 of its remaining 26,667 rows are from the last two
  days and thin to ~106 as they age past the window, so this lands near
  ~1,650 rows / ~1.3 MB.
  **The integrity check that matters:** a full `POST /api/performance`
  re-run against the thinned data returned **sampledEvents 1545, analyzed
  1543, tickers 55, calibration "mixed" — identical to the pre-purge
  report**. Only `totalScoreRows` moved (61,805 → 26,667), which is the raw
  row-count stat by definition. All 8 pages 200.)*
  **Why:** #61/#62 fixed the write path going forward; the historical bloat
  remains. Applying the same rule retroactively — keep the last row per
  ticker per UTC day — would delete **63,228 of 64,773 `stock_scores` rows
  (97.6%, ~49 MB)** and **63,281 of 64,499 `drawdown_metrics` rows**.
  The strong argument that this loses nothing: the 1,545 rows the thin would
  keep is **exactly** the `sampledEvents: 1545` figure in the stored
  `performance_report_v2` — i.e. it deletes precisely the rows
  `buildScoreEvents` already throws away, and no other consumer reads
  intraday resolution at all (`latestScore`/`latestDrawdown` take the newest
  row; `scoreSeries` takes last-per-day).
  **What:** either (a) run the existing `runRetention()` thin with
  `SCORE_THIN_AFTER_DAYS` temporarily at 0 as a one-off, or (b) shorten
  `SCORE_THIN_AFTER_DAYS` 30 → ~2 permanently so the window itself stops
  holding a month of intraday rows. (b) is the better default now that the
  write path no longer produces them in bulk.
  **Do not do this without asking** — it is irreversible for anything older
  than the newest backup, and "real data only" cuts both ways.
  **Accept:** DB back to roughly 35–40 MB, `/performance` regenerates with
  an unchanged report (same 1,545 sampled events), backups shrink
  proportionally.

**Operational, not a code item:** `FinanceAgentWake` is still **not
installed** (`Get-ScheduledTask` shows only `FinanceAgentJobs` Running and
`FinanceAgentWatchdog` Ready). #60 shipped the script; it needs Colby to run
`scripts/install-wake-task.ps1` from an elevated PowerShell.

---

# Improvement Roadmap — v8 (2026-07-19)

v8 came from the post-v7 forensics pass (2026-07-19 evening), three days
after #56 shipped. The loud-failure plumbing works — the 07-19 scheduled
ingestion recorded `gdelt: 0 items — 1 throttled (429), 1 http error` — but
GDELT is still dark, and live probes **overturned v7's penalty-decay
theory**: a cold simple query returned 200 just 4 hours after the runner's
own 429 (no multi-day IP penalty exists), while a connector-shaped batched
query got 429 even after 30 seconds of politeness, and every request made
during a penalty re-armed it (4 consecutive 429s at 10–30s spacing).
Responses are also slow — 13.2s for a successful trivial query, 429s
arriving at 11–19s — so the current 20s timeout has almost no headroom and
the 5.5s completion-to-start spacing trips the limiter on the second
request of nearly every run. Separately, the alert scan showed two hygiene
problems: a machine-wake network blip on 07-17 emitted **52 `data_stale`
warnings in one minute**, and back-to-back refresh+maintenance ticks on
07-19 emitted **duplicate `new_setup` alerts one minute apart** (quality
drifted 7.5→7.0, defeating the exact-message dedupe) on top of a
113-row unacked `new_setup` backlog that nothing ever drains.

## v8 — Tier 1: data-source truth (continued)

- [~] **57. GDELT: run within the limiter's real budget** *(small–medium —
  CODE SHIPPED + TESTED 2026-07-20; loud-failure path verified live;
  fetch-success UNCONFIRMED and must be watched on /status over the coming
  days. Honest blocker: I ran ~8 diagnostic requests at GDELT today and put
  my own IP into a persistent penalty — the only 200 all session was the
  very first request, hours ago, before any others; every request since
  (including a single-phrase maxrecords=10 query after 8 min idle) 429'd.
  So I could not prove a clean fetch tonight without abusing a free API,
  and stopped. The design (one company/query, maxrecords 10, 20s spacing,
  30s timeout) is evidence-consistent but the shape-vs-penalty variables
  stayed confounded. NEXT: once the penalty decays (hours, not days),
  watch the /status Data sources card / /events. If scheduled runs still
  show gdelt=0 after a clean window, GDELT is simply too rate-limited for
  per-company polling — pivot to their suggested ngrams dataset or drop it.
  **2026-08-06 — the clean window has now been observed and the answer is
  no: 12 consecutive scheduled runs, 07-21 → 08-06, all fetched 0 items.
  Superseded by v9 #63, which carries the evidence and the decision.**)*
  **Why:** post-#56 runs fail honestly but still fetch zero. Probes
  (2026-07-19): no long-lived IP penalty — cold start returns articles —
  but a ~6s completion-to-start gap trips the 429 despite the stated
  1-per-5s floor, requests during a penalty re-arm it indefinitely, and
  responses take 13–20s (a 429 took 19.1s — a whisker under the 20s
  timeout, one jitter away from being miscounted as a timeout). With 5.5s
  spacing the second request of a run nearly always trips, the run dies,
  and the source looks permanently dark.
  **What:** in `fetchGdeltNews`: `spacingMs` 5500 → 20000, per-request
  timeout 20s → 30s, `maxQueries` 8 → 4 (day-rotation #56 already cycles
  the tail across runs), and after any non-429 failure double the pause
  before the next request (failed requests still count against the
  budget — tonight's run: query 1 http error, query 2 429). Batch cost
  down: `buildGdeltQueriesFor` batchSize 6 → **1** and `maxPerQuery` 25 →
  **10**. (Started at batch 3 / maxrecords 15, but a second clean probe
  settled it: a 3-phrase OR at maxrecords=15 got 429 on the FIRST request
  after 10 minutes idle — since idle time didn't reset it, the limiter is
  rejecting on query COST, not spacing. The one shape that returned 200
  cold was a single phrase at low maxrecords. So one company per query is
  the only shape reliably served; the extractor attributes by article
  title, so batching only ever bought coverage speed, which rotation
  restores.) Thesis-scout's single query gets the same 30s timeout.
  Worst-case run: 4 × (30s + 20s) ≈ 3.3 min — inside `maxDuration = 300`.
  **Accept:** unit tests with scripted fetchFn + injected sleep assert the
  spacing schedule (normal, doubled-after-failure, stop-on-429), one
  company per query, and maxrecords=10. Live: a cold scheduled run's
  leading single-phrase query fetches >0 items, or /events records an
  honest per-class reason (the loud-failure path is already proven — the
  07-19 run recorded `gdelt: 0 items — 1 throttled (429), 1 http error`).

## v8 — Tier 2: alert hygiene

- [x] **58. `new_setup` alert lifecycle: once-while-unacked + auto-ack when
  the episode ends** *(small–medium — done 2026-07-20; `new_setup` is now a
  FLUID_CONDITION_TYPE emitted with `onceWhileUnacked` and marked from
  `activeSetups()` so it also honors the archive. Live: the runner's first
  new-code scan added 0 new rows (`0 new alert(s)` in jobs.log) — the
  onceWhileUnacked guard held against the existing backlog — and the
  113-row backlog had already dropped to 65 as ended-episode tickers
  auto-acked. The 65 survivors are legacy duplicates for the 13 tickers
  whose episodes are STILL active (each was a separate pre-fix daily
  re-emit >20h apart); they can't consolidate retroactively but stop
  growing now and drain as each episode ends / #36's 14-day auto-ack
  sweeps them.)*
  **Why:** `new_setup` re-emits on every scan for every active q≥7 setup,
  deduped only by exact message — quality drifting 7.5→7.0 between the
  01:43 refresh and 01:44 maintenance tick minted duplicate rows for the
  same setups one minute apart, and 113 unacked rows have accumulated
  because event alerts are never auto-acked. But a setup is not an event —
  it is a condition with a natural end (`scanForSetups` already computes
  episode-end for archive suppression, #swing-archive).
  **What:** reclassify `new_setup` as a fluid condition at (type, ticker)
  granularity: emit with `onceWhileUnacked`, `mark("new_setup", ticker)`
  while any q≥7 active setup exists for the ticker, and let
  `ackClearedConditionAlerts` drain rows when no such setup remains.
  Trade-off (documented): a second setup type on an already-alerted ticker
  won't add a row while the first is unacked — /swing shows every setup
  regardless.
  **Accept:** persistence tests — same setup two scans running → one row;
  quality drift → still one row; episode ends → row auto-acked; ack + new
  episode → fresh row. Live: the 113-row backlog drains to just tickers
  with currently-active quality setups on the first scan.

- [x] **59. Collapse total-refresh-failure stale waves into one alert**
  *(small — done 2026-07-20; `generateAlerts` gathers stale tickers first,
  then emits ONE aggregate `data_stale` warning (ticker null,
  `onceWhileUnacked`) when ≥`STALE_WAVE_MIN` (10) AND ≥50% of the board is
  stale; below that it stays per-ticker. The aggregate is marked so #49
  auto-ack supersedes older per-ticker rows on the transition and clears
  the aggregate once freshness returns. Persistence-tested (12/12 → one
  aggregate; 3/12 → per-ticker; 12/30 minority → per-ticker; supersede +
  freshen round-trip). Not live-triggerable without a real network
  outage — the tests stand in for it.)*
  **Why:** when the machine wakes into a dead network, every tracked
  ticker is stale at once and the per-ticker loop emits a wave — observed
  2026-07-17T04:37Z: **52 `data_stale` warnings + one digest push for a
  WiFi blip**. A wave of identical warnings is one fact wearing 52 rows.
  **What:** in `generateAlerts`, count stale tickers first; when ≥10 AND
  ≥50% of tracked, emit ONE aggregate warning (`data_stale`, ticker null:
  "N of M tracked tickers have stale data — refresh has been failing;
  check network / runner") instead of per-ticker rows, marked so #49
  auto-ack clears it when freshness returns. Below threshold, per-ticker
  behavior unchanged (a single dead symbol stays individually visible).
  **Accept:** persistence tests — 52/52 stale → exactly one row; 3/52
  stale → per-ticker rows; aggregate auto-acks when data freshens. Live:
  present on the next wake-into-blip instead of a wave.

## v8 — Tier 3: coverage

- [x] **60. Wake task: don't sleep through market hours** *(small–medium —
  done 2026-07-20; Colby chose `-WakeToRun`. The runner is only SUSPENDED
  while the laptop sleeps, so a machine asleep during market hours does
  nothing — Friday 07-17's entire session was missed (laptop slept Thu
  22:27 → Sun 15:43 HST). New opt-in `FinanceAgentWake` task
  (`scripts/install-wake-task.ps1`, uninstall mirror): a weekday
  `-WakeToRun` daily trigger (default 03:10 local, `-WakeAt` overridable)
  wakes the machine pre-open, then `scripts/keep-awake.ps1` — launched
  hidden via a new `run-hidden-ps.vbs` (mirrors #51's `run-hidden.vbs`
  but for a .ps1; needs `cmd /c` so `>>` redirection works) — asserts
  `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` to hold the system awake
  until 16:05 ET (computed in US Eastern → local, so DST-correct for HST;
  weekends self-skip) and releases in a `finally`. No permanent power-plan
  edits. Verified live: DST math (close = 10:05 HST under EDT), the P/Invoke
  under PS 5.1 (**decimal literals, not hex — `[uint32]0x80000000` throws
  under 5.1**), the hidden vbs→cmd→powershell→log chain, BOM/CRLF on the
  new .ps1 files. NOT verifiable tonight: the multi-hour hold itself (a
  Start-Sleep loop around the proven assertion) — first real proof is the
  next weekday wake. Two OS deps `-WakeToRun` can't override, documented in
  README + the install script: "Allow wake timers" must be on, and a
  lid-close can still force sleep. Colby installs it (needs elevated PS).)*
  **Why:** every liveness surface plus the whole trading day depends on the
  machine being awake during market hours; his laptop is his only host and
  it sleeps. Equity-curve holes for 07-17/07-18 stay honest — real-data
  only means no backfill.

---

# Improvement Roadmap — v7 (2026-07-16) — complete

v7 came from the post-v6 forensics pass (2026-07-16 evening): the new /status
Data sources card and the run log agree that **GDELT has fetched zero items in
every recorded run since at least 2026-07-10** — spanning the 07-11 audit, so
not a regression — while `ingestion_runs.errors` stayed empty every time.
Live probes: a single simple query returns articles (the API works, the IP is
not permanently blocked), but the connector's 1.5s spacing violates GDELT's
stated 1-request-per-5-seconds limit and trips multi-minute penalty windows.
The smoking gun: a throttled 429 response took **11.7 seconds to arrive —
past the connector's 10s request timeout** — so in production the abort
fires first, the empty catch swallows it, and the connector never sees the
429 at all: no warn, no backoff, and the next query 1.5s later re-triggers
the penalty. That is why a week of dead runs shows zero errors and only one
429 warning (the one day GDELT answered fast).

## v7 — Tier 1: data-source truth (continued)

- [x] **56. GDELT: obey the rate limit and make silent failures loud**
  *(small–medium — done 2026-07-16; first live run after the fix recorded
  `gdelt: 0 items — 1 throttled (429)` in the run's errors — the 20s timeout
  let the connector finally SEE the slow 429 and stop after one request
  instead of hammering eight blind. The penalty window needs days of polite
  behavior to decay; watch the /status card — the failure is loud now either
  way.)*
  **Why:** the source has been dark ≥6 days with zero errors recorded.
  `fetchGdeltNews` never throws: 429 stops the run with only a console.warn,
  a 200 whose body isn't JSON parses to `{}` → zero articles, and a
  timeout/network error is swallowed by an empty catch. `ingestCore` records
  `bySource.gdelt = 0`, `errors: []` — indistinguishable from "no news
  today". Meanwhile the request spacing (1.5s) is below GDELT's documented
  1-per-5s minimum, so a run of 8 batched queries self-inflicts throttling,
  and observed penalty windows extend minutes beyond the nominal 5s.
  **What:** (a) `fetchGdeltNews` gains a diagnostics channel: return
  `{ items, failures }` (or accept an errors sink) counting per-run
  `throttled` / `timedOut` / `badPayload` / `httpError` outcomes, with the
  first offending body head captured for badPayload; `ingestCore` pushes a
  one-line summary into `result.errors` whenever gdelt produced 0 items AND
  failures > 0 — it then flows to `ingestion_runs.errors_json`, the /events
  run list, and the /status card's context for free. (b) Respect the limit:
  default `spacingMs` 5500 (>5s), honor a `Retry-After` header when present
  on 429 before giving up, and raise the per-request timeout to 20s (GDELT
  is slow; a 10s cap plus silent catch is how whole runs vanished). (c)
  Rotate batch order across runs (persist a cursor or derive from run count)
  so companies beyond the first batches still get coverage when a run dies
  early.
  **Accept:** unit tests with a scripted fetchFn (429 with/without
  Retry-After, non-JSON 200, timeout, mixed success) assert both the items
  and the failure counts, plus the ingestCore error-line wiring. Live: the
  next scheduled ingestion either produces gdelt items or records a
  human-readable reason in the run's errors — never again a bare silent 0.

---

# Improvement Roadmap — v6 (2026-07-13) — complete

Roadmaps v1–v6 (#1–#55) are **complete** — see below and the archives. v6
came from runtime forensics on 2026-07-13: the newly installed scheduled
task's logon run died after 13 seconds with 0xC000013A (console Ctrl+C /
window close) and nothing restarted it — the whole Monday market session ran
with no scheduler and no notice anywhere; `catalyst_scan` hadn't fired since
Friday (its cron has no catch-up); the 07-12 daily maintenance was missed
because the >20h due-anchor had drifted 43 minutes past the machine's
bedtime; every Yahoo browser-fallback invocation fails to parse; and GDELT
has produced 0 items across six straight ingestion runs with zero errors
shown. Items are #51+. Implemented 2026-07-16.

## v6 — Tier 1: runner resilience

- [x] **51. Runner survivability: hidden task window + single-instance
  lock** *(small–medium — done 2026-07-16; task re-registered on the
  hidden VBS action and Running with a fresh heartbeat; a second
  `npm run jobs` exits 1 with the "another scheduler (pid N)" message.
  Live surprise: `Stop-ScheduledTask` kills only the wscript launcher and
  orphans the cmd/npm/node tree — even the old cmd.exe action behaved
  this way — so `scripts/stop-jobs-task.ps1` now stops the task AND kills
  the pid in `data/jobs.lock`, and README says to use it. Also: .ps1
  files need a UTF-8 BOM or PS 5.1 parses an em dash inside a string as a
  smart-quote terminator.)*
  **Why:** the scheduled task runs `cmd.exe` interactively at logon, so a
  console window pops up on every logon — closing it (or a stray Ctrl+C)
  kills the runner, and the task doesn't restart it. Observed 2026-07-13:
  LastTaskResult 0xC000013A 13s after logon, runner dead all day. Ad-hoc
  `npm run jobs` terminals also compete with the task — the double-scheduler
  footgun the README warns about (the 07-12 evening runner was a manual one;
  its output isn't even in jobs.log).
  **What:** (a) `scripts/run-jobs-hidden.vbs`: `WScript.Shell.Run` of
  `cmd /c npm run jobs >> data\logs\jobs.log 2>&1` with window style 0 and
  bWaitOnReturn=True, so no window ever appears, the task shows *Running*,
  and `Stop-ScheduledTask` kills the whole tree. `install-jobs-task.ps1`
  points the action at `wscript.exe` + the vbs and gains `-StartNow`;
  the uninstall script stops the task before unregistering (stopping is now
  Stop-ScheduledTask, not Ctrl+C — losing the best-effort SIGINT
  notification flush on a hard stop is acceptable). (b) single-instance
  lock: at startup the scheduler exclusively creates `data/jobs.lock`
  containing its PID; if the file exists and that PID is alive, log
  "another scheduler (pid N) is running — exiting" and exit(1); a dead PID's
  lock is stolen; the lock is removed on SIGINT/SIGTERM. Lock *errors*
  (fs failures) never stop the runner — only a held lock does.
  **Accept:** lock helper unit-tested with injectable PID-liveness (fresh
  start, held-by-live-pid, stale-pid steal, unreadable lockfile). Live:
  re-register + start → no window, heartbeat ticks; a second
  `npm run jobs` exits immediately with the clear message;
  `Stop-ScheduledTask` actually stops node (heartbeat stops).

- [x] **52. One scheduling mechanism: fold the cron jobs into the minute
  loop** *(medium — done 2026-07-16; node-cron removed, both jobs on
  minute-loop due-checks. Live: after restart, catalyst_scan (2h old)
  correctly stayed quiet inside its 4h window and maintenance did not
  re-run after today's completed 08:02 run — calendar anchor holding; no
  cron banners in jobs.log. The rewire also fixed a latent crash: a throw
  inside `void catalystScan()` was an unhandled rejection under cron.)*
  **Why:** two of the three jobs still depend on being awake at exact
  minutes. `catalyst_scan` (`0 */4 * * 1-5`) has **no catch-up** — last ran
  Friday 07-10 20:00 local, then nothing (weekend gate aside, Monday was
  simply missed). And maintenance's ">20h since last run" anchor drifts
  later every time a catch-up runs late: the 07-11 catch-up ran 17:18 local,
  so 07-12's maintenance wasn't due until 13:18 — 43 minutes after the
  machine went to sleep — and the day was silently skipped. node-cron also
  spams missed-execution warnings after every sleep.
  **What:** drop node-cron entirely; the existing self-scheduling minute
  loop becomes the only trigger. Two pure due-checks in `jobHealth.ts`:
  `isMaintenanceDue(lastRunAt, now)` — past 08:00 local AND the last
  completed run's **local calendar date** is before today (calendar
  anchoring can't drift; a mid-run kill self-heals because the completion
  date stays yesterday); `isCatalystScanDue(lastRunAt, now)` — local
  Mon–Fri AND (never ran OR >4h old). Tick order: heartbeat → refresh →
  maintenance if due → catalyst scan if due *and* maintenance didn't just
  run this tick (maintenance already includes the news scan). The
  `maintaining` guard stays; the #43 startup timer and
  `isMaintenanceCatchupDue` are deleted (the loop's first tick at boot
  covers startup catch-up). `recordJobRun("daily_maintenance","error")`
  still bumps last_run_at, so a failing maintenance retries next day —
  unchanged from #48.
  **Accept:** due-checks unit-tested with fake clocks (pre/post 08:00,
  ran-today, ran-yesterday-late, never-ran, unparseable, weekend vs weekday,
  4h boundary). node-cron gone from package.json. Live: with stale last
  runs, both jobs fire within a minute of runner start, and sleep/wake no
  longer logs cron warnings.

## v6 — Tier 2: data-source truth

- [x] **53. Yahoo browser fallback: verify live, then fix or retire**
  *(small–medium — done 2026-07-16; **fixed**, not retired: the live probe
  (AAPL + MSFT) showed the page loads clean with no consent wall, but the
  main quote's price moved off fin-streamer — zero `data-symbol="<ticker>"`
  elements on the whole page — into `data-testid="qsp-price"` spans, with
  the 52-week range on a `fiftyTwoWeekRange` streamer's data-value. Parser
  now falls back to those; pinned by a fixture test from the live page.
  Post-fix probe parsed AAPL at 331.92 with zero extraction errors. The
  earnings in-page API path was verified working (4 rows) and untouched;
  the news-scan fallback stays behind the stable RSS primary.)*
  **Why:** every browser-quote invocation in the recent log fails with
  "regularMarketPrice not found — page layout may have changed", and
  chromium-1228 *is* installed — this is parser rot, not environment. The
  last-resort quote net demonstrably catches nothing, keeps Playwright load
  in the hot path, and fills the log with noise during outages.
  **What:** drive `yahooFinanceBrowser` live (quote path and the news-scan
  fallback separately) against real tickers. If the page still carries the
  data (fin-streamer data-field attributes or the embedded JSON state
  blob), fix the extraction and pin it with a saved-fixture unit test. If
  Yahoo's page is no longer reliably scrapable headless (consent walls,
  anti-bot), remove the browser **quote** fallback — `yahooHttp` stays
  primary, `quoteFromSummaryFields` untouched — and update the README and
  provenance notes; judge the news fallback by the same rule. Bias: don't
  keep a safety net that demonstrably doesn't catch.
  **Accept:** either a live browser quote returns real fields plus a green
  fixture test, or the dead path is removed with tests/typecheck/README
  updated. Log noise gone either way.

- [x] **54. /status "Data sources" health card** *(small — done
  2026-07-16; live /status immediately showed the real problem: gdelt
  amber at "8 runs dark", sec-edgar and ir-rss producing, and the three
  quote transports with honest last-produced stamps — alpaca fresh,
  yahoo/yahoo-browser last used 07-10/07-11.)*
  **Why:** GDELT returned 0 items in six straight ingestion runs with zero
  errors — silent 429 throttling looks identical, on /events, to "nothing
  happened". The browser rot (#53) was likewise invisible until log
  forensics. Nothing answers "which sources actually produced data lately?"
  **What:** pure helpers in `status.ts`, derived from existing tables — no
  new writes. Per ingestion source (sec-edgar / gdelt / ir-rss) from
  `ingestion_runs.by_source`: last producing run + consecutive zero-item
  streak, amber at ≥3. Per quote transport (alpaca / yahoo / yahoo-browser)
  from `market_price_snapshots.source`: last "produced data" timestamp,
  phrased so a legitimately-never-invoked fallback isn't an alarm. New card
  on /status.
  **Accept:** helpers unit-tested (streak counting, sources missing from
  some runs, empty/absent by_source JSON). Live: /status shows a gdelt
  streak matching ingestion_runs and renders with real data.

## v6 — Tier 3: last-resort alerting

- [x] **55. Dead-runner watchdog task** *(small–medium — done 2026-07-16;
  entrypoint landed in `src/jobs/watchdog.ts` (not scripts/) to keep `@/`
  imports. Live-verified against a REAL outage: with the runner down
  mid-migration, `npm run watchdog` raised the desktop toast ("heartbeat
  is 14 minutes old"), the immediate re-run stayed silent (6h throttle),
  and after the runner came back the state file self-cleared.
  FinanceAgentWatchdog registered without elevation, Ready, 30-min
  repetition — note `[TimeSpan]::MaxValue` as RepetitionDuration is
  rejected by current builds; omit the parameter for "indefinite".)*
  **Why:** every liveness surface — header badge, /status, alerts, ntfy —
  is served by processes that are dead exactly when the answer matters.
  Observed 2026-07-13: runner dead since 22:35 the prior night, the whole
  market session missed, zero notification anywhere.
  **What:** `scripts/watchdog.ts` (tsx entrypoint — `loadDotEnv()` first,
  per the #40 rule): opens the DB read-only (missing DB → silent exit 0),
  reads the heartbeat age; if >10 min stale, pushes a critical notification
  through the existing ntfy/desktop plumbing (severity-gate bypass, like
  the morning brief's direct send), throttled to one alert per outage with
  a 6h re-alert via `data/watchdog-state.json`; a fresh heartbeat clears
  the state silently. If no notification channel is configured it logs and
  exits — the install script warns about that. `install-watchdog-task.ps1`
  registers `FinanceAgentWatchdog` on a 30-minute repetition using the #51
  hidden-vbs pattern (short-lived run each time), with an uninstall mirror;
  opt-in like #18. A sleeping machine pauses the watchdog too — correct,
  since there's nobody there to alert.
  **Accept:** staleness/throttle helpers unit-tested (fresh, stale,
  missing DB, inside/outside the re-alert window, state round-trip). Live:
  with the runner stopped, one manual watchdog run raises the toast/ntfy
  push; with it running, a run stays silent and clears the state.

---

# Roadmap v5 (2026-07-11) — complete

Roadmaps v1–v4 (#1–#47) are **complete** — see below and the archives. v5
came from runtime signals observed on 2026-07-11 against the live system
(alert-table composition, job heartbeats vs. the maintenance log, and a
mis-themed pick found while verifying the audit fixes). Items are #48+.

## v5 — Tier 1: ops correctness & alert hygiene

- [x] **48. Sleep-proof the daily maintenance schedule** *(small — done
  2026-07-11)*
  **Why:** node-cron's `0 8 * * *` tick doesn't fire when the machine is
  asleep at 08:00, and the #43 catch-up only runs at process startup.
  Observed 2026-07-11: the runner's heartbeat was alive 08:36–08:42 local
  (machine woke after the tick) but no maintenance ran all day — no
  retention, no backup, no discovery — with nothing on /status to say why.
  The refresh loop is already a sleep-tolerant self-scheduling timer; only
  maintenance depends on being awake at one exact minute.
  **What:** pure `isMaintenanceCatchupDue(lastRunAt, now, dueHour=8,
  maxAgeHours=20)` in `jobHealth.ts` — due only when past `dueHour` local
  AND `isDailyJobDue` — called from the minute refresh loop; a `maintaining`
  guard prevents overlap with the 08:00 cron and the startup catch-up (both
  stay). Note `recordJobRun("daily_maintenance","error")` bumps
  `last_run_at`, so a failing maintenance retries next day, not every
  minute — unchanged from today.
  **Accept:** helper unit-tested (pre-hour stale, post-hour stale, post-hour
  fresh, never-ran, unparseable). Live: with a >20h-old last run, the
  running scheduler kicks maintenance within a minute — no restart needed.

- [x] **49. Auto-acknowledge condition alerts whose condition has cleared**
  *(medium — done 2026-07-11; the first live scan drained the backlog
  64→14 criticals, 118→13 warnings, event alerts untouched)*
  **Why:** #45 stopped daily re-emits, but rows for dead states linger
  forever: observed 48 unacked `stop_loss_hit` **criticals all referencing
  closed trades** (RTX ×28), `exit_recommended` for long-closed F/ORCL
  trades, and 93 `data_stale` warnings whose tickers have long since
  refreshed. The header badge stays red on states nobody can act on. #36's
  age-based auto-ack deliberately never touches criticals — age is not
  evidence a critical is moot — but the condition objectively ending is.
  **What:** two layers. (a) `generateAlerts` tracks which condition alerts
  are currently true per (type, ticker) and, after the scan, auto-acks
  unacked rows no longer true. *Fluid* conditions (`near_stop_loss`,
  `target_hit`, `trade_score_low/critical`, `exit/trim/add`,
  `entry_range_reached`, `concentration`, `data_stale`) clear as soon as a
  scan stops finding them; *sticky* criticals (`stop_loss_hit`,
  `thesis_invalidated`) clear only when the ticker has no open trade left —
  an intraday stop breach stays visible even if price recovers. Event
  alerts (order fills/cancels, auto-closes, new_setup, major_catalyst,
  mentions, morning brief) are never touched. (b) `closeTrade` acks the
  trade-scoped types for its ticker immediately; on multi-trade tickers the
  next scan re-emits if another open trade still has the condition (#45's
  ack re-arm makes this self-healing).
  **Accept:** persistence tests — zombie stop alert on a closed trade acked
  by one scan; an open-trade breach survives; stale→fresh `data_stale`
  acked; event alerts untouched; `closeTrade` acks immediately. Live: the
  48-critical backlog drains on the first scan and the badge drops.

## v5 — Tier 2: pick quality

- [x] **50. Sector Scout: theme-membership check on surfaced picks**
  *(small–medium — done 2026-07-11; also covers kept "added" picks, which is
  how the live ALKS row got its flag)*
  **Why:** validation proves a ticker has real price data, not that it
  belongs to the theme — the live "space" scan holds **ALKS (Alkermes, a
  biotech)** as an added pick, an LLM-expansion slip from 2026-06-29 that
  rode a decent market score into the industry list. Thesis validation
  would catch this via `themeFitScore`, but it's budget-capped and opt-in.
  **What:** after the score/thesis gates select the surfaced set, one
  batched LLM call re-checks membership ("which of these are NOT primarily
  <industry> businesses?") and stores a flag; the pick card shows a visible
  "theme fit questioned" chip — flag, never silently drop (decision
  support). Rule-based fallback: curated-theme members pass, everything
  else is left unflagged (no false accusations without evidence). Nullable
  `theme_fit_flag` column on `sector_scout_picks` (normal migration flow).
  **Accept:** parser + fallback unit-tested; persistence test that a
  flagged pick keeps its flag through a re-scan upsert. Live: a re-scan of
  "space" flags a biotech interloper while leaving RKLB-class names clean.

---

# Roadmap v4 (2026-07-10) — complete

Roadmaps v1 (#1–#14), v2 (#15–#28), and v3 (#29–#43, including follow-ups)
are **complete** — see below and the archives. v4 came from a fresh pass on
2026-07-10 over the modules v2/v3 hadn't touched (orderSync, catalysts,
discovery, earnings fetch) plus runtime signals from the first-ever real
maintenance run. Items are numbered #44+.

## v4 — Tier 1: correctness

- [x] **44. `classifyCatalyst` tone adjustment forces the sign** *(small — done)*
  **Why:** `catalysts.ts` tone rules say "adjustment for otherwise-neutral
  matches" but apply to every match with sign-forcing math:
  `Math.min(impact - 1, -1)` turns a +4 guidance-raise headline containing
  one word like "warns" into **-1**, and the positive mirror turns a -3
  estimates-miss with "soars" into **+1**. The existing test only covers the
  neutral case, so the flip is unexercised.
  **What:** Tone only *nudges*: when no rule matched (impact 0) it sets ±1
  as today; when a rule matched, add/subtract 1 with the -5..5 clamp but
  never force the result across zero. Tests for the two flip cases plus the
  existing neutral behavior.
  **Accept:** "Raises guidance but warns on supply" scores strongly positive
  (+3), "misses estimates as shares soar" stays negative; old tests green.

- [x] **45. Suppress re-emits of condition alerts while one is already
  unacked** *(medium — done)*
  **Why:** `emitAlert`'s 20h dedupe keys on the exact message, and condition
  messages embed the live price/score — so a stop that stays breached or a
  ticker that stays stale re-alerts **every day with a new row**: observed
  91 `data_stale`, 48 `stop_loss_hit` rows. The feed and badge fill with
  repeats of states the user already hasn't acted on.
  **What:** An `onceWhileUnacked` option on `emitAlert`: skip when an
  **unacknowledged** alert of the same (type, ticker) already exists,
  regardless of message/age. Apply to the condition-state alerts in
  `generateAlerts` (stop/near-stop, score low/critical, exit/trim/add,
  buy-zone, data_stale, concentration) — not to event alerts (order fills,
  auto-closes, mentions, brief). Acknowledging re-arms the alert.
  **Accept:** Persistence test: same condition two days running → one row
  while unacked; ack + re-emit → second row. Live feed stops accumulating
  daily repeats.

## v4 — Tier 2: efficiency & UX

- [x] **46. Parallelize the maintenance Yahoo loops** *(small — done)*
  **Why:** `scanYahooNews`, `fetchEarningsForTickers`, and
  `fetchUpcomingEarningsForTickers` each `await` per ticker in a `for` loop
  — 3 × 45 serialized Yahoo calls per maintenance (~20s observed for the
  earnings pair alone). `mapPool` is the established idiom everywhere else.
  **What:** `mapPool(tickers, 4, …)` in all three, keeping per-ticker
  error isolation exactly as now (SQLite writes are synchronous on the main
  thread, so parallel fetch + serial write is safe).
  **Accept:** Tests stay green; a live maintenance run logs the same counts
  in visibly less wall time.

- [x] **47. Live R/R + size feedback in the trade dialog** *(small–medium — done)*
  **Why:** The pre-trade gate (#29) answers only on submit; the dialog shows
  est. notional but not the risk/reward being keyed in or a suggested size,
  though `riskRewardRatio` and `suggestPositionSize` are pure and
  client-importable.
  **What:** In `TradeOrder`, compute R/R from limit/stop/target as the user
  types (with the configured minimum passed as a prop from the server page),
  show it inline colored by threshold, plus "suggested size: N shares
  (risking $X)" from `suggestPositionSize` when a stop is set. Display-only
  — the server gate stays authoritative.
  **Accept:** Typing a thin target shows the sub-minimum R/R immediately;
  the placed order still round-trips the server gate unchanged.

---

# Roadmap v3 (2026-07-09) — complete

This v3 list came from a fresh pass over the codebase on 2026-07-09; every
"Why" cites the actual code it's grounded in. Items are numbered #29+ so
git-history references to "roadmap #N" stay unambiguous.

## Working agreement (read before starting any item)

- Read `README.md`, `AGENTS.md`, and `docs/agent-memory.md` first.
- Real data only — never run `db:seed`, never fabricate rows.
- Keep the "decision support, not advice" framing: model output is labeled as
  interpretation; Catalyst Edge stats are historical correlation, not
  prediction.
- Schema changes: edit `src/db/schema.ts`, run
  `npm run db:generate -- --name <slug>`, commit the `drizzle/` output. Never
  edit applied migrations or `src/db/legacyBaseline.ts`.
- `npm run jobs` does not hot-reload — restart it after code changes.
- Before calling an item done: `npm run typecheck`, `npm test`, and verify the
  behavior live (`npm run dev`, exercise the real page/API). Small fixes go
  straight to `main`; features get a branch and a `Merge: <title> (roadmap
  #N)` merge commit (see git history for the style).
- New code uses the shared modules — `src/services/llm.ts`,
  `src/components/useApiAction.ts`, `src/lib/util.ts` (`nowIso`, `clamp`,
  `errorMessage`, `mapPool`), `src/services/watchlist.ts` — don't re-roll
  them. Since #26, quote refresh lives in `src/services/quotes.ts`, the bar
  store in `src/services/bars.ts`, and `getTrackedTickers` in
  `@/lib/queries`; `marketData.ts` is analysis orchestration only.

## Tier 1 — Wire up the dead safety features

- [x] **29. Pre-trade risk gate: wire `validateProposedTrade` into trade
  entry** *(medium — done)*
  **Why:** `validateProposedTrade` (`src/services/riskManagement.ts:134`)
  checks exactly what a swing trader should see before entry — no stop
  defined, no target, R/R below `minRiskReward`, inside the
  `avoidEarningsWithinDays` window — and it has unit tests
  (`riskManagement.test.ts:87`). **Nothing calls it.** The order dialog
  (`TradeOrder.tsx`) and both write paths (`POST /api/trades/place`,
  `POST /api/trades`) submit with zero risk-rule feedback; the only
  server-side check is bracket-leg sidedness.
  **What:** In both API routes, run `validateProposedTrade` (entry = limit
  price / reference price / entryPrice; `daysToEarnings` from
  `daysToNextEarnings(ticker)`; thresholds from config). When problems exist
  and the request doesn't set `confirmRisks: true`, return 400 with
  `{ error, riskProblems }` — mirroring the existing `confirmLive` pattern,
  so it's a speed bump, never a hard block (decision support, not an
  autopilot). In `TradeOrder.tsx`, surface returned `riskProblems` with a
  "place anyway" confirm path; optionally pre-compute the R/R warning
  client-side as the user types.
  **Accept:** Unit/route tests: no-stop and thin-R/R trades → 400 with
  problems listed; same request + `confirmRisks` → succeeds; clean trade →
  no friction. Live: the dialog shows the problems and the confirm path
  works.

- [x] **30. Account-level concentration alerts: wire `concentrationWarnings`
  into `generateAlerts`** *(small — done)*
  **Why:** `concentrationWarnings` (`riskManagement.ts:104`) computes
  per-position and per-sector weight breaches against
  `maxPortfolioConcentrationPercent` / `maxSectorConcentrationPercent` — both
  configurable in Settings — and is tested. **No caller.** `generateAlerts`
  (`alerts.ts:65`) covers stops/targets/scores/catalysts/staleness but never
  concentration; per-position weight only feeds the trade *score*
  (`tradeScoring`), which a holdings-only user never sees.
  **What:** In `generateAlerts`, build positions from `portfolio_holdings`
  (`marketValue`) plus open trades (`shares × currentPrice`), account value
  via `currentAccountValue()`, and emit one `warning` alert per breach
  through the existing `emit` dedupe. Note: holdings carry no sector data
  today, so pass `sector: null` and let only the position-weight half fire —
  don't invent sectors.
  **Accept:** Persistence test: an oversized holding → exactly one alert,
  rerun → no duplicate; under-cap → none. Live: visible in the alerts feed
  with real holdings.

## Tier 2 — Surface data the DB already holds

- [x] **31. Portfolio equity curve (daily account-value snapshots)**
  *(medium — done)*
  **Why:** `portfolio_holdings` is current-state only and
  `market_price_snapshots` is per-ticker — the app cannot answer "how has my
  account done over time?" even though it recomputes
  `currentAccountValue()` constantly. Realized-trade stats exist, but no
  equity curve.
  **What:** New `portfolio_snapshots` table (normal migration flow): one row
  per calendar day — total holdings value, open-trade value, holding count —
  upserted (not stacked) by daily maintenance and by `fullRefresh`. On
  `/portfolio`, render a dependency-free SVG equity curve (reuse the
  `PriceChart` idiom) once ≥2 days exist, with SPY normalized to the same
  start for comparison; before that, show "collecting — N day(s) so far".
  Real data only: the curve starts today, no backfill fabrication.
  **Accept:** Persistence test: two upserts same day → one row, next day →
  two. Live: after a refresh the row exists and the page states its day
  count honestly.

- [x] **32. Upcoming-earnings calendar view** *(small — done; card lives on
  the Summary page)*
  **Why:** #16 auto-fetches upcoming-earnings dates into `catalysts`
  (type=earnings, status=upcoming, `EARNINGS_CALENDAR_SOURCE`), but they
  surface only as per-row badges. There's no single "what reports in the
  next two weeks across everything I track" view — the exact question the
  earnings guard is about.
  **What:** A card on the Catalysts page (or Summary if it fits better):
  tracked tickers' upcoming-earnings catalysts within N days (default 14),
  sorted by date, with the existing days-to badge styling and links to the
  stock pages. Pure read of existing rows — a `lib/queries` helper + UI.
  **Accept:** With real fetched dates, the card lists them soonest-first and
  shows nothing (with a quiet empty state) when no reports are near.

- [x] **33. Score-history sparkline on the stock page** *(small–medium —
  done)*
  **Why:** `stock_scores` keeps an append-only per-ticker time series
  (retention thins to one row/ticker/day precisely so history survives), and
  Signal Performance proves the data is usable — but `/stock/[ticker]` shows
  only the latest score. "Is this name improving or decaying?" requires the
  performance page detour.
  **What:** Small SVG sparkline of `overallScore` over the stored history
  (reuse the Sector Scout sparkline idiom from #25) next to the score block,
  with min/max labels and a "N points since <date>" caption so short
  histories aren't over-read.
  **Accept:** Renders real history for a long-tracked ticker; a
  single-point history states "no trend yet"; no new deps.

## Tier 3 — Operational QoL

- [x] **34. Test-notification button in Settings** *(small — done)*
  **Why:** Notification wiring (desktop toast + ntfy, #15/#9) can only be
  verified by lowering `notifyMinSeverity` and waiting for a real alert —
  so a broken ntfy topic or PowerShell toast path stays silent until it
  matters.
  **What:** "Send test notification" button in the Settings notifications
  block → `POST /api/settings/test-notification` → calls the existing
  channel senders directly (bypassing severity gating, labeled as a test),
  returns per-channel ok/error for display.
  **Accept:** Clicking it with ntfy configured delivers to the phone and
  reports per-channel results in the UI; with nothing configured it says so
  instead of pretending success.

- [x] **35. Acknowledge-all on `/alerts`** *(small — done)*
  **Why:** The alerts page (#27) acknowledges one row at a time; after a
  noisy day (stale-data warnings across 45 tickers) that's dozens of
  clicks.
  **What:** An "Acknowledge all shown" button that acks the current
  *filtered* set via one API call (`POST /api/alerts/ack-all` with the same
  filter params), with row count in the label.
  **Accept:** Filter to a subset → button acks exactly that subset; route
  test covers filter scoping.

## Tier 4 — Follow-ups spotted while shipping v3 (2026-07-09)

- [x] **36. Alert-table retention** *(small — done)*
  **Why:** `runRetention` pruned snapshots/drawdowns/score history but never
  `alerts` — 278 unacked rows and growing, dominated by repeated stale-data
  warnings the 20h dedupe happily re-emits every day.
  **What:** In `runRetention`: auto-acknowledge non-critical alerts left
  unacked for 14+ days (no longer actionable; the row survives as audit
  trail; **critical is never auto-acked** — it waits for the user), and
  delete acknowledged alerts older than 90 days. Reported in the maintenance
  log line.
  **Accept:** Persistence test covers auto-ack severity gating, recent rows
  untouched, and the delete window. Live run auto-acked 29 stale alerts on
  the real database.

- [x] **37. Sector data for holdings** *(medium — done)*
  **Why:** Nothing stores a sector, so the sector half of
  `concentrationWarnings` (#30) can never fire, and the portfolio has no
  sector breakdown. Yahoo `quoteSummary` `assetProfile` carries
  sector/industry, and `fundamentals.ts` already requests that module for
  discovery — the plumbing exists.
  **What:** Add `sector` to `portfolio_holdings` (migration). Backfill in
  daily maintenance (and on portfolio sync) via a small
  `getYahooSector(ticker)` (or reuse the fundamentals fetch), only for rows
  missing it. Pass real sectors into the #30 concentration scan (drop the
  `sector: null` placeholder), and show a small sector-weights strip on
  `/portfolio`.
  **Accept:** After one maintenance run, real holdings carry sectors, the
  strip renders true weights, and an over-cap sector emits the warning
  alert (persistence-tested with seeded sectors).

- [x] **38. `trade_setups` retention that preserves the backtest's episodes**
  *(small — done)*
  **Why:** `scanForSetups` re-inserts every live setup on each refresh
  (~854 rows in the first 12 days) and nothing pruned the table. The catch:
  the setup backtest's `dedupeSetups` chains rows into episodes by ≤10-day
  gaps and resolves outcomes from each episode's **earliest** row, so naive
  deletion could split episodes or change their entry/stop levels.
  **What:** In `runRetention`: for non-active rows older than 30 days, keep
  the first row (`MIN(id)`) per (ticker, setupType, day) — episode-start
  rows survive exactly and gap chaining is unchanged at day resolution.
  **Accept:** Persistence test proves `dedupeSetups` returns identical
  episodes before and after thinning, and active rows are never touched.

- [x] **39. Opt-in daily morning brief** *(small–medium — done 2026-07-10)*
  **Why:** Everything a trader should glance at each morning (market regime,
  earnings inside the avoid window, trades flagged Exit/Trim, buy-zone hits,
  fresh quality setups) is computed but spread across four pages; the
  notification rails (#9/#15/#34) were only used for reactive alerts.
  **What:** `src/services/morningBrief.ts` — `buildMorningBrief()` composes
  the sections (empty ones omitted) and `sendMorningBrief()` emits it once
  per day as an info alert (date in the message keys the dedupe) at the end
  of daily maintenance, pushing through the channels directly when the
  severity gate would suppress info (the `morningBriefEnabled` toggle is the
  opt-in; master `notifyEnabled` still applies; no double-send when the gate
  passes info). New config key + settings validation + Settings row, per the
  new-setting checklist.
  **Accept:** Tests cover section composition, quiet-day omission, the
  disabled/sent/already-sent-today paths, and exactly one alert row. Live
  compose against real data produced a correct brief (regime favorable, LLY
  Trim, six buy-zone names, five q≥7 setups, earnings section rightly
  absent).

- [x] **40. The jobs runner never loaded `.env`** *(small, operational bug —
  done 2026-07-10)*
  **Why:** Next.js loads `.env` for the app, but `npm run jobs` runs under
  plain tsx, which doesn't — so the background scheduler has been running
  **keyless** the whole time: quotes fell back to Yahoo, broker order sync
  and portfolio sync silently skipped, Alpaca clock phase detection
  approximated, and LLM-gated features ran rule-based even with a key
  configured. Found by comparing snapshot sources: dev-server refreshes
  wrote `alpaca`, scheduler refreshes wrote `yahoo`. The README's
  Scheduled-Task section even claimed `.env` was read.
  **What:** `src/lib/loadEnv.ts` — dependency-free `applyDotEnv` parser
  (comments, `export` prefixes, quotes, trailing comments; **never
  overwrites real env vars**) + `loadDotEnv()` called at the top of the
  three tsx entrypoints (`scheduler.ts`, `db/restore.ts`, `db/seed.ts`).
  Safe because every env read in the codebase happens at call time.
  **Accept:** Parser unit-tested (quoting, precedence, CRLF). Live: after
  restart, the scheduler's refresh wrote 45/45 snapshots with source
  `alpaca` (was `yahoo`), in 3s instead of a Yahoo-paced crawl.

- [x] **41. Surface the runner's env on `/status`** *(small — done
  2026-07-10)*
  **Why:** #40 stayed invisible for weeks because `/status` reports the
  *web process's* integrations while the scheduler is a separate process —
  "Alpaca: connected" on the page said nothing about the runner being
  keyless.
  **What:** The minute heartbeat now records the scheduler's own
  integration flags in its `job_runs` message (`alpaca=paper llm=on`);
  `schedulerEnvFromHeartbeat` (pure, in `status.ts`) surfaces it on
  `/status` and raises an amber warning when the web app has Alpaca but
  the runner reports `alpaca=off` — exactly #40's failure mode.
  **Accept:** Helper unit-tested (match, mismatch, both-keyless,
  legacy null message). Live: restarted runner heartbeat shows
  `alpaca=paper llm=on` on the page.

- [x] **42. Unacked-alerts badge in the header** *(small — done 2026-07-10)*
  **Why:** The alerts feed only warns if you visit it — 319 unacked rows
  (64 critical) had accumulated with zero ambient visibility; the header
  had a jobs-health badge but nothing for alerts.
  **What:** `AlertsBadge` (client, 60s poll of the new
  `GET /api/alerts/unacked-count`) next to `JobHealthBadge`: hidden at
  zero, muted amber-dot count normally, red when anything critical waits;
  links to `/alerts?ack=unacked`.
  **Accept:** Route test (acked rows excluded, criticals counted); live
  endpoint returns the real backlog and the chip renders in the header.

- [x] **43. Startup catch-up for missed daily maintenance** *(small,
  operational bug — done 2026-07-10)*
  **Why:** The 08:00 maintenance cron only fires while the runner is alive
  at 08:00. With the runner living in ad-hoc terminals, `job_runs` showed
  **zero `daily_maintenance` completions ever** and `data/backups/` didn't
  exist — no retention, no backups, no scheduled backtests had actually
  been happening. (The #18 Scheduled Task installer would prevent this but
  is opt-in and was never installed.)
  **What:** Pure `isDailyJobDue(lastRunAt, now, maxAgeHours=20)` in
  `jobHealth.ts`; on scheduler startup, when the last completed maintenance
  is missing or >20h old, run it 30s after boot (logged as a catch-up).
  **Accept:** Due-check unit-tested (never/stale/unparseable/recent). Live:
  restarted runner logged the catch-up, ran full maintenance (discovery,
  159 earnings quarters, retention), and wrote the **first backup ever**
  (`finance-agent-2026-07-10.db`, 12.9 MB).

## Archive — v2 (2026-07-06 review), all done 2026-07-09

`#15` Windows desktop notifications · `#16` auto-fetch upcoming earnings
dates (earnings guard live) · `#17` setup outcome backtest (Signal
Performance §4) · `#18` jobs runner as a Windows Scheduled Task · `#19`
`db:restore` backup restore path · `#20` SQLite housekeeping in maintenance ·
`#21` market-regime context for entries · `#22` trade & journal CSV export ·
`#23` price-chart volume + event markers · `#24` entity watch + new-mention
alerts · `#25` Sector Scout industry trend sparkline · `#26` split
`marketData.ts` into quotes/bars/orchestration · `#27` alerts history page ·
`#28` esbuild override for drizzle-kit's dev-only advisory.

## Archive — v1 (2026-07-01 review), all done 2026-07-05

Kept for git-history reference ("roadmap #N" in commit messages):
`#1` Alpaca order-fill sync · `#2` data retention · `#3` scheduled Signal
Performance backtest · `#4` job-health heartbeat + badge · `#5` drizzle-kit
migrations (schema written once) · `#6` in-memory SQLite test harness ·
`#7` parallelized Sector Scout · `#8` Yahoo over plain HTTP (browser demoted
to fallback) · `#9` alert notifications (desktop/ntfy) · `#10` bracket-leg
auto-close · `#11` watchlist bulk import · `#12` → carried to #26 ·
`#13` /status page · `#14` daily VACUUM INTO backups.
