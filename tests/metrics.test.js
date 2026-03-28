/**
 * Tests for shared Prometheus metrics module
 */
import { describe, it, expect } from 'vitest';
import { createMetrics, createHttpMetrics } from '../shared/metrics.js';

describe('metrics', () => {
    it('creates a counter and renders it', () => {
        const m = createMetrics('test_svc');
        const c = m.counter('requests_total', 'Total requests', ['method']);

        c.inc({ method: 'GET' });
        c.inc({ method: 'GET' });
        c.inc({ method: 'POST' });

        const output = m.render();
        expect(output).toContain('# TYPE test_svc_requests_total counter');
        expect(output).toContain('test_svc_requests_total{method="GET"} 2');
        expect(output).toContain('test_svc_requests_total{method="POST"} 1');
    });

    it('creates a gauge and renders it', () => {
        const m = createMetrics('test_svc');
        const g = m.gauge('active_connections', 'Active connections');

        g.set(5);
        const output = m.render();
        expect(output).toContain('# TYPE test_svc_active_connections gauge');
        expect(output).toContain('test_svc_active_connections 5');
    });

    it('gauge supports inc/dec', () => {
        const m = createMetrics('test_svc');
        const g = m.gauge('items', 'Items');

        g.inc();
        g.inc();
        g.dec();
        const output = m.render();
        expect(output).toContain('test_svc_items 1');
    });

    it('creates a histogram with buckets', () => {
        const m = createMetrics('test_svc');
        const h = m.histogram('latency_ms', 'Latency', [], [10, 50, 100]);

        h.observe(5);
        h.observe(25);
        h.observe(75);
        h.observe(200);

        const output = m.render();
        expect(output).toContain('# TYPE test_svc_latency_ms histogram');
        expect(output).toContain('test_svc_latency_ms_bucket{le="10"} 1');
        expect(output).toContain('test_svc_latency_ms_bucket{le="50"} 2');
        expect(output).toContain('test_svc_latency_ms_bucket{le="100"} 3');
        expect(output).toContain('test_svc_latency_ms_bucket{le="+Inf"} 4');
        expect(output).toContain('test_svc_latency_ms_sum');
        expect(output).toContain('test_svc_latency_ms_count 4');
    });

    it('includes process metrics', () => {
        const m = createMetrics('test_svc');
        const output = m.render();

        expect(output).toContain('test_svc_process_uptime_seconds');
        expect(output).toContain('test_svc_process_heap_bytes');
        expect(output).toContain('test_svc_process_rss_bytes');
    });

    it('counter without labels works', () => {
        const m = createMetrics('test_svc');
        const c = m.counter('errors_total', 'Total errors');

        c.inc();
        c.inc();
        c.inc();

        const output = m.render();
        expect(output).toContain('test_svc_errors_total 3');
    });

    it('histogram supports labeled observations', () => {
        const m = createMetrics('test_svc');
        const h = m.histogram('duration_ms', 'Duration', ['method'], [50, 100]);

        h.observe(25, { method: 'GET' });
        h.observe(75, { method: 'POST' });

        const output = m.render();
        expect(output).toContain('method="GET"');
        expect(output).toContain('method="POST"');
    });

    it('handleRequest sets correct content type', () => {
        const m = createMetrics('test_svc');
        let capturedHeaders = {};
        let capturedBody = '';
        const mockRes = {
            writeHead: (status, headers) => { capturedHeaders = headers; },
            end: (body) => { capturedBody = body; },
        };

        m.handleRequest(mockRes);
        expect(capturedHeaders['Content-Type']).toContain('text/plain');
        expect(capturedBody).toContain('process_uptime_seconds');
    });

    it('createHttpMetrics creates request counter and latency histogram', () => {
        const m = createMetrics('test_svc');
        const { requestCounter, latencyHistogram } = createHttpMetrics(m);

        requestCounter.inc({ method: 'GET', path: '/api/buy', status: '200' });
        latencyHistogram.observe(42, { method: 'GET', path: '/api/buy' });

        const output = m.render();
        expect(output).toContain('http_requests_total');
        expect(output).toContain('http_request_duration_ms');
    });
});
