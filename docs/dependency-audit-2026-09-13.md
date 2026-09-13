# Dependency audit — 2026-09-13

This records the #65 lockfile review, not a permanent assertion that dependencies
are vulnerability-free. Re-run the audit for every dependency update and release.

## Reproduce

```sh
yarn install --immutable
yarn npm audit --all --recursive --json
yarn check
yarn test:unit
yarn vsce package --no-yarn -o svn-scm.vsix
node scripts/check-package-size.cjs svn-scm.vsix
```

The audit exits nonzero for the accepted findings below. Do not suppress the exit
code and call the result clean; compare the full output, including new advisory
IDs. A network/registry error is a failed audit, not an empty finding set. Use
`yarn why -R <package>` to trace consumers and `yarn npm info <package>@<version>
--fields version,engines --json` to verify compatibility before an override.

All dependencies are declared in `devDependencies`, including libraries bundled
at runtime. Consequently `--environment production` alone cannot establish the
security of this extension. Inspect the production webpack source map and VSIX.

## Compatible lockfile updates

Refreshed the packages below with `yarn up -R` within existing declared ranges;
no forced major overrides or compatibility-anchor changes were made.

| Package | Previously affected versions | Resolved versions | Reviewed advisories |
| --- | --- | --- | --- |
| ajv | 8.5.0 | 8.20.0 | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) |
| brace-expansion | 5.0.6 | 5.0.9 | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) |
| form-data | 4.0.4 | 4.0.6 | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) |
| js-yaml | 3.14.2 / 4.1.1 | 3.15.2 / 4.3.2 | [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68), [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj), [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) |
| linkify-it | 5.0.0 | 5.0.2 | [GHSA-22p9-wv53-3rq4](https://github.com/advisories/GHSA-22p9-wv53-3rq4), [GHSA-v245-v573-v5vm](https://github.com/advisories/GHSA-v245-v573-v5vm) |
| markdown-it | 14.1.1 | 14.3.2 | [GHSA-6v5v-wf23-fmfq](https://github.com/advisories/GHSA-6v5v-wf23-fmfq) |
| qs | 6.15.2 | 6.16.0 | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) |
| semver | 7.3.5 | 7.8.5 | [GHSA-c2qf-rxjj-qqgw](https://github.com/advisories/GHSA-c2qf-rxjj-qqgw) |
| tmp | 0.2.6 | 0.2.7 | [GHSA-7c78-jf6q-g5cm](https://github.com/advisories/GHSA-7c78-jf6q-g5cm) |

The repeated audit no longer reports any of the advisories in this table.

## Accepted tooling risk

`mocha@10.8.2` retains `serialize-javascript@6.0.2`, affected by
[code injection](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) and
[CPU exhaustion](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v).
Version 7.0.5 addresses both but declares Node >=20, above the Node 18 API/runtime
compatibility floor for VS Code 1.86. An override would also cross Mocha's
`^6.0.2` dependency contract. Retain Mocha 10 and record the risk rather than
silently weakening minimum-host support.

In the installed Mocha source the serializer is used by its parallel worker
pool. Our unit and host runners construct serial Mocha instances with project-
controlled options; no workspace/user objects are supplied to that serializer.
It is absent from the production webpack module inventory and VSIX. This limits
the identified exposure to tooling; it is not a claim that vulnerable code is
intrinsically safe. Revisit before enabling Mocha parallel workers, accepting
external runner options, changing the compatibility floor, or the next release.
The maintainer owns this exception; prefer a compatible upstream backport.

Six deprecation notices remain, distinct from the two security advisories:
`glob@8.1.0` belongs to Mocha 10; `inflight@1.0.6`, `prebuild-install@7.0.1`,
`npmlog@4.1.2`, `gauge@2.7.4`, and `are-we-there-yet@1.1.7` belong to legacy
tooling/native-install paths including optional `keytar@7.8.0`. They are not in
the shipped bundle. Replacing those dependency majors underneath their consumers
without upstream compatibility evidence is not an accepted fix. Track upstream
packager/test-runner updates and re-evaluate these notices at each release.

## Packaging evidence

The production source-map inventory contains `@vscode/iconv-lite-umd`,
`balanced-match`, `brace-expansion`, `chardet`, `dayjs`, `jschardet`, `minimatch`,
`sax`, `semver`, `tmp`, `xml2js`, and `xmlbuilder`. Comparing the resolved versions
against the repeated full audit found no reported vulnerable package version in
this inventory. This is audit evidence, not proof of absence of vulnerabilities.

Local #65 packaging on top of #77 produced a 1,039,582-byte bundle and a
451,204-byte VSIX, below the 1.5 MiB / 768 KiB budgets. Inspect every new artifact:
only the manifest, README/changelog/license, bundle/license, CSS, icons, and
runtime images are intended. Source maps, source/tests, maintainer docs,
AGENTS.md, and release scripts are excluded. Full OS/minimum/stable CI remains
mandatory before merging dependency changes.

