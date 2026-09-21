# Debug Session: m10-debug-endpoint-refusal
- **Status**: [OPEN]
- **Issue**: Real DSH M10 evidence reports two raw browser `ERR_CONNECTION_REFUSED` errors; the request URLs must be identified and resolved without filtering.
- **Debug Servers**: `http://127.0.0.1:7777/event` (PID `51308`, active);
  the `127.0.0.1:7778` collector PID `51324` exited on its configured idle timeout
- **Log Files**: no event file was created because neither strict run requested
  a collector endpoint

## Reproduction Steps
1. Start an isolated DSH web profile with the M10 P6 workspace.
2. Open P6 through the DSH Agent/App flow.
3. Play, capture deterministic Runtime evidence, and Stop.
4. Inspect raw browser console and failed-request URLs.

## Hypotheses & Verification

| ID | Hypothesis | Likelihood | Effort | Evidence |
| --- | --- | --- | --- | --- |
| A | A retained debug probe requests `127.0.0.1:7777` or `7778`, and the missing collector causes both errors. | Low | Low | Exact retained probes exist in `tests/m7-browser.mjs` and `tests/m9-ui-browser.mjs`, but neither runs in M10 real-provider evidence. |
| B | The errors are failed DSH host or MCP resource requests unrelated to debug probes. | Low | Low | Two strict real-provider runs completed with raw `browserProblems: []`. |
| C | The probe exists only in generated/runtime state rather than tracked source. | Rejected for M10 | Medium | No endpoint appears in M10 product code, the real-provider harness, `dsh-uni-editor`, or built artifacts. |
| D | Starting the official collector on the exact requested endpoint removes both raw browser errors without product changes. | Not needed | Low | Collectors received no event in either strict run; the M10 path made no request to them. |

## Log Evidence

The pre-fix `.tmp/m10-dsh-runtime-final-r3` run completed Play, deterministic
capture, and Stop replacement, then reported two generic console errors:
`Failed to load resource: net::ERR_CONNECTION_REFUSED`. The harness filter has
been removed and failed-request URL reporting has been added. Static search
found retained probes at exact `127.0.0.1:7777/event` and
`127.0.0.1:7778/event`; no such endpoint appears in M10 product code,
`dsh-uni-editor`, or built artifacts. Official TRAE collectors listened on
both exact ports during the strict reproductions.

The strict real-provider G1 and P6 runs both completed with
`browserProblems: []`. No collector event file was created, proving the M10
path did not request either endpoint. PID `51324` on port `7778` later exited
on its configured idle timeout without being signalled; PID `51308` on port
`7777` remains live. PID `51754` was absent and was never signalled.

## Verification Conclusion

The earlier generic refusals were not reproduced under strict URL-reporting
instrumentation. The exact retained probes are test-only:

- `tests/m7-browser.mjs` posts to `http://127.0.0.1:7778/event`.
- `tests/m9-ui-browser.mjs` reads `.dbg/m9-app-view-loading.env`, currently
  `http://127.0.0.1:7778/event`.

The debug record remains open pending the debugger cleanup gate; no M10 source
probe or browser-error filter remains.
