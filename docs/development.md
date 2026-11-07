# Development

## Image

```bash
docker build -t aws-kinesis-local .
docker run --rm -p 4567:4567 aws-kinesis-local
```

The Dockerfile installs a pinned kinesalite release with npm. `docker-entrypoint.sh` maps the variables in [Configuration](configuration.md) to kinesalite flags.

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
| [CI](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/ci.yml) | Changes to `Dockerfile` or the workflow | Builds the image for `linux/amd64` and `linux/arm64`, pushes it to Docker Hub and scans it with Trivy. On pull requests, it deploys the Kustomize manifests and the chart to a kind cluster. |
| [Charts](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/charts.yml) | Changes under `charts/` | Lints the chart and checks the chart README. On pull requests, it installs the chart in a kind cluster. On main, it publishes the chart. |
| [Issues](https://github.com/saidsef/aws-kinesis-local/blob/main/.github/workflows/issues.yml) | New or reopened issues | Posts a comment that thanks the reporter. |

GitHub withholds repository secrets from pull requests opened from forks and by Dependabot, so the CI workflow fails at the Docker Hub login on those pull requests.

## Image tags

The CI workflow tags each image with its branch name, with `/` replaced by `-`. A build from main is tagged `latest` and `vYYYY.MM` for the month of the build, so each build from main replaces that month's tag. The chart and the Kustomize manifests reference a `vYYYY.MM` tag.
