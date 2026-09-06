import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Mark identifiers used only in JSX as used (React 18 auto-import mode).
      'react/jsx-uses-vars': 'error',
      // This codebase intentionally seeds state inside effects (countdown init,
      // loading flags, geolocation fallback). The rule is too aggressive here.
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'warn',
      // React 18 JSX transform doesn't need `import React`; these imports are
      // intentional but harmless.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^React$' }],
    },
  },
];