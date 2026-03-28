/**
 * TempEdge — Lightweight Prometheus Metrics
 *
 * Zero-dependency Prometheus exposition format (text/plain; version=0.0.4).
 * Each service creates a Metrics instance and registers counters, gauges,
 * and histograms. The /metrics endpoint renders them in Prometheus scrape format.
 *
 * Design decisions:
 *   - No external dependencies (prom-client is 200KB+ and overkill for 7 services)
 *   - Histogram uses fixed buckets optimized for HTTP latency (ms)
 *   - All metrics are prefixed with the service name for Grafana disambiguation
 *   - Thread-safe: single-threaded Node.js so no locking needed
 *
 * Usage:
 *   import { createMetrics } from '../../shared/metrics.js';
 *   const metrics = createMetrics('trading_svc');
 *
 *   // Define metrics
 *   const httpRequests = metrics.counter('http_requests_total', 'Total HTTP requests', ['method', 'path', 'status']);
 *   const httpLatency = metrics.histogram('http_request_duration_ms', 'HTTP request latency in ms', ['method', 'path']);
 *   const activeConnections = metrics.gauge('active_connections', 'Current active connections');
 *
 *   // Record values
 *   httpRequests.inc({ method: 'POST', path: '/api/buy', status: '200' });
 *   httpLatency.observe(42.5, { method: 'POST', path: '/api/buy' });
 *   activeConnections.set(5);
 *
 *   // Expose endpoint
 *   if (path === '/metrics') return metrics.handleRequest(res);
 */

// ── Default histogram buckets (ms) — optimized for HTTP latency ─────────
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ── Counter ─────────────────────────────────────────────────────────────

class Counter {
    constructor(name, help, labelNames = []) {
        this.name = name;
        this.help = help;
        this.labelNames = labelNames;
        this._values = new Map(); // key → number
    }

    inc(labels = {}, value = 1) {
        const key = this._key(labels);
        this._values.set(key, (this._values.get(key) || 0) + value);
    }

    _key(labels) {
        if (this.labelNames.length === 0) return '';
        return this.labelNames.map((n) => labels[n] || '').join('\0');
    }

    _render(prefix) {
        const fullName = `${prefix}_${this.name}`;
        const lines = [`# HELP ${fullName} ${this.help}`, `# TYPE ${fullName} counter`];
        for (const [key, value] of this._values) {
            const labelStr = this._labelStr(key);
            lines.push(`${fullName}${labelStr} ${value}`);
        }
        return lines.join('\n');
    }

    _labelStr(key) {
        if (!key) return '';
        const parts = key.split('\0');
        const pairs = this.labelNames.map((n, i) => `${n}="${parts[i] || ''}"`);
        return `{${pairs.join(',')}}`;
    }
}

// ── Gauge ───────────────────────────────────────────────────────────────

class Gauge {
    constructor(name, help, labelNames = []) {
        this.name = name;
        this.help = help;
        this.labelNames = labelNames;
        this._values = new Map();
    }

    set(value, labels = {}) {
        this._values.set(this._key(labels), value);
    }

    inc(labels = {}, value = 1) {
        const key = this._key(labels);
        this._values.set(key, (this._values.get(key) || 0) + value);
    }

    dec(labels = {}, value = 1) {
        const key = this._key(labels);
        this._values.set(key, (this._values.get(key) || 0) - value);
    }

    _key(labels) {
        if (this.labelNames.length === 0) return '';
        return this.labelNames.map((n) => labels[n] || '').join('\0');
    }

    _render(prefix) {
        const fullName = `${prefix}_${this.name}`;
        const lines = [`# HELP ${fullName} ${this.help}`, `# TYPE ${fullName} gauge`];
        for (const [key, value] of this._values) {
            const labelStr = this._labelStr(key);
            lines.push(`${fullName}${labelStr} ${value}`);
        }
        return lines.join('\n');
    }

    _labelStr(key) {
        if (!key) return '';
        const parts = key.split('\0');
        const pairs = this.labelNames.map((n, i) => `${n}="${parts[i] || ''}"`);
        return `{${pairs.join(',')}}`;
    }
}

// ── Histogram ───────────────────────────────────────────────────────────

class Histogram {
    constructor(name, help, labelNames = [], buckets = DEFAULT_BUCKETS) {
        this.name = name;
        this.help = help;
        this.labelNames = labelNames;
        this.buckets = [...buckets].sort((a, b) => a - b);
        this._data = new Map(); // key → { buckets: number[], sum: number, count: number }
    }

    observe(value, labels = {}) {
        const key = this._key(labels);
        let data = this._data.get(key);
        if (!data) {
            data = { buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
            this._data.set(key, data);
        }
        data.sum += value;
        data.count++;
        // Store in the first bucket that fits (non-cumulative; cumulative computed on render)
        for (let i = 0; i < this.buckets.length; i++) {
            if (value <= this.buckets[i]) {
                data.buckets[i]++;
                break;
            }
        }
    }

    /** Helper: time an async function and observe its duration in ms */
    async time(fn, labels = {}) {
        const start = performance.now();
        try {
            return await fn();
        } finally {
            this.observe(performance.now() - start, labels);
        }
    }

    _key(labels) {
        if (this.labelNames.length === 0) return '';
        return this.labelNames.map((n) => labels[n] || '').join('\0');
    }

    _render(prefix) {
        const fullName = `${prefix}_${this.name}`;
        const lines = [`# HELP ${fullName} ${this.help}`, `# TYPE ${fullName} histogram`];
        for (const [key, data] of this._data) {
            const labelStr = this._labelStr(key);
            const sep = labelStr ? ',' : '';
            let cumulative = 0;
            for (let i = 0; i < this.buckets.length; i++) {
                cumulative += data.buckets[i];
                lines.push(`${fullName}_bucket{${labelStr ? labelStr.slice(1, -1) + sep : ''}le="${this.buckets[i]}"} ${cumulative}`);
            }
            lines.push(`${fullName}_bucket{${labelStr ? labelStr.slice(1, -1) + sep : ''}le="+Inf"} ${data.count}`);
            lines.push(`${fullName}_sum${labelStr} ${data.sum}`);
            lines.push(`${fullName}_count${labelStr} ${data.count}`);
        }
        return lines.join('\n');
    }

    _labelStr(key) {
        if (!key) return '';
        const parts = key.split('\0');
        const pairs = this.labelNames.map((n, i) => `${n}="${parts[i] || ''}"`);
        return `{${pairs.join(',')}}`;
    }
}

// ── Metrics Registry ────────────────────────────────────────────────────

class Metrics {
    constructor(prefix) {
        this.prefix = prefix;
        this._metrics = [];
        this._startTime = Date.now();

        // Auto-register process metrics
        this._processMetrics = true;
    }

    counter(name, help, labelNames = []) {
        const c = new Counter(name, help, labelNames);
        this._metrics.push(c);
        return c;
    }

    gauge(name, help, labelNames = []) {
        const g = new Gauge(name, help, labelNames);
        this._metrics.push(g);
        return g;
    }

    histogram(name, help, labelNames = [], buckets) {
        const h = new Histogram(name, help, labelNames, buckets);
        this._metrics.push(h);
        return h;
    }

    /** Render all metrics in Prometheus exposition format */
    render() {
        const sections = [];

        // Process metrics (always included)
        if (this._processMetrics) {
            const uptimeS = (Date.now() - this._startTime) / 1000;
            const mem = process.memoryUsage();
            sections.push(
                `# HELP ${this.prefix}_process_uptime_seconds Process uptime in seconds`,
                `# TYPE ${this.prefix}_process_uptime_seconds gauge`,
                `${this.prefix}_process_uptime_seconds ${uptimeS.toFixed(1)}`,
                `# HELP ${this.prefix}_process_heap_bytes Process heap memory usage`,
                `# TYPE ${this.prefix}_process_heap_bytes gauge`,
                `${this.prefix}_process_heap_bytes ${mem.heapUsed}`,
                `# HELP ${this.prefix}_process_rss_bytes Process RSS memory`,
                `# TYPE ${this.prefix}_process_rss_bytes gauge`,
                `${this.prefix}_process_rss_bytes ${mem.rss}`,
            );
        }

        // User-defined metrics
        for (const m of this._metrics) {
            sections.push(m._render(this.prefix));
        }

        return sections.join('\n') + '\n';
    }

    /** Handle a /metrics HTTP request — returns true if handled */
    handleRequest(res) {
        res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        res.end(this.render());
        return true;
    }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a metrics registry for a service.
 * @param {string} prefix - Service name (e.g. 'trading_svc')
 * @returns {Metrics}
 */
export function createMetrics(prefix) {
    return new Metrics(prefix);
}

/**
 * Create standard HTTP metrics (request counter + latency histogram).
 * Returns { requestCounter, latencyHistogram, metricsMiddleware }.
 *
 * @param {Metrics} metrics - Metrics registry
 * @returns {{ requestCounter: Counter, latencyHistogram: Histogram, wrapHandler: Function }}
 */
export function createHttpMetrics(metrics) {
    const requestCounter = metrics.counter('http_requests_total', 'Total HTTP requests', ['method', 'path', 'status']);
    const latencyHistogram = metrics.histogram('http_request_duration_ms', 'HTTP request duration in ms', ['method', 'path']);

    /**
     * Wrap a request handler to automatically track metrics.
     * @param {Function} handler - async (req, res) => void
     * @returns {Function} Wrapped handler
     */
    function wrapHandler(handler) {
        return async (req, res) => {
            const start = performance.now();
            const url = new URL(req.url, 'http://localhost');
            // Normalize path: collapse IDs to :id for cardinality control
            const path = url.pathname.replace(/\/[0-9a-f-]{8,}/gi, '/:id').replace(/\/\d{4}-\d{2}-\d{2}/g, '/:date');

            try {
                await handler(req, res);
            } finally {
                const duration = performance.now() - start;
                const status = String(res.statusCode || 200);
                requestCounter.inc({ method: req.method, path, status });
                latencyHistogram.observe(duration, { method: req.method, path });
            }
        };
    }

    return { requestCounter, latencyHistogram, wrapHandler };
}
