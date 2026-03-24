# TempEdge - Build & Deploy All Microservices to Kubernetes
# Usage: .\deploy.ps1            (build + deploy all services)
#        .\deploy.ps1 -NoBuild   (deploy only, skip Docker builds)
#        .\deploy.ps1 -Only data-svc,monitor  (build + deploy specific services)

param(
    [switch]$NoBuild,
    [string]$Only = ""
)

$ErrorActionPreference = "Stop"

Write-Host "`nTempEdge - Microservices Build & Deploy`n" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor DarkGray

# -- Service Definitions ---------------------------------------------------
# All Dockerfiles use repo-root as build context (docker build -f <Dockerfile> .)

$allServices = @(
    @{ Name = "data-svc";       Image = "tempedge-data-svc";       Dir = "services/data-svc" },
    @{ Name = "weather-svc";    Image = "tempedge-weather-svc";    Dir = "services/weather-svc" },
    @{ Name = "market-svc";     Image = "tempedge-market-svc";     Dir = "services/market-svc" },
    @{ Name = "trading-svc";    Image = "tempedge-trading-svc";    Dir = "services/trading-svc" },
    @{ Name = "liquidity-svc";  Image = "tempedge-liquidity-svc";  Dir = "services/liquidity-svc" },
    @{ Name = "dashboard-svc";  Image = "tempedge-dashboard-svc";  Dir = "services/dashboard-svc" },
    @{ Name = "monitor";        Image = "tempedge-monitor";        Dir = "services/monitor" }
)

# K8s manifests in apply order (secrets/config before deployments)
$k8sBase = @(
    "k8s/namespace.yaml",
    "k8s/configmap.yaml",
    "k8s/vpn-secret.yaml",
    "k8s/trading-secret.yaml",
    "k8s/weather-api-keys-secret.yaml",
    "k8s/pvc.yaml"
)

# Filter services if -Only is specified
if ($Only -ne "") {
    $onlyList = $Only -split ","
    $services = $allServices | Where-Object { $onlyList -contains $_.Name }
    if ($services.Count -eq 0) {
        Write-Host "[FAIL] No matching services found for: $Only" -ForegroundColor Red
        Write-Host "   Available: $(($allServices | ForEach-Object { $_.Name }) -join ', ')" -ForegroundColor DarkGray
        exit 1
    }
    Write-Host "  Targeting: $(($services | ForEach-Object { $_.Name }) -join ', ')" -ForegroundColor Yellow
} else {
    $services = $allServices
}

# -- Step 1: Build Docker Images -------------------------------------------

if (-not $NoBuild) {
    Write-Host "`n[BUILD] Building Docker images..." -ForegroundColor Yellow
    $buildStart = Get-Date
    $failed = @()

    foreach ($svc in $services) {
        Write-Host "  [BUILD] $($svc.Image):latest" -ForegroundColor White -NoNewline

        # All Dockerfiles use repo-root as build context
        # Use cmd /c to avoid PowerShell treating Docker stderr progress as errors
        $env:DOCKER_CLI_HINTS = "false"
        cmd /c "docker build -t `"$($svc.Image):latest`" -f `"$($svc.Dir)/Dockerfile`" . > nul 2>&1"

        if ($LASTEXITCODE -ne 0) {
            Write-Host " [FAIL]" -ForegroundColor Red
            $failed += $svc.Name
        } else {
            Write-Host " [OK]" -ForegroundColor Green
        }
    }

    $buildDuration = ((Get-Date) - $buildStart).TotalSeconds
    Write-Host "`n  Built $($services.Count - $failed.Count)/$($services.Count) images in $([math]::Round($buildDuration, 1))s" -ForegroundColor DarkGray

    if ($failed.Count -gt 0) {
        Write-Host "  [FAIL] Failed: $($failed -join ', ')" -ForegroundColor Red
        Write-Host "  Is Docker Desktop running?" -ForegroundColor DarkGray
        exit 1
    }
} else {
    Write-Host "`n[SKIP] Skipping Docker builds (-NoBuild)" -ForegroundColor DarkGray
}

# -- Step 2: Apply K8s Resources (Layered by Dependencies) -----------------
#
# Dependency graph:
#   Layer 0 (no deps):       data-svc, weather-svc, market-svc
#   Layer 1 (-> data-svc):   trading-svc, liquidity-svc
#   Layer 2 (-> L0+L1):      dashboard-svc
#   Layer 3 (-> all):        monitor
#
# initContainers in each manifest also enforce this at the K8s level.

Write-Host "`n[DEPLOY] Deploying to Kubernetes..." -ForegroundColor Yellow

# Allow kubectl to return errors without stopping the script (VPN sidecar may be slow)
$ErrorActionPreference = "Continue"

# Always apply base infrastructure first
foreach ($manifest in $k8sBase) {
    if (Test-Path $manifest) {
        kubectl apply -f $manifest 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [FAIL] Failed to apply $manifest" -ForegroundColor Red
            exit 1
        }
    }
}

# Create VPN config map (idempotent: delete + create)
$ovpnFile = Get-ChildItem "k8s/*.ovpn" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ovpnFile) {
    kubectl delete configmap nordvpn-ovpn -n tempedge 2>&1 | Out-Null
    kubectl create configmap nordvpn-ovpn -n tempedge --from-file="nordvpn.ovpn=$($ovpnFile.FullName)" 2>&1 | Out-Null
    Write-Host "  [OK] VPN config (nordvpn-ovpn from $($ovpnFile.Name))" -ForegroundColor Green
}

Write-Host "  [OK] Base resources (namespace, config, secrets, PVC)" -ForegroundColor Green

# Deployment layers (ordered by dependencies)
$layers = @(
    @{ Name = "Layer 0 - Foundation (no dependencies)"; Services = @("data-svc", "weather-svc", "market-svc") },
    @{ Name = "Layer 1 - Depends on data-svc";          Services = @("trading-svc", "liquidity-svc") },
    @{ Name = "Layer 2 - Depends on Layer 0 + 1";       Services = @("dashboard-svc") },
    @{ Name = "Layer 3 - Depends on all services";      Services = @("monitor") }
)

if ($Only -ne "") {
    # Targeted deploy - apply only selected manifests (no layer ordering)
    foreach ($svc in $services) {
        $manifest = "k8s/$($svc.Name).yaml"
        if (Test-Path $manifest) {
            kubectl apply -f $manifest 2>&1 | Out-Null
            Write-Host "  [OK] $($svc.Name)" -ForegroundColor Green
        } else {
            Write-Host "  [WARN] No manifest: $manifest" -ForegroundColor Yellow
        }
    }

    # Force pod restart to pick up rebuilt images (imagePullPolicy: Never + same tag)
    Write-Host "`n[RESTART] Restarting deployments to pick up new images..." -ForegroundColor Yellow
    foreach ($svc in $services) {
        kubectl rollout restart "deployment/$($svc.Name)" -n tempedge 2>&1 | Out-Null
        Write-Host "  [RESTART] $($svc.Name)" -ForegroundColor DarkGray
    }

    # Wait for targeted deployments
    Write-Host "`n[WAIT] Waiting for deployments..." -ForegroundColor Yellow
    foreach ($svc in $services) {
        Write-Host "  [WAIT] $($svc.Name)" -ForegroundColor White -NoNewline
        kubectl rollout status "deployment/$($svc.Name)" -n tempedge --timeout=120s 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host " [TIMEOUT]" -ForegroundColor Yellow
        } else {
            Write-Host " [OK]" -ForegroundColor Green
        }
    }
} else {
    # Full deploy - apply and wait layer by layer
    foreach ($layer in $layers) {
        Write-Host "`n  $($layer.Name)" -ForegroundColor Cyan

        # Apply all manifests in this layer
        foreach ($svcName in $layer.Services) {
            $manifest = "k8s/$svcName.yaml"
            if (Test-Path $manifest) {
                kubectl apply -f $manifest 2>&1 | Out-Null
                Write-Host "    [APPLY] $svcName" -ForegroundColor DarkGray
            }
        }

        # Force pod restart to pick up rebuilt images (imagePullPolicy: Never + same tag)
        foreach ($svcName in $layer.Services) {
            kubectl rollout restart "deployment/$svcName" -n tempedge 2>&1 | Out-Null
            Write-Host "    [RESTART] $svcName" -ForegroundColor DarkGray
        }

        # Wait for all deployments in this layer to be ready
        foreach ($svcName in $layer.Services) {
            Write-Host "    [WAIT] $svcName" -ForegroundColor White -NoNewline
            kubectl rollout status "deployment/$svcName" -n tempedge --timeout=180s 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host " [TIMEOUT]" -ForegroundColor Yellow
            } else {
                Write-Host " [OK]" -ForegroundColor Green
            }
        }
    }
}

# -- Step 3: Show Status ---------------------------------------------------

Write-Host "`n[STATUS] Cluster Status:" -ForegroundColor Cyan
kubectl get pods -n tempedge -o wide --no-headers | ForEach-Object { Write-Host "  $_" -ForegroundColor White }
Write-Host ""
kubectl get svc -n tempedge --no-headers | ForEach-Object { Write-Host "  $_" -ForegroundColor White }

Write-Host "`n==================================================" -ForegroundColor DarkGray
Write-Host "[OK] TempEdge deployed!" -ForegroundColor Green
Write-Host "   Dashboard:      http://localhost:30301" -ForegroundColor White
Write-Host ""
Write-Host "   Logs:" -ForegroundColor DarkGray
Write-Host "     kubectl logs -f -n tempedge deployment/monitor" -ForegroundColor DarkGray
Write-Host "     kubectl logs -f -n tempedge deployment/dashboard-svc" -ForegroundColor DarkGray
Write-Host "     kubectl logs -f -n tempedge deployment/data-svc" -ForegroundColor DarkGray
Write-Host "     kubectl logs -f -n tempedge deployment/trading-svc -c trading-svc" -ForegroundColor DarkGray
Write-Host "     kubectl logs -f -n tempedge deployment/trading-svc -c vpn" -ForegroundColor DarkGray
Write-Host ""
