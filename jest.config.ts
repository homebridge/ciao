import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: "ts-jest",
  testEnvironment: "node",
  coverageReporters: ["lcov"],
  collectCoverageFrom: [
    "src/**",
    "!src/internal/**"
  ]
}

export default config;
