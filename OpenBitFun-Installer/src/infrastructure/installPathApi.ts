import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { InstallPathValidation } from '../types/installer';

export const installPathApi = {
  defaultPath: (allUsers: boolean) => invoke<string>('get_default_install_path', { allUsers }),
  validate: (path: string) => invoke<InstallPathValidation>('validate_install_path', { path }),
  chooseDirectory: (defaultPath: string, title: string) => open({ directory: true, defaultPath, title }),
};
