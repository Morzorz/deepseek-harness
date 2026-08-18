import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

function alias(pkg: string): [string, string] {
  return [pkg, resolve(root, '..', 'node_modules', '.pnpm', 'node_modules', pkg)]
}

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@deepseek-ai/cordis': alias('@deepseek-ai/cordis')[1],
      '@deepseek-ai/dsh-tools': alias('@deepseek-ai/dsh-tools')[1],
      '@deepseek-ai/dsh-agent': alias('@deepseek-ai/dsh-agent')[1],
      '@deepseek-ai/dsh-llm': alias('@deepseek-ai/dsh-llm')[1],
      '@deepseek-ai/dsh-session': alias('@deepseek-ai/dsh-session')[1],
      '@deepseek-ai/dsh-user-approval': alias('@deepseek-ai/dsh-user-approval')[1],
      '@deepseek-ai/schemastery': alias('@deepseek-ai/schemastery')[1],
    },
  },
})
