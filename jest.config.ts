import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  coverageReporters: ["lcov"],
  collectCoverageFrom: [
    "src/**",
  ],
};

export default config;
