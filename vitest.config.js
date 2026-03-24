import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.js'],
        testTimeout: 10000,
        pool: 'forks', // better-sqlite3 needs separate process
    },
});
