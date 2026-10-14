module.exports = { setupFiles: ['<rootDir>/tests/setup-env.ts'], globalSetup: '<rootDir>/tests/global-setup.ts',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000,
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/worker.ts'],
};
