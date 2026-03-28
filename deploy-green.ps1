# TempEdge — Blue-Green Deployment for Testing
#
# Deploys the current branch as a "green" stack alongside the existing "blue" production.
# Green services are isolated: they talk to each other via green-prefixed K8s services.
# Green dashboard is exposed on NodePort 30302 for side-by-side testing.
#
# Usage:
#   .\deploy-green.ps1              # Build + deploy green stack
#   .\deploy-green.ps1 -NoBuild     # Deploy only (skip Docker builds)
#   .\deploy-green.ps1 -Teardown    # Remove entire green stack
#   .\deploy-green.ps1 -Promote     # Promote green → blue (swap selectors)
#
# After validation:
#   .\deploy-green.ps1 -Promote     # Makes green the new production
#   .\deploy-green.ps1 -Teardown    # Removes old green deployments

param(
    [switch]$NoBuild,
    [switch]$Teardown,
    [switch]$Promote
)

$ErrorActionPreference = "Stop"
$namespace = "tempedge"
$suffix = "green"

Write-Host "`nTempEdge — Blue-Green Deployment`n" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor DarkGray

# -- Service Definitions ---------------------------------------------------

$allServices = @(
    @{ Name = "data-svc";       Image = "tempedge-data-svc";       Port = 3005; Dir = "services/data-svc" },
    @{ Name = "weather-svc";    Image = "tempedge-weather-svc";    Port = 3002; Dir = "services/weather-svc" },
    @{ Name = "market-svc";     Image = "tempedge-market-svc";     Port = 3003; Dir = "services/market-svc" },
    @{ Name = "trading-svc";    Image = "tempedge-trading-svc";    Port = 3004; Dir = "services/trading-svc" },
    @{ Name = "liquidity-svc";  Image = "tempedge-liquidity-svc";  Port = 3001; Dir = "services/liquidity-svc" },
    @{ Name = "dashboard-svc";  Image = "tempedge-dashboard-svc";  Port = 3000; Dir = "services/dashboard-svc" },
    @{ Name = "monitor";        Image = "tempedge-monitor";        Port = 0;    Dir = "services/monitor" }
)

# ── TEARDOWN ─────────────────────────────────────────────────────────────

if ($Teardown) {
    Write-Host "[TEARDOWN] Removing green stack..." -ForegroundColor Yellow
    foreach ($svc in $allServices) {
        $greenName = "$($svc.Name)-$suffix"
        kubectl delete deployment $greenName -n $namespace 2>&1 | Out-Null
        kubectl delete service $greenName -n $namespace 2>&1 | Out-Null
        Write-Host "  [DEL] $greenName" -ForegroundColor DarkGray
    }
    Write-Host "`n[OK] Green stack removed.`n" -ForegroundColor Green
    exit 0
}

# ── PROMOTE ──────────────────────────────────────────────────────────────

if ($Promote) {
    Write-Host "[PROMOTE] Swapping blue → green..." -ForegroundColor Yellow
    Write-Host "  This will update production services to use green pods." -ForegroundColor DarkGray

    foreach ($svc in $allServices) {
        if ($svc.Port -eq 0) { continue }  # skip monitor (no service)

        # Patch the production service selector to point to green pods
        $patch = "{`"spec`":{`"selector`":{`"version`":`"$suffix`"}}}"
        kubectl patch svc $svc.Name -n $namespace --type=merge -p $patch 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [OK] $($svc.Name) → green" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $($svc.Name)" -ForegroundColor Red
        }
    }

    # Scale down monitor blue, scale up monitor green
    kubectl scale deployment monitor -n $namespace --replicas=0 2>&1 | Out-Null
    kubectl scale deployment "monitor-$suffix" -n $namespace --replicas=1 2>&1 | Out-Null
    Write-Host "  [OK] monitor → green" -ForegroundColor Green

    Write-Host "`n[OK] Production now running green code!" -ForegroundColor Green
    Write-Host "  Dashboard: http://localhost:30301 (production)" -ForegroundColor White
    Write-Host "`n  To rollback: manually patch selectors back to remove 'version: green'" -ForegroundColor DarkGray
    exit 0
}

# ── BUILD ────────────────────────────────────────────────────────────────

$greenTag = "green"

if (-not $NoBuild) {
    Write-Host "`n[BUILD] Building Docker images (tag: $greenTag)..." -ForegroundColor Yellow
    $buildStart = Get-Date
    $failed = @()

    foreach ($svc in $allServices) {
        Write-Host "  [BUILD] $($svc.Image):$greenTag" -ForegroundColor White -NoNewline

        $env:DOCKER_CLI_HINTS = "false"
        cmd /c "docker build -t `"$($svc.Image):$greenTag`" -f `"$($svc.Dir)/Dockerfile`" . > nul 2>&1"

        if ($LASTEXITCODE -ne 0) {
            Write-Host " [FAIL]" -ForegroundColor Red
            $failed += $svc.Name
        } else {
            Write-Host " [OK]" -ForegroundColor Green
        }
    }

    $buildDuration = ((Get-Date) - $buildStart).TotalSeconds
    Write-Host "`n  Built $($allServices.Count - $failed.Count)/$($allServices.Count) images in $([math]::Round($buildDuration, 1))s" -ForegroundColor DarkGray

    if ($failed.Count -gt 0) {
        Write-Host "  [FAIL] Failed: $($failed -join ', ')" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "`n[SKIP] Skipping Docker builds (-NoBuild)" -ForegroundColor DarkGray
}

# ── DEPLOY GREEN STACK ───────────────────────────────────────────────────

Write-Host "`n[DEPLOY] Deploying green stack..." -ForegroundColor Yellow
$ErrorActionPreference = "Continue"

# Green services use green-specific K8s DNS names to talk to each other
# This ensures the green stack is fully isolated from blue

$greenEnvOverrides = @{
    "DATA_SVC_URL"      = "http://data-svc-green:3005"
    "WEATHER_SVC_URL"   = "http://weather-svc-green:3002"
    "MARKET_SVC_URL"    = "http://market-svc-green:3003"
    "TRADING_SVC_URL"   = "http://trading-svc-green:3004"
    "LIQUIDITY_SVC_URL" = "http://liquidity-svc-green:3001"
}

# Deploy layers in dependency order
$layers = @(
    @("data-svc", "weather-svc", "market-svc"),
    @("trading-svc", "liquidity-svc"),
    @("dashboard-svc"),
    @("monitor")
)

foreach ($layer in $layers) {
    foreach ($svcName in $layer) {
        $svc = $allServices | Where-Object { $_.Name -eq $svcName }
        $greenName = "$svcName-$suffix"
        $greenImage = "$($svc.Image):$greenTag"

        Write-Host "  [DEPLOY] $greenName" -ForegroundColor White -NoNewline

        # Build env var args for inter-service URLs
        $envArgs = @()
        foreach ($key in $greenEnvOverrides.Keys) {
            $envArgs += "--env=$key=$($greenEnvOverrides[$key])"
        }

        # Check if green deployment already exists
        $existing = kubectl get deployment $greenName -n $namespace 2>&1
        if ($LASTEXITCODE -eq 0) {
            # Update existing
            kubectl set image "deployment/$greenName" -n $namespace "$svcName=$greenImage" 2>&1 | Out-Null
            kubectl rollout restart "deployment/$greenName" -n $namespace 2>&1 | Out-Null
        } else {
            # Read the original manifest and create a modified green version
            $manifestPath = "k8s/$svcName.yaml"
            if (-not (Test-Path $manifestPath)) {
                Write-Host " [SKIP - no manifest]" -ForegroundColor Yellow
                continue
            }

            $manifest = Get-Content $manifestPath -Raw

            # Transform manifest for green:
            # 1. Rename deployment and service
            # 2. Add version label
            # 3. Use green-tagged image
            # 4. Override service URLs to point to green services
            $greenManifest = $manifest `
                -replace "name: $svcName`r?`n", "name: $greenName`n" `
                -replace "component: $svcName", "component: $greenName" `
                -replace "image: $($svc.Image):latest", "image: $greenImage" `
                -replace "nodePort: 30301", "nodePort: 30302"

            # Add version label to pod template labels
            $greenManifest = $greenManifest -replace "(labels:\s*\n\s+app: tempedge\s*\n\s+component: $greenName)", "`$1`n        version: $suffix"

            # Override service URLs in env section
            foreach ($key in $greenEnvOverrides.Keys) {
                $value = $greenEnvOverrides[$key]
                $greenManifest = $greenManifest -replace "($key`r?\n\s+value: `")([^`"]+)(`")", "`${1}$value`${3}"
            }

            # Update init container health check URLs to green services
            $greenManifest = $greenManifest `
                -replace "http://data-svc:3005/health", "http://data-svc-green:3005/health" `
                -replace "http://trading-svc:3004/health", "http://trading-svc-green:3004/health" `
                -replace "http://liquidity-svc:3001/health", "http://liquidity-svc-green:3001/health" `
                -replace "http://weather-svc:3002/health", "http://weather-svc-green:3002/health" `
                -replace "http://market-svc:3003/health", "http://market-svc-green:3003/health"

            $tempFile = [System.IO.Path]::GetTempFileName() + ".yaml"
            $greenManifest | Out-File -FilePath $tempFile -Encoding utf8
            kubectl apply -f $tempFile -n $namespace 2>&1 | Out-Null
            Remove-Item $tempFile -ErrorAction SilentlyContinue
        }

        Write-Host " [OK]" -ForegroundColor Green
    }

    # Wait for this layer's deployments
    foreach ($svcName in $layer) {
        $greenName = "$svcName-$suffix"
        Write-Host "    [WAIT] $greenName" -ForegroundColor White -NoNewline
        kubectl rollout status "deployment/$greenName" -n $namespace --timeout=180s 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host " [TIMEOUT]" -ForegroundColor Yellow
        } else {
            Write-Host " [OK]" -ForegroundColor Green
        }
    }
}

# -- Status ----------------------------------------------------------------

Write-Host "`n[STATUS] Green Stack:" -ForegroundColor Cyan
kubectl get pods -n $namespace -l "version=$suffix" --no-headers 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor White }
Write-Host ""
kubectl get svc -n $namespace --no-headers 2>&1 | Where-Object { $_ -match "$suffix" } | ForEach-Object { Write-Host "  $_" -ForegroundColor White }

Write-Host "`n==================================================" -ForegroundColor DarkGray
Write-Host "[OK] Green stack deployed!" -ForegroundColor Green
Write-Host ""
Write-Host "  Blue (production):   http://localhost:30301" -ForegroundColor White
Write-Host "  Green (testing):     http://localhost:30302" -ForegroundColor Green
Write-Host ""
Write-Host "  Compare both dashboards side-by-side!" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  NOTE: Green monitor is PAUSED (replicas=0)" -ForegroundColor Yellow
Write-Host "        Green won't execute trades until promoted." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Commands:" -ForegroundColor DarkGray
Write-Host "    .\deploy-green.ps1 -Promote    # Swap production to green" -ForegroundColor DarkGray
Write-Host "    .\deploy-green.ps1 -Teardown   # Remove green stack" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Green logs:" -ForegroundColor DarkGray
Write-Host "    kubectl logs -f -n $namespace deployment/dashboard-svc-green" -ForegroundColor DarkGray
Write-Host "    kubectl logs -f -n $namespace deployment/data-svc-green" -ForegroundColor DarkGray
Write-Host "    kubectl logs -f -n $namespace deployment/trading-svc-green -c trading-svc-green" -ForegroundColor DarkGray
Write-Host ""
