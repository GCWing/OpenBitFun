import { useEffect, useState } from 'react';

export function skillPageNumbers(page: number, totalPages: number): Array<number | 'start-gap' | 'end-gap'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'end-gap', totalPages];
  if (page >= totalPages - 3) {
    return [1, 'start-gap', ...Array.from({ length: 5 }, (_, index) => totalPages - 4 + index)];
  }
  return [1, 'start-gap', page - 1, page, page + 1, 'end-gap', totalPages];
}

export function useSkillsPagination<Skill>(skills: Skill[], resetKey: string, ready: boolean, pageSize: number) {
  const [selection, setSelection] = useState({ key: resetKey, page: 1, pageSize });
  // On resize, keep the previously first visible skill on the new page.
  const requestedPage = selection.key === resetKey
    ? Math.floor((selection.page - 1) * selection.pageSize / pageSize) + 1
    : 1;
  const totalPages = Math.max(1, Math.ceil(skills.length / pageSize));
  const page = ready ? Math.min(requestedPage, totalPages) : requestedPage;

  useEffect(() => {
    // Refreshes may temporarily empty the catalog. Clamp only a completed result,
    // but always reset when the workspace, query, or filter changes.
    setSelection(previous => previous.key === resetKey && previous.page === page && previous.pageSize === pageSize
      ? previous
      : { key: resetKey, page, pageSize });
  }, [page, resetKey, pageSize]);

  const offset = (page - 1) * pageSize;
  return {
    page,
    totalPages,
    pages: skillPageNumbers(page, totalPages),
    skills: ready ? skills.slice(offset, offset + pageSize) : [],
    start: skills.length === 0 ? 0 : offset + 1,
    end: Math.min(offset + pageSize, skills.length),
    goToPage: (next: number) => setSelection({ key: resetKey, page: Math.max(1, Math.min(next, totalPages)), pageSize }),
  };
}
