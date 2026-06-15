import { defineConfig } from 'vitest/config';

// clad Unit/Coverage 게이트(`npx vitest run [--coverage]`)가 루트에서 워크스페이스의
// 실제 테스트(studio-host)를 그대로 돌리도록 위임한다. studio-host/vitest.config.ts를
// 프로젝트로 참조하므로 alias·환경 설정은 그 파일이 단일 소스로 유지한다.
export default defineConfig({
  test: {
    projects: ['apps/studio-host'],
  },
});
