import { SettingsPage } from '../shared/SettingsPage';
import GitCommitSettingsSection from './GitCommitSettingsSection';
import WorkspaceSearchSection from './WorkspaceSearchSection';
import RemoteUserSkillsSection from './RemoteUserSkillsSection';
import WorktreeSettingsSection from './WorktreeSettingsSection';

export default function WorkspaceGitSettingsPage() {
  return (
    <SettingsPage pageId="development.workspace">
      <WorkspaceSearchSection />
      <RemoteUserSkillsSection />
      <GitCommitSettingsSection />
      <WorktreeSettingsSection />
    </SettingsPage>
  );
}
