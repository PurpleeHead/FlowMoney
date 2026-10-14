import { useState } from 'react';
import { Camera, FileImage, LoaderCircle, Languages, CheckCircle2 } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import { parseReceiptLines, type ReceiptItem } from '../lib/receiptParser';
import { api } from '../lib/api';

type Props = {
  onSave: (items: ReceiptItem[], rawText: string) => Promise<void>;
  vndPerUsdt: number;
  vndPerRub: number;
};

export default function ReceiptScanner({ onSave, vndPerUsdt, vndPerRub }: Props) {
  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [ocrLanguage, setOcrLanguage] = useState('vie+eng');

  async function scan(file?: File) {
    if (!file) return;
    setBusy(true);
    setStatus('Loading OCR language data…');
    try {
      const worker = await createWorker(ocrLanguage);
      try {
        setStatus('Reading receipt locally…');
        const result = await worker.recognize(file);
        setOriginalText(result.data.text);
        setTranslatedText('');
        setItems(parseReceiptLines(result.data.text));
        setStatus(`OCR finished. Review ${parseReceiptLines(result.data.text).length} detected item(s).`);
      } finally {
        await worker.terminate();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'OCR failed');
    } finally {
      setBusy(false);
    }
  }

  async function translate() {
    if (!originalText.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ translatedText: string }>('/translate', {
        method: 'POST',
        body: JSON.stringify({ text: originalText, source: 'vi', target: 'ru' }),
      });
      setTranslatedText(result.translatedText);
      const translatedItems = parseReceiptLines(result.translatedText);
      if (translatedItems.length) setItems(translatedItems);
      setStatus('Translation complete. Original Vietnamese text is preserved; check names and amounts.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Translation service unavailable');
    } finally {
      setBusy(false);
    }
  }

  function updateItem(index: number, patch: Partial<ReceiptItem>) {
    setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  return (
    <section className="panel receipt-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">SMART RECEIPT</span>
          <h3>Scan a receipt</h3>
          <p>OCR runs in your browser. Original text is kept separately from its Russian translation.</p>
        </div>
        <Camera size={22} />
      </div>
      <div className="scan-controls">
        <label className="upload-button">
          <FileImage size={18} /> Choose receipt
          <input type="file" accept="image/*" capture="environment" onChange={event => scan(event.target.files?.[0])} />
        </label>
        <select value={ocrLanguage} onChange={event => setOcrLanguage(event.target.value)} aria-label="OCR language">
          <option value="vie+eng">Vietnamese + English</option>
          <option value="eng">English</option>
          <option value="rus">Russian</option>
        </select>
      </div>
      {busy && <p className="status"><LoaderCircle className="spin" size={16} />{status}</p>}
      {!busy && status && <p className="status"><CheckCircle2 size={16} />{status}</p>}
      <label className="field-label">
        Original receipt text
        <textarea rows={5} value={originalText} onChange={event => {
          setOriginalText(event.target.value);
          setTranslatedText('');
          setItems(parseReceiptLines(event.target.value));
        }} placeholder="Upload a receipt or paste its original Vietnamese text here…" />
      </label>
      {translatedText && (
        <label className="field-label translated-receipt">
          Russian translation (preview)
          <textarea rows={4} readOnly value={translatedText} />
        </label>
      )}
      <div className="receipt-actions">
        <button className="button secondary" onClick={translate} disabled={!originalText.trim() || busy}>
          <Languages size={16} /> Translate to Russian
        </button>
        <button className="button primary" onClick={() => onSave(items, originalText)} disabled={!items.length || busy}>
          Save {items.length || ''} items
        </button>
      </div>
      {items.length > 0 && (
        <div className="detected-items">
          <strong>Detected items — review and edit before saving</strong>
          {items.map((item, index) => (
            <div className="detected-row receipt-edit-row" key={`${item.name}-${index}`}>
              <label className="receipt-item-name">
                <span className="sr-only">Item name</span>
                <input value={item.name} onChange={event => updateItem(index, { name: event.target.value })} />
              </label>
              <label className="receipt-item-price">
                <span className="sr-only">Price in VND</span>
                <input type="number" min="1" step="any" value={item.price} onChange={event => updateItem(index, { price: Number(event.target.value) })} />
                <small>₫</small>
                <small className="receipt-conversions">
                  {vndPerRub > 0 ? `≈ ${(item.price / vndPerRub).toLocaleString('en-US', { maximumFractionDigits: 2 })} RUB` : ''}
                  {vndPerUsdt > 0 ? ` · ${(item.price / vndPerUsdt).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT` : ''}
                </small>
              </label>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
