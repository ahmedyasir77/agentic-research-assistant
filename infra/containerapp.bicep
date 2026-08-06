// The whole deployment: a workspace to log into, an environment to run in, and one
// container app. There is no database, no queue and no cache, because the app has
// no state that outlives a run.
//
// Deployed by infra/deploy.sh, which is the supported entry point — it creates the
// resource group and the registry first, since neither belongs to this template.

@description('Base name for every resource. Lowercase letters and digits.')
@minLength(3)
@maxLength(20)
param name string

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Fully qualified image reference, including the tag.')
param image string

@description('Login server of the registry holding the image, e.g. myacr.azurecr.io.')
param registryServer string

@description('Registry username. The ACR admin user, created by deploy.sh.')
param registryUsername string

@secure()
@description('Registry password. Stored as a container app secret, never as an env var.')
param registryPassword string

@secure()
@description('Anthropic API key. Leave empty to deploy in offline demo mode.')
param anthropicApiKey string = ''

@secure()
@description('Tavily API key. Leave empty to use recorded search fixtures.')
param tavilyApiKey string = ''

@description('live calls the real APIs; offline replays recorded fixtures and needs no keys.')
@allowed(['live', 'offline'])
param demoMode string = 'offline'

@description('Model id, read from config so it is a deploy-time choice, never a source change.')
param modelId string = 'claude-opus-5'

@allowed(['tavily', 'fixture'])
param searchProvider string = 'fixture'

@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('Runs started per IP per minute.')
param rateLimitPerMin int = 10

@description('Scales to nothing when idle. A demo is idle almost all of the time.')
param minReplicas int = 0

@description('Two, not one, so a rolling revision has somewhere to go. See the note on state below.')
param maxReplicas int = 2

// The app listens here; the Dockerfile sets the same value.
var appPort = 8080

var hasAnthropicKey = !empty(anthropicApiKey)
var hasTavilyKey = !empty(tavilyApiKey)

// Every credential is a secret with a reference, so it never appears in the
// container's environment block, in `az containerapp show`, or in a portal blade.
var secrets = concat(
  [
    {
      name: 'registry-password'
      value: registryPassword
    }
  ],
  hasAnthropicKey
    ? [
        {
          name: 'anthropic-api-key'
          value: anthropicApiKey
        }
      ]
    : [],
  hasTavilyKey
    ? [
        {
          name: 'tavily-api-key'
          value: tavilyApiKey
        }
      ]
    : []
)

var environmentVariables = concat(
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'PORT', value: string(appPort) }
    { name: 'LOG_LEVEL', value: logLevel }
    { name: 'DEMO_MODE', value: demoMode }
    { name: 'MODEL_ID', value: modelId }
    { name: 'SEARCH_PROVIDER', value: searchProvider }
    { name: 'RATE_LIMIT_PER_MIN', value: string(rateLimitPerMin) }
  ],
  hasAnthropicKey ? [{ name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }] : [],
  hasTavilyKey ? [{ name: 'TAVILY_API_KEY', secretRef: 'tavily-api-key' }] : []
)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    // A demo does not need a quarter of logs. Thirty days is the floor.
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: appPort
        transport: 'auto'
        allowInsecure: false
        // A run lives in one replica's memory, and the browser subscribes to its
        // event stream in a second request. Affinity keeps that second request on
        // the replica that holds the run. The honest fix is a shared store; this
        // is the cheap one, and it is why maxReplicas is 2 rather than 20.
        stickySessions: { affinity: 'sticky' }
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: environmentVariables
          probes: [
            {
              // Liveness asks only whether the process is wedged. A failing
              // dependency must not get the container killed.
              type: 'Liveness'
              httpGet: { path: '/healthz', port: appPort }
              initialDelaySeconds: 5
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              // Readiness fails while the app is draining, so ingress stops
              // sending new requests before the process stops accepting them.
              type: 'Readiness'
              httpGet: { path: '/readyz', port: appPort }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http'
            http: {
              // A run holds a connection open for the length of the run, so
              // concurrency is the meaningful signal here rather than RPS.
              metadata: { concurrentRequests: '20' }
            }
          }
        ]
      }
    }
  }
}

@description('Paste this into a browser.')
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output fqdn string = app.properties.configuration.ingress.fqdn
