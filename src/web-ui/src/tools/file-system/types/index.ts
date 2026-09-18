export interface FileSystemNode {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  children?: FileSystemNode[];
  extension?: string;
  lastModified?: Date;
  
  isCompressed?: boolean;
  compressedPath?: string;
  originalNodes?: FileSystemNode[];
  
  isSelected?: boolean;
  isExpanded?: boolean;
  
  totalAnchors?: number;
  hasFixResult?: boolean;
}


export interface FileExplorerProps {
  fileTree: FileSystemNode[];
  selectedFile?: string;
  revealTarget?: FileTreeRevealTarget;
  onFileSelect?: (filePath: string, fileName: string) => void;
  className?: string;
  enablePathCompression?: boolean;
  showFileSize?: boolean;
  showLastModified?: boolean;
  
  expandedFolders?: Set<string>;
  loadingPaths?: Set<string>;
  onNodeExpand?: (path: string, expanded: boolean) => void;
  
  onFileDoubleClick?: (filePath: string) => void;
  onContextMenu?: (filePath: string, event: React.MouseEvent) => void;
  
  searchQuery?: string;
  fileFilter?: (node: FileSystemNode) => boolean;
  
  renamingPath?: string | null;
  onRename?: (oldPath: string, newName: string) => void;
  onCancelRename?: () => void;
  
  workspacePath?: string;
  
  onNewFile?: (data: { parentPath: string }) => void;
  onNewFolder?: (data: { parentPath: string }) => void;
  onRefresh?: () => void;

  /** When true, the floating toolbar is not rendered (e.g. actions live in a parent header). */
  hideToolbar?: boolean;
}

/** Zero-arg handlers for toolbar buttons when the UI is rendered outside FileExplorer. */
export interface FileExplorerToolbarHandlers {
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
}


export interface FileTreeProps {
  nodes: FileSystemNode[];
  selectedFile?: string;
  expandedFolders?: Set<string>;
  loadingPaths?: Set<string>;
  onNodeSelect?: (node: FileSystemNode) => void;
  onNodeExpand?: (path: string, expanded: boolean) => void;
  className?: string;
  level?: number;
  
  workspacePath?: string;
  
  renderNodeContent?: (node: FileSystemNode, level: number) => React.ReactNode;
  renderNodeActions?: (node: FileSystemNode) => React.ReactNode;
  
  renamingPath?: string | null;
  onRename?: (oldPath: string, newName: string) => void;
  onCancelRename?: () => void;
}


export interface FileTreeNodeProps {
  node: FileSystemNode;
  level: number;
  isSelected?: boolean;
  isExpanded?: boolean;
  loadingPaths?: Set<string>;
  onSelect?: (node: FileSystemNode) => void;
  onToggleExpand?: (path: string) => void;
  className?: string;
  
  workspacePath?: string;
  
  renamingPath?: string | null;
  onRename?: (path: string, newName: string) => void;
  onCancelRename?: () => void;
  
  renderContent?: (node: FileSystemNode, level: number) => React.ReactNode;
  renderActions?: (node: FileSystemNode) => React.ReactNode;
}


export interface FileSystemOptions {
  enablePathCompression?: boolean;
  showHiddenFiles?: boolean;
  sortBy?: 'name' | 'size' | 'lastModified' | 'type';
  sortOrder?: 'asc' | 'desc';
  maxDepth?: number;
  excludePatterns?: string[];
}


export interface FileSystemState {
  fileTree: FileSystemNode[];
  selectedFile?: string;
  expandedFolders: Set<string>;
  loading: boolean;
  error?: string;
  searchQuery?: string;
  options: FileSystemOptions;
}


export type FileIconType = 
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'image'
  | 'code'
  | 'javascript'
  | 'typescript'
  | 'react'
  | 'vue'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c-cpp'
  | 'html'
  | 'css'
  | 'sass'
  | 'config'
  | 'json'
  | 'markdown'
  | 'text'
  | 'database'
  | 'font'
  | 'audio'
  | 'video'
  | 'archive'
  | 'binary';


export interface FileSystemEvent {
  type: 'select' | 'expand' | 'collapse' | 'doubleClick' | 'contextMenu';
  node: FileSystemNode;
  path: string;
  timestamp: Date;
}

export interface FileSystemChangeEvent {
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
  timestamp: Date;
}


export interface IFileSystemService {
  loadFileTree(workspaceId: string, rootPath: string, options?: FileSystemOptions): Promise<FileSystemNode[]>;
  searchFiles(rootPath: string, query: string): Promise<FileSystemNode[]>;
  watchFileChanges(rootPath: string, callback: (event: FileSystemChangeEvent) => void): () => void;
  getFileContent(workspaceId: string, filePath: string): Promise<string>;
  getFileStats(filePath: string): Promise<{ size: number; lastModified: Date }>;
}


export interface FlatFileNode {
  path: string;
  name: string;
  parentPath: string | null;
  isDirectory: boolean;
  depth: number;
  childrenLoaded: boolean;
  isLoading?: boolean;
  size?: number;
  extension?: string;
  lastModified?: Date;
  isCompressed?: boolean;
  originalNode?: FileSystemNode;
}


export interface FileTreeRevealTarget {
  path: string;
  requestId: number;
}

export interface VirtualFileTreeProps {
  flatNodes: FlatFileNode[];
  selectedFile?: string;
  revealTarget?: FileTreeRevealTarget;
  expandedFolders: Set<string>;
  onNodeSelect?: (node: FlatFileNode) => void;
  onToggleExpand?: (path: string) => void;
  height?: number | string;
  className?: string;
  workspacePath?: string;
  renamingPath?: string | null;
  onRename?: (oldPath: string, newName: string) => void;
  onCancelRename?: () => void;
  renderNodeContent?: (node: FileSystemNode, level: number) => React.ReactNode;
  renderNodeActions?: (node: FileSystemNode) => React.ReactNode;
}


export interface DirectoryCacheEntry {
  path: string;
  children: FileSystemNode[];
  timestamp: number;
  isComplete: boolean;
}


export interface LazyLoadState {
  loadedPaths: Set<string>;
  loadingPaths: Set<string>;
  cache: Map<string, DirectoryCacheEntry>;
}
