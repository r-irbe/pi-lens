------------------------- MODULE NavigationLifecycle -------------------------
(***************************************************************************)
(* Admitted-context Lean semantic navigation, .ilean scan ticket           *)
(* invalidation, and MCP session bootstrap lifecycle across same-process   *)
(* session replacement and whole-service reset (tools/lsp-navigation.ts,   *)
(* clients/lsp/lean4-ilean.ts, clients/lean-context.ts, clients/lsp/       *)
(* index.ts, clients/mcp/session.ts).                                      *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - an in-flight semantic navigation / .ilean scan operation (`navPhase` *)
(*    from "idle" -> "inflight" -> "done"):                                *)
(*      NavStart captures the caller's live SessionScope (`navScope`),     *)
(*      the admitted LeanContext/route identity (`navAdm`), the LSP        *)
(*      service generation (`navSvcGen`), and the .ilean scan invalidation *)
(*      stamp (`navStamp`) at operation entry before the first await       *)
(*      (`NavEntryCapture == TRUE`; mutant `NavEntryCaptureOff` defers     *)
(*      capture until publish time).                                       *)
(*      NavFinish checks `isNavigationContextCurrent`: the captured scope  *)
(*      must still be live (`navScope \in liveScopes`), the admitted root  *)
(*      and service generation must match (`navAdm = adm /\ navSvcGen =    *)
(*      svcGen`), and the scan invalidation stamp must match (`navStamp =  *)
(*      ileanStamp`). When current, it publishes (`navPublished`); when    *)
(*      stale, it suppresses publication (`navSuppressed`) and returns     *)
(*      structured `unavailable` (`session-unavailable` or                 *)
(*      `context-changed`).                                                *)
(*  - a survivor navigation operation started in the current scope after   *)
(*    prior resets (`survPhase`): when no subsequent reset or retirement   *)
(*    intervenes, it must complete and publish (`NoDropSurvivorNavigation`,*)
(*    broken by mutant `NavNoDropSurvivorOff`).                            *)
(*  - host / service lifecycle transitions:                                *)
(*      RetirePrimaryScope retires the primary scope (`retireScope`);      *)
(*      SecondaryScopeRetire retires an isolated secondary scope without   *)
(*      disturbing the primary scope;                                      *)
(*      ReAdmitConfig re-runs `initLSPConfig` (`adm' = adm + 1` and bumps  *)
(*      `ileanStamp`);                                                     *)
(*      ServiceReset runs `resetLSPService()` / `LSPService.shutdown()`,   *)
(*      which bumps `svcGen` and, via `configureLspServiceLifecycle`'s     *)
(*      `beforeReset` hook (`NavBeforeReset == TRUE`), calls               *)
(*      `clearILeanScanCache()` to bump `ileanStamp` (`MutNavNoBeforeReset`*)
(*      omits the `beforeReset` invalidation).                             *)
(*  - MCP session bootstrap (`clients/mcp/session.ts`):                    *)
(*      McpBootstrapStart begins an async `loadBootstrapClients()` under   *)
(*      `mcpEpoch`; McpReset (`_resetMcpSessionContext`) increments        *)
(*      `mcpEpoch`, retires any published runtime, and clears              *)
(*      `resolvedRuntime`; McpBootstrapFinish only publishes               *)
(*      `resolvedRuntime` if its captured `mcpPendingEpoch = mcpEpoch`     *)
(*      (`McpBootstrapEpoch == TRUE`; mutant `McpBootstrapEpochOff`        *)
(*      republishes a stale runtime across `_resetMcpSessionContext`).     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

\* As-built code switches and their mutant overrides (`<-` in *.cfg).
NavEntryCapture == TRUE
NavEntryCaptureOff == FALSE

NavBeforeReset == TRUE
NavBeforeResetOff == FALSE

McpBootstrapEpoch == TRUE
McpBootstrapEpochOff == FALSE

NavNoDropSurvivor == TRUE
NavNoDropSurvivorOff == FALSE

\* Inert in NavigationLifecycle (defined so family-wide pin resolution agrees
\* across both modules in formal/session-straddle/).
QuietWindow == TRUE
ResetClears == TRUE
Dedupe == TRUE
ToolDrift == FALSE
Strays == FALSE
Overflow == FALSE
LateAdmit == FALSE
EarlyAbandon == FALSE
FixParts == {"settle", "reconcile", "reconcileTaskCapture", "admission", "stray", "entryCapture"}

MaxSteps == 2

VARIABLES
    liveScopes,       \* subset of {1, 2, 3}: 1 = primary s1, 2 = secondary, 3 = primary s2
    activePrimary,    \* 1 or 3
    adm,              \* admitted LeanContext generation (1..MaxSteps+1)
    svcGen,           \* LSP service generation (1..MaxSteps+1)
    ileanStamp,       \* .ilean scan invalidation stamp (1..2*MaxSteps+1)
    navPhase,         \* "idle" | "inflight" | "done"
    navScope,         \* scope captured by in-flight navigation
    navAdm,           \* admission generation captured by in-flight navigation
    navSvcGen,        \* service generation captured by in-flight navigation
    navStamp,         \* ileanStamp captured by in-flight navigation
    navBoundarySeen,  \* TRUE if a lifecycle boundary invalidated the in-flight navigation
    navPublished,     \* TRUE if in-flight navigation published a semantic result
    navSuppressed,    \* TRUE if in-flight navigation was suppressed as unavailable
    survPhase,        \* survivor navigation in current context: "idle" | "done"
    survPublished,    \* TRUE if survivor navigation published
    survDropped,      \* TRUE if survivor navigation was falsely dropped
    mcpEpoch,         \* _resetMcpSessionContext epoch counter
    mcpPending,       \* TRUE if getMcpSessionContext bootstrap is in flight
    mcpPendingEpoch,  \* epoch captured at getMcpSessionContext entry
    mcpResetMidFlight,\* TRUE if _resetMcpSessionContext ran while bootstrap was in flight
    mcpPublishedStale \* TRUE if an interrupted bootstrap republished resolvedRuntime

vars == <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
          navPhase, navScope, navAdm, navSvcGen, navStamp,
          navBoundarySeen, navPublished, navSuppressed,
          survPhase, survPublished, survDropped,
          mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

Init ==
    /\ liveScopes = {1, 2}
    /\ activePrimary = 1
    /\ adm = 1
    /\ svcGen = 1
    /\ ileanStamp = 1
    /\ navPhase = "idle"
    /\ navScope = 1
    /\ navAdm = 1
    /\ navSvcGen = 1
    /\ navStamp = 1
    /\ navBoundarySeen = FALSE
    /\ navPublished = FALSE
    /\ navSuppressed = FALSE
    /\ survPhase = "idle"
    /\ survPublished = FALSE
    /\ survDropped = FALSE
    /\ mcpEpoch = 1
    /\ mcpPending = FALSE
    /\ mcpPendingEpoch = 1
    /\ mcpResetMidFlight = FALSE
    /\ mcpPublishedStale = FALSE

\* Start an admitted-context navigation / .ilean scan in the primary scope.
NavStart ==
    /\ navPhase = "idle"
    /\ activePrimary \in liveScopes
    /\ navPhase' = "inflight"
    /\ navScope' = activePrimary
    /\ navAdm' = adm
    /\ navSvcGen' = svcGen
    /\ navStamp' = ileanStamp
    /\ navBoundarySeen' = FALSE
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* Primary session replacement retires primary scope 1 and activates scope 3.
RetirePrimaryScope ==
    /\ activePrimary = 1
    /\ liveScopes' = (liveScopes \ {1}) \cup {3}
    /\ activePrimary' = 3
    /\ ileanStamp' = ileanStamp + 1
    /\ navBoundarySeen' = IF navPhase = "inflight" /\ navScope = 1 THEN TRUE ELSE navBoundarySeen
    /\ UNCHANGED <<adm, svcGen, navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* Retiring a secondary scope isolates the primary scope (does NOT mark primary nav stale).
SecondaryScopeRetire ==
    /\ 2 \in liveScopes
    /\ liveScopes' = liveScopes \ {2}
    /\ UNCHANGED <<activePrimary, adm, svcGen, ileanStamp,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navBoundarySeen, navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* Re-running initLSPConfig replaces admitted LeanContext and invalidates .ilean scan stamp.
ReAdmitConfig ==
    /\ adm <= MaxSteps
    /\ adm' = adm + 1
    /\ ileanStamp' = ileanStamp + 1
    /\ navBoundarySeen' = IF navPhase = "inflight" THEN TRUE ELSE navBoundarySeen
    /\ UNCHANGED <<liveScopes, activePrimary, svcGen,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* Whole-service reset (resetLSPService / LSPService.shutdown): bumps svcGen and,
\* when NavBeforeReset = TRUE, runs clearILeanScanCache() via beforeReset.
ServiceReset ==
    /\ svcGen <= MaxSteps
    /\ svcGen' = svcGen + 1
    /\ ileanStamp' = IF NavBeforeReset THEN ileanStamp + 1 ELSE ileanStamp
    /\ navBoundarySeen' = IF navPhase = "inflight" THEN TRUE ELSE navBoundarySeen
    /\ UNCHANGED <<liveScopes, activePrimary, adm,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* Complete the in-flight navigation / .ilean scan check.
\* Note: an .ilean scan ticket (scanAllILeanFiles) checks the captured scope,
\* admission, and ileanStamp; whole-service resetLSPService is observed by
\* scanAllILeanFiles through clearILeanScanCache() bumping ileanStamp.
NavFinish ==
    /\ navPhase = "inflight"
    /\ navPhase' = "done"
    /\ LET effScope == IF NavEntryCapture THEN navScope ELSE activePrimary
           effAdm   == IF NavEntryCapture THEN navAdm ELSE adm
           effStamp == IF NavEntryCapture THEN navStamp ELSE ileanStamp
           isCurrent == /\ effScope \in liveScopes
                        /\ effAdm = adm
                        /\ effStamp = ileanStamp
       IN IF isCurrent
            THEN /\ navPublished' = TRUE
                 /\ navSuppressed' = FALSE
            ELSE /\ navPublished' = FALSE
                 /\ navSuppressed' = TRUE
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navScope, navAdm, navSvcGen, navStamp, navBoundarySeen,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* A survivor navigation call started in the current active primary scope with
\* no intervening boundary must complete and publish without false drop.
SurvivorNavigate ==
    /\ survPhase = "idle"
    /\ activePrimary \in liveScopes
    /\ survPhase' = "done"
    /\ IF NavNoDropSurvivor
         THEN /\ survPublished' = TRUE
              /\ survDropped' = FALSE
         ELSE /\ survPublished' = FALSE
              /\ survDropped' = TRUE
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navBoundarySeen, navPublished, navSuppressed,
                   mcpEpoch, mcpPending, mcpPendingEpoch, mcpResetMidFlight, mcpPublishedStale>>

\* MCP session bootstrap starts (`getMcpSessionContext`).
McpBootstrapStart ==
    /\ ~mcpPending
    /\ mcpEpoch <= MaxSteps
    /\ mcpPending' = TRUE
    /\ mcpPendingEpoch' = mcpEpoch
    /\ mcpResetMidFlight' = FALSE
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navBoundarySeen, navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPublishedStale>>

\* `_resetMcpSessionContext()` runs while MCP bootstrap is pending.
McpReset ==
    /\ mcpPending
    /\ ~mcpResetMidFlight
    /\ mcpEpoch <= MaxSteps
    /\ mcpEpoch' = mcpEpoch + 1
    /\ mcpResetMidFlight' = TRUE
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navBoundarySeen, navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpPending, mcpPendingEpoch, mcpPublishedStale>>

\* In-flight `loadBootstrapClients()` resolves after await.
McpBootstrapFinish ==
    /\ mcpPending
    /\ mcpPending' = FALSE
    /\ LET epochMatches == IF McpBootstrapEpoch THEN (mcpPendingEpoch = mcpEpoch) ELSE TRUE
       IN mcpPublishedStale' = IF mcpResetMidFlight /\ epochMatches THEN TRUE ELSE mcpPublishedStale
    /\ UNCHANGED <<liveScopes, activePrimary, adm, svcGen, ileanStamp,
                   navPhase, navScope, navAdm, navSvcGen, navStamp,
                   navBoundarySeen, navPublished, navSuppressed,
                   survPhase, survPublished, survDropped,
                   mcpEpoch, mcpPendingEpoch, mcpResetMidFlight>>

Next ==
    \/ NavStart
    \/ RetirePrimaryScope
    \/ SecondaryScopeRetire
    \/ ReAdmitConfig
    \/ ServiceReset
    \/ NavFinish
    \/ SurvivorNavigate
    \/ McpBootstrapStart
    \/ McpReset
    \/ McpBootstrapFinish

Spec == Init /\ [][Next]_vars

(* Invariant 1: An in-flight navigation or .ilean scan across a scope retirement,
   config re-admission, or whole-service reset never publishes stale results. *)
NoStaleNavigationPublish ==
    ~(navBoundarySeen /\ navPublished)

(* Invariant 2: An in-flight MCP bootstrap interrupted by _resetMcpSessionContext
   never republishes a stale resolvedRuntime. *)
NoStaleMcpRuntimePublish ==
    ~mcpPublishedStale

(* Invariant 3: A current-scope navigation call with no intervening reset or
   retirement is never falsely dropped. *)
NoDropSurvivorNavigation ==
    ~survDropped
=============================================================================
