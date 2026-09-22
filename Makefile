# Local developer entrypoints mirroring the CI gates.
# Usage: make help

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

-include .env
export

APP_DIR              ?= app
IMAGE_NAME           ?= sample-service
ARTIFACT_REGISTRY_HOST ?= asia-south1-docker.pkg.dev
GCP_PROJECT_ID       ?= example-project-dev
ARTIFACT_REGISTRY_REPO ?= apps
GIT_SHA              := $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
IMAGE_LOCAL          := $(IMAGE_NAME):sha-$(GIT_SHA)
IMAGE_REMOTE         := $(ARTIFACT_REGISTRY_HOST)/$(GCP_PROJECT_ID)/$(ARTIFACT_REGISTRY_REPO)/$(IMAGE_NAME)
TRIVY                ?= docker run --rm -v "$(PWD)":/work -w /work -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.56.2
HADOLINT             ?= docker run --rm -i -v "$(PWD)/.hadolint.yaml":/.hadolint.yaml hadolint/hadolint:v2.12.0
KUBECTL              ?= kubectl

.PHONY: help install test lint build run stop scan scan-fs scan-image hadolint kustomize-validate render-uat render-prod clean all

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install app dependencies (npm ci)
	cd $(APP_DIR) && npm ci --ignore-scripts

test: ## Run unit tests with coverage
	cd $(APP_DIR) && npm run test:ci

lint: ## Lint JavaScript sources
	cd $(APP_DIR) && npm run lint

hadolint: ## Lint the Dockerfile
	$(HADOLINT) hadolint - < $(APP_DIR)/Dockerfile

build: ## Build the container image locally
	docker build \
	  --build-arg GIT_SHA=$(GIT_SHA) \
	  --build-arg VERSION=0.0.0-$(GIT_SHA) \
	  --build-arg BUILD_DATE=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
	  -t $(IMAGE_LOCAL) -f $(APP_DIR)/Dockerfile $(APP_DIR)

run: ## Run the image locally on :8080 with a read-only root filesystem
	docker run --rm -d --name $(IMAGE_NAME) -p 8080:8080 --read-only --cap-drop ALL \
	  --security-opt no-new-privileges $(IMAGE_LOCAL)
	@echo "http://localhost:8080/healthz"

stop: ## Stop the local container (sends SIGTERM, exercises graceful shutdown)
	docker stop -t 30 $(IMAGE_NAME)

scan-fs: ## Trivy filesystem scan (vuln, secret, misconfig)
	$(TRIVY) fs --config trivy.yaml .

scan-image: build ## Trivy image scan of the locally built image
	$(TRIVY) image --config trivy.yaml $(IMAGE_LOCAL)

scan: scan-fs scan-image ## Run all Trivy scans

render-uat: ## Render the UAT overlay
	$(KUBECTL) kustomize k8s/overlays/uat

render-prod: ## Render the production overlay
	$(KUBECTL) kustomize k8s/overlays/prod

kustomize-validate: ## Render both overlays and validate with kubeconform (if installed)
	scripts/kustomize-validate.sh k8s/overlays/uat
	scripts/kustomize-validate.sh k8s/overlays/prod

smoke: ## Smoke-test a running instance (BASE_URL defaults to http://localhost:8080)
	scripts/smoke-test.sh $${BASE_URL:-http://localhost:8080}

all: lint test hadolint build scan kustomize-validate ## Run every local gate

clean: ## Remove build and test artefacts
	rm -rf $(APP_DIR)/coverage $(APP_DIR)/node_modules rendered.yaml *.sarif
