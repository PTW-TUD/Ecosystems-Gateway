import tsParser from '@typescript-eslint/parser';
import typescriptEslintEslintPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...compat.extends(
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ),
  {
    files: ['**/*.ts'],

    languageOptions: {
      parser: tsParser,
      sourceType: 'module',

      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },

      globals: {
        ...globals.node,
      },
    },

    plugins: {
      '@typescript-eslint': typescriptEslintEslintPlugin,
    },

    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['**/.eslintrc.js', 'src/generated/**'],
  },
];
