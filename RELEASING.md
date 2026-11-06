# Releasing

`@vllm-sr/dsh` goes to npm from GitHub Actions with [trusted publishing](https://docs.npmjs.com/trusted-publishers):
[`publish.yml`](.github/workflows/publish.yml) signs in to npm with a short-lived OIDC token, so the repository holds
no npm token, and npm attaches a provenance statement to every version it publishes.

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
2. Tag the merge commit and push the tag:

   ```bash
   git tag -a v0.3.1 -m "@vllm-sr/dsh 0.3.1"
   git push origin v0.3.1
   ```

The workflow runs the tests, stops unless the tag is `v` followed by `package.json`'s version, lists the tarball, and
runs `npm publish --access public --provenance`. A version that is already on npm is skipped, so the tag of a version
published by hand runs green. To run it again for an existing tag, start **Publish** from the Actions tab with the tag
under "Use workflow from" (`gh workflow run publish.yml --ref v0.3.1`); a run on a branch publishes nothing.

3. Once `npm view @vllm-sr/dsh version` shows the new version, name it on System Duo's site too, and release the site.
   The DeepSeek Harness lines of [app.vllm-sr.ai](https://app.vllm-sr.ai)'s "Ways in" and of its
   [docs](https://app.vllm-sr.ai/docs#deepseek-harness) (web and headless) name the version, as README.md's do, and
   install the old one until they change.
