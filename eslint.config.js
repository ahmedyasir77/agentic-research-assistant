import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The rules of engagement, enforced by the linter rather than by review.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Read configuration from config/env.ts, never process.env.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'Dynamic code construction is banned — see tools/calculator.ts for why.',
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: 'Dynamic code construction is banned — see tools/calculator.ts for why.',
        },
      ],
    },
  },

  // Boot code is the one place allowed to touch process and the console: config
  // parsing has to report a fatal misconfiguration before a logger exists.
  {
    files: ['apps/api/src/main.ts', 'apps/api/src/config/env.ts', 'apps/*/vite.config.ts'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-globals': 'off',
    },
  },

  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
