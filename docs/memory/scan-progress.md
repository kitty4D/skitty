# scan progress

`src/scanPipeline.ts` runs two independent discovery sections at a time: coins, kiosks, containers, receipts/allowances, and generic burns. sections report waiting, scanning, complete, or error independently. unknown page totals aren't turned into invented percentages

the hook publishes verified actions throughout the scan. coins appear only after coin/package blocklist checks; optional names and decimals enrich them later, with raw balances until metadata arrives. metadata and kiosk object lookups each use a two-request pool. kiosk candidates publish after the first check and every ten checks. generic burns publish after a callable function and rebate check pass. containers and receipts publish when their discovery and object-list checks finish

later failures retain already verified results and add a warning. an incomplete section isn't presented as an empty successful scan. scan epochs suppress superseded results, and item workers stop scheduling when stale. reads already in flight can finish; container/receipt discovery still uses its own per-request timeouts

the dashboard shows partial results and per-panel completion notes while scanning. selection, simulation, execution, flagged opt-in, and the queue stay locked until the scan settles. a new scan clears selection and pending confirmation. progress-only updates retain action array identity so they don't repeatedly invalidate quotes

`ScanProgressPanel` displays elapsed time, actual page/object/type counts, active work, and completed check counts. elapsed time isn't an ETA. screen readers announce completion counts, not every timer tick

november 11 read-only browser check: `premierjon.sui` had 354 coin objects, 84 allowed non-SUI token types needing metadata, and 503 kiosk caps. production showed no result panels at 20 seconds while still processing kiosks; its full duration wasn't recorded. in a stable local run, coin panels appeared at 1.6 seconds, kiosk candidates at 3.1 seconds, and the entire scan finished at 43.3 seconds without incomplete-discovery warnings. these are observations from that wallet, not timing guarantees or a controlled end-to-end speed comparison

## queue dismissal

an outside pointer click minimizes the open queue without clearing selections. clicks inside don't dismiss it. the minimized button reopens it. dismissal is disabled during execution and while a confirmation, simulation popup, or raw simulation view is open. no modal overlay is added, so the page remains usable

dismissal uses window capture for pointerdown and click, so page handlers that stop bubbling don't block it and keyboard-generated clicks work. dismissal sets minimized state explicitly; it doesn't toggle twice across pointerdown and click. the expanded panel unmounts immediately rather than waiting for a spring exit. the previous connected-app exit took about 0.9 seconds and left a nearly invisible panel present until it settled

## connected account menu

the installed dapp-kit account menu has max-height 200px but no overflow scrolling. with 24 accounts it painted only a 200px background while menu items occupied over 1,000px. `src/index.css` scopes overrides to `[data-dapp-kit][role='menu']`: bounded width, opaque background, scrollable content, nonshrinking rows, and height limited by Radix's available viewport space. no vendor files are edited

browser verification uses a mock wallet with 24 accounts and signing methods that always throw. it covers full connected dashboard queue dismissal, stopped event propagation, keyboard clicks, review cancellation, scrolling to and selecting account 24, and keyboard End reaching Disconnect at desktop and 390px mobile widths. mock reads don't prove real wallet signing or onchain behavior
