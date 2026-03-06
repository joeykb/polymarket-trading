# TempEdge - Tear down Kubernetes deployment
# Usage: .\teardown.ps1

$ErrorActionPreference = "Stop"

Write-Host "`n🌡️  TempEdge - Teardown`n" -ForegroundColor Cyan

Write-Host "Deleting all resources in tempedge namespace..." -ForegroundColor Yellow
kubectl delete -f k8s/service.yaml --ignore-not-found
kubectl delete -f k8s/deployment.yaml --ignore-not-found
kubectl delete -f k8s/pvc.yaml --ignore-not-found
kubectl delete -f k8s/configmap.yaml --ignore-not-found
kubectl delete -f k8s/namespace.yaml --ignore-not-found

Write-Host "`n✅ TempEdge resources deleted." -ForegroundColor Green
Write-Host ""
