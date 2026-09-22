# Image tagging strategy

## Principles

1. **Immutable identity.** Every build receives a `sha-<7-char-sha>` tag. The tag is derived from the commit, so it is unique per build and never moved.
2. **Deploy by digest.** Deploy jobs receive the manifest digest (`sha256:...`) from the build job and pin it with `kustomize edit set image sample-service=<image>@<digest>`. The tag is used only for humans and annotations. A digest reference cannot be altered by anyone with push access to the registry.
3. **Promote, do not rebuild.** Production receives the exact digest that passed UAT. There is no second build for production, so there is no window in which base image or dependency drift could produce a different artefact.
4. **No `latest`.** `docker/metadata-action` is configured with `flavor: latest=false`. `scripts/kustomize-validate.sh` fails if a rendered manifest references `:latest` or an untagged image.

## Tags produced by `docker/metadata-action`

| Event | Tags | Notes |
|---|---|---|
| Push to `main` | `sha-<short>`, `main` | `main` is a moving pointer for convenience; deploys never use it |
| Tag `v1.4.2` | `sha-<short>`, `1.4.2`, `1.4` | Semver tags make a release discoverable; `1.4` floats within the minor series |
| PR (CI only) | none pushed | CI builds `sample-service:ci-<sha>` locally and never pushes |

The `sha-` tag has the highest priority so it is the one shown as `tag` in outputs and summaries.

## Labels

The Dockerfile and `metadata-action` both set `org.opencontainers.image.*` labels (`title`, `source`, `revision`, `version`, `created`, `licenses`, `base.name`). `revision` is the full commit SHA, so an image found in a registry can be traced to a commit without consulting CI logs.

## Attestations

`docker/build-push-action` is run with `provenance: mode=max` and `sbom: true`. Both attestations are pushed to Artifact Registry alongside the image index and can be inspected with:

```bash
docker buildx imagetools inspect <image>@<digest> --format '{{ json .Provenance }}'
docker buildx imagetools inspect <image>@<digest> --format '{{ json .SBOM }}'
```

## Rollback targets

Because every deployed digest also carries a `sha-` tag (and a semver tag for releases), `rollback.yml` can resolve a human-readable target with `gcloud artifacts docker images describe <image>:<tag>` and deploy the digest. Only tags that already exist in the registry can be rolled back to; the rollback workflow never builds.

## Retention

Artifact Registry cleanup policies (configured outside this repository) should keep all tagged images for at least 90 days and delete untagged manifests after 14 days. Because deploys are digest-pinned, a cleanup policy must never delete a digest that is still referenced by a running Deployment; keeping `sha-` tags for the retention window is what guarantees this.

## Local builds

`make build` produces `sample-service:sha-<short>` from the working tree so local scans use the same naming. Local images are never pushed by the Makefile.
