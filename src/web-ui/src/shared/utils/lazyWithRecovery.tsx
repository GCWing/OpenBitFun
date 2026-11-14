import {
  Component,
  createElement,
  forwardRef,
  lazy,
  type ComponentPropsWithRef,
  type ComponentType,
  type ErrorInfo,
  type ForwardRefExoticComponent,
  type LazyExoticComponent,
} from 'react';
import { ModuleLoadFailure } from './ModuleLoadFailure';
import { createLogger } from './logger';
import { createModuleLoader, subscribeToModuleRecovery } from './moduleLoader';

const log = createLogger('LazyModule');

class ModuleImportError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'ModuleImportError';
  }
}

export type RecoverableLazyComponent<T extends ComponentType<any>> =
  ForwardRefExoticComponent<ComponentPropsWithRef<T>> & { preload: () => Promise<{ default: T }> };

/**
 * A local import boundary with a fresh React.lazy payload on retry. Suspense
 * remains owned by the caller; loaded descendants retain their state. Only
 * loader failures are contained here, never exceptions from rendering a view.
 */
export function lazyWithRecovery<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
): RecoverableLazyComponent<T> {
  const load = createModuleLoader(loader);
  const createLazyComponent = () => lazy(() => load().catch(error => {
    throw new ModuleImportError(error);
  }));
  // Share the initial lazy type too: React can discard uncommitted trees while
  // suspended. Creating a lazy type on every mount would repeatedly suspend.
  let Content = createLazyComponent();

  type Props = { componentProps: ComponentPropsWithRef<T> };
  type State = { error: ModuleImportError | null; content: LazyExoticComponent<T> };

  class ModuleBoundary extends Component<Props, State> {
    state: State = { error: null, content: Content };
    private unsubscribe?: () => void;

    static getDerivedStateFromError(error: unknown) {
      if (!(error instanceof ModuleImportError)) throw error;
      return { error };
    }

    componentDidMount() {
      // React StrictMode replays mount/unmount without discarding error state.
      if (this.state.error) this.listenForRecovery();
    }

    private listenForRecovery() {
      this.unsubscribe?.();
      this.unsubscribe = subscribeToModuleRecovery(this.retry);
    }

    componentDidCatch(error: ModuleImportError, info: ErrorInfo) {
      // A later mount (closing/reopening a view) must not inherit React.lazy's
      // rejected payload. Existing failed mounts retain their visible error.
      if (Content === this.state.content) Content = createLazyComponent();
      this.listenForRecovery();
      log.warn('Failed to load view module', {
        error: error.originalError,
        componentStack: info.componentStack,
      });
    }

    componentWillUnmount() {
      this.unsubscribe?.();
    }

    retry = () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.setState({ error: null, content: Content });
    };

    render() {
      const { error, content } = this.state;
      if (!error) return createElement(content, this.props.componentProps);

      return <ModuleLoadFailure error={error} retry={this.retry} />;
    }
  }

  // Preserve refs for lazy editors/panels as well as their inferred prop types.
  const Recoverable = forwardRef((props, ref) => (
    <ModuleBoundary componentProps={{ ...props, ...(ref === null ? {} : { ref }) } as ComponentPropsWithRef<T>} />
  ));
  Recoverable.displayName = 'RecoverableLazy';
  return Object.assign(Recoverable, { preload: load }) as RecoverableLazyComponent<T>;
}
