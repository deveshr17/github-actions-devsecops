# Pipeline design

This document describes the stages of the delivery pipeline, the gate applied at each stage, and what happens when a stage fails. The pipeline is split across four workflows so that permissions and triggers stay narrow.

## Workflows at a glance

| Workflow | Trigger | Purpose | Permissions |
|---|---|---|---|
| `pr-validation.yml` | `pull_request` (opened, edited, synchronize, reopened) | PR title, actionlint, Kustomize render, kubeconform, Trivy config scan | `contents: read`, `pull-requests: read` |
| `ci.yml` | `pull_request` to `main`, `push` to `main` | Lint, unit tests, SonarCloud, Trivy fs, hadolint, image build, Trivy image scan | `contents: read`, `security-events: write` |
| `cd.yml` | `push` to `main`, tags `v*.*.*` | Build and push once, deploy UAT, approval, deploy production | `id-token: write` only in the jobs that need it |
| `rollback.yml` | `workflow_dispatch` | Roll an environment back to the previous revision or a named tag/digest | `id-token: write` |

`reusable-docker-build-push.yml` and `reusable-deploy-gke.yml` are `workflow_call` workflows invoked by `cd.yml`. They contain no triggers of their own and can be reused by other services in the same organisation.

## Stages

```
push / PR
  |
  +-- PR validation ------ title, actionlint, kustomize build, kubeconform, trivy config
  |
  +-- CI
  |     lint ---------------------------- node scripts/lint.js
  |     unit tests + coverage ------------ node:test, lcov
  |     SonarCloud + quality gate -------- sonarqube-scan-action, quality-gate-action
  |     Trivy fs (vuln, secret, misconfig) SARIF + gate
  |     hadolint ------------------------- SARIF + gate
  |     image build (no push) ------------ buildx, gha cache
  |     container smoke ------------------ start, probe, uid check, SIGTERM
  |     Trivy image ---------------------- SARIF + gate
  |
  +-- CD (main / tags only)
        build + push ---------------------- OIDC to Artifact Registry, SBOM + provenance
        Trivy image (pushed digest) ------- gate before any deploy
        deploy UAT ------------------------ kustomize set image <digest>, apply, rollout status, smoke Job
        approval --------------------------- GitHub environment `production` required reviewers
        deploy production ------------------ same digest, same procedure
```

## Gates and failure policy

| Stage | Gate | On failure |
|---|---|---|
| PR title | Conventional Commits type and lowercase subject | PR check fails; nothing else affected |
| Lint / tests | Exit code non-zero | CI fails; image is not built |
| SonarCloud | Quality gate status must be `OK` (waits up to 5 min) | CI fails. Skipped, not failed, on PRs from forks because `SONAR_TOKEN` is unavailable |
| Trivy fs | Any CRITICAL or HIGH with a fix available | CI fails. SARIF is uploaded first so findings are visible in the Security tab either way |
| hadolint | Any warning or error not listed in `.hadolint.yaml` | CI fails before the image build |
| Image build | Build must succeed and the container must serve `/healthz`, run as UID 65532 and exit cleanly on SIGTERM | CI fails |
| Trivy image | Same policy as fs, applied to the OS and library layers of the built image | CI fails; on CD, the image is already pushed but is never deployed |
| Deploy UAT | `kubectl rollout status` within timeout and smoke Job succeeds | Automatic `rollout undo` to the previous revision; production job never starts |
| Approval | At least one required reviewer approves the `production` environment | Workflow waits (up to 30 days) then expires |
| Deploy production | Same as UAT with a longer rollout timeout | Automatic `rollout undo`; workflow marked failed; diagnostics printed |

### Why SARIF and gate are separate steps

`aquasecurity/trivy-action` exits non-zero when the gate trips, which would skip a subsequent upload step unless it is marked `if: always()`. Producing SARIF with `exit-code: 0` first and then running the gate in table format guarantees the Security tab is populated even for failing builds, and the second run reuses the vulnerability database downloaded by the first (`skip-setup-trivy: true`).

### Why the pushed image is scanned again

CI scans the image built for the PR. CD rebuilds from the merge commit, with buildx cache but potentially with newer base-image layers or dependency resolutions. Scanning the exact digest that will be deployed closes that gap. The image is pushed before the scan so that the SBOM and provenance attestations exist for auditing; the deploy jobs depend on the scan job succeeding, so a failing digest is never rolled out.

## Concurrency

- CI: `ci-<workflow>-<pr number | ref>` with `cancel-in-progress: true`. Superseded PR builds are cancelled.
- CD: `cd-<ref>` with `cancel-in-progress: false`. A second push to `main` queues behind the running release train rather than interrupting a deploy.
- Rollback: `cd-<environment>-rollback` so two rollbacks of the same environment cannot overlap.

## Caching

- npm: `actions/setup-node` cache keyed on `app/package-lock.json`.
- Docker layers: `type=gha` cache in both CI and CD builds. `mode=max` exports every layer including the dependency-install stage.
- Trivy DB: downloaded once per job by the SARIF step and reused by the gate step.

## Timeouts

Every job sets `timeout-minutes`. Deploy jobs additionally pass `--timeout` to `kubectl rollout status` (5 minutes UAT, 10 minutes production) so a stuck rollout triggers rollback rather than hanging until the job timeout.

## Outputs and traceability

- The build job publishes `image`, `digest`, `tag` and `image_ref` as workflow outputs; both deploy jobs consume the same `digest`.
- Every deploy annotates the Deployment with `kubernetes.io/change-cause` containing the tag, short SHA, actor and run ID. `kubectl rollout history` therefore maps each revision to a GitHub Actions run.
- Step summaries record image, digest, previous and new revision, and rollout/smoke results.
