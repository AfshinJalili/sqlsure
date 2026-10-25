# Releasing

Releases are cut by pushing a version tag. [`.github/workflows/release.yml`](./.github/workflows/release.yml) then:

1. runs every CI job (unit tests and the packed-tarball smoke test on the oldest and latest supported Node 22 and 24 and on Node 26, and the full eval suite with its thresholds);
2. checks the tag matches `package.json` and that `CHANGELOG.md` has a section for the version;
3. publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no stored token);
4. creates a GitHub Release whose notes are that `CHANGELOG.md` section.

Re-running the workflow is safe: a version already on npm is not published again, and an existing GitHub Release is left alone.

## Cutting a release

```sh
git switch main && git pull
# 1. Move the entries under "## [Unreleased]" in CHANGELOG.md to a new "## [X.Y.Z] - YYYY-MM-DD"
#    section and add its compare link at the bottom. Commit.
# 2. Bump the version; this commits package.json and creates the tag vX.Y.Z.
npm version X.Y.Z -m "Release %s"
# 3. Push the commit and the tag. The tag starts the release workflow.
git push --follow-tags
```

Watch it with `gh run watch`. When it is green, `npm view sqlsure version` shows the new version.

## Versioning

sqlsure follows semver. While it is 0.x, a change that alters the generated types of existing queries (a column becoming non-null, a new type mapping) is a minor release; fixes that only remove errors are patches.

## One-time setup: trusted publishing

0.1.0 was published by hand on 2026-10-25. Before the workflow can publish later versions, npm must trust it. npm refuses to configure this with a token that bypasses two-factor authentication, so do it on the website:

1. On https://www.npmjs.com/package/sqlsure/access, under **Trusted Publisher**, choose **GitHub Actions**.
2. Enter organization or user `AfshinJalili`, repository `sqlsure` and workflow filename `release.yml`; leave the environment empty.
3. Save. If npm asks for two-factor authentication, turn it on first (Account → Two-Factor Authentication).

With an npm session that has 2FA, the command line does the same thing:

```sh
npm trust github sqlsure --repo AfshinJalili/sqlsure --file release.yml --allow-publish
```

npm attaches provenance only to packages published from public repositories.
