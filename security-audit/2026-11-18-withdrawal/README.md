# Withdrawn advisory and unresolved matcher performance

This directory adds evidence; it does not replace the historical 18-high reports
in `security-audit/2026-11-18`. `advisory.raw.json` is the unmodified GitHub API
response. `retrieval.json` records its URL, retrieval time and SHA-256.
The API marks GHSA-fc5q-39xc-vjpf withdrawn at 2026-11-18T15:38:56Z.
Withdrawal is a database status, not evidence of a matcher implementation fix.
The response retains its original security description and has no patched version.
Do not infer a technical resolution from the withdrawal reason.

## Reachability review

* Tailwind: `tailwind.config.js` pins `./index.html` and
  `./src/**/*.{js,jsx,ts,tsx}`. Installed `tailwindcss/lib/lib/content.js`
  passes configured content through fast-glob. The source policy hashes this
  configuration and the controller rejects source changes and unreviewed ignored
  files, including dotenv files. It strips externally supplied glob/Node settings.
* Vite: `vite.config.js` has repository-defined React/CSP plugins and no external
  glob input. Vite and tinyglobby still expose general picomatch APIs; tinyglobby's
  `dist/index.mjs` compiles transformed match/ignore patterns using picomatch.
* Electron Builder: package file patterns, wrapper and NSIS adapter are pinned.
  The builder also traverses installed dependency metadata through
  app-builder-lib, @electron/rebuild, node-gyp and tinyglobby. The reviewed
  node-gyp Windows solution glob is the fixed `build/*.sln`.
* The release workflow accepts no pattern input, external checkout, downloaded
  source artifact or dependency cache. App source has no picomatch import.
  These observations constrain the reviewed configuration; they are not a proof
  that every dependency-generated pattern is safe or that package lifecycle
  scripts cannot introduce another call path.

## Decisions and controls

The raw isolated regression command still exits 1 for timeouts and never runs a
potentially blocking expression in the controller. Its existing 128 MiB Node heap
and 2-second per-case deadline remain. A Node preload cannot replace the matcher
in these raw probes; invalid or excessive deadline overrides are rejected.
This diagnostic is deliberately not treated as proof of an application exploit.
Conversely, trusted fixed configuration is not treated as a general safety proof.

The clean-audit review route requires genuine successful full and production
audit JSON, no findings at any severity, exact installed paths/versions and full
unaltered probe vectors. Unknown errors, dependencies, versions and missing
evidence are rejected. Withdrawal evidence is checked for identity, hash, origin,
timestamp and a seven-day maximum age, with no automatic renewal.

`reviewCompleted` means evidence collection and classification succeeded.
`releaseEligible` is separate. Reproducible timeouts keep strict packaging blocked.
The controller's current spawn timeout does not prove CPU/memory containment of
all descendant Windows processes. This is an explicit unresolved blocker, not an
accepted risk. No new signature or production authorization is created.
The old withdrawn-advisory signature route is inapplicable to an audit containing
zero findings and is not silently repurposed as performance-risk approval.

## Minimum conditions for any performance exception

Before another release attempt, implement and verify either a restricted glob
boundary across all actual CJS/ESM entry points (including derived patterns and
raw-regex helper APIs), or OS-enforced process-tree CPU/time/memory containment.
Keep legitimate build glob controls and malicious-vector tests isolated. Record
unknown entry points as blockers; a wrapper around only one picomatch copy is
insufficient. Preserve installer static verification and unfiltered audit output.

Any remaining bounded risk then requires a separate explicit performance-risk
decision by the actual approver, bound to the new commit, lock/install hashes,
fresh real audit and all probe/containment evidence, one UUID, one durable external
ledger receipt, at most seven days, nonrenewing and revocable. No such policy or
authorization is automatically signed here. Audit findings continue to block.

Local diagnostic test/package results are not release authorization. Existing
v1.8.1 must remain untouched; no tag, push or GitHub Release is authorized.
