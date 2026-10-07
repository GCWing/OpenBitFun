import { SettingsPage } from '../shared/SettingsPage';
import GitCommitSettingsSection from './GitCommitSettingsSection';
import WorkspaceSearchSection from './WorkspaceSearchSection';
import WorktreeSettingsSection from './WorktreeSettingsSection';

export default function WorkspaceGitSettingsPage() {
  return (
    <SettingsPage pageId="development.workspace">
      <WorkspaceSearchSection />
      <GitCommitSettingsSection />
      <WorktreeSettingsSection />
    </SettingsPage>
  );
}
