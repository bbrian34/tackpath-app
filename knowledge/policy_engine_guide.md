# TackPath Policy Engine — What Was Built

**Live at:** tackpath.com/policy-engine-recovery.html
**Status:** Functional prototype. Fully isolated — no live TackPath data, no database, no backend, no API calls. Nothing on the real site (dispatcher.html, driver.html, fleet.html) was touched building any of this.

This document explains six connected pieces built today, in the order they were built and the order they depend on each other. Each section covers what it is, what it actually does, and how to use it.

---

## 1. The Policy Engine (the foundation everything else sits on)

**What it is:** A way to tell TackPath, in plain English, how your business should operate — and have it turned into real, enforceable rules instead of a vague instruction.

**What it does:** You type a sentence like *"If a driver is more than 20 minutes late, notify the dispatcher."* TackPath parses that into four parts:

- **Trigger** — what situation this responds to (driver late, driver stalled, delivery failed, new order, driver unavailable, customer cancels, route reassigned, delivery at risk, driver arrives, stop completed — 10 total)
- **Action** — what should happen (notify dispatcher, notify driver, notify customer, log the event, reassign the stop, change the route, change the delivery window, escalate, require approval — 9 total, plus 4 high-risk actions that are permanently blocked: cancel a delivery, issue a refund, change pricing, override an SLA)
- **Scope** — which deliveries this applies to (all, critical priority, standard, or a specific client)
- **Priority** — a number 1–10 used only when two rules genuinely conflict

Every rule also carries an **effect**: `allow` or `suppress`. A suppress rule (like *"Never notify customers about delays"*) doesn't just sit next to an allow rule — it can genuinely block that action from happening, and TackPath will tell you plainly when that's occurred.

**Risk tiers, and why they matter:** Every action is tagged low, medium, or high risk.
- Low risk (notifications, logging) happens automatically.
- Medium risk (reassigning a stop, escalating, changing a route) always requires a human to approve it first.
- High risk (cancellations, refunds, pricing changes, SLA overrides) cannot be enabled through this engine at all, in this version, on purpose.

**Conflict detection, done properly:** If you create two rules that could genuinely both apply to the same real event, opposite effects, same action, TackPath flags it and asks you to resolve it, rather than silently picking one. This was tested specifically: rules like *"notify when >20 min late"* and *"never notify when ≤10 min late"* are correctly recognized as **not** conflicting, because no single event can ever satisfy both. Rules that *can* genuinely overlap are correctly caught.

**How to use it:**
1. Go to the **Create Rules** tab.
2. Type a rule in plain English.
3. TackPath shows you exactly what it understood — trigger, action, scope, priority — before anything is saved.
4. Click **Confirm & Add Rule**. Nothing is created until you approve it.
5. If something's ambiguous (like *"if a driver is late"* with no number), TackPath asks a clarifying question instead of guessing.
6. Every rule can be edited, disabled, deleted, or have its priority changed at any time from the same list.

**One honest limitation:** the natural-language understanding is deliberately simple right now — pattern-matching against a fixed vocabulary, not a true AI model. That was an intentional choice: get the underlying decision logic correct and safe first, and let a real language model translate freely-worded requests into this same structure later, without ever letting the model make the actual decision.

---

## 2. Route Recovery Agent

**What it is:** The answer to "okay, something's wrong — now what?" Route Recovery is what actually gets invoked whenever a rule's action is *"reassign the stop."*

**What it does:** Given a driver's route and a stop they're going to miss, it checks every other available driver and asks three real questions:
1. Do they have room in their own route (capacity)?
2. Can they actually reach that stop in time, given where they currently are?
3. Would inserting this stop break any of *their own* existing deadlines?

It then recommends the single best option — the one adding the least extra distance while still meeting every deadline — and shows exactly what that costs (extra miles, extra minutes) and confirms whether the SLA is actually restored.

**Verified example:** a driver stuck 16.9 miles away was correctly ruled out because he couldn't reach the stop in time even after reassignment — the same reasoning a real dispatcher would use, not an arbitrary distance cutoff.

**One honest limitation, stated plainly on the page itself:** distance is calculated as a straight line at a fixed average speed, not real traffic-aware routing. A real version would plug in the same live GPS/traffic data SmartTrack already uses — this was a deliberate placeholder to prove the decision logic first.

**It never acts on its own.** Every recommendation requires a human to click Approve or Reject.

**How to use it:** Route Recovery isn't a separate tab — it activates automatically, inline, whenever a rule's action is "reassign the stop" and that rule actually fires (visible in Test Rule, Driver Agent, or Command Agent).

---

## 3. Driver Agent

**What it is:** The other end of the conversation — instead of dispatch defining rules, a driver reports something happening in real time, in their own words.

**What it does:** A driver types something like *"Customer isn't home,"* *"I'm stuck in traffic, running 25 minutes late,"* or *"My van just broke down."* That plain report is turned into a real structured event and run through the exact same Policy Engine and Route Recovery already built — not a separate decision system. The driver gets a simple, human confirmation ("Thanks, letting dispatch know now."). Dispatch sees the full real mechanics: which rules fired, what needs approval, and any Route Recovery recommendation, automatically.

**If nothing matches:** rather than guessing or failing silently, TackPath tells the driver it's flagging this for dispatch directly — a graceful fallback for anything genuinely outside what's automated yet.

**How to use it:** Go to the **Driver Agent** tab. Type a report, or click one of the four preset examples. Watch the Dispatch View panel on the right update with the real decision trace.

---

## 4. Command Agent

**What it is:** A way for a dispatcher to ask TackPath questions about the operation in plain English.

**What it does — and just as important, what it deliberately doesn't do:** Command Agent has **no decision-making power of its own.** It never invents an answer. Every response is read directly from real data — the actual rules list, the actual decision log, or a direct call into the same evaluation function Test Rule uses. If you ask it something outside its scope (tested directly: *"What's the weather like?"*), it says so honestly instead of guessing.

It can currently answer:
- *"Any pending approvals?"*
- *"How many rules are active?"*
- *"What rules exist for driver late?"*
- *"What would happen if [some situation]?"*
- *"Is anything at risk right now?"*

**How to use it:** Go to the **Command** tab and ask, or use one of the five preset buttons.

---

## 5. History / Audit Trail

**What it is:** A complete, honest record of every decision the system has ever made — not just the ones waiting on a human.

**What it does:** Every time a rule fires, gets suppressed, or needs approval, it's logged with a timestamp, the exact rule responsible, and the event that triggered it. Pending approvals show real **Approve** and **Reject** buttons that actually change the record — approving or rejecting genuinely updates that entry's status everywhere it's referenced (including what Command Agent reports).

**How to use it:** Go to the **History** tab. The top panel shows anything currently waiting on you. The bottom panel shows the complete history, newest first.

---

## 6. Onboarding Agent

**What it is:** A guided setup flow for a brand-new courier company, so getting started doesn't mean manually writing rules from scratch.

**What it does:** TackPath asks five real, bounded questions:
1. How many drivers do you run?
2. How many minutes late before dispatch should be notified?
3. Should customers also be notified when a driver's late?
4. If a driver becomes unavailable, reassign or escalate?
5. If a delivery fails, notify the customer automatically?

From those five answers, it creates real, active rules directly in the same shared rule set used everywhere else in the system — verified directly: after onboarding, the exact new rules appear immediately in the Create Rules tab, because it *is* the same list, not a separate copy.

**How to use it:** Go to the **Onboarding** tab (first in the list) and answer the questions as they come.

---

## How everything fits together

```
Onboarding Agent  ──creates──▶  Policy Engine rules
Driver Agent      ──reports──▶  a real event
                                    │
                                    ▼
                             Policy Engine
                          (evaluates the rules)
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
                 fires an action          suppresses an action
                        │
                 if the action is
                "reassign the stop"
                        │
                        ▼
                Route Recovery Agent
             (recommends who should
              take the stop, and why)
                        │
                        ▼
              Human approves or rejects
                        │
                        ▼
                  Logged in History

Command Agent reads from all of the above, on request, and decides nothing on its own.
```

Every one of these connections was actually tested, not just described — including one real bug caught and fixed along the way (two preset buttons had a JavaScript escaping error that silently did nothing when clicked; found by testing real clicks instead of shortcutting through the input field directly).

---

## What this is *not*, honestly

- Not connected to any real database. Refreshing the page clears everything.
- Not connected to real TackPath drivers, jobs, or GPS data. All sample data (routes, drivers, distances) is hardcoded for demonstration.
- Not using a real AI language model anywhere. All parsing is deterministic pattern-matching against a fixed, closed vocabulary — a deliberate choice so the underlying logic could be proven correct before adding a model on top of it.
- Not autonomous. Every medium-risk action requires human approval; every high-risk action is blocked outright.

The next real steps, when ready, are: a real database (Supabase, matching the rest of TackPath), wiring real events from the actual dispatcher/driver apps instead of typed reports, and making the approved actions actually execute against real jobs instead of just logging what *would* happen.
