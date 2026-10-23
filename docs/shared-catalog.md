# Shared catalog preparation and reconciliation

This repository owns reviewed registrations for meanings and logical DataModels.
Publication remains a Git review operation. The staging command neither activates
a writer nor changes the ModelSpec registry, public URLs, DNS or production data.

## Validate and stage

Use Node 24+ and the Go toolchain declared in `tools/modelcheck/go.mod`:

```sh
npm ci --ignore-scripts
npm test
go -C tools/modelcheck test .
ingitdb validate --path=. --safe-diagnostics
npm run catalog -- --output /tmp/meaninggraph-catalog-staging
```

Use a destination that does not exist and is disjoint from the source checkout.
The complete tree appears by rename only after validation; failures remove the
private preparation tree. The input snapshot includes all registration, import,
lock, validator and policy files. Release-suitable output requires their exact
committed bytes; `--allow-working-tree` permits local experiments but records
`activation_eligible: false`. Those outputs must not be activated. The protected
registry default-branch merge base is recorded and checked for deletion or changes
to previously admitted receipt/definition/blob bytes; missing/shallow baseline
history fails rather than silently skipping preservation checks.

The last command reads the reviewed selection files and verifies source commits
against their repository's default-branch history. It executes only registry-owned
tooling and the pinned reference validators, never publisher code. The Go adapter
validates HCL/JSON twins using ModelSpec v0.3.0, ProfileDefault, with explicit module
closure. Existing imported pins allow earlier authoring spelling; new roots must
use current authoring vocabulary. Components, enums, constraints and keyless records
remain native structures. The old index summary intentionally keeps its old shape.

`tools.json` pins the semantic checker independently of any registered semantic
resource. Model-only and empty catalogs do not fetch or execute that checker.
These Git collections are public; Git review and repository permissions govern
writes. This change does not add private hosting or invent a permission service.

The command writes a fresh staging tree (use a new destination for each run):

- `catalog.json`: selected resources, one selected source commit per repository,
  source pin map, revision-index digest and catalog checksum.
- `revisions/index.json` and `revisions/$records/*.yaml`: immutable revision
  identities and full artifact/provenance receipts, including retained history.
- `artifacts/sha256/*/*`: original HCL, JSON, meaning, licence and registry records.
- `definitions/*.json`: native views; model numeric values retain exact JSON text.
- `index.json`: unchanged legacy semantic projection.
- `modelspec-index.json`: legacy model projection with unchanged shape/checksum.
- `reconciliation.json`: resource counts, pins, digests and unregistered attachments.

JSON is a YAML subset; revision receipts use canonical JSON in `.yaml` records so
the same files remain an inGitDB collection. Nested receipt structure is validated
by `validateRevision`, beyond inGitDB's supported `map[string]any`/`[]any` columns.

## Exact resolution and history

`scripts/lib/revisions.mjs` exports `resolveRevision(root,{kind,address,commit})`.
An exact source commit is required; `selectRevision` is a separate explicit choice.
A missing or corrupt old artifact never falls back to current selection. Every
source artifact and the native definition are digest-checked. Module locks retain
exact revision IDs and can resolve older versions independently of search.

A revision key is SHA-256 of UTF-8 JSON
`["meaninggraph-revision/v1",kind,address,commit]`. Immutable writes are equal-byte
no-ops or explicit conflicts. Updating selection does not delete history. Changing
logical structure for the same module identity/version fails validation; comments,
mapping additions and source movement may preserve the logical digest. The digest
is computed losslessly by the reference adapter, excluding module version and
provenance but including logical attributes and its finite dependency closure.

New or changed selection records must first exist at the registry commit recorded
in the receipt. The initial nine copied model records retain their original registry
commit/path via `imports/modelspec-registry.json`, including byte digests. Editing
one removes that imported provenance path automatically. Fixture injection exists
only as an explicit test mode and is identified in its reconciliation report.

## Release boundary and rollback

Staging is preparation. Review the report, compare both legacy indexes with their
authorities, validate the staged receipt collection, and run consumer contract tests
before copying output into the registry change. Do not copy publisher databases,
unregistered attachments as new registrations, credentials or executable trees.

Keep prior receipts and artifacts when installing a newer staging tree. Rebuild the
same selection twice and compare all output bytes. Missing historical module locks,
immutable conflicts or reconciliation mismatches block publication.

Before activating a compatibility writer, freeze the old writer, record its final
commit and late-write reconciliation, and retain the original registry snapshot.
Only then may the new shared registry become authoritative and produce the legacy
projection. This command does not perform that operational fence. If a former
writer cannot represent newly added definitions, rollback is read-only or to a
forward-compatible reader; never discard new writes to restore old code. Public
redirects, package publication and production activation need separate authorization.

Typed declarations, exact source pointers and composition views follow the
[reviewed model graph draft](model-graph.md). The normalized native AST does not
relabel the original archived ModelSpec format.
