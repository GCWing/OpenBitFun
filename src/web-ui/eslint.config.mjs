import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'public/monaco-editor/**',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'src/**/*.example.tsx',
    ],
  },
  {
    // Adapter-layer fence: business Tauri commands must reach the platform
    // only through ApiClient (api.invoke). Direct `invoke` from
    // '@tauri-apps/api/core' is reserved for the adapter implementations in
    // adapters/** (and the peer-device host bridge, which intentionally runs
    // outside the routed transport — see PeerHostInvokeBridge). This is the
    // executable form of "front end calls go through the adapter layer";
    // reintroducing a direct invoke elsewhere fails the build.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/infrastructure/api/adapters/**',
      // PeerHostInvokeBridge runs on the HOST side of Peer-Device Mode: it
      // executes *dynamic* command names forwarded from the peer device via a
      // raw Tauri invoke. ApiClient is already routed to the peer adapter at
      // this point, so routing through it would be wrong. This is the one
      // intentional exception to the adapter-layer fence.
      'src/infrastructure/peer-device/PeerHostInvokeBridge.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/api/core'],
              importNames: ['invoke'],
              message:
                '业务命令必须经 api.invoke(ApiClient) 统一适配层,不可直接 import invoke。' +
                '如需直连平台 invoke,放到 adapters/ 内并经 api 暴露。',
            },
          ],
        },
      ],
      // no-restricted-imports only covers static ImportDeclaration in ESLint 9;
      // dynamic `import('@tauri-apps/api/core')` to grab `invoke` bypasses it.
      // Block the same surface with an ImportExpression selector so a future
      // dynamic-import bypass fails the build too. Same ignores (adapters/** +
      // PeerHostInvokeBridge) apply via this block's ignores; exceptions must be
      // added with an owner comment, like the static rule.
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value='@tauri-apps/api/core']",
          message:
            '业务命令必须经 api.invoke(ApiClient) 统一适配层,不可动态 import invoke。' +
            '如需直连平台 invoke,放到 adapters/ 内并经 api 暴露。',
        },
        {
          // api.invoke captures the device surface when it is called, after
          // its arguments were awaited. An await inside the arguments can
          // therefore send the previous device's IDs or paths to the next one.
          selector: "CallExpression[callee.property.name='invoke'] > * AwaitExpression, CallExpression[callee.property.name='invoke'] > AwaitExpression",
          message:
            'Do not await inside api.invoke(...) arguments: the device surface is captured after ' +
            'they resolve. Use invokePrepared(command, async scope => args) instead.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-use-before-define': 'off',
      'no-case-declarations': 'warn',
      'no-cond-assign': 'warn',
      'no-control-regex': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: true,
          ignoreTypeReferences: true,
        },
      ],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Pre-existing legacy: context-system type impls use class components
    // that call React Hooks (a pattern predating the adapter fence). Exempt
    // ONLY the noisy legacy rule here — the adapter fence
    // (no-restricted-imports / no-restricted-syntax) still applies to this
    // directory, so a direct or dynamic `invoke` import from
    // '@tauri-apps/api/core' here fails the build just like anywhere else.
    // This was previously a global ignore that let the whole fence be bypassed.
    files: ['src/shared/context-system/core/types/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    files: ['*.{ts,mts,cts}', '*.config.{ts,mts,cts}', 'vite.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parser: tseslint.parser,
    },
  },
  {
    // SessionDriver seam fence: flow_chat must reach dispatch machinery only
    // through session-drivers. This is the executable form of "no dispatch
    // branches in flow_chat" — reintroducing one fails the build.
    //
    // Exceptions, each with an owner:
    // - session-drivers/**: the dispatch driver's own implementation.
    // - types/flow-chat.ts: type-only SessionConfig fields (collapses into a
    //   single `config.dispatch` member in a follow-up).
    // - store/FlowChatStore.ts: dispatch snapshot/cursor mutations kept
    //   in-place by design during the seam refactor (same follow-up).
    // - ChatInput.tsx / ChatInputWorkspaceStrip.tsx: render the dispatch
    //   target-picker feature chip — feature UI, not transport branching.
    files: ['src/flow_chat/**/*.{ts,tsx}'],
    ignores: [
      'src/flow_chat/session-drivers/**',
      'src/flow_chat/types/flow-chat.ts',
      'src/flow_chat/store/FlowChatStore.ts',
      'src/flow_chat/components/ChatInput.tsx',
      'src/flow_chat/components/ChatInputWorkspaceStrip.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/dispatch/*'],
              message:
                'flow_chat reaches dispatch only through session-drivers. ' +
                'Add the behavior to the SessionDriver interface instead.',
            },
          ],
        },
      ],
    },
  },
);
