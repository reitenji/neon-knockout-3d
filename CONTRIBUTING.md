# Development workflow

Create a `feature/<short-name>` branch from `develop` and open a pull request back to `develop`. When the integrated changes are ready for release, open a pull request from `develop` to `main` and use a merge commit to preserve shared ancestry. GitHub's default branch remains `main`; select `develop` as the base for feature pull requests.

Both `main` and `develop` require pull requests, resolved review conversations, and the successful GitHub Actions `verify` check. Force pushes and branch deletion are blocked; the ruleset has no bypass actors, including administrators. A separate approving reviewer is optional so the repository owner can merge their own PRs after CI passes.

Use Node.js 24 and install dependencies with `npm ci`. Install the Chromium binary with `npx playwright install chromium`; Linux CI also needs `--with-deps`. Before opening a PR, run:

```sh
npm run lint
npm run typecheck
npm test
npm run test:load
npm run build:lan
npm run build:sites
```

The test suite includes a real Chromium/WebRTC interoperability check. The Sites signaling tests require `node:sqlite`, which is available in Node.js 24. A merge does not deploy the hosted Sites application; deployment is a separate action.
