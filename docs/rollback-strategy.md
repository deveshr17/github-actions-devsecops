# Rollback strategy

Rollbacks are a first-class, tested path rather than an emergency procedure improvised under pressure. There are two mechanisms: automatic rollback inside the deploy workflow and a manual rollback workflow.

## Automatic rollback (inside `reusable-deploy-gke.yml`)

Trigger conditions (all must hold):

- `kubectl apply -k` succeeded, so the Deployment was actually changed.
- A previous revision existed (`previous_revision != 0`); a first-ever deploy has nothing to roll back to.
- Either `kubectl rollout status` timed out / reported failure, or the in-cluster smoke Job failed or timed out.

Actions:

1. `kubectl rollout undo deploy/sample-service --to-revision=<previous>` restores the previous ReplicaSet, which references the previous image digest.
2. The Deployment is annotated with `kubernetes.io/change-cause="AUTO-ROLLBACK to revision N after failed deploy of <tag> run <id>"`.
3. `kubectl rollout status` is awaited again so the job only finishes once the old version is fully serving.
4. Diagnostics (describe, pods, recent events, rollout history) are printed to the log; the job fails so the production stage is never reached.

The rolling update strategy (`maxSurge: 1`, `maxUnavailable: 0`) combined with readiness probes means a failing new version never receives traffic in the first place; the rollback restores the desired state so the cluster stops trying to converge on the broken version.

## Manual rollback (`rollback.yml`)

Run from the Actions tab with three inputs:

| Input | Meaning |
|---|---|
| `environment` | `uat` or `production`; selects cluster, namespace and environment secrets |
| `target` | `previous` (rollout undo), an image tag such as `sha-1a2b3c4` or `v1.4.1`, or a full `sha256:` digest |
| `reason` | Free text recorded in the change-cause annotation |

Modes:

- **previous**: `kubectl rollout undo`. Fastest option; uses the ReplicaSet history retained by `revisionHistoryLimit: 10`.
- **tag or digest**: the tag is resolved to a digest with `gcloud artifacts docker images describe`, then `kubectl set image deploy/sample-service app=<image>@<digest>`. Only the image changes; ConfigMap and other manifest fields remain as currently applied. This is intentional: a rollback should be the smallest possible change.

After either mode the workflow waits for the rollout, runs the same smoke Job used by deploys, and writes a summary showing revision and image before and after.

## Approval for production rollbacks

The rollback job declares `environment: production`, so it inherits the same required-reviewer rule as a production deploy. In practice this means a second person confirms the rollback. If a faster path is needed, create a separate `production-rollback` environment with a smaller reviewer set (or none, with a tight deployment-branch policy) and point `rollback.yml` at it. The trade-off is documented in `github-environments-setup.md`.

## Sequence

```
operator            GitHub Actions                 GKE
   |  dispatch rollback   |                          |
   |--------------------->|                          |
   |                      | resolve target           |
   |                      | (previous | tag -> digest)|
   |                      | rollout undo / set image |
   |                      |------------------------->|
   |                      | annotate change-cause    |
   |                      |------------------------->|
   |                      | rollout status --timeout |
   |                      |<-------------------------|
   |                      | smoke Job                |
   |                      |------------------------->|
   |                      |<-------------------------|
   |   summary            |                          |
   |<---------------------|                          |
```

## What rollback does not cover

- **Schema or data migrations.** The service has no database; if one is added, migrations must be backward compatible for at least one release so that rolling the application back does not require rolling the schema back.
- **ConfigMap changes** when rolling back by tag. Use `previous` mode (which restores the previous pod template including env from the ConfigMap generator hash) if the configuration also needs to be reverted.
- **Infrastructure changes.** Cluster, Istio, and load balancer configuration are owned by separate repositories.

## Verifying a rollback

```bash
kubectl -n sample-service-prod rollout history deploy/sample-service
kubectl -n sample-service-prod get deploy sample-service -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n sample-service-prod port-forward svc/sample-service 8080:80 &
scripts/smoke-test.sh http://localhost:8080
```
