# Deployment Automation Scripts
#
# Automated deployment scripts for TableStack services.
# Supports staging and production environments.
#
# Usage:
#   ./deploy.sh staging    # Deploy to staging
#   ./deploy.sh production # Deploy to production
#
# @see Phase 3.2: Deployment Automation

#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT=${1:-staging}
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Environment-specific configuration
declare -A CONFIG
CONFIG[staging_domain]="staging-api.tablestack.io"
CONFIG[production_domain]="api.tablestack.io"
CONFIG[staging_cluster]="tablestack-staging"
CONFIG[production_cluster]="tablestack-production"

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}TableStack Deployment${NC}"
echo -e "${YELLOW}========================================${NC}"
echo -e "Environment: ${GREEN}${ENVIRONMENT}${NC}"
echo -e "Timestamp: ${TIMESTAMP}"
echo ""

# Validate environment
if [[ ! "${CONFIG[${ENVIRONMENT}_domain]}" ]]; then
    echo -e "${RED}Error: Invalid environment '${ENVIRONMENT}'${NC}"
    echo "Valid environments: staging, production"
    exit 1
fi

# Functions
log() {
    echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check for required tools
    command -v docker >/dev/null 2>&1 || error "Docker is required but not installed"
    command -v kubectl >/dev/null 2>&1 || error "kubectl is required but not installed"
    command -v pnpm >/dev/null 2>&1 || error "pnpm is required but not installed"
    
    # Check for environment variables
    if [[ "${ENVIRONMENT}" == "production" ]]; then
        [[ -z "${PROD_KUBECONFIG}" ]] && error "PROD_KUBECONFIG environment variable not set"
        export KUBECONFIG="${PROD_KUBECONFIG}"
    else
        [[ -z "${STAGING_KUBECONFIG}" ]] && error "STAGING_KUBECONFIG environment variable not set"
        export KUBECONFIG="${STAGING_KUBECONFIG}"
    fi
    
    log "Prerequisites check passed"
}

run_tests() {
    log "Running tests..."
    
    cd "${PROJECT_ROOT}"
    
    # Run linting
    pnpm lint || error "Linting failed"
    
    # Run type checking
    pnpm tsc --noEmit || error "Type checking failed"
    
    # Run tests
    pnpm test || error "Tests failed"
    
    log "All tests passed"
}

build() {
    log "Building application..."
    
    cd "${PROJECT_ROOT}"
    
    # Build all packages
    pnpm build || error "Build failed"
    
    log "Build completed successfully"
}

run_migrations() {
    log "Running database migrations..."
    
    cd "${PROJECT_ROOT}"
    
    # Run Drizzle migrations
    pnpm db:migrate || error "Database migrations failed"
    
    log "Database migrations completed"
}

deploy() {
    log "Deploying to ${ENVIRONMENT}..."
    
    local cluster="${CONFIG[${ENVIRONMENT}_cluster]}"
    local domain="${CONFIG[${ENVIRONMENT}_domain]}"
    
    # Create deployment manifest
    cat > "${PROJECT_ROOT}/.deployment-${TIMESTAMP}.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tablestack-api
  namespace: ${cluster}
  labels:
    app: tablestack-api
    version: ${TIMESTAMP}
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tablestack-api
  template:
    metadata:
      labels:
        app: tablestack-api
        version: ${TIMESTAMP}
    spec:
      containers:
      - name: api
        image: tablestack/api:${TIMESTAMP}
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: ${ENVIRONMENT}
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: tablestack-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: tablestack-secrets
              key: redis-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: tablestack-api
  namespace: ${cluster}
spec:
  selector:
    app: tablestack-api
  ports:
  - port: 80
    targetPort: 3000
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tablestack-api
  namespace: ${cluster}
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
spec:
  tls:
  - hosts:
    - ${domain}
    secretName: tablestack-tls
  rules:
  - host: ${domain}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tablestack-api
            port:
              number: 80
EOF

    # Apply deployment
    kubectl apply -f "${PROJECT_ROOT}/.deployment-${TIMESTAMP}.yaml" || error "Kubernetes deployment failed"
    
    # Wait for rollout
    log "Waiting for deployment rollout..."
    kubectl rollout status deployment/tablestack-api -n "${cluster}" --timeout=300s || error "Deployment rollout failed"
    
    # Cleanup
    rm -f "${PROJECT_ROOT}/.deployment-${TIMESTAMP}.yaml"
    
    log "Deployment completed successfully"
}

verify_deployment() {
    log "Verifying deployment..."
    
    local domain="${CONFIG[${ENVIRONMENT}_domain]}"
    
    # Wait for service to be ready
    sleep 10
    
    # Health check
    local health_response=$(curl -s -o /dev/null -w "%{http_code}" "https://${domain}/api/health" --max-time 30)
    
    if [[ "${health_response}" != "200" ]]; then
        error "Health check failed with status ${health_response}"
    fi
    
    # Readiness check
    local ready_response=$(curl -s -o /dev/null -w "%{http_code}" "https://${domain}/api/ready" --max-time 30)
    
    if [[ "${ready_response}" != "200" ]]; then
        error "Readiness check failed with status ${ready_response}"
    fi
    
    log "Deployment verification passed"
}

notify() {
    local status=$1
    local message=$2
    
    # Send Slack notification (if configured)
    if [[ -n "${SLACK_WEBHOOK_URL}" ]]; then
        local color="good"
        [[ "${status}" == "failure" ]] && color="danger"
        
        curl -X POST "${SLACK_WEBHOOK_URL}" \
            -H 'Content-Type: application/json' \
            -d "{
                \"attachments\": [{
                    \"color\": \"${color}\",
                    \"title\": \"Deployment ${status}\",
                    \"text\": \"${message}\",
                    \"fields\": [
                        {\"title\": \"Environment\", \"value\": \"${ENVIRONMENT}\", \"short\": true},
                        {\"title\": \"Timestamp\", \"value\": \"${TIMESTAMP}\", \"short\": true}
                    ]
                }]
            }" || warn "Failed to send Slack notification"
    fi
}

# Main deployment flow
main() {
    local start_time=$(date +%s)
    
    # Pre-deployment
    check_prerequisites
    run_tests
    build
    
    # Deployment
    run_migrations
    deploy
    
    # Post-deployment
    verify_deployment
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deployment Successful!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo -e "Environment: ${GREEN}${ENVIRONMENT}${NC}"
    echo -e "Duration: ${duration} seconds"
    echo -e "URL: https://${CONFIG[${ENVIRONMENT}_domain]}"
    echo ""
    
    notify "success" "Deployment to ${ENVIRONMENT} completed successfully in ${duration}s"
}

# Error handler
trap 'error "Deployment failed"; notify "failure" "Deployment to ${ENVIRONMENT} failed"' ERR

# Run main function
main
