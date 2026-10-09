# Project SID technical audit — 2 October 2026

## 1. Executive summary

1. A lost bridge acknowledgement can corrupt the bank because the runtime rolls back its ledger even when Minecraft has already moved the emeralds.
2. Work-order settlement can pay twice, mark unpaid work complete, and erase wages after a failed reserve payment.
3. The nightly agent backup omits SQLite, while the deployment guide points to an obsolete plugin artifact, making recovery and rollback unreliable.
4. The scheduler serializes individual actions rather than whole citizen jobs, and live navigation stalls and rejected builder plans show substantial wasted work.
5. The dashboard grants trusted-LAN callers mayor controls without authentication, and the plugin trusts the runtime for privileged actions rather than independently authorizing them.

### Scope and evidence boundary

**Located source:** `C:/Users/jrmym/Documents/ProjectSid/sid-local`, not the older `C:/Users/jrmym/Documents/ChatGPT/Project Sid` workspace. **Live runtime:** LXC 119, `/opt/sid-local`, systemd `sid-local`, running as `sid-local`, Node **22.23.3**. The SSH aliases `ct119` and `ct120` work. No production files, configuration, gameplay state, or services were changed during this audit.

SHA-256 comparison covered 119 selected deployed source/document/script files: 114 match the newer local copy, three diagnostic helpers exist only remotely, and two differ: the remote `SIDLocal.java` is an obsolete short version, and the local dashboard changed during this audit (last modified 03:04 America/Chicago). All compared Node `.mjs` runtime sources match. The manifest records this final comparison; dashboard UI behavior may differ between copies. The plugin installed in LXC 120 matches **`server-plugin/build/libs/SIDLocal-2.13.0.jar`**, SHA-256 `f2566473bae2d124dc8dc57fc28770eb8cf8ac9b74f054d3ef4c0eaadf82476f`. Neither `dist` JAR matches. Java findings below refer to the local source; matching the JAR does not prove that this unversioned source produced it. I did not rebuild, decompile, or execute destructive plugin tests.

**Verification:** 191/191 existing tests and all four named simulations passed locally on **Node 24.15.0**, not the production Node 22 runtime. Six additional isolated demonstrations reproduce faults; their passing result means the defect was reproduced. They use fake world adapters and in-memory SQLite. They are not live Minecraft tests. No full 30-day soak, restoration drill, Java/Fabric build, or TPS profile was performed.

Live observations around **07:47–07:52 UTC** (02:47–02:52 America/Chicago):

| Observation | Result and limit |
|---|---|
| Runtime | Active; `NRestarts=0` in the current systemd accounting period; cgroup memory 161,767,424 bytes |
| Snapshot | Connected; age 0 seconds at sampling; 14 of 18 homes marked built |
| Last two hours of logs | 350 `nav_stalled`, 15 `unstuck`, 34 `agent_error`; 22 errors reject plans because the builder is already building |
| Plan context | 473 logged action contexts, 17,328–35,162 characters, excluding the separate system prompt/schema; these are not measured token counts |
| Bank | Last audit: physical 520, liabilities 520, difference 0; accrued unpaid wages 2,096; tax reserves 0; minted today 256/256; mintable goods value 1,241 |
| Persistent data | memory.json 1,771,198 bytes; main SQLite file 10,391,552 bytes, excluding WAL/SHM |
| SQLite rows | social_events 22,351; relationship_marks 556; orders 379; goals/milestones 1,159; conversations 1,926; conversation_lines 7,400 |
| Orders | 232 EXPIRED, 110 VERIFIED, 23 CANCELLED, 12 OPEN, 2 CLAIMED; historical distribution does not establish a current completion rate |
| Dashboard | Unauthenticated LAN GET returned 200: `/api/state` 245,695 bytes/42.9 ms, `/api/relationships` 63,984 bytes/29.4 ms; one sample each, not p95 or CPU measurements |
| Backups | Agent-memory timer and world-backup timer active; world backup service last result success; latest archive 174 MB; existence is not proof of restorability |

Evidence files in this directory: `live-observations.json`, `deployment-evidence.txt`, `source-manifest.json`, `unit-tests.log`, four simulation logs, `reproduction-results.json`, `reproduce.mjs`, `npm-audit.json`. Source references below are relative to the located source root and use one-based lines. Severity describes consequences for this home-lab town, not real financial systems. S = roughly ≤1 day, M = 2–5 days, L = >5 days including validation; estimates are not commitments.

## 2. Findings table

V = verified source; R = isolated reproduction; L = live observation; I = inferred consequence, not observed exploitation or failure.

| ID | Dimension | Severity | Likelihood | Evidence | Running-town impact | Recommended fix | Effort |
|---|---|---|---|---|---|---|---|
| F01 | B,C,F | High | Medium; disconnect-dependent | V/R: `agent-core/skills/banking.mjs:73–80`; `node-bridge/bridge.mjs:62–63,112`; Java `SIDLocal.java:740,804–808`; B01 | Withdraw executes, ACK is lost, balance is restored; vault is undercollateralized. Deposit has the reverse discrepancy. Client reply cache disappears on reconnect. | Durable operation IDs, outcome query, UNKNOWN reconciliation; never compensate merely because transport failed. | L |
| F02 | B,E | High | Medium; competing payment paths | V/R: `agent-core/intel/executor.mjs:212–223,233–241`; `agent-core/skills/quests.mjs:143–152`; B03/B04 | Concurrent turn-in pays twice; empty treasury still produces VERIFIED and loses an actionable payable; advance is paid before the claim is secured. | Reserve claim first; CAS settlement state, durable payable, one payment operation per order. | M |
| F03 | B,E | High | Medium | V/R: `agent-core/skills/economy.mjs:77–97`; B02 | Failed reserve payment is logged, then its amount is deducted from accrued wages and reported paid. Payroll itself has no single-flight guard. | Subtract confirmed payment amounts only; serialize payroll/reserve allocation; persist batch and per-recipient results. | M |
| F04 | F,B | High | Medium when chests fill | V: `server-plugin/src/main/java/local/sid/SIDLocal.java:2093–2095,2111–2120`; I | Partial deposit refunds only the overflow then removes accepted coins from vault: accepted coins disappear. Partial treasury transfer returns no moved count, while Node subtracts the requested amount. | Preflight capacity, full rollback or explicit actual counts; conservation tests against real chest inventories. | S/M |
| F05 | C,H | High | High on restore | V/L: `systemd/sid-memory-backup.service:6`; `scripts/backup-world.py:34–44` | Memory backup omits SQLite and conversation files. World and memory backups are separate checkpoints; restored justice, orders, balances and world may disagree. | Coordinated recovery checkpoint; SQLite online backup; copy complete state and runtime-mutated plugin configuration; isolated restore drill. | M |
| F06 | H,A | High | High on next documented deploy | V/L: `DEPLOY-NOW.md:9–10,21–22,30–37`; artifact hashes in `deployment-evidence.txt` | Guide copies obsolete dist plugin and stale config; source is unversioned and local/deployed plugin source differs. Partial SCP can create mixed releases. | Establish one Git source, immutable release manifest, config migrations, staged install and tested rollback. | M |
| F07 | B,A,E | High | High | V/L: `agent-core/main.mjs:194–205,966–967,1009–1051,1226–1265,1311–1326` | `working` protects worker jobs, `thinking` protects some LLM turns, and `exclusive` protects one action only. Jobs can interleave stale assumptions and overwrite movement; a stuck worker blocks its own safety evaluation. | Per-citizen intent owner/epoch and cancellable job lifecycle, with bounded safety preemption and state revalidation. | L |
| F08 | B,E,C | High | Medium on restart/error | V/R: `agent-core/skills/justice.mjs:263–277,334–350,386–400`; B05 | Trial is held/TRIED before awaited speech and sentencing; saved intermediate state cannot resume. Jail record may exist although confine failed. Release removes record before world confirmation. | Persist verdict and pending effects together; restartable sentence executor; truthful arrest/release statuses. | M |
| F09 | G | High | High exposure on trusted LAN; abuse untested | V/L: `agent-core/main.mjs:1096–1115,1124–1139`; unauthenticated GETs | LAN callers bypass key and POST controls impersonate owner. Missing token opens access entirely. No Origin/content-type protection for writes; cross-site write risk depends on browser network protections. Tailscale does not remove LAN exposure. | Authenticated write session, roles, Origin/CSRF enforcement, JSON-only writes; separate read-only feed. | M |
| F10 | G,F | High | Medium after token/runtime compromise | V: `SIDLocal.java:794–797,1475–1478,2054–2085,2098–2133`; `plugin.yml:19–25` | A session-owning bridge client can invoke vault withdrawal/mint, property registration, confine and free placement. Numeric limits are not authorization. General `/sid` permission defaults to all players. | Capability table enforced by plugin; operator vs worker scopes; role- and state-specific approvals for economic/justice effects. | M |
| F11 | C,B | Medium | Medium | V: `agent-core/memory.mjs:20–39`; `main.mjs:62,181` | Atomic rename prevents normal torn JSON but not loss of last 30 s or cross-store divergence. Failed debounce flush is swallowed and dirty is cleared first. Shutdown saves before all work drains. | Visible persistence health; restore dirty/retry on failure; drain accepted operations; move critical transitions to durable transactions. | M |
| F12 | D,J | Medium | High; large contexts observed | V/L: `main.mjs:1205–1228`; `lm.mjs:214–219,291–303,427–429`; `cognition.mjs:116–133` | Context fan-in has no total token limit or town call budget. Endpoint queue is unbounded; repair/review/speech add calls. Message trigger bypasses min-gap; latency reflects successful calls only. | Budgeted context assembly, bounded priority queue with queue deadline, token/call metering, operational action menus. | M |
| F13 | E,D | High | High funding pressure observed | V/L: `civic.mjs:159–174`; `economy.mjs:40–44,62–68,79–95` | Every warehouse deposit can accrue producer pay/mintable value, without provenance proving new production. Largest debt gets paid first; fixed real-day cap cannot fund indefinite wages. Current arrears are 2,096. | Pay once per production lot/completed service; reserve job funding, fair aged payroll; explicitly define issuance and inflation targets. | L |
| F14 | E,B | Medium | High | V: `skills/quests.mjs:163–179`; `intel/orders.mjs:125–149` | Patrol increments after four unsuccessful walks; community service can credit a cosmetic effect. Board progress can change terminal records; merge raises quantity without renegotiating reward. | Server-observed arrival/work receipts; guarded transitions; separate simulation effort from completed economic work. | M |
| F15 | E,C | Medium | High with repeated social traffic | V/R: `skills/gossip.mjs:49–61`; `intel/social.mjs:30–38,49–51`; B06 | Only 12 known rumors are retained; forgotten stories can recur and reapply harm. Distortion increases impact without veracity weighting; repeated effects can defeat trust recovery and block trade. | Durable heard-ID TTL, per-event impact cap, correction/retraction channel, calibrated recovery metrics. | M |
| F16 | F,J | Medium | Medium; profiling needed | V: `SIDLocal.java:614–628,643–663,2212–2234`; `ChunkLeases.java:41–54` | Main thread handles up to 32 whole tasks/tick, synchronous JSON/file saves and all snapshots. Separate per-actor 5×5 tickets bypass the bounded async chunk loader and need unified ownership. | Time-budgeted scan jobs, one chunk lease owner/refcount system, async serialization/writes of immutable copies, profiling. | L |
| F17 | F,E | Medium | High stalls observed | V/L: `GlobalNavigation.java:37–62`; `agent-core/intel/executor.mjs:155–158`; `roles/miner.mjs:84` | Straight-line local legs fail on obstacles needing prolonged movement away from target; no global route planner. A 1,000-block town clamp remains in GOTO. Finished mine has no expansion task. | Route memory/coarse waypoints, failure reasons and backoff, remove policy clamp, explicitly enqueue funded new mining faces. | M/L |
| F18 | C,J | Medium | High over weeks | V/L: `intel/db.mjs:36–41,70–89`; `intel/social.mjs:89–92`; `intel/index.mjs:67–76`; `main.mjs:1148–1152` | Unbounded history tables and synchronous queries share the network thread. Relationship endpoint makes about 612 queries for 18 citizens. busy_timeout can block it for two seconds; repeated full dashboard assembly costs grow. | Retention/rollups with replay checkpoint; batch pair queries; cached dashboard view; measured SQLite worker extraction. | M |
| F19 | C,A | Medium | Medium during upgrade | V: `main.mjs:68–82,931–932`; `intel/index.mjs:46–60`; `intel/db.mjs:80–89` | One-time flags and startup repairs are not a versioned migration ledger; schema CREATE IF NOT EXISTS is not a column migration system. VACUUM/replay can delay startup. | Numbered transactional migrations, preflight backup and compatibility gate, pure migration fixtures. | M |
| F20 | A | Medium | High maintenance cost | V: `main.mjs:894–941,1013–1044,1218`; `civic.mjs:1689`; `lifesim.mjs:169–175` | Optional dependency calls mask absent wiring; job selectors can mutate state even when a higher-priority job wins; timeouts do not cancel underlying queued effects. Feature ownership and shutdown ownership are unclear. | Typed narrow ports, required dependency assertions, pure selection then commit, shared clock/cancellation scope. | L |
| F21 | H | Medium | Medium on partial outage | V: `scripts/watchdog.sh:10–18`; `scripts/backup-world.py:21–43`; `main.mjs:38–43` | Watchdog equates an open TCP port with usable plugin health and can restart indefinitely on auth/protocol errors. RCON backup save-off precedes its try/finally; short reads/EOF are mishandled. Log payload `type` can replace event name. | Classify dependency outage; circuit breaker; guarded save-on recovery and protocol parsing; protected log envelope. | M |
| F22 | I | Medium | High blind spots | V/R: `tests/runtime.test.mjs:131–147`; `tests/bridge-rate.test.mjs:23–42`; `test-life-sim.mjs:31–34`; six reproductions | Passing fake-world tests miss Java inventory semantics, ACK loss after commit, scheduling overlap and restart recovery. Wall-clock timing assertions are load-sensitive; no flake reproduced in this run. | Fake clock for policy tests; real-loopback integration separately; disposable Paper/Citizens world with failure injection. | L |
| F23 | G,H | Medium | Unknown reachability | V: `package.json:23`; `server-plugin/build.gradle:18`; `npm-audit.json` | npm audit reports two moderate package entries from one uuid advisory through exceljs; not evidence of an exploitable export route. Citizens SNAPSHOT is mutable without dependency locking. Secrets were previously shared in this conversation. | Trace advisory call path, choose tested compatible fix; lock dependencies/checksums; rotate exposed tokens outside artifacts; no blind force downgrade. | S/M |
| F24 | J,G | Low | Medium | V: `client-mod/src/main/java/local/sid/minimap/SidFeed.java:24–48`; `MinimapConfig.java:28` | Client duplicates full dashboard pulls and relies on keyless LAN; async callback writes nonvolatile `busy`; transient failure may keep an old citizen list. Auth tightening will break this feed unless migrated. | Scoped read-only position feed, atomic/volatile completion handoff and explicit stale age; coordinate with dashboard auth rollout. | S |

No Critical finding is assigned: the verified scope is a private game town, and no arbitrary host execution or Internet-wide exposure was demonstrated. F10 is a trust-boundary weakness, not proof that chat currently exposes every plugin opcode: Node's Ajv action schema, governor-only pardon check, jail guard and RCON allowlist do restrict paths. Preserve them.

## 3. Top ten recommendations, in priority order

### 1. Establish a restorable baseline before changing behavior — F05/F06

**Change:** `systemd/sid-memory-backup.service`, `scripts/backup-world.py`, `DEPLOY-NOW.md`; add a checkpoint manifest and restore script. Include memory, SQLite via the online backup API, conversation files, current plugin data/config, world, actual JAR, runtime release hash, Node/Java/Citizens versions. Use a brief coordinated pause/drain for a coherent cross-service recovery point; a live SQLite snapshot alone is not a cross-world transaction. Keep encrypted copies off the Proxmox storage as well as locally. Fix save-on cleanup coverage before relying on the existing world backup script.

**Verify:** restore to disposable directories/world, run SQLite integrity_check, load memory, compare inventory/ledger totals and pending operations, start isolated agents and confirm snapshots. Record restore time and recovery-point age. Existing archive success is insufficient.

**Rollback:** retain current backup jobs until the new restore succeeds; keep both for one retention cycle. Never overwrite the live state while testing recovery.

### 2. Make money movements reconcilable — F01/F03/F04

**Change:** `skills/banking.mjs`, `skills/economy.mjs`, `node-bridge/bridge.mjs`, plugin vault cases. Introduce operation ID, payload hash, PREPARED/SENT/CONFIRMED/UNKNOWN status, actual moved count and durable receipts. Persist intent before send; carry the same ID across reconnect; query status before retry. Reject reuse of an ID with different contents. Make uncertain operations block only their affected account/resources until reconciled. Add a payroll batch lock and decrement arrears only for confirmed credits.

Minecraft world storage and an external ledger are not one atomic transaction. A persistent plugin receipt written after mutation still has a crash window; use write-ahead intent, inventory/version preconditions and recovery reconciliation, and explicitly document any remaining boundary instead of promising exactly-once execution. Correct partial deposit refund and treasury actual-count handling independently first.

**Verify:** B01/B02 become regression tests for preserved invariants; fill a chest with room for 3 of 10 emeralds, drop ACKs after mutation, restart either side at every boundary. Total coins and ledger liabilities must reconcile after recovery.

**Rollback:** use an additive protocol version with feature flag; deploy receipt-capable plugin first. Drain UNKNOWN operations before reverting Node; never erase pending receipts to make rollback appear clean.

### 3. Give orders an authoritative settlement state machine — F02/F14

**Change:** `intel/orders.mjs`, `intel/executor.mjs`, `skills/quests.mjs`. Claim with compare-and-set before an advance; use OPEN → CLAIMED → DELIVERED → PAYMENT_PENDING → VERIFIED (or a separate fulfilment/payment pair). Reserve funding or record an explicit payable, with a unique order-payment ID. Repeated turn-in returns the stored result. Progress requires the correct state, contractor and finite positive count; evidence of arrival/delivery/work is separate from a citizen's assertion.

**Verify:** race worker completion against two LLM turn-ins and a player contribution; exactly one payment/credit. Insufficient funds preserve payable debt. Expired/cancelled orders cannot be revived by stale callbacks. B03/B04 must stop reproducing.

**Rollback:** add fields/tables first; shadow old transitions, switch one quest category, and retain old views during migration. Do not roll back to an executor that ignores new PAYMENT_PENDING rows without a compatibility adapter.

### 4. Introduce one job owner per citizen — F07/F20

**Change:** extract `runtime/agent-controller.mjs` and `runtime/job-policy.mjs` from `main.mjs:951–1054`; route LLM, role, court, furnishing and player intents through it. Every job carries intent ID, state revision, resource claims, deadline, cancellation signal, priority and phase. Safety may preempt movement, but must reconcile a sent inventory action before replacement. Split selection from mutations: do not call side-effectful job factories for candidates that lose priority. Preserve current priority order in characterization tests, then deliberately put critical survival ahead of long-standing nonemergency player orders.

**Verify:** delayed inference returns after an order change; builder and furnishing target the same NPC; role is cancelled during give; bridge disconnects. No conflicting intent executes, cancelled queued requests do not later fire, and a safety need is examined within one fresh snapshot. Compare shadow-policy choices over a day before changing the winner.

**Rollback:** keep the old scheduler selectable per citizen; canary one noncritical citizen, then builder/miner. Abort/drain the canary job before switching back.

### 5. Separate dashboard viewing from authority — F09/F10/F24

**Change:** extract the HTTP server from `main.mjs`. Keep phone access through Tailscale, require authentication for all mutation routes including LAN, and fail startup if write authentication is absent. Replace query-string admin keys with a session exchange and short-lived secure cookie over HTTPS; enforce exact allowed Origin, CSRF token and application/json, request/body limits, and UUID-backed mayor identity. Provide a least-privilege GET feed for the Fabric minimap. Audit plugin capability checks separately: ordinary work sessions should not independently mint or register arbitrary vaults.

**Verify:** from LAN, Tailscale and a hostile-origin test page: anonymous POST denied; read-only credential cannot vote/command; authenticated phone works; expired credential rejected; Fabric feed continues. Test chat attempts to demand forbidden operations against the policy layer, not just the prompt.

**Rollback:** keep read-only access available; roll back UI/session code while retaining denial of unauthenticated writes. Do not restore the LAN owner bypass as a convenience fallback.

### 6. Make sentences restartable and clock semantics explicit — F08

**Change:** `skills/justice.mjs`, `roles/sheriff.mjs`, `intel/orders.mjs`. Atomically store verdict and planned effects before optional speech. Execute durable fine/service/warrant effects independently from dialogue. Mark a sentence applied only after confirmation; on failure retain ARREST_PENDING/RELEASE_PENDING. Reconcile cases with missing service quests; a full order board currently can leave an investigation with `quest:null` and no retry. Do not resolve a reconcile verdict until its required service is completed, or explicitly define service as advisory.

Define sentence duration as active simulation seconds or wall time, not both. Current tick uses elapsed real time capped at 60 s, only while world snapshots are fresh: downtime over a minute does not serve the full time. Clamp negative deltas and test day-clock resets. Do not base guilt solely on prior convictions: the current 1.5-point prior maximum reaches the 1.5 fault threshold without fresh evidence.

**Verify:** B05, restart during speech/confine/release, no sheriff, full board, no jail, three occupied cells, backwards clock, ten-minute outage. Every TRIED case has recoverable pending effects; nobody is reported freed while still confined.

**Rollback:** additive status adapter and pending-effect table; disable new trials while reconciling, preserve existing sentences, and retain a tested mayor pardon path.

### 7. Fund actual output and unblock stone supply — F13/F17

**Change:** `civic.mjs:159–174`, `skills/economy.mjs`, `roles/miner.mjs:84`, `materials.mjs`, builder admission in `main.mjs`. Give production/delivery lots stable IDs; moving already-owned warehouse stock is not new production. Reserve materials and funding for one build before starting another. When `mine.next` reaches layout.length, issue an explicit survey/expansion task or mark producer unavailable and surface that constraint to the builder. Use alternative approved materials only when structural rules permit.

Pay small aged debts before repeatedly serving the largest creditor; reserve essential food/mining compensation. Define real-day issuance (currently 256) versus 35-minute simulation days. A real day contains about 41 town days, so a 30-town-day test spans only 17.5 real hours and may miss a mint reset. Set a bounded arrears target before changing the cap; raising the cap alone hides accounting defects.

**Verify:** withdrawal/redeposit cycle produces zero new mint credit; production receipts counted once; 30-day and multi-midnight soaks show bounded arrears and builder progress. Track mined/delivered/reserved/consumed stone separately, not merely queued buildings.

**Rollback:** retain prior wage policy/config as a version; apply new rates prospectively. Do not delete historical debt or rewrite balances to hide failure.

### 8. Bound inference work and measure it — F12

**Change:** add `cognition/context-budget.mjs` and a task scheduler in `lm.mjs`; replace unlimited `...module.context()` composition with named budgeted sections. Keep immutable role/rules first, current action capabilities and essential perception next, then retrieved memories. Preserve identity/authorization outside all model text. Record actual provider usage when available and local tokenizer counts otherwise; character counts alone are not a reliable tokenizer.

**Initial tunable budgets, not measured guarantees:** planning input ≤4,000 tokens total including system/schema, 700 visible output tokens plus the existing 1,500 reasoning allowance; dialogue input ≤1,500/output ≤250; background summarization input ≤3,000/output ≤600. Town budget 240 background plans/hour, per-agent 12/hour with burst 2; reserve a separate bounded player-dialogue lane and a small emergency lane. Count repairs/reviews/failovers against a global model-call/token budget; allow one repair, then deterministic fallback. Cap endpoint waiting queue at 16 and attach a total queue deadline. Benchmark and adjust before enforcing budgets on every citizen.

**Verify:** log queue wait, first-token time, end-to-end latency, prompt/output tokens, invalid JSON, rejected intent, cancellation and fallback by task/model. Target initial p95 ≤45 s plan and ≤15 s player reply, queue wait ≤10 s; investigate violations rather than expanding queues. Test both PCs off and model loss mid-stream. Keep deterministic jobs operational. Plan review is not universal: `plan()` repairs invalid JSON; `proposeAndReview()` is a separate optional path.

**Rollback:** budget controller can be disabled while keeping telemetry; retain a bounded hard queue limit and rejection fallback.

### 9. Put performance and persistence behind explicit budgets — F11/F16/F18/F21

**Change:** add cached read models for dashboard/state and a compact positions feed. Batch relationships in two bounded queries instead of about 612; retain a replay checkpoint before pruning social history. Measure event-loop delay before moving SQLite to a single writer worker; queue bounds and transactional ownership still matter. Report flush failures and oldest unflushed change. Move only immutable serialization/file buffers off Paper's main thread; world reads/writes remain on the server thread. Replace 32 unbounded actions/tick with time-bounded scan continuations and a common chunk budget.

**Verify:** initial goals: Node event-loop p99 <50 ms, cached dashboard p95 <100 ms, Paper SID work p95 <5 ms/tick and server p95 MSPT <50 ms, 18 active NPCs, bounded loaded chunks. These require a profile; one HTTP sample proves none of them. Stress offline archive growth and query retention. Preserve client pacing at 15/s and agent gap 300 ms until measured changes justify it.

**Rollback:** cache/worker/scan changes behind flags, retain a compatible read path, drain outstanding scan jobs; never remove world-thread checks.

### 10. Adopt releases and a failure-oriented test gate — F06/F19/F22/F23

**Change:** put the discovered source into one Git repository after checking secret exclusions; stop concurrent editors from independently deploying the same files. Build immutable `/opt/sid-releases/<release-id>` with checksums, protocol/schema versions and frozen dependencies; activate via one atomic `current` link. Use a separate runtime config and state directory. Generate DEPLOY-NOW and artifact names from the manifest. Pin a tested Node 22 minor; `>=22` alone does not express the node:sqlite requirements.

**Verify:** test production Node version plus the chosen upgrade version; unit tests, six converted regressions, four simulations, then disposable Paper/Citizens integration and restore gate. Exercise timer policies with a fake clock rather than busy-wait timing. Verify dependency advisories by call path; do not accept npm's proposed exceljs major downgrade automatically. Freeze Citizens artifacts/checksums. For plugin upgrades, announce 60 seconds, drain runtime, stop server, back up, install, restart and health-check both protocol and gameplay.

**Rollback:** switch code link/JAR to previous tested release only when its schema reader is compatible; otherwise restore the coordinated checkpoint, acknowledging lost post-checkpoint play. Keep player warning and downtime window explicit.

## 4. Target architecture and staged migration

Keep one Node process and SQLite initially; microservices would add failure boundaries before these are resolved.

```text
Paper/Citizens events + observations
          |
  bridge adapter (epochs, request IDs, UNKNOWN outcome query)
          |
  world read model --- event bus --- telemetry/read-only dashboard
          |
  agent controller per citizen
    safety/body policy -> role/work intent -> social intent -> LLM proposal
          |                         |
    action policy              bounded model router
    resource claims            perception/reflection/planning
    intent revision            compact retrieved memories
          |
  command/outcome journal <-> Paper action validator + receipts
          |
  SQLite: orders, payments, sentence effects, migrations, event history
  JSON: noncritical preferences/personality cache during migration
  World/plugin files: blocks, entities, inventories (checkpointed together)

Git -> tests -> immutable release + manifest -> isolated test world
    -> checkpoint -> canary runtime -> player-announced plugin rollout
    -> smoke/metrics -> retain previous compatible release
```

Suggested boundaries: `bootstrap/` only constructs services; `runtime/` owns scheduling and shutdown; `domain/economy`, `domain/justice`, `domain/orders`, `domain/social` own transitions; `skills/` produce intents; `adapters/paper`, `adapters/lmstudio`, `adapters/sqlite`, `adapters/http` handle I/O. Give services typed JSDoc/TypeScript ports such as Clock, RandomSource, ActionGateway, OrderRepository, InventoryView. Optional hooks must be explicitly optional; required ports fail construction when missing. Avoid passing a bag containing the entire town to every factory.

**Week 1:** locate/freeze/hash source; Git baseline; recovery drill; fix partial transfer, lost-pay and duplicate-settlement tests; expose persistence/queue metrics; correct deploy guide. Deploy each small fix separately with a one-day observation window. Do not move every field to SQLite yet.

**Weeks 2–4:** durable command/payment journal, order and sentence transitions, additive versioned migrations, authenticated dashboard write path with compatible Fabric read feed; scheduler runs in shadow then canary mode; material reservation and mine exhaustion workflow. Keep current feature APIs through adapters.

**Weeks 5–8:** migrate one domain's authoritative state at a time, budgeted context/router, chunk/scan budgets, cached dashboard, history rollups, scheduled restore and soak gate. Delete compatibility adapters only after their callers and saved-state readers are gone. Dead-code candidates must be proven by imports/coverage and route tests; I did not establish a reliable whole-project dead-code set. The apparently unreachable warehouse-crowding branch (`main.mjs:1005–1028`) is one concrete candidate because crowded already excludes warehouseExit.

**Adding a feature:** define invariants and state transitions first; specify event inputs/intent outputs and required ports; add pure rules and adversarial tests; version persisted data and plugin capabilities if needed; run read-only/shadow; canary a citizen; enable via config. No new direct mutation of another domain's `memory.data`, unmanaged timer, or direct plugin action from the feature's LLM callback.

## 5. Long-run simulation risks, invariants and soak plan

| Risk | Invariant / metric | Adversarial scenario |
|---|---|---|
| Coin duplication/loss | Settled vault holdings = account liabilities + tax reserves; UNKNOWN movements explicitly reconcile; total coin change equals authorized mint/burn | Crash both sides before/after each transfer/ACK; partial chest capacity; repeated operation ID |
| Wage starvation/inflation | Confirmed work credited once; debt decreases only by confirmed pay; finite nonnegative amounts; per-producer payment age and real net issuance | Recycle warehouse goods, empty treasury, rich-first queue, fractional tax splitting, mint midnight, price shocks |
| Builder starvation | One funded/material-reserved active build; every blocked job has a reason, next retry and owner; stone delivery exceeds consumption over chosen window | Mine exhausted, no pickaxe/fuel, courier unreachable, simultaneous building votes |
| False work/reward farming | Progress follows inventory/arrival/work receipts; terminal orders immutable; reward exactly once; no advance without reservation | Four failed patrol legs, visual-only community service, stale callbacks after expiry, partial player delivery |
| Court deadlock/over-jailing | TRIED has a pending/applied sentence; RESOLVED has fulfilled or explicitly waived obligations; no double sentence; release reconciled | Prior convictions without new evidence, no sheriff/jail, full board, overlapping warrants, restart during speech |
| Trust collapse/rumor echo | Scores finite/bounded; one social impact per origin event/listener per retention policy; wrong rumors retract; recovery half-life measured | More than 12 rumors, repeated retelling/correction, insolvent issuer, proposal rejection loops |
| Hunger/energy starvation | Needs stay in valid units; critical survival examined within one fresh snapshot; failed eat does not improve hunger | Forever-follow order, stuck job, nightfall, unreachable food, jailed citizen with no ration |
| Queue/storage growth | Bounded queue/retention and positive drain rate after outages; no silent dropped durable effect | Models offline 48 h, stalled endpoint, 10× conversation volume, SQLite lock, ENOSPC |
| Spatial failure | Every travel intent terminates/replans with a reason; no duplicate chunk ownership loss; bounded tickets; progress can temporarily move away from goal | Mountain/U-shaped wall, distant chunks, obstructed roof, world border, 18 dispersed NPCs |

Implement a seeded, accelerated harness with fake Clock/RandomSource and a persistent fake world that models actual plugin rules: capacity, reach, partial quantities, rate limits, chunk availability and ACK uncertainty. Drive the same scheduler/domain APIs, not a simplified happy-path copy. Run **30 town days × 20 seeds**, then separately **7–30 real-day-equivalent** clocks so daily mint/reset/TTL behavior is covered. Use starting snapshots with 18 citizens, food scarcity, no stone, completed mine, insolvent treasury and full court queue. Persist a checkpoint every simulated day, kill/recreate the runtime, and compare uninterrupted/restarted invariants.

Emit per-day CSV/JSON: coin supply, liabilities/diff, accrued arrears and age distribution, producer pay, prices, inventory/material flow, builds completed/stalled, orders per state and payment age, prisoners/wait time, guilty-without-new-evidence count, trust quantiles/trade refusal rate, unique/duplicate rumor impacts, hunger-critical time, plans/tokens/latency/fallback, navigation success, queue peaks, table rows and checkpoint bytes. Fail conservation/authorization/state-machine invariants immediately; compare balance metrics against an agreed gameplay envelope rather than declaring every change in price/trust a bug.

Then run **24–72 real hours** on a disposable Paper/Citizens world with the actual plugin and 18 sessions: place/repair roof and stairs, fill a chest, restore oriented blocks, exercise private chests/court, interrupt WebSocket after commit, restart runtime/plugin, and verify no duplicate NPCs or receipts. Use a separate token, ports, state directory, allowlisted test world and matching server versions. Disable treasury/justice mutations in any read-only production probe. Capture MSPT and chunk tickets; unit timing is not a TPS test.

Existing coverage proves selected pure rules, schema validation, memory round-trip, loopback bridge reconnect/pacing and scripted feature flows. It does not prove survival scheduling under overlap, physical inventory rollback, live court completion, honest quest work, long-term economic equilibrium, or crash-safe cross-store persistence. The client mod and plugin Java tests/builds were not executed here. Property-based tests should generate transition sequences, amounts/capacities, event duplicates, seeds, clock shifts and outages; shrinking should retain a minimal reproducible failure trace.

## 6. Quick wins (each under approximately one hour, separately reviewed)

1. `DEPLOY-NOW.md:9`: replace obsolete dist instruction with the verified 2.13.0 artifact/hash and add “do not overwrite live plugin config”; test a dry-run file manifest.
2. `skills/economy.mjs:94–97`: count only confirmed reserve credits and add B02 as a regression; keep outstanding pay on failure.
3. `memory.mjs:25`: log failed persistence, restore dirty and retry with backoff; expose oldest dirty age. Simulate unwritable state directory.
4. `main.mjs:39`: place the canonical log event field after payload fields (or name it `event`); add a collision test. Live logs currently include payload-type event names such as RESOURCE_REQUEST.
5. `intel/executor.mjs:157`: replace the town-origin 1,000-block clamp with dimension/world-border validation and chunk-budgeted travel; test an accepted distant goal without actually dispatching it live.
6. `roles/miner.mjs:84`: expose `mine_exhausted` as an actionable dashboard blocker and suppress new dependent builds; do not promise autonomous expansion until implemented.
7. `main.mjs:1096–1106`: fail closed for mutation routes if token/session auth is absent; retain read-only feed compatibility. Full cookie/CSRF rollout is larger than an hour.
8. `lifesim.mjs:174`: set `registered:true` only when property registration succeeds; fake rejection must leave the home pending.
9. `scripts/watchdog.sh`: add a maintenance marker and rate-limit automatic restarts; test reachable-but-unauthorized plugin without touching production.
10. Add `npm run audit:reproduce` or run the saved demonstration file explicitly; label its assertions as bug demonstrations until inverted into regression expectations.

## 7. Questions needed to go further

1. May any LAN user or future Minecraft guest issue mayor commands, or should only your player UUID and authenticated dashboard account do so? Current code makes broader assumptions.
2. Is the economy intended to conserve physical emeralds, pay all useful labor eventually, or allow controlled fiat issuance? What maximum arrears and inequality are acceptable?
3. Should jail sentences advance while the Minecraft server/runtime is offline? Is community service real completed work or elapsed time in a role?
4. What loss window and downtime are acceptable: for example, ≤5 minutes of general town history and zero silently lost confirmed transfers? Which off-host storage may hold encrypted backups?
5. Which machine/session is the authoritative editor for `Documents/ProjectSid/sid-local`, and may it become the single Git-backed deployment source? Other AI sessions must stop deploying independently.
6. Can a disposable Paper/Citizens server/world be allocated for restart, inventory and court tests, and when is the next player-announced maintenance window?
7. Should unlimited exploration remain a requirement when it competes with town food/material delivery and chunk/TPS budgets? Range should not be silently capped by an unrelated goal executor.
8. What is the intended policy for the plugin's `free`, vault mint and confine capabilities: operator-only, specific deterministic services, or all agent sessions?

### Reference constraints used for recommendations

SQLite documents the [online backup API](https://www.sqlite.org/backup.html) for consistent database snapshots without naïvely copying a live main database file. That does not make the Minecraft world and JSON state part of the same transaction. Paper's [scheduler documentation](https://docs.papermc.io/paper/dev/scheduler/) requires care with world access on asynchronous tasks: offload immutable serialization and I/O, not live Bukkit world mutation. npm's current report is saved verbatim; the [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) requires call-path assessment before asserting application exploitability.
