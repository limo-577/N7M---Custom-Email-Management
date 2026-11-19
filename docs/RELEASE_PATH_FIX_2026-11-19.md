# Release verification path repair

The Windows build uses `package.json` output `release`, the guarded distribution
passes that same absolute directory, and release.yml verifies `--output release`.
Upload, download and publishing paths also consistently use `release/*-Setup.exe`,
`release/*-Portable.exe` and `release/*-NoInstall.zip`. The verifier incorrectly
required a descendant of release, excluding the release directory itself.

The shared path helper now permits release itself and its descendants. It rejects
adjacent prefixes, outside absolute paths, explicit `..` segments before path
normalization, drive-relative Windows paths, junctions and symbolic links (including
dangling links). Report paths remain strictly below `.risk-build`; existing reports
cannot be overwritten. The unpacked payload root and each installer are also
checked before reading. The guarded build uses the same filesystem checks.
Directory-link rejection is deliberately conservative, even for internal links.
These checks do not claim protection against an attacker concurrently replacing
filesystem components while verification runs.

The regression suite parses the actual workflow and manifest and checks that the
builder output, verifier arguments and upload/download/publish patterns agree.
No audit policy, glob-boundary rules, resource budgets or historical evidence is
changed. This repair does not establish that the picomatch matcher is fixed.

## Subsequent release

The existing v1.8.2 tag points to the pre-fix commit. Never move, delete or force
push it. Rerunning that tag's workflow still uses its original SHA and workflow;
merely merging this repair to main cannot update that run.

Preferred next step, only after review and explicit publication approval: merge
the repair, prepare a new patch version such as 1.8.3 in package.json and lockfile,
verify the new fixed commit through the complete strict pipeline, confirm the new
tag is unused, and create that new tag. Tag push triggers the current workflow's
publishing job, so it requires publication approval, not just source approval.
This fix intentionally leaves the software version at 1.8.2 for regression builds.

Alternatively, a separately reviewed manual publication can build a specified
fixed SHA, preserve the real audit and probe outputs, run all security gates and
verify all three payloads and hashes before uploading the exact approved files.
Its provenance must name the fixed SHA and distinguish it from the immutable
v1.8.2 tag. Do not silently replace tag-associated binaries or relabel validation
packages as another version. No push, tag change or Release publication is
performed by this repair.
