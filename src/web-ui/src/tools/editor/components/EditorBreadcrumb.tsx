import { useEditorDocument } from '../services/EditorDocument';
/** File path breadcrumb with a dropdown for quick navigation. */

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { Code, Loader2 } from 'lucide-react';
import { getFileIconType } from '@/tools/file-system/utils/fileIcons';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';

import './EditorBreadcrumb.scss';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Icon, Menu, MenuItem, MenuSection, Tooltip, type IconSize } from '@openbitfun/ui';

const log = createLogger('EditorBreadcrumb');

export interface EditorBreadcrumbProps {
  /** Full file path */
  filePath: string;
  /** Workspace path (for calculating relative path) */
  workspacePath?: string;
  /** Custom class name */
  className?: string;
}

interface PathSegment {
  name: string;
  fullPath: string;
  isFile: boolean;
}

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Get icon component based on file name */
const getFileIconComponent = (fileName: string, size: IconSize = 'xs'): React.ReactElement => {
  const iconType = getFileIconType({ name: fileName, isDirectory: false } as any);
  
  switch (iconType) {
    case 'javascript':
    case 'typescript':
    case 'react':
    case 'vue':
    case 'python':
    case 'rust':
    case 'go':
    case 'java':
    case 'c-cpp':
    case 'html':
    case 'css':
    case 'sass':
    case 'code':
      return <Icon glyph={Code} size={size} />;
    default:
      return <Icon name="files" size={size} />;
  }
};

/** Get directory name from path */
const getDirectoryName = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

/** Get parent directory path */
const getParentPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return normalized.substring(0, lastSlash);
};

/** Dropdown menu component (rendered to body via Portal) */
interface DropdownMenuProps {
  isOpen: boolean;
  items: FileItem[];
  loading: boolean;
  currentDirPath: string;
  initialDirPath: string;
  onSelect: (item: FileItem) => void;
  onGoBack: () => void;
  onClose: () => void;
  anchorEl: HTMLElement | null;
  currentFilePath: string;
  workspacePath?: string;
}

const DropdownMenu: React.FC<DropdownMenuProps> = ({
  isOpen,
  items,
  loading,
  currentDirPath,
  initialDirPath,
  onSelect,
  onGoBack,
  onClose,
  anchorEl,
  currentFilePath,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchorEl;
  const popoverLayout = useAnchoredPopoverPosition({
    open: isOpen,
    anchorRef,
    popoverRef: menuRef,
    preferredPlacement: 'bottom',
    alignment: 'start',
    gap: 4,
    layoutRevision: `${loading}:${currentDirPath}:${items.length}`,
  });

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        anchorEl &&
        !anchorEl.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handleClickOutside);
      removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [isOpen, onClose, anchorEl]);

  if (!isOpen) return null;

  // Sort: directories first, then by name
  const sortedItems = [...items].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  // Check if we can go back to parent
  const canGoBack = currentDirPath !== initialDirPath;
  const currentDirName = getDirectoryName(currentDirPath);

  const menuContent = (
    <Menu
      ref={menuRef}
      aria-label={currentDirName}
      autoFocusFirstItem
      className="editor-breadcrumb-dropdown"
      data-openbitfun-product-component="editor-breadcrumb"
      data-openbitfun-product-part="menu"
      style={{
        position: 'fixed',
        top: popoverLayout?.top ?? 0,
        left: popoverLayout?.left ?? 0,
        visibility: popoverLayout ? 'visible' : 'hidden',
      }}
    >
      <MenuSection
        actions={canGoBack ? [{
          icon: <Icon name="arrow-left" size="xs" />,
          id: 'back',
          label: 'Go to parent directory',
          onClick: (event) => {
            event.stopPropagation();
            onGoBack();
          },
        }] : undefined}
        title={canGoBack ? (
          <Tooltip content={currentDirPath} placement="top">
            <span>{currentDirName}</span>
          </Tooltip>
        ) : undefined}
      >
        {loading ? (
          <div
            data-openbitfun-product-component="editor-breadcrumb"
            data-openbitfun-product-part="loading"
            className="editor-breadcrumb-dropdown__loading"
            role="status"
          >
            <Loader2 size={14} className="editor-breadcrumb-dropdown__spinner" />
            <span>Loading...</span>
          </div>
        ) : sortedItems.length === 0 ? (
          <div
            data-openbitfun-product-component="editor-breadcrumb"
            data-openbitfun-product-part="empty"
            className="editor-breadcrumb-dropdown__empty"
            role="status"
          >
            Empty directory
          </div>
        ) : (
          sortedItems.map((item) => {
            const isCurrentFile = item.path.replace(/\\/g, '/') === currentFilePath.replace(/\\/g, '/');
            return (
              <MenuItem
                checked={isCurrentFile}
                key={item.path}
                leading={item.isDirectory
                  ? <Icon name="folder" size="sm" />
                  : getFileIconComponent(item.name, 'sm')}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(item);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' && item.isDirectory) {
                    event.preventDefault();
                    onSelect(item);
                  } else if (event.key === 'ArrowLeft' && canGoBack) {
                    event.preventDefault();
                    onGoBack();
                  }
                }}
                role="menuitemradio"
                shortcut={item.isDirectory
                  ? <Icon name="chevron-right" size="xs" />
                  : undefined}
              >
                {item.name}
              </MenuItem>
            );
          })
        )}
      </MenuSection>
    </Menu>
  );

  return createOverlayPortal(menuContent, getAppearanceOverlayHost());
};
export const EditorBreadcrumb: React.FC<EditorBreadcrumbProps> = ({
  filePath,
  workspacePath,
  className = '',
}) => {
  // Dropdown menu state
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [dropdownItems, setDropdownItems] = useState<FileItem[]>([]);
  const [dropdownLoading, setDropdownLoading] = useState(false);
  const [currentDirPath, setCurrentDirPath] = useState<string>('');
  const [initialDirPath, setInitialDirPath] = useState<string>('');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLSpanElement>>(new Map());

  // Parse path into segments
  const segments = useMemo<PathSegment[]>(() => {
    if (!filePath) return [];

    const normalizedPath = filePath.replace(/\\/g, '/');
    let relativePath = normalizedPath;
    const normalizedWorkspace = workspacePath ? workspacePath.replace(/\\/g, '/') : '';

    if (normalizedWorkspace) {
      if (normalizedPath.toLowerCase().startsWith(normalizedWorkspace.toLowerCase())) {
        relativePath = normalizedPath.slice(normalizedWorkspace.length).replace(/^\//, '');
      }
    }

    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 0) return [];

    const result: PathSegment[] = [];
    
    // Add root directory as first level
    if (normalizedWorkspace) {
      const rootName = normalizedWorkspace.split('/').filter(Boolean).pop() || 'root';
      result.push({
        name: rootName,
        fullPath: normalizedWorkspace,
        isFile: false,
      });
    }

    let currentPath = normalizedWorkspace;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      result.push({
        name: part,
        fullPath: currentPath,
        isFile: i === parts.length - 1,
      });
    }

    return result;
  }, [filePath, workspacePath]);

  // Load directory contents
  const document = useEditorDocument();
  const workspaceId = document?.scope.workspaceId;
  const loadDirectoryContents = useCallback(async (dirPath: string) => {
    setDropdownLoading(true);
    setCurrentDirPath(dirPath);
    try {
      if (!workspaceId) throw new Error('Workspace ID is required to browse an editor directory');
      const fileTree = await workspaceAPI.getFileTree(workspaceId, dirPath, 1);
      const rootNode = fileTree?.[0];
      const children = rootNode?.children || [];
      
      const items: FileItem[] = children
        .filter((entry: any) => {
          const name = entry.name || '';
          return !name.startsWith('.') && 
                 !['node_modules', 'target', 'dist', 'build', '__pycache__', '.git'].includes(name);
        })
        .map((entry: any) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory || false,
        }));

      setDropdownItems(items);
    } catch (error) {
      log.error('Failed to load directory', error);
      setDropdownItems([]);
    } finally {
      setDropdownLoading(false);
    }
  }, [workspaceId]);

  // Handle segment click
  const handleSegmentClick = useCallback((segment: PathSegment, event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    
    const target = event.currentTarget as HTMLElement;
    
    if (openDropdown === segment.fullPath) {
      setOpenDropdown(null);
      setAnchorEl(null);
    } else {
      setOpenDropdown(segment.fullPath);
      setAnchorEl(target);
      
      const dirPath = segment.isFile 
        ? segment.fullPath.substring(0, segment.fullPath.lastIndexOf('/'))
        : segment.fullPath;
      
      setInitialDirPath(dirPath);
      loadDirectoryContents(dirPath);
    }
  }, [openDropdown, loadDirectoryContents]);

  // Handle dropdown item selection
  const handleDropdownSelect = useCallback(async (item: FileItem) => {
    if (item.isDirectory) {
      loadDirectoryContents(item.path);
    } else {
      setOpenDropdown(null);
      setAnchorEl(null);
      
      const { fileTabManager } = await import('@/shared/services/FileTabManager');
      fileTabManager.openFile({
        filePath: item.path,
        fileName: item.name,
        workspacePath
      });
    }
  }, [loadDirectoryContents, workspacePath]);

  const handleGoBack = useCallback(() => {
    const parentPath = getParentPath(currentDirPath);
    if (parentPath) {
      loadDirectoryContents(parentPath);
    }
  }, [currentDirPath, loadDirectoryContents]);

  const handleCloseDropdown = useCallback(() => {
    setOpenDropdown(null);
    setAnchorEl(null);
  }, []);

  const setItemRef = useCallback((path: string, el: HTMLSpanElement | null) => {
    if (el) {
      itemRefs.current.set(path, el);
    } else {
      itemRefs.current.delete(path);
    }
  }, []);

  if (segments.length === 0) {
    return null;
  }

  const maxVisibleSegments = 6;
  let displaySegments: (PathSegment | { name: string; isEllipsis: true })[] = segments;
  
  if (segments.length > maxVisibleSegments) {
    displaySegments = [
      segments[0],
      { name: '…', isEllipsis: true },
      ...segments.slice(-4)
    ];
  }

  return (
    <nav className={`editor-breadcrumb ${className}`} data-openbitfun-product-component="editor-breadcrumb" data-openbitfun-product-part="root">
      {displaySegments.map((segment, index) => {
        const isEllipsis = 'isEllipsis' in segment && segment.isEllipsis;
        const pathSegment = segment as PathSegment;
        const isDropdownOpen = openDropdown === pathSegment.fullPath;

        return (
          <React.Fragment key={isEllipsis ? 'ellipsis' : pathSegment.fullPath}>
            {index > 0 && (
              <Icon name="chevron-right" size="2xs" data-openbitfun-product-component="editor-breadcrumb" data-openbitfun-product-part="separator" className="editor-breadcrumb__separator" />
            )}
            
            {isEllipsis ? (
              <span data-openbitfun-product-component="editor-breadcrumb" data-openbitfun-product-part="item" className="editor-breadcrumb__item editor-breadcrumb__item--ellipsis">
                {segment.name}
              </span>
            ) : (
              <Tooltip content={pathSegment.fullPath} placement="bottom">
                <span data-overflow-trigger
                  data-openbitfun-product-component="editor-breadcrumb"
                  data-openbitfun-product-part="item"
                  data-openbitfun-state={isDropdownOpen ? 'active' : undefined}
                  ref={(el) => setItemRef(pathSegment.fullPath, el)}
                  className={`editor-breadcrumb__item ${
                    pathSegment.isFile 
                      ? 'editor-breadcrumb__item--file' 
                      : 'editor-breadcrumb__item--folder'
                  } editor-breadcrumb__item--clickable ${isDropdownOpen ? 'editor-breadcrumb__item--active' : ''}`}
                  onClick={(e) => handleSegmentClick(pathSegment, e)}
                >
                  <span data-openbitfun-product-component="editor-breadcrumb" data-openbitfun-product-part="itemIcon" className="editor-breadcrumb__item-icon">
                    {pathSegment.isFile ? (
                      getFileIconComponent(pathSegment.name)
                    ) : (
                      <Icon name="folder" size="xs" />
                    )}
                  </span>
                  <OverflowText data-openbitfun-product-component="editor-breadcrumb" data-openbitfun-product-part="itemText" className="editor-breadcrumb__item-text">
                    {pathSegment.name}
                  </OverflowText>
                </span>
              </Tooltip>
            )}
          </React.Fragment>
        );
      })}
      
      <DropdownMenu
        isOpen={openDropdown !== null}
        items={dropdownItems}
        loading={dropdownLoading}
        currentDirPath={currentDirPath}
        initialDirPath={initialDirPath}
        onSelect={handleDropdownSelect}
        onGoBack={handleGoBack}
        onClose={handleCloseDropdown}
        anchorEl={anchorEl}
        currentFilePath={filePath}
        workspacePath={workspacePath}
      />
    </nav>
  );
};

EditorBreadcrumb.displayName = 'EditorBreadcrumb';

export default EditorBreadcrumb;
