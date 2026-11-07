import { createRoot } from 'react-dom/client';
import LivingLinePreview from './preview';

const host = document.getElementById('living-line-root');
if (!host) throw new Error('LivingLine preview root element is missing');
createRoot(host).render(<LivingLinePreview />);
