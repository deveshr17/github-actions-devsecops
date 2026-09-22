## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Type of change

- [ ] feat / fix (application)
- [ ] ci / build (pipeline, Dockerfile)
- [ ] k8s manifests
- [ ] docs

## Checklist

- [ ] PR title follows Conventional Commits (`type(scope): subject`)
- [ ] `make test lint` pass locally
- [ ] `make kustomize-validate` passes for uat and prod
- [ ] No secrets, real project IDs, IPs or domains added
- [ ] If a Trivy finding is suppressed, `.trivyignore` has an entry with a justification and expiry
