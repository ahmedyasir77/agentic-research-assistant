#!/usr/bin/env bash
#
# Deploys the app to Azure Container Apps. Idempotent: run it as many times as you
# like, the second run is an image push and a revision.
#
#   ./infra/deploy.sh
#
# Everything is configurable by environment variable; the defaults deploy an
# offline demo that needs no API keys at all. To deploy the live version:
#
#   set -a; source .env.local; set +a
#   DEMO_MODE=live SEARCH_PROVIDER=tavily ./infra/deploy.sh
#
# The image is built by `az acr build`, server-side, so no local Docker daemon is
# required — which also means the image that ships is built the same way whether it
# comes from this script or from CI.

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-ara-rg}"
LOCATION="${LOCATION:-eastus}"
APP_NAME="${APP_NAME:-ara}"
# Registry names are globally unique and allow no punctuation, hence the suffix.
ACR_NAME="${ACR_NAME:-araacr$(whoami | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]' | cut -c1-8)}"

DEMO_MODE="${DEMO_MODE:-offline}"
MODEL_ID="${MODEL_ID:-claude-opus-5}"
SEARCH_PROVIDER="${SEARCH_PROVIDER:-fixture}"
LOG_LEVEL="${LOG_LEVEL:-info}"
RATE_LIMIT_PER_MIN="${RATE_LIMIT_PER_MIN:-10}"

ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
TAVILY_API_KEY="${TAVILY_API_KEY:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The tag is the commit, so a running revision can be traced back to a diff. A
# dirty tree is tagged as such rather than pretending to be the commit it is not.
if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
  if ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null; then
    IMAGE_TAG="${IMAGE_TAG}-dirty"
  fi
else
  IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
fi

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

command -v az >/dev/null || {
  echo "az is not installed: https://learn.microsoft.com/cli/azure/install-azure-cli" >&2
  exit 1
}
az account show >/dev/null 2>&1 || {
  echo "Not logged in. Run: az login" >&2
  exit 1
}
# Used below to build the parameter file. Present on the GitHub runner; on a Mac,
# `brew install jq`.
command -v jq >/dev/null || {
  echo "jq is not installed." >&2
  exit 1
}

# Fail before spending five minutes on a build, not after.
if [[ "$DEMO_MODE" == "live" && -z "$ANTHROPIC_API_KEY" ]]; then
  echo "DEMO_MODE=live needs ANTHROPIC_API_KEY. Source .env.local, or deploy offline." >&2
  exit 1
fi
if [[ "$SEARCH_PROVIDER" == "tavily" && -z "$TAVILY_API_KEY" ]]; then
  echo "SEARCH_PROVIDER=tavily needs TAVILY_API_KEY. Source .env.local, or use fixture." >&2
  exit 1
fi

say "Subscription"
az account show --query '{name:name, id:id}' -o tsv

say "Providers"
# Registration is a no-op once done, and a baffling error message if skipped.
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait

say "Resource group $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

say "Registry $ACR_NAME"
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az acr create \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --sku Basic \
    --admin-enabled true \
    -o none
fi

REGISTRY_SERVER="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer -o tsv)"
IMAGE="${REGISTRY_SERVER}/${APP_NAME}:${IMAGE_TAG}"

say "Building $IMAGE"
# Built from the repository root so the context matches the Dockerfile's COPY
# paths, and filtered by the root .dockerignore.
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --file infra/Dockerfile \
  --image "${APP_NAME}:${IMAGE_TAG}" \
  "$REPO_ROOT"

say "Deploying $APP_NAME"

# Secrets go in a parameter file with restrictive permissions rather than on the
# command line, where they would land in shell history and in the process table.
PARAMS_FILE="$(mktemp)"
chmod 600 "$PARAMS_FILE"
trap 'rm -f "$PARAMS_FILE"' EXIT

REGISTRY_PASSWORD="$(az acr credential show --name "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
REGISTRY_USERNAME="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"

# `--arg` keeps every value out of the jq program text, so a key containing a
# quote or a backslash cannot break the JSON or leak into an error message.
jq -n \
  --arg name "$APP_NAME" \
  --arg image "$IMAGE" \
  --arg registryServer "$REGISTRY_SERVER" \
  --arg registryUsername "$REGISTRY_USERNAME" \
  --arg registryPassword "$REGISTRY_PASSWORD" \
  --arg anthropicApiKey "$ANTHROPIC_API_KEY" \
  --arg tavilyApiKey "$TAVILY_API_KEY" \
  --arg demoMode "$DEMO_MODE" \
  --arg modelId "$MODEL_ID" \
  --arg searchProvider "$SEARCH_PROVIDER" \
  --arg logLevel "$LOG_LEVEL" \
  --argjson rateLimitPerMin "$RATE_LIMIT_PER_MIN" \
  '{
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      name: { value: $name },
      image: { value: $image },
      registryServer: { value: $registryServer },
      registryUsername: { value: $registryUsername },
      registryPassword: { value: $registryPassword },
      anthropicApiKey: { value: $anthropicApiKey },
      tavilyApiKey: { value: $tavilyApiKey },
      demoMode: { value: $demoMode },
      modelId: { value: $modelId },
      searchProvider: { value: $searchProvider },
      logLevel: { value: $logLevel },
      rateLimitPerMin: { value: $rateLimitPerMin }
    }
  }' > "$PARAMS_FILE"

FQDN="$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name "${APP_NAME}-$(date -u +%Y%m%d%H%M%S)" \
  --template-file "$REPO_ROOT/infra/containerapp.bicep" \
  --parameters "@$PARAMS_FILE" \
  --query 'properties.outputs.fqdn.value' -o tsv)"

say "Deployed"
echo "  mode:  $DEMO_MODE (search: $SEARCH_PROVIDER, model: $MODEL_ID)"
echo "  image: $IMAGE"
echo "  url:   https://${FQDN}"
echo
echo "  logs:  az containerapp logs show -n $APP_NAME -g $RESOURCE_GROUP --follow"
