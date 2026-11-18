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
`guardedBuildEligible` requires eight freshly executed CJS/ESM boundary and
Windows resource-limit tests without skips. Review `releaseEligible` remains
false; only a completed strict build and final payload verification can set it
true. Raw matcher timeouts are never relabeled as passes.

The build-only preload restricts patterns: no extglobs, regex grouping, nested or
range braces, ambiguous repeated wildcards, arbitrary regex helpers or external
private parse APIs. Public and internal matcher entries are wrapped before Node
snapshots CJS exports for ESM. Long patterns, arrays and matcher inputs fail.
Micromatch's exact locked caller may import the string/path escaping utilities;
direct private parse imports remain forbidden and this compatibility is tested.
Unsupported legitimate patterns also block instead of changing semantics.
Only distribution inherits this preload; raw diagnostics use the real matcher.

Every controller step joins a Windows Job Object before its suspended process
resumes: 2 GiB committed memory per process, 6 GiB aggregate committed memory,
64 active processes, 600 seconds aggregate CPU and a per-step wall deadline
(20 minutes for distribution). No breakaway is enabled. Closing the job kills
remaining descendants, including after normal root exit. Real CPU, memory,
wall-deadline and orphan-cleanup tests verify enforcement. Launcher failure
blocks; no uncontained fallback exists. This is a resource budget, not a proof
of linear matching or a sandbox for executing hostile repository code.

Distribution requires proof that all three installed matcher copies actually
validated inputs. Rejections fail even if a dependency catches the exception.
Final static verification still checks Setup, Portable and ZIP payloads. No
risk signature or production authorization is generated. The normal route
requires clean audits and mandatory controls, not an advisory exception.
The old withdrawn-advisory signature route is inapplicable to an audit containing
zero findings and is not silently repurposed as performance-risk approval.

## Minimum conditions for any performance exception

The boundary and resource limits must not be relaxed to make a build pass.
Unknown copies, uncovered imports, unsupported patterns, skipped tests and any
containment failure block. Keep legitimate glob controls and malicious cases
isolated, and retain unfiltered audits and installer static verification.

Any request to accept input outside the enforced boundary or exceed its budget
requires a separate explicit performance-risk decision and implementation review
by the actual approver: new commit, lock/install hashes, fresh real audit and
all probe/containment evidence, one UUID, one durable external ledger receipt,
at most seven days, nonrenewing and revocable. No such bypass or authorization
is implemented or automatically signed here. Audit findings continue to block.

Local diagnostic test/package results are not release authorization. Existing
v1.8.1 must remain untouched; no tag, push or GitHub Release is authorized.
