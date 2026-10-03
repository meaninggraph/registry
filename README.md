# MeaningGraph registry

The public list of meaning graphs: for each one, the address people write to
refer to it, the repository it lives in, the commit that is its current
reviewed version, its licences, its maintainers, and the other graphs it
depends on.

| Id | Address | Repository at commit | Kind | Status |
|---|---|---|---|---|
| `core` | `meaning://github.com/meaninggraph/core` | [meaninggraph/core@cb97dbc](https://github.com/meaninggraph/core/tree/cb97dbcd9e951b00e7d46cb2e0c4e120c24c8db7) | universal | draft |
| `chinook` | `meaning://github.com/datatug/chinookdb` | [datatug/chinookdb@f0c71b9](https://github.com/datatug/chinookdb/tree/f0c71b959bd082c3ec495df5fbecb4af014d6d12) | dataset | draft |

## This repository is the registry

The registry is this Git repository, not a database service. Registering a
graph, or moving it to a new commit, is a pull request; CI fetches the graph
at that commit and runs the meaning checks, so a graph that does not check
cannot be registered.

Why GitHub and not Firestore as the source of truth:

- **Review and history come free.** Every registration is a reviewed pull
  request with an author, a diff and a permanent record. A database would
  need its own write API, permissions and audit log to match that.
- **Nothing broken gets in.** The check runs before the merge, in the same
  place as the change. A write to a database is checked after the fact, if at
  all.
- **It is where the graphs are.** Graphs live in Git repositories and are
  pinned by commit. A registry in Git uses the same words: a repository, a
  commit, a pull request.
- **Anyone can read, fork or mirror it** without an account or a key, and it
  costs nothing to run.

A Firestore collection comes later, only as a search index for
meaninggraph.io: CI generates it from this repository and nobody edits it
(see [Planned search index](#planned-search-index)). It is never the
authority; when the two disagree, this repository is right.

## It is an inGitDB database

The registry is an [inGitDB](https://github.com/ingitdb/ingitdb-cli) database:
plain YAML files in Git, with collection definitions that say which columns
each record has. It can be read as plain files, written by pull request, and
it is validated in two layers (see [Checks](#checks)).

```
.ingitdb/root-collections.yaml      the three collections and their directories
graphs/.collection/definition.yaml  the columns of a graph record
graphs/$records/<id>.yaml           one record per graph, keyed by registry id
dependencies/$records/<graph>--<depends_on>.yaml
maintainers/$records/<github-handle>.yaml
index.json                          every graph in one file, generated
scripts/                            the meaning checks and index.json writer
```

Ways to read it:

- **Plain files.** Fetch `graphs/$records/<id>.yaml`, or `index.json` for
  everything at once.
- **The inGitDB CLI**, in a clone:
  `ingitdb select --path . --from graphs --where 'address==meaning://github.com/datatug/chinookdb' --fields '$id,repository,commit'`
- **Go, through [DALgo](https://github.com/dal-go/dalgo)**, with the
  [`dalgo2ingitdb`](https://github.com/ingitdb/dalgo2ingitdb) adapter.

## Format: `meaning-registry/draft-1`

A draft, like the meaning-file format `meaning/draft-1` that the graphs use: it
may change before `meaning-registry/1`.

### `graphs`: one record per graph

The file name is the registry id: `graphs/$records/chinook.yaml` registers
`chinook`.

| Column | Required | Meaning |
|---|---|---|
| (key) | yes | Registry id: lower-case letters, digits and single hyphens, at most 80 characters. |
| `format` | yes | `meaning-registry/draft-1`. |
| `title` | yes | A short name. |
| `description` | yes | What the graph covers, in a few sentences. |
| `kind` | yes | `universal` (concepts for any dataset, such as `core`) or `dataset` (the meaning of one dataset, bound to its model). |
| `status` | yes | `draft`, `published` or `deprecated`. |
| `homepage` | no | The publisher's own page for the graph, to be shown as **Website** on the graph's page at <https://meaninggraph.io> once that page shows it. A public https URL; see [What `index.json` guarantees about `homepage`](#what-indexjson-guarantees-about-homepage). It need not be on `github.com`. |
| `address` | yes | What consumers write: `meaning://{host}/{org}/{repo}`, the `meaning://` form of `repository`. |
| `repository` | yes | The repository's https URL on an allowed host (today only `github.com`), as `https://github.com/{org}/{repo}`: no `.git`, trailing slash, `.` or `..` segments. Two spellings that differ only in case are the same repository. |
| `commit` | yes | Full 40-character commit id of the current reviewed version. |
| `tag` | no | A tag that points at `commit`, when the graph has one. |
| `meaning_files` | yes | The meaning files, as paths in the repository. `*` matches within one path segment, so `*.meaning.yaml` means every meaning file in the repository root. |
| `meaning_licence` | yes | SPDX id of the meaning files' licence. |
| `model_files` | no | The data model files the meaning files bind to (for example ModelSpec). |
| `model_licence` | with `model_files` | SPDX id of the model files' licence. |
| `maintainers` | yes | GitHub handles; each one has a `maintainers` record. |

### `dependencies`: one record per graph a graph depends on

Keyed `<graph>--<depends_on>`, with columns `graph`, `depends_on` (both
registry ids) and `commit`: the commit of `depends_on` that the graph's own
`meaning://…?ref=` references pin. A graph depends on exactly the registered
graphs its meaning files reference.

### `maintainers`: one record per maintainer

Keyed by GitHub handle, with a `name`.

### Paths inside a repository

`meaninggraph/core` keeps its meaning files in the repository root, and its
checks read the root only. A dataset repository has other things in its root
(code, data, a website), so its meaning file may sit in a directory:
Chinook's is `model/chinook.meaning.yaml`. A registry entry therefore always
names its files: exact paths, or a `*` pattern within one directory. A
resolver that follows an address to a repository reads the files that the
entry names, at the commit it pins.

### Addresses

The address is the `meaning://` form of the repository URL:
`https://github.com/datatug/chinookdb` is
`meaning://github.com/datatug/chinookdb`, and a concept in it is
`meaning://github.com/datatug/chinookdb/<concept-id>?ref=<commit>`. That is the
form `meaninggraph/core` defines for its own concepts, the form Chinook uses to
reference them, and the address Chinook's own checks give the repository.
Draft 1 registers one graph per repository.

### Status

`draft` means the graph is usable and checked, but its format can still
change: every graph written in `meaning/draft-1` is `draft`, including `core`
and `chinook`. `published` is for graphs in a stable format, so consumers can
rely on it not changing shape. `deprecated` keeps the record (old pins stay
resolvable) but tells consumers to move on.

## How to register a graph

Open a pull request that adds:

1. `graphs/$records/<id>.yaml` with the columns above.
2. `dependencies/$records/<id>--<other>.yaml` for every registered graph the
   meaning files reference, with the commit they pin.
3. `maintainers/$records/<handle>.yaml` if a maintainer is new here.
4. The regenerated `index.json`: `npm ci && npm run index`.

Run the checks locally with `ingitdb validate` and `npm run check`; CI runs both
on the pull request. The check runs git over https only and ignores your
global and system git configuration (so an `insteadOf` rewrite to ssh does
not apply) and any inherited `GIT_*` repository variables. Behind a proxy or
a private certificate authority, set `HTTPS_PROXY` or `GIT_SSL_CAINFO`.

## How to use it

To resolve an address, look it up: `address` → `repository` and `commit`, then
read the `meaning_files` at that commit. `index.json` has every graph and its
dependencies in one file. Its `checksum` is `sha256:` and the SHA-256 of the
`graphs` array written as compact JSON (`JSON.stringify(index.graphs)`), so a
consumer can check that it read the whole file.

### What `index.json` guarantees about `homepage`

When an entry in `index.json` has a `homepage`, it is a string that is all of:

- at most 200 characters, ASCII only, and made of no characters other than the
  letters `A-Z a-z`, the digits `0-9`, and `- . _ ~ / :`. So it contains no
  whitespace, control character, quote (`"` or `'`), backtick, `<`, `>`, `&`,
  `%`, `?`, `#`, `@` or backslash, and can be written into a link as it stands;
- `https://`, in lower case, then a host, then a path:
  - the **host** is dot-separated labels of lower-case letters, digits and
    hyphens (1 to 63 characters each, none starting or ending with a hyphen),
    at least two labels, no trailing dot. It is not an IP address in any
    spelling, not `localhost`, and not a local, internal or reserved name
    (`.local`, `.internal`, `.test`, `.example`, `.onion` and similar). An
    international name is written in its `xn--` form (`https://xn--mnchen-3ya.de/`,
    not `https://münchen.de/`);
  - **no port** (not even `:443`), **no userinfo, no query and no fragment**
    (so `https://github.com/org/repo#readme` and `https://example.com/#/model`
    cannot be used);
  - the **path** starts with `/` and uses only `A-Z a-z 0-9 . _ ~ / -`: no
    percent escape (`%xx`), no empty segment (`//`), no `.` or `..` segment. A
    bare host is written with its slash, `https://example.com/`. Parentheses,
    `+`, `,`, `;`, `=`, `:` and `@` in a path are not accepted either;
- written exactly as the WHATWG URL parser would write it, so each page has one
  spelling.

An entry without a homepage has no `homepage` key (never `null` or `""`). The
checks read the text and **never fetch** the URL. They cannot tell whether the
page exists or what a public-looking name resolves to (`127.0.0.1.nip.io` is a
public name that points at a private address, and a look-alike `xn--` name is
valid): a site should show the ASCII form it is given, and whatever fetches a
homepage must check the address itself.

## Versioning

Moving a graph to a new version is a pull request that changes `commit` (and
`tag`, if any); the checks run against the new commit. Older commits stay
valid for anyone who pins them: a `?ref=` pin names an immutable commit, and
the registry never rewrites a graph's history, it only says which commit is
current.

## Checks

Two layers run in CI ([`.github/workflows/check.yml`](.github/workflows/check.yml)):

1. **inGitDB** ([`ingitdb/ingitdb-action`](https://github.com/ingitdb/ingitdb-action),
   at a pinned commit and CLI release) validates every record against its
   collection definition: column types, required columns, the `kind`,
   `status` and `format` values, the 40-character `commit`, no unknown
   columns, `model_licence` when there are `model_files`, and the foreign keys
   (`maintainers` name maintainer records; `graph` and `depends_on` name graph
   records).
2. **The meaning checks** (`npm run check`, [`scripts/check.mjs`](scripts/check.mjs))
   cover what a collection definition cannot express, and everything that
   needs the graph's repository:
   - ids follow the record-contract rule; commits are lower-case hex;
     licences are SPDX-shaped; paths stay inside the repository;
   - a `homepage`, when a record has one, passes the rules in
     [What `index.json` guarantees about `homepage`](#what-indexjson-guarantees-about-homepage).
     It is checked as text and **never fetched**: the checks make no request to
     the homepage's host, so a page that is down, moved or not yet deployed does
     not fail them. The only hosts the checks contact are the allow-listed git
     hosts (each record's `repository` and the checker's own repository) and
     the npm registry, which `npm ci` reads for the checker's locked
     dependencies;
   - every key of a record is a column its collection definition declares: an
     undeclared key (an `id`, a typo, a column of another collection) is
     refused. So is a YAML merge key, in any spelling (`<<`, `"<<"`, `? <<`,
     `!!merge <<`, or a `<<` under a `%YAML 1.1` directive), because a merged
     value is not a value written in the record; and so is any `%YAML` directive,
     which changes how values such as `yes` or `1:30` are read. An index entry is
     built from the declared columns only, in the order of the definition's
     `columns_order`, and its `id` is always the record's file name (a
     definition may not declare an `id` or `depends` column);
   - each address is the `meaning://` form of its repository, and no address
     or repository is registered under two ids;
   - each dependency record is keyed `<graph>--<depends_on>`;
   - `index.json` is what `npm run index` writes;
   - each graph's commit can be fetched from its repository, is in the
     history of the repository's default branch, and a `tag` (if any) points
     at it. GitHub serves a fork's commits through the parent repository's
     URL, so "can be fetched" alone would let a fork's commit be registered
     under the parent's address. The same rule applies to every commit one
     graph pins another at;
   - every listed file exists at that commit, and every model a meaning file
     reads is listed in `model_files`;
   - the meaning files pass the meaning checker: the `meaning/draft-1` JSON
     Schema and the cross-concept rules (references resolve, `extends` joins
     compatible kinds without a cycle, ids and values are unique, bindings
     name real ModelSpec entities and properties). A reference to another
     graph resolves through this registry, at the commit it pins;
   - the licence each file declares (a meaning file's `license`, or a
     `Licence:` / `SPDX-License-Identifier:` line at the top of a model file)
     is the one the entry states. A file that declares none takes the
     repository's default licence: the licence of its unsuffixed `LICENSE`
     (or `LICENCE`, `COPYING`) file when there is one, even one whose text
     the check does not recognise, or, without one, the one licence all its
     LICENSE files name. When that is not a single recognised licence, the
     file must declare its own;
   - listed files, and the models a meaning file reads, are regular files of
     the repository: no symbolic links, no `..`;
   - the dependency records are exactly the registered graphs the meaning
     files reference, at the commits they pin.

The meaning checker is not copied into this repository. It is
`scripts/lib/meaning.mjs`, with `meaning.schema.json`, of `meaninggraph/core`
at the commit that `graphs/$records/core.yaml` registers: the check fetches
that commit and installs its locked dependencies. That code is only ever
taken from `https://github.com/meaninggraph/core`, and only from a commit in
the history of its `main` branch, so a pull request cannot point CI at
checker code that only a fork has. A pull request that moves
`core` to a new commit therefore moves the checker with it, and is checked by
it.

The repositories the check fetches (a checkout of each graph and of the
checker at its commit, and the history of each default branch) are kept in a
git cache, so that a later run fetches only what is new. The cache is never
inside this repository, where a pull request could commit a `.cache`
directory holding a repository with hooks of its own:

- it is a directory of the user's own, `$XDG_CACHE_HOME/meaninggraph-registry`
  or, when `XDG_CACHE_HOME` is not set, `meaninggraph-registry-<user>` in the
  system's temporary directory, with one subdirectory per registry checkout.
  The check creates it with mode 0700 and refuses a cache directory that is a
  symbolic link, belongs to another user, can be written by others, or is
  inside the registry;
- the check refuses to run on a registry that tracks a `.cache` directory
  (`.cache/` is git-ignored, and nothing reads it any more);
- git never runs a hook from a hooks directory or a file-system monitor
  (`core.hooksPath` is an empty directory and `core.fsmonitor` is off on
  every command), reads no system or user configuration, talks only https,
  and does not follow replacement refs;
- a cached repository is used again only after it is verified: its
  configuration holds what git itself writes for such a repository and
  nothing else (no hook path, hook command, URL rewrite, filter, include or
  other remote), no file redirects it to other objects or history, and every
  object hashes to its name (`git fsck`). A checkout must also be at its
  commit, and its files are deleted and written from the commit again with
  a new index, so neither an index that hides an altered file nor a file
  left in the checkout has any effect. A repository that
  fails, or a branch history that cannot be brought up to date, is deleted
  and fetched again, and the check prints a `note:` line saying why;
- the cache is not removed with the checkout it belongs to: delete the
  directory to get the space back. A `.cache` directory that an earlier
  version left in a checkout is no longer used and can be deleted.

`npm test` proves each check fails on a broken entry: an unknown commit, a
missing path, a meaning file that does not fit the schema, a licence that
differs from the files, the same graph under a second id, a wrong address, a
dependency at the wrong commit, a missing or unused dependency, a reference to
an unregistered graph, an unlisted model, a stale `index.json`, a graph
commit, a pin or a checker commit that is not on the default branch, a
checker taken from another repository, the same repository spelled with
`.git` or in another case, a repository value shaped like a git option, a
model path that leaves the repository, a symbolic link, an undeclared licence
where the repository's default is ambiguous, and a tag lookalike. It also
proves the cache rules: a repository planted in a `.cache` directory of the
registry is not read when it is untracked and stops the check when it is
tracked, and its hooks do not run either way; no hook in a hooks directory
and no file-system monitor of a repository runs; a cached repository with a
forged object, or with configuration or files that git did not write, is
fetched again; a replacement ref is not followed; a file altered behind a
forged index is written from the commit again; and a cache directory inside
the registry, writable by others, or behind a symbolic link is refused.
`npm run test:ingitdb` (with `INGITDB_CLI` set to the CLI) proves inGitDB
rejects each broken constraint of the collection definitions.

## Planned search index

meaninggraph.io will search a Firestore collection that CI generates from
this database after each merge to `main`. It is never edited by hand and is
rebuilt from here when in doubt. Its records use the existing MeaningGraph
domain record contract, filled from the entry by name:

| Index field | Filled from |
|---|---|
| `id` | the record key (registry id); the contract's id rule is the registry's |
| `name` | `title` |
| `description` | `description` |
| `sourceRepo` | `repository` |
| `revision` | `commit` |
| `version` | `tag`, empty when there is none |
| `status` | `status`; the contract accepts `draft` and `published`, so a `deprecated` graph is left out of the index until the contract has a value for it |
| `entities` | not from the entry: read from the meaning files at `commit` |

## Licence

Everything in this repository (the records, the collection definitions,
`index.json`, the scripts) is [CC0-1.0](LICENSE). The graphs keep their own
licences, which each entry states.
