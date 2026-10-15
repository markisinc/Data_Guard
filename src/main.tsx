import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);

Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) {
    root.render(<p style={{ padding: 16 }}>DataGuard runs inside Excel.</p>);
    return;
  }
  if (!Office.context.requirements.isSetSupported('ExcelApi', '1.9')) {
    root.render(<p style={{ padding: 16 }}>This version of Excel is too old for DataGuard (needs ExcelApi 1.9 / Excel 2021 or Microsoft 365).</p>);
    return;
  }
  root.render(<App />);
});
