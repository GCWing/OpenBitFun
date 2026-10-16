import './theme/installerThemeBootstrap';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import '@openbitfun/ui/styles.css';
import App from './App';
import { installTextInputGuard } from '../../src/shared/text-input/textInputGuard';

const removeTextInputGuard = installTextInputGuard(document);
if (import.meta.hot) import.meta.hot.dispose(removeTextInputGuard);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
