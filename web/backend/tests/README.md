# Tests

Plain Node scripts, no framework. Anyone who can run the app can run these.

```bash
cd web/backend
npm test                # every suite
npm test -- router      # just the ones matching "router"
```

Each suite prints `N passed, M failed` and exits non-zero if anything failed, so it works in CI
without further wiring.

| Suite | What it holds the line on |
|---|---|
| `t-router.js` | Row routing. Round-trips all 198 catalogue use cases across 31 industries, then checks the awkward parts: partner headers we have never seen, values recognised from the data when the header says nothing, missing values derived or omitted but never invented, and an industry that simply does not make the call the data is asking for. Pure module, runs in about a second. |
| `t-realworld.js` | Files as they actually arrive, rather than as we would write them: semicolon and tab delimiters, a byte-order mark, a title row above the headers, headers with units in them, a name split across two columns, a Spanish export, phone numbers Excel turned into scientific notation, Excel serial dates, and the day-first/month-first question. First run scored 15/21; three of the six failures were silently wrong values rather than visible errors. |
| `t-concurrency.js` | One ElevenLabs agent, two partners dialling at the same moment. Runs the server in-process with `node-fetch` replaced, so every request the platform makes of ElevenLabs is captured and inspected. Proves each call carries its own prompt, voice, language and variables in `conversation_config_override`, that the campaigns genuinely interleave, and that nothing writes to the shared agent while they run. |
| `t-bulk-e2e.js` | The same path through a real server: CSV upload, the reported column mapping, queue ordering, do-not-call and duplicate pruning, and a simulated campaign placing exactly the calls the analysis promised. Builds an isolated instance under the OS temp folder with its own port, a blank `DATABASE_URL` and `MAIL_PROVIDER=dev`, so it touches neither live data nor a real mailbox. |

## Writing another

Copy the harness at the top of `t-bulk-e2e.js`. The parts that matter:

- **Isolate.** Build a throwaway copy of the app under `os.tmpdir()`, with its own port and a blank
  `DATABASE_URL`, so a suite can never write to the live database or the developer's own JSON files.
- **Junction `node_modules`** rather than reinstalling: `mklink /J` on Windows, a symlink elsewhere.
- **`MAIL_PROVIDER=dev`.** No suite may send real mail. Codes are printed to stdout for the test to
  read back.
- **Say what the assertion means**, not which function returned what. `'a bill twenty days past
  reaches collections'` survives a refactor; `'expects archetype to equal overdue_followup'` does not.
