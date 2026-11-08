# Development

## Source

The TypeScript source lives in [`src/`](https://github.com/saidsef/aws-kinesis-local/tree/main/src). Node.js runs it directly, so development needs no build step:

```bash
npm ci
npm start -- --port 4567 --path ./data
```

| Command | What it does |
| --- | --- |
| `npm run generate` | Generates `src/generated/model.ts` from the Smithy model. The test, typecheck and build commands run it first. |
| `npm run typecheck` | Checks every source and test file with TypeScript. |
| `npm test` | Runs the unit and integration tests against a server in the same process. |
| `npm run build` | Compiles the source and its type declarations to `dist/`, which the npm package and the image ship. |
| `npm run model -- <commit>` | Downloads the Kinesis Smithy model from `aws/api-models-aws` at that commit and strips its documentation. |

[Architecture](specs/architecture.md) describes the source layout, and [Request validation](specs/validation.md) describes the model and the generator. The source has no comments. The pages under `docs/specs/` hold the reasons behind the design.

## Image

```bash
docker build -t aws-kinesis-local .
docker run --rm -p 4567:4567 aws-kinesis-local
```

The Dockerfile compiles the source in a build stage and copies only the compiled JavaScript into the runtime stage. The runtime stage has no npm packages, and it removes npm, npx, Corepack and Yarn from the Node.js image. `docker-entrypoint.sh` maps the variables in [Configuration](configuration.md) to command-line flags.

## Tests against the image

[Testing](specs/testing.md) describes each suite. The client suites share one container and together create more shards than the default limit, so start it with a higher one:

```bash
docker run -d -p 4567:4567 -e SHARDLIMIT=1000 aws-kinesis-local
```

These commands then run the suites from the repository root:

```bash
KINESIS_ENDPOINT=http://127.0.0.1:4567 npm run test:endpoint
KINESIS_ENDPOINT=http://127.0.0.1:4567 sh test/clients/aws-cli.sh
KINESIS_ENDPOINT=http://127.0.0.1:4567 python test/clients/test_boto3.py
IMAGE=aws-kinesis-local sh test/kcl/run.sh
```

The Kinesis Client Library suite starts its own containers and needs only Docker.

## Releases

The version in `package.json` drives each release. Bump it in a pull request, and the [Release](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/release.yml) workflow does the rest when the pull request merges. It runs only on pushes to `main`, so no other branch and no manual run can publish:

1. It skips steps 2 to 4 when the tag `v<version>` exists and npm already has that version.
2. It runs the typecheck, the tests and the Kinesis Client Library suite against a fresh image.
3. It tags the commit `v<version>` and creates a GitHub release with generated notes. It never moves an existing tag.
4. It publishes `@saidsef/aws-kinesis-local` to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so the workflow needs no npm token and npm records provenance for the package.
5. It builds the image from the tag `v<version>` for `linux/amd64` and `linux/arm64`, unless Docker Hub already has it, and moves the tags that [Image tags](#image-tags) describes.

The trusted publisher on npmjs.com names the user `saidsef`, the repository `aws-kinesis-local` and the workflow `release.yml`, and allows `npm publish`. Renaming the workflow file or moving the repository breaks publishing until the trusted publisher matches again. If a publish fails, use "Re-run jobs" on that workflow run.

npm accepts a trusted publisher only for a package that already has a version, so version 1.0.0 was published by hand from its tag. Every later version goes through the workflow.

## Chart

```bash
helm lint charts/kinesis
helm template kinesis charts/kinesis
```

helm-docs generates the [chart README](https://github.com/saidsef/aws-kinesis-local/blob/main/charts/kinesis/README.md) from `Chart.yaml` and the `# --` comments in `values.yaml`. Give each new value a `# --` comment, then regenerate the README with the helm-docs version that the Charts workflow pins:

```bash
docker run --rm -v "$PWD:/helm-docs" -u "$(id -u)" jnorwood/helm-docs:<version>
```

The Charts workflow fails when the committed chart README differs from the generated one.

chart-releaser publishes each chart version as a GitHub release named `kinesis-<version>`. Bump `version` in `Chart.yaml` with every chart change, and list the changes in its `artifacthub.io/changes` annotation.

## Documentation

Read the Docs builds this site from `mkdocs.yml` with MkDocs Material. To preview it, run `uv pip install mkdocs-material && mkdocs serve` in a virtual environment.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [CI](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/ci.yml) | Changes to the source, tests, model, package files, Dockerfile, entrypoint or the workflow | Typechecks and tests the source, installs the packed npm package and runs it, then builds the image and runs the SDK, AWS CLI and boto3 suites and a Trivy scan against it. On pull requests, when those pass, it builds the image for `linux/amd64` and `linux/arm64`, pushes it to Docker Hub under the branch name, and deploys the Kustomize manifests and the chart to a kind cluster. |
| [Release](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/release.yml) | Changes on main to the source, model, package files or the workflow | Tests a new version, tags it, creates a GitHub release, publishes it to npm and pushes its image to Docker Hub, as [Releases](#releases) describes. |
| [Charts](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/charts.yml) | Changes under `charts/` | Lints the chart and checks the chart README. On pull requests, it installs the chart in a kind cluster. On main, it publishes the chart. |
| [Issues](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/issues.yml) | New or reopened issues | Posts a comment that thanks the reporter. |

GitHub withholds repository secrets from pull requests opened from forks and by Dependabot, so the CI workflow fails at the Docker Hub login on those pull requests.

## Image tags

The release workflow pushes each release under its version, such as `1.0.1`, and never overwrites a version tag that is already on Docker Hub. Every time it runs on `main`, it points `latest` and the minor and major tags, such as `1.0` and `1`, at the image of the version in `package.json`. It moves them by digest, without building the image again. A pre-release version, such as `1.1.0-rc.1`, gets only its own tag and does not move the others.

The CI workflow pushes an image for each pull request, tagged with the branch name, with `/` replaced by `-`. Older images also have month tags, such as `v2026.11`. Docker Hub keeps them, but no workflow pushes month tags any more. The chart and the Kustomize manifests still reference a `vYYYY.MM` tag.

The image carries the standard OCI labels. CI sets `org.opencontainers.image.version` from `package.json`, and adds `org.opencontainers.image.created` and `org.opencontainers.image.revision` for each build. A local build reports the version as `dev`.
