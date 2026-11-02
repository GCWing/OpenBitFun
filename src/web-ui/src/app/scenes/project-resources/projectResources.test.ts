import { expect, it } from 'vitest';
import { parseProjectResourceTarget, projectResourceSceneId } from './projectResourceTarget';

it('keeps equal project IDs on different devices distinct and preserves arbitrary IDs', () => {
  const target = { surfaceId: 'peer:a/b', workspaceId: 'project:% / 工程' };
  expect(parseProjectResourceTarget(projectResourceSceneId(target))).toEqual(target);
  expect(projectResourceSceneId(target)).not.toBe(projectResourceSceneId({ ...target, surfaceId: 'local' }));
  for (const id of ['session', 'project-resources:%', 'project-resources:["local"]', 'project-resources:["local",1]']) {
    expect(parseProjectResourceTarget(id)).toBeNull();
  }
});
