# Security controls

Controls are listed by the layer they protect, with the file that implements each one.

## Source and pipeline

| Control | Implementation |
|---|---|
| No long-lived cloud credentials | `google-github-actions/auth@v2` with Workload Identity Federation in every workflow that touches GCP; no JSON keys anywhere |
| Least-privilege tokens | `permissions: contents: read` at workflow level; `id-token: write` and `security-events: write` only on the jobs that need them |
| Actions pinned | All actions pinned to a major version or exact release (`trivy-action@0.28.0`, `hadolint-action@v3.1.0`); Dependabot keeps them current weekly |
| Fork PR safety | CI never pushes; SonarCloud skipped on forks (no secrets exposure); CD runs only on `push` |
| Secret scanning | Trivy `secret` scanner runs in the filesystem scan on every PR |
| Workflow lint | `actionlint` in `pr-validation.yml` catches expression and shell mistakes |
| Review requirements | CODEOWNERS on workflows, manifests, Dockerfile and Trivy policy; branch protection documented in `github-environments-setup.md` |
| Change control for production | GitHub environment `production` with required reviewers and self-review prevention |

## Code quality and dependencies

| Control | Implementation |
|---|---|
| Static analysis and quality gate | SonarCloud scan plus `sonarqube-quality-gate-action`; the gate must be `OK` |
| Dependency vulnerabilities | Trivy fs scan of `package-lock.json`; CRITICAL/HIGH with fix available block the build |
| Reproducible installs | `npm ci --ignore-scripts` in CI and in the Dockerfile; lockfile committed |
| Minimal dependency surface | Only `express` and `prom-client` at runtime; no devDependencies, so the build stage installs nothing that ships |
| Automated updates | Dependabot for npm, Docker base images and GitHub Actions |

## Container image

| Control | Implementation |
|---|---|
| Distroless runtime | `gcr.io/distroless/nodejs20-debian12:nonroot`: no shell, no package manager |
| Non-root | `USER 65532:65532` in the Dockerfile; verified in CI by inspecting `Config.User` |
| Multi-stage build | Dependencies installed in a `node:20-bookworm-slim` stage and copied into the runtime stage; build tooling never ships |
| Dockerfile lint | hadolint with warnings treated as failures |
| Image vulnerability scan | Trivy image scan in CI (local image) and CD (pushed digest) with the same policy |
| Supply-chain metadata | SLSA provenance (`mode=max`) and SPDX SBOM attestations pushed with every image |
| OCI labels | `org.opencontainers.image.revision`, `source`, `version` for traceability |
| Immutable references | Deploys use `image@sha256:<digest>`; the deploy workflow refuses anything that is not a digest |

## Kubernetes runtime

| Control | Implementation |
|---|---|
| Pod Security Standards | Namespaces labelled `pod-security.kubernetes.io/enforce: restricted` |
| Pod security context | `runAsNonRoot`, `runAsUser: 65532`, `seccompProfile: RuntimeDefault` |
| Container security context | `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `privileged: false` |
| Writable scratch | Only `/tmp` via a size-limited `emptyDir` |
| No API access from the pod | Dedicated ServiceAccount with `automountServiceAccountToken: false` on both the ServiceAccount and the pod |
| Network isolation | Default-deny NetworkPolicy plus explicit ingress from `istio-ingress`, monitoring namespaces and same-namespace peers; egress limited to kube-dns and the Private Google Access VIP range |
| Resource bounds | Requests and limits on every container; HPA bounded by `maxReplicas` |
| Availability during maintenance | PDB (`minAvailable`), topology spread across zones and nodes, `maxUnavailable: 0` |
| Secrets | Referenced with `secretKeyRef` only; values managed by External Secrets Operator or Secret Manager CSI, never in git |
| Manifest validation | kubeconform (strict, pinned Kubernetes version), Trivy config scan, repository policy script that fails on missing probes/limits/security context, `:latest`, or rendered Secrets |

## Application

| Control | Implementation |
|---|---|
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cache-Control: no-store`; `x-powered-by` disabled |
| Input bounds | JSON body limited to 64 KB; query parameter length capped |
| No stack traces to clients | Central error handler returns generic messages for 5xx, logs structured JSON server-side |
| Graceful shutdown | Readiness flips to 503 before sockets close, so in-flight requests complete during rollouts |
| Metrics cardinality | Route label uses the matched route template, not the raw URL |

## Residual risks and next steps

- Image signing with cosign/Sigstore and a Binary Authorization policy on GKE that admits only signed digests from this pipeline.
- Admission policy (Gatekeeper or Kyverno) enforcing the same rules the repository script checks, so they hold for every deployment path.
- Runtime threat detection (GKE Security Posture, Falco) is out of scope for this repository.
- The `production-rollback` environment trade-off between speed and review is documented in `rollback-strategy.md`.
