# GitHub environments, secrets and Workload Identity Federation

This document lists every piece of configuration that lives outside the repository and is required for the workflows to run.

## 1. Environments

Create two environments under **Settings > Environments**:

| Environment | Required reviewers | Deployment branches | Wait timer |
|---|---|---|---|
| `uat` | none | `main` and tags `v*` | 0 |
| `production` | at least 1 (recommended 2 from a platform team) | `main` and tags `v*` | 0 (optional 5 min) |

Enable **Prevent self-review** on `production` so the author of a change cannot approve their own deployment. The `rollback.yml` workflow also targets these environments, so a production rollback is reviewed by the same group. If a lighter-weight rollback path is needed, add a `production-rollback` environment and change the `environment.name` in `rollback.yml`.

## 2. Secrets

Secrets are read with `${{ secrets.NAME }}`. Set them at the repository level for CI and at the environment level (`uat`, `production`) for deploys so each environment can impersonate a different, least-privilege service account.

| Secret | Scope | Description |
|---|---|---|
| `SONAR_TOKEN` | repository | SonarCloud token for the project (Analysis token type) |
| `WIF_PROVIDER` | repository (build) and per environment | Full resource name: `projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `WIF_SERVICE_ACCOUNT` | repository (build) and per environment | Email of the GCP service account to impersonate |
| `GCP_PROJECT_ID` | repository and per environment | Project that owns Artifact Registry (build) or the GKE cluster (deploy) |

Never store a service account JSON key. `google-github-actions/auth@v2` exchanges the GitHub OIDC token for a short-lived access token via Workload Identity Federation.

## 3. Variables

Set under **Settings > Secrets and variables > Actions > Variables** (repository level).

| Variable | Example (placeholder) | Used by |
|---|---|---|
| `ARTIFACT_REGISTRY_HOST` | `asia-south1-docker.pkg.dev` | `cd.yml`, `rollback.yml` |
| `ARTIFACT_REGISTRY_REPO` | `apps` | `cd.yml`, `rollback.yml` |
| `GKE_LOCATION` | `asia-south1` | deploy and rollback |
| `GKE_CLUSTER_UAT` | `example-uat-gke` | deploy and rollback |
| `GKE_CLUSTER_PROD` | `example-prod-gke` | deploy and rollback |

## 4. Workload Identity Federation in GCP

The following creates a pool, a GitHub OIDC provider restricted to this repository, and two service accounts (one for pushing images, one for deploying). Replace the placeholder values.

```bash
export PROJECT_ID="example-project-dev"
export PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
export GITHUB_ORG="deveshr17"
export GITHUB_REPO="github-actions-devsecops"
export POOL="github-pool"
export PROVIDER="github-provider"

gcloud iam workload-identity-pools create "${POOL}" \
  --project="${PROJECT_ID}" --location=global \
  --display-name="GitHub Actions pool"

# Restrict the provider to a single repository via attribute condition.
gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
  --project="${PROJECT_ID}" --location=global \
  --workload-identity-pool="${POOL}" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository == '${GITHUB_ORG}/${GITHUB_REPO}'"

# Service account for image pushes.
gcloud iam service-accounts create gha-image-push \
  --project="${PROJECT_ID}" --display-name="GitHub Actions image push"
gcloud artifacts repositories add-iam-policy-binding apps \
  --project="${PROJECT_ID}" --location=asia-south1 \
  --member="serviceAccount:gha-image-push@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Service account for deploys (one per environment is recommended).
gcloud iam service-accounts create gha-deploy-uat \
  --project="${PROJECT_ID}" --display-name="GitHub Actions deploy (uat)"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:gha-deploy-uat@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/container.developer"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:gha-deploy-uat@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"

# Allow identities from the pool (this repository) to impersonate the accounts.
# The `attribute.environment` condition binds the deploy account to one environment.
gcloud iam service-accounts add-iam-policy-binding \
  "gha-image-push@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}"

gcloud iam service-accounts add-iam-policy-binding \
  "gha-deploy-uat@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.environment/uat"

echo "WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
```

Repeat the deploy service account steps for `production` (typically in a separate project such as `example-project-prod`) with `attribute.environment/production`. `roles/container.developer` is broader than strictly necessary; for tighter scoping grant `roles/container.clusterViewer` at project level and a namespaced Kubernetes `Role` (get/list/patch on deployments, jobs, configmaps, services) bound to the service account via RBAC.

## 5. Branch protection

On `main`:

- Require a pull request with at least one approval and CODEOWNERS review.
- Required status checks: `CI status`, `Conventional commit title`, `Kustomize build and kubeconform (uat)`, `Kustomize build and kubeconform (prod)`, `Workflow lint (actionlint)`, `Manifest policy checks`.
- Require linear history; disallow force pushes.

## 6. Code scanning

Enable **Code scanning** in Settings > Code security so that SARIF uploads from Trivy and hadolint appear in the Security tab. No additional configuration is required; the workflows upload with distinct `category` values so results do not overwrite each other.

## 7. SonarCloud

Create the project in SonarCloud, set **Analysis method** to *GitHub Actions* (disable Automatic Analysis so it does not conflict with CI), and update `sonar.organization` / `sonar.projectKey` in `sonar-project.properties`.
