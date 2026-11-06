# Releasing

`@vllm-sr/dsh` is published to npm by hand, from a tarball checked first, and its tag follows ([Release](#release)).
[`publish.yml`](.github/workflows/publish.yml) runs on the tag, finds the version on npm and stays green. The workflow
is ready for [trusted publishing](https://docs.npmjs.com/trusted-publishers), where it signs in to npm with a
short-lived OIDC token, so the repository holds no npm token, and npm attaches a provenance statement to every
version it publishes. That is not configured for `@vllm-sr/dsh`: npm refused the v0.6.12 tag's Publish run with
E404, and every 0.6.x release was published by hand.

## Turn on trusted publishing

On npmjs.com, open the package's **Settings**, find **Trusted Publisher**, choose **GitHub Actions** and enter:

- Organization or user: `Xunzhuo`
- Repository: `dsh-system-one-plugin`
- Workflow filename: `publish.yml`
- Environment name: leave empty; the workflow uses none
- Allowed actions: allow `npm publish`, which the workflow runs (`npm stage publish` alone is not enough)

From a terminal instead (npm 11.10 or later, an account with 2FA):
`npm trust github @vllm-sr/dsh --repo Xunzhuo/dsh-system-one-plugin --file publish.yml --allow-publish`.

npm attaches a trusted publisher only to a package that already exists, and a new trusted publisher expires if it has
not published within 2 days. While `@vllm-sr/dsh` is not on npm yet, publish its first version once by hand from a
clean checkout of its tag (`npm publish --access public --provenance=false`; provenance needs CI), and add the trusted
publisher shortly before the next release. When the workflow has published, set the package's **Publishing access**
to "Require two-factor authentication and disallow tokens".

`publishConfig.provenance` is `true`, so a plain `npm publish` outside CI stops with "Automatic provenance generation
not supported for provider: null". That keeps a publish from a laptop deliberate.

## Release

1. Set `version` in `package.json`, add the version's entry to `CHANGELOG.md`, and merge to `main`. README.md's
   install lines name no version, so they need no change: pnpm installs a bare name once a release is a day old. When
   the supported DeepSeek Harness range changes, change `engines.dsh` and the `@deepseek-ai/dsh-*` peer ranges
   together, and the `cordis` and `schemastery` ranges to the versions that harness ships.
2. Publish the version by hand, before its tag. From a clean checkout of the merge commit, run the tests, pack the
   tarball, check what it holds, and publish that file. The npm token is only in `$HOME/.config/npm-publish/npmrc`
   (mode 600): npm reads it through `NPM_CONFIG_USERCONFIG`, and the token is never printed or put on a command line.

   ```bash
   npm test
   npm pack                        # writes vllm-sr-dsh-0.3.1.tgz
   tar tzf vllm-sr-dsh-0.3.1.tgz   # package.json, README.md, LICENSE, cordis.patch.yml, src/ and web/ only
   NPM_CONFIG_USERCONFIG="$HOME/.config/npm-publish/npmrc" \
     npm publish ./vllm-sr-dsh-0.3.1.tgz --access public --provenance=false
   npm view @vllm-sr/dsh version   # 0.3.1
   ```

   Outside CI `--provenance=false` is needed (`publishConfig.provenance` is `true`), and the `./` keeps npm from
   reading the file name as a GitHub shorthand.
3. Once `npm view @vllm-sr/dsh version` shows the new version, tag the merge commit and push the tag:

   ```bash
   git tag -a v0.3.1 -m "@vllm-sr/dsh 0.3.1"
   git push origin v0.3.1
   ```

   The tag's Publish run tests it, stops unless the tag is `v` followed by `package.json`'s version, lists the
   tarball, finds the version on npm ("@vllm-sr/dsh@0.3.1 is already on npm; nothing to publish.") and stays green. A
   tag pushed before the version is on npm fails at Publish with E404: publish by hand, then run it again (`gh run
   rerun <run id>`, or start **Publish** for the tag: `gh workflow run publish.yml --ref v0.3.1`; a run on a branch
   publishes nothing). If trusted publishing is configured on npmjs.com later (the package owner's call), the order
   may flip back: push the tag first and let the workflow publish, with provenance.
4. Leave System Duo's site as it is. The DeepSeek Harness lines of [app.vllm-sr.ai](https://app.vllm-sr.ai)'s
   "Ways in" and of its [docs](https://app.vllm-sr.ai/docs#deepseek-harness) (web and headless) name no version, and
   neither do README.md's install lines: `dsh plugin --profile web add @vllm-sr/dsh`. pnpm installs a bare name only
   once a release is a day old, so both give a new version a day after `npm view @vllm-sr/dsh version` shows it, with
   no site release.

   Keep releases at least a day apart. Until the newest release is a day old, the bare name installs the newest one
   that is, so a release that follows another within the day keeps visitors on the one before both, and a release
   replaced within its first day still reaches them once it turns a day old. The site's and README.md's install lines
   both stay unversioned: whoever cannot wait a day names the version, as README.md's FAQ says
   (`@vllm-sr/dsh@<version>`).
