# TempEdge — Tear Down Kubernetes Microservices
# Usage: .\teardown.ps1              (delete all services, keep namespace + PVC)
#        .\teardown.ps1 -Full        (delete everything including namespace + PVC)
#        .\teardown.ps1 -Only monitor,trading-svc  (delete specific services only)

param(
    [switch]$Full,
    [string]$Only = ""
)

$ErrorActionPreference = "Stop"

Write-Host "`n🌡️  TempEdge — Teardown`n" -ForegroundColor Cyan

# Service manifests (reverse deployment order for clean shutdown)
$serviceManifests = @(
    "k8s/monitor.yaml",
    "k8s/dashboard-svc.yaml",
    "k8s/liquidity-svc.yaml",
    "k8s/trading-svc.yaml",
    "k8s/market-svc.yaml",
    "k8s/weather-svc.yaml",
    "k8s/data-svc.yaml"
)

$baseManifests = @(
    "k8s/pvc.yaml",
    "k8s/trading-secret.yaml",
    "k8s/vpn-secret.yaml",
    "k8s/configmap.yaml",
    "k8s/namespace.yaml"
)

if ($Only -ne "") {
    # Targeted teardown
    $onlyList = $Only -split ","
    Write-Host "  Targeting: $($onlyList -join ', ')" -ForegroundColor Yellow

    foreach ($name in $onlyList) {
        $manifest = "k8s/$name.yaml"
        if (Test-Path $manifest) {
            kubectl delete -f $manifest --ignore-not-found 2>&1 | Out-Null
            Write-Host "  🗑️  Deleted $name" -ForegroundColor Yellow
        } else {
            Write-Host "  ⚠️  No manifest: $manifest" -ForegroundColor DarkGray
        }
    }

    Write-Host "`n✅ Targeted teardown complete." -ForegroundColor Green
} else {
    # Full or standard teardown
    Write-Host "Deleting service deployments..." -ForegroundColor Yellow

    foreach ($manifest in $serviceManifests) {
        if (Test-Path $manifest) {
            $name = [System.IO.Path]::GetFileNameWithoutExtension($manifest)
            kubectl delete -f $manifest --ignore-not-found 2>&1 | Out-Null
            Write-Host "  🗑️  $name" -ForegroundColor Yellow
        }
    }

    if ($Full) {
        Write-Host "`nDeleting base resources (namespace, PVC, secrets)..." -ForegroundColor Yellow
        foreach ($manifest in $baseManifests) {
            if (Test-Path $manifest) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($manifest)
                kubectl delete -f $manifest --ignore-not-found 2>&1 | Out-Null
                Write-Host "  🗑️  $name" -ForegroundColor Yellow
            }
        }
        Write-Host "`n✅ Full teardown complete (namespace deleted)." -ForegroundColor Green
    } else {
        Write-Host "`n✅ Services deleted. Namespace + PVC preserved." -ForegroundColor Green
        Write-Host "   Run with -Full to also delete namespace and persistent data." -ForegroundColor DarkGray
    }
}

Write-Host ""
