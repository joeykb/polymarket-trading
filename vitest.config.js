import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.js'],
        testTimeout: 10000,
        pool: 'forks', // better-sqlite3 needs separate process
        coverage: {
            provider: 'v8',
            include: ['shared/**/*.js', 'services/**/*.js'],
            exclude: [
                '**/node_modules/**',
                '**/static/**',
                '**/*.test.js',
                '**/Dockerfile',
                'services/dashboard-svc/static/**',
            ],
            reporter: ['text', 'text-summary', 'json-summary'],
            reportsDirectory: './coverage',
            thresholds: {
                // Global baseline — service entry points drag these down
                lines: 20,
                functions: 25,
                branches: 20,
                statements: 20,
                // Per-directory: shared/ is well-covered, enforce higher bar
                'shared/**': {
                    lines: 75,
                    functions: 70,
                    branches: 65,
                    statements: 75,
                },
            },
        },
    },
});
