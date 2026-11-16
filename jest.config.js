module.exports = {
  preset: 'ts-jest',
  testEnvironment: '@ton/sandbox/jest-environment',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 60000,
};
