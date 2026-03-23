import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
    // ── Base: ESLint recommended rules ──────────────────────────────────
    js.configs.recommended,

    // ── Prettier: disable ESLint formatting rules that conflict ─────────
    prettierConfig,

    // ── Project-wide config ─────────────────────────────────────────────
    {
        files: ['**/*.js'],
        ignores: ['node_modules/**', '_deprecated/**', 'output/**'],
        plugins: {
            prettier,
        },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // ── Prettier integration ────────────────────────────────────
            'prettier/prettier': 'warn',

            // ── Error prevention ────────────────────────────────────────
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],

            // ── Code quality ────────────────────────────────────────────
            'no-var': 'error',
            'prefer-const': ['warn', { destructuring: 'all' }],
            'eqeqeq': ['warn', 'always', { null: 'ignore' }],
            'no-throw-literal': 'error',

            // ── Empty catch blocks: require a comment (enforces our audit) ─
            'no-empty': ['warn', { allowEmptyCatch: false }],

            // ── Relaxed rules for existing patterns ─────────────────────
            'no-empty-pattern': 'off',         // destructuring patterns
            'no-prototype-builtins': 'off',     // obj.hasOwnProperty() used
            'no-case-declarations': 'off',      // let/const in switch-case
            'no-fallthrough': 'warn',
            'no-control-regex': 'off',
        },
    },

    // ── Browser-side JS in dashboard static files ───────────────────────
    {
        files: ['services/dashboard-svc/static/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            // Dashboard client JS is best-effort, relax some rules
            'no-unused-vars': 'off',
            'no-undef': 'off',
            'no-var': 'off',
            'no-redeclare': 'off',
            'no-useless-assignment': 'off',
            'prettier/prettier': 'off',
        },
    },

    // ── Test files ──────────────────────────────────────────────────────
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                // vitest globals
                describe: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                vi: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                test: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'off',
        },
    },

    // ── Global ignores ──────────────────────────────────────────────────
    {
        ignores: [
            'node_modules/**',
            '_deprecated/**',
            'output/**',
            'k8s/secrets/**',
            '**/node_modules/**',
        ],
    },
];
