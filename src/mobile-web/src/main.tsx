import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import App from './App';
import { installTextInputGuard } from '../../shared/text-input/textInputGuard';

const removeTextInputGuard = installTextInputGuard(document);
if (import.meta.hot) import.meta.hot.dispose(removeTextInputGuard);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
