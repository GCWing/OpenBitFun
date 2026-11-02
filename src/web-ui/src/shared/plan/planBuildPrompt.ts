import { i18nService } from '@/infrastructure/i18n';

/** Keep execution instructions in English while honoring the selected UI language. */
export function planBuildPrompt(filePath: string): string {
  const locale = i18nService.getCurrentLocale();
  const language = i18nService.getCurrentLocaleMetadata()?.englishName ?? locale;

  return `Implement the plan at \`${filePath}\`.

Read the plan file before making changes and treat it as the source of truth. Implement the plan and verify the result. Do not edit the plan file unless the user requests a plan revision.

Language Preference: Use ${language} (${locale}) for all user-facing communication, including progress updates and the final response, unless the user explicitly requests another language. The language of these instructions or the plan file does not override this preference.`;
}
