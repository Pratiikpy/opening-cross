# ADR-0973: A diagnosis links the program's documentation and source, and says whether they are for the release it explained

Status: accepted (2026-10-16) · Row L5 · Code `packages/diagnose` · Evidence `W5-1H.md` · Extends ADR-0303

## Decision

1. **A diagnosis of a program error carries `docs`**: the documentation pages, the documentation's own explanation of that error, a permalink to the line that defines the error in the program's source at a pinned commit, `raisedIn` for a program whose documentation lists where each error is returned, and `versions`: the IDL's release, the release the documentation's changelog lists first, the release in the source's `Cargo.toml`, and whether each equals the IDL's.
2. **"Version-matched" is a statement that is checked, not assumed.** A page or a commit for a different release is still linked, and the diagnosis says so in words (`docs.note`), because an explanation of the wrong release is worse than none if it is presented as right.
3. **The words are attached only where they agree.** The generator parses the documentation's error tables and the source's `#[error_code]` enum and attaches a cause or a line only where the name at that code equals the IDL's. Every disagreement is printed when the tables are generated.
4. **Sources are the local captures**: `meteora-resources` (the published documentation) and `research/repos` (the program repositories, each at the commit that was read). Nothing is fetched at run time.
5. **Nothing is attached where nothing is held**: Anchor framework errors, runtime errors, and programs with neither documentation nor source here (the Opening Cross programs) have `docs: null`.

## What it found

Meteora DAMM v2: the IDL is 0.2.5, the documentation's changelog lists 0.2.4, and the source commit is 0.2.4. Zap: the IDL is 0.2.0 and the documentation lists 0.2.2. Raydium CPMM: the source has an error (`LamportsCalculateError`, code 6015) that the IDL on file does not. Meteora DBC agrees across all three (0.2.1). DLMM's documentation (0.12.0) agrees with its IDL and no source is held. These are reported to the reader of a diagnosis, not corrected.

## Alternatives rejected

- Linking only the documentation's home page: no version, no error.
- Fetching the documentation when a diagnosis is made: a network call in a library whose promise is that it works from tables, and a page that can change under an old diagnosis.
- Copying Meteora's text into the package: a licence question (NOT VERIFIED) and a copy that goes stale.

## Consequences

The documentation lines and links are as current as the local captures; refreshing them is regenerating the tables. The commit permalinks are to the clone's commit, which is not guaranteed to be the release the deployed program was built from (the Cargo release is compared and reported, but a program deployed from a commit between releases is not detected). Only five programs have anything attached.
