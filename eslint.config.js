import tseslint from 'typescript-eslint';

// clad Lint 게이트(`npx eslint .`)용 — 이 레포는 그동안 eslint를 쓰지 않았으므로
// '최소 도입' 방침으로 시작한다: 손가락 사고(debugger 잔류·중복 키·도달 불가 코드
// 등) 같은 명백한 버그성만 error로 차단하고, 스타일/엄격 규칙은 warn으로 둔다
// (warn은 eslint를 비-0으로 만들지 않는다 — 게이트는 통과하되 린트는 실제로 돈다).
// 검사 대상은 유일한 TS 패키지인 studio-host의 소스로 한정한다.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vendor/**',
      '**/*.config.*',
      'third_party/**',
      'apps/desktop/**',
      'scripts/**',
      'tests/**',
      'apps/studio-host/hop-overrides*',
    ],
  },
  {
    files: ['apps/studio-host/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // 명백한 버그성 — 차단(error)
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      // 기본값(except-parens): `while ((m = re.exec(s)) !== null)` 같은 의도적 대입
      // idiom은 허용하고, 괄호 없는 `if (x = 5)` 오타성 대입만 차단한다.
      'no-cond-assign': 'error',
      'no-self-assign': 'error',
      // 정리 대상 — 경고(triage용, 차단하지 않음)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      'no-empty': 'warn',
    },
  },
);
