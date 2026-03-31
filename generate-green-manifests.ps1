# TempEdge — Generate Green K8s Manifests
# Creates proper green-stack YAML files from templates
#
# Usage: .\generate-green-manifests.ps1
# Output: k8s/green/ directory with all green manifests

$ErrorActionPreference = "Stop"
$outDir = "k8s/green"

if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$namespace = "tempedge"
$suffix = "green"

# Green service URLs (isolated stack)
$greenUrls = @{
    DATA_SVC_URL      = "http://data-svc-green:3005"
    WEATHER_SVC_URL   = "http://weather-svc-green:3002"
    MARKET_SVC_URL    = "http://market-svc-green:3003"
    TRADING_SVC_URL   = "http://trading-svc-green:3004"
    LIQUIDITY_SVC_URL = "http://liquidity-svc-green:3001"
}

# ── Simple services (no special config) ──────────────────────────────────

function Write-SimpleService {
    param($Name, $Port, $Image, $Env, $HealthPath, $Cmd)
    if (-not $Cmd) { $Cmd = "index.js" }
    if (-not $HealthPath) { $HealthPath = "/health" }

    $envYaml = ""
    foreach ($key in $Env.Keys) {
        $envYaml += "            - name: $key`n              value: `"$($Env[$key])`"`n"
    }

    $yaml = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $Name-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: $Name-$suffix
    version: $suffix
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempedge
      component: $Name-$suffix
      version: $suffix
  template:
    metadata:
      labels:
        app: tempedge
        component: $Name-$suffix
        version: $suffix
    spec:
      containers:
        - name: $Name-$suffix
          image: $($Image):$suffix
          imagePullPolicy: Never
          ports:
            - containerPort: $Port
          env:
$envYaml          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: $HealthPath
              port: $Port
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: $HealthPath
              port: $Port
            initialDelaySeconds: 10
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: $Name-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: $Name-$suffix
    version: $suffix
spec:
  type: ClusterIP
  selector:
    app: tempedge
    component: $Name-$suffix
    version: $suffix
  ports:
    - name: http
      port: $Port
      targetPort: $Port
      protocol: TCP
"@
    return $yaml
}

# ── PVC for green data-svc (separate from production) ────────────────────
# Production uses tempedge-output (RWO). Green needs its own to avoid lock conflicts.
$pvcYaml = @"
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tempedge-output-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: storage
    version: $suffix
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Mi
  storageClassName: local-path
"@
$pvcYaml | Out-File "$outDir/pvc-green.yaml" -Encoding utf8
Write-Host "[OK] pvc-green.yaml" -ForegroundColor Green

# ── data-svc-green ───────────────────────────────────────────────────────
$dataSvcYaml = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: data-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: data-svc-$suffix
    version: $suffix
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: tempedge
      component: data-svc-$suffix
      version: $suffix
  template:
    metadata:
      labels:
        app: tempedge
        component: data-svc-$suffix
        version: $suffix
    spec:
      containers:
        - name: data-svc-$suffix
          image: tempedge-data-svc:$suffix
          imagePullPolicy: Never
          ports:
            - containerPort: 3005
          env:
            - name: OUTPUT_DIR
              value: "/app/output"
            - name: DATA_SVC_PORT
              value: "3005"
          volumeMounts:
            - name: output
              mountPath: /app/output
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 3005
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 3005
            initialDelaySeconds: 10
            periodSeconds: 30
      volumes:
        - name: output
          persistentVolumeClaim:
            claimName: tempedge-output-green
---
apiVersion: v1
kind: Service
metadata:
  name: data-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: data-svc-$suffix
    version: $suffix
spec:
  type: ClusterIP
  selector:
    app: tempedge
    component: data-svc-$suffix
    version: $suffix
  ports:
    - name: http
      port: 3005
      targetPort: 3005
      protocol: TCP
"@
$dataSvcYaml | Out-File "$outDir/data-svc-green.yaml" -Encoding utf8
Write-Host "[OK] data-svc-green.yaml" -ForegroundColor Green

# ── weather-svc-green ────────────────────────────────────────────────────
$env = @{ WEATHER_SVC_PORT = "3002" }
Write-SimpleService -Name "weather-svc" -Port 3002 -Image "tempedge-weather-svc" -Env $env |
    Out-File "$outDir/weather-svc-green.yaml" -Encoding utf8
Write-Host "[OK] weather-svc-green.yaml" -ForegroundColor Green

# ── market-svc-green ─────────────────────────────────────────────────────
$env = @{ MARKET_SVC_PORT = "3003"; DATA_SVC_URL = $greenUrls.DATA_SVC_URL }
Write-SimpleService -Name "market-svc" -Port 3003 -Image "tempedge-market-svc" -Env $env |
    Out-File "$outDir/market-svc-green.yaml" -Encoding utf8
Write-Host "[OK] market-svc-green.yaml" -ForegroundColor Green

# ── liquidity-svc-green ──────────────────────────────────────────────────
$env = @{ LIQUIDITY_SVC_PORT = "3001"; DATA_SVC_URL = $greenUrls.DATA_SVC_URL }
Write-SimpleService -Name "liquidity-svc" -Port 3001 -Image "tempedge-liquidity-svc" -Env $env |
    Out-File "$outDir/liquidity-svc-green.yaml" -Encoding utf8
Write-Host "[OK] liquidity-svc-green.yaml" -ForegroundColor Green

# ── trading-svc-green (needs VPN sidecar, secrets) ───────────────────────
# This one is complex — we reuse the existing blue VPN sidecar config
$tradingYaml = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trading-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: trading-svc-$suffix
    version: $suffix
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempedge
      component: trading-svc-$suffix
      version: $suffix
  template:
    metadata:
      labels:
        app: tempedge
        component: trading-svc-$suffix
        version: $suffix
    spec:
      containers:
        - name: trading-svc-$suffix
          image: tempedge-trading-svc:$suffix
          imagePullPolicy: Never
          ports:
            - containerPort: 3004
          env:
            - name: DATA_SVC_URL
              value: "$($greenUrls.DATA_SVC_URL)"
            - name: TRADING_SVC_PORT
              value: "3004"
            - name: HTTP_PROXY
              value: "socks5://127.0.0.1:1080"
            - name: HTTPS_PROXY
              value: "socks5://127.0.0.1:1080"
            - name: NO_PROXY
              value: "data-svc-green,localhost,*.polygon-rpc.com,rpc.ankr.com,polygon-bor-rpc.publicnode.com"
          envFrom:
            - secretRef:
                name: polymarket-trading
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 3004
            initialDelaySeconds: 15
            periodSeconds: 30
        - name: vpn
          image: qmcgaw/gluetun:latest
          securityContext:
            capabilities:
              add: ["NET_ADMIN"]
          env:
            - name: VPN_SERVICE_PROVIDER
              value: "custom"
            - name: VPN_TYPE
              value: "openvpn"
            - name: OPENVPN_CUSTOM_CONFIG
              value: "/vpn/nordvpn.ovpn"
          envFrom:
            - secretRef:
                name: nordvpn-credentials
          volumeMounts:
            - name: vpn-config
              mountPath: /vpn
              readOnly: true
            - name: tun-device
              mountPath: /dev/net/tun
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
      volumes:
        - name: vpn-config
          configMap:
            name: nordvpn-ovpn
        - name: tun-device
          hostPath:
            path: /dev/net/tun
---
apiVersion: v1
kind: Service
metadata:
  name: trading-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: trading-svc-$suffix
    version: $suffix
spec:
  type: ClusterIP
  selector:
    app: tempedge
    component: trading-svc-$suffix
    version: $suffix
  ports:
    - name: http
      port: 3004
      targetPort: 3004
      protocol: TCP
"@
$tradingYaml | Out-File "$outDir/trading-svc-green.yaml" -Encoding utf8
Write-Host "[OK] trading-svc-green.yaml" -ForegroundColor Green

# ── dashboard-svc-green (NodePort 30302) ─────────────────────────────────
# Direct template — regex init container injection was producing broken YAML indentation
$dashboardYaml = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dashboard-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: dashboard-svc-$suffix
    version: $suffix
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempedge
      component: dashboard-svc-$suffix
      version: $suffix
  template:
    metadata:
      labels:
        app: tempedge
        component: dashboard-svc-$suffix
        version: $suffix
    spec:
      initContainers:
        - name: wait-for-deps
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              echo "Waiting for data-svc-green..."
              until wget -qO- http://data-svc-$($suffix):3005/health > /dev/null 2>&1; do sleep 2; done
              echo "Waiting for trading-svc-green..."
              until wget -qO- http://trading-svc-$($suffix):3004/health > /dev/null 2>&1; do sleep 2; done
              echo "Waiting for liquidity-svc-green..."
              until wget -qO- http://liquidity-svc-$($suffix):3001/health > /dev/null 2>&1; do sleep 2; done
              echo "All green dependencies ready."
      containers:
        - name: dashboard-svc-$suffix
          image: tempedge-dashboard-svc:$suffix
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
          env:
            - name: DASHBOARD_PORT
              value: "3000"
            - name: DATA_SVC_URL
              value: "$($greenUrls.DATA_SVC_URL)"
            - name: TRADING_SVC_URL
              value: "$($greenUrls.TRADING_SVC_URL)"
            - name: LIQUIDITY_SVC_URL
              value: "$($greenUrls.LIQUIDITY_SVC_URL)"
            - name: MARKET_SVC_URL
              value: "$($greenUrls.MARKET_SVC_URL)"
            - name: WEATHER_SVC_URL
              value: "$($greenUrls.WEATHER_SVC_URL)"
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: dashboard-svc-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: dashboard-svc-$suffix
    version: $suffix
spec:
  type: NodePort
  selector:
    app: tempedge
    component: dashboard-svc-$suffix
    version: $suffix
  ports:
    - name: http
      port: 3000
      targetPort: 3000
      nodePort: 30302
      protocol: TCP
"@
$dashboardYaml | Out-File "$outDir/dashboard-svc-green.yaml" -Encoding utf8
Write-Host "[OK] dashboard-svc-green.yaml (NodePort 30302)" -ForegroundColor Green

# ── monitor-green (starts paused) ────────────────────────────────────────
$monEnv = @{
    DATA_SVC_URL     = $greenUrls.DATA_SVC_URL
    WEATHER_SVC_URL  = $greenUrls.WEATHER_SVC_URL
    MARKET_SVC_URL   = $greenUrls.MARKET_SVC_URL
    TRADING_SVC_URL  = $greenUrls.TRADING_SVC_URL
    LIQUIDITY_SVC_URL = $greenUrls.LIQUIDITY_SVC_URL
}

$monYaml = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: monitor-$suffix
  namespace: $namespace
  labels:
    app: tempedge
    component: monitor-$suffix
    version: $suffix
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempedge
      component: monitor-$suffix
      version: $suffix
  template:
    metadata:
      labels:
        app: tempedge
        component: monitor-$suffix
        version: $suffix
    spec:
      initContainers:
        - name: wait-for-deps
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              until wget -qO- http://data-svc-green:3005/health > /dev/null 2>&1; do sleep 2; done
              until wget -qO- http://weather-svc-green:3002/health > /dev/null 2>&1; do sleep 2; done
              until wget -qO- http://market-svc-green:3003/health > /dev/null 2>&1; do sleep 2; done
              until wget -qO- http://trading-svc-green:3004/health > /dev/null 2>&1; do sleep 2; done
              echo "All dependencies ready."
      containers:
        - name: monitor-$suffix
          image: tempedge-monitor:$suffix
          imagePullPolicy: Never
          env:
            - name: DATA_SVC_URL
              value: "$($greenUrls.DATA_SVC_URL)"
            - name: WEATHER_SVC_URL
              value: "$($greenUrls.WEATHER_SVC_URL)"
            - name: MARKET_SVC_URL
              value: "$($greenUrls.MARKET_SVC_URL)"
            - name: TRADING_SVC_URL
              value: "$($greenUrls.TRADING_SVC_URL)"
            - name: LIQUIDITY_SVC_URL
              value: "$($greenUrls.LIQUIDITY_SVC_URL)"
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
"@
$monYaml | Out-File "$outDir/monitor-green.yaml" -Encoding utf8
Write-Host "[OK] monitor-green.yaml" -ForegroundColor Green

Write-Host "`n[DONE] Green manifests generated in $outDir/" -ForegroundColor Cyan
Write-Host "  Apply with: kubectl apply -f $outDir/" -ForegroundColor DarkGray
