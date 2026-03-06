# TempEdge - Build & Deploy to Kubernetes (Docker Desktop)
# Usage: .\deploy.ps1

$ErrorActionPreference = "Stop"

Write-Host "`n🌡️  TempEdge - Build & Deploy`n" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkGray

# ── Step 1: Build Docker image ────────────────────────────────────────
Write-Host "`n📦 Building Docker image..." -ForegroundColor Yellow
docker build -t tempedge:latest .
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker build failed. Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Image built: tempedge:latest" -ForegroundColor Green

# ── Step 2: Create namespace and apply K8s resources ──────────────────
Write-Host "`n🚀 Deploying to Kubernetes..." -ForegroundColor Yellow

# Apply in order: namespace first, then config, storage, deployment, service
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Kubernetes deployment failed. Is Kubernetes enabled in Docker Desktop?" -ForegroundColor Red
    exit 1
}

# ── Step 3: Wait for rollout ──────────────────────────────────────────
Write-Host "`n⏳ Waiting for deployment to be ready..." -ForegroundColor Yellow
kubectl rollout status deployment/tempedge -n tempedge --timeout=120s

# ── Step 4: Show status ──────────────────────────────────────────────
Write-Host "`n📋 Deployment Status:" -ForegroundColor Cyan
kubectl get pods -n tempedge
Write-Host ""
kubectl get svc -n tempedge

Write-Host "`n══════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host "✅ TempEdge deployed!" -ForegroundColor Green
Write-Host "   Dashboard: http://localhost:30300" -ForegroundColor White
Write-Host "   Monitor logs: kubectl logs -f -n tempedge deployment/tempedge -c monitor" -ForegroundColor DarkGray
Write-Host "   Dashboard logs: kubectl logs -f -n tempedge deployment/tempedge -c dashboard" -ForegroundColor DarkGray
Write-Host ""
