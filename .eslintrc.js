module.exports = {
  parserOptions: {
    ecmaVersion: 2020,
  },
  extends: ['plugin:prettier/recommended'],
  ignorePatterns: ['coverage', 'lib'],
  overrides: [
    {
      files: ['src/**/*'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        sourceType: 'module',
      },
      extends: ['plugin:@typescript-eslint/recommended', 'prettier/@typescript-eslint'],
      rules: {
        'require-await': 'error',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
